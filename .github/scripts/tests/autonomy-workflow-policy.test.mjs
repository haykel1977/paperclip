import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADVISORY_CHECKS, REQUIRED_STATUS_CHECKS } from '../required-checks.mjs';

// These assertions read the workflow YAML as text rather than parsing it. The
// properties being pinned here are about ordering, guard expressions and the
// literal absence of a permission — all of which a parser would happily
// normalise away, and all of which were silently wrong before.

function workflow(name) {
  return readFileSync(fileURLToPath(new URL(`../../workflows/${name}`, import.meta.url)), 'utf8');
}

const prWorkflow = workflow('pr.yml');
const reviewWorkflow = workflow('commitperclip-review.yml');
const secretScanWorkflow = workflow('secret-scan.yml');

function stepIndex(source, stepName) {
  const at = source.indexOf(`- name: ${stepName}`);
  assert.notEqual(at, -1, `step "${stepName}" must exist`);
  return at;
}

// ── commitperclip-review: ordering and least privilege ────────────────────────

test('review: the auto-merge decision runs before the terminal quality gate', () => {
  // Revocation is the safety-critical outcome. When "Fail if quality gates
  // failed" ran first its `exit 1` aborted the job, so a PR that had just
  // become unsafe kept its already-armed auto-merge.
  assert.ok(
    stepIndex(reviewWorkflow, 'Decide native auto-merge for automation PRs (enable or revoke)') <
      stepIndex(reviewWorkflow, 'Fail if quality gates failed'),
    'the decision step must precede every step that can exit non-zero',
  );
});

test('review: the auto-merge decision is guarded by always(), not by gate success', () => {
  const decision = reviewWorkflow.slice(
    stepIndex(reviewWorkflow, 'Decide native auto-merge for automation PRs (enable or revoke)'),
  );
  const guard = decision.match(/if: \$\{\{ (.+?) \}\}/)[1];
  assert.match(guard, /always\(\)/, 'a failed advisory gate must not skip the decision');
  assert.match(guard, /steps\.token\.outcome == 'success'/, 'without a token the script cannot act');
  assert.doesNotMatch(guard, /steps\.quality/, 'quality outcome must not gate the decision');
});

test('review: the advisory dependency review cannot fail the job', () => {
  const advisory = reviewWorkflow.slice(
    stepIndex(reviewWorkflow, 'Dependency Review'),
    stepIndex(reviewWorkflow, 'Set up Node'),
  );
  assert.match(advisory, /continue-on-error: true/);
});

test('review: GITHUB_TOKEN is not granted contents: write', () => {
  const permissions = reviewWorkflow.slice(
    reviewWorkflow.indexOf('\npermissions:'),
    reviewWorkflow.indexOf('\njobs:'),
  );
  assert.match(permissions, /contents: read/);
  assert.doesNotMatch(permissions, /contents: write/);
  // `administration` is not a GITHUB_TOKEN scope at all; declaring it here
  // would be silently ignored and would read as satisfied when it is not.
  assert.doesNotMatch(permissions, /administration:/);
});

test('review: the required contexts it enforces match the single source of truth', () => {
  const declared = reviewWorkflow.match(/REQUIRED_CHECKS: (.+)/)[1].trim().split(',');
  assert.deepEqual(declared, [...REQUIRED_STATUS_CHECKS]);
  for (const advisory of ADVISORY_CHECKS) {
    assert.ok(!declared.includes(advisory), `${advisory} is aggregated by verify, not required`);
  }
});

// ── pr.yml: verify aggregates every lane and always terminates ────────────────

test('verify: aggregates every sibling lane in the workflow', () => {
  const verifyJob = prWorkflow.slice(
    prWorkflow.indexOf('\n  verify:'),
    prWorkflow.indexOf('\n  build:'),
  );
  for (const lane of [
    'typecheck_release_registry',
    'general_tests',
    'build',
    'verify_serialized_server',
    'canary_dry_run',
    'e2e',
  ]) {
    assert.match(verifyJob, new RegExp(`^      - ${lane}$`, 'm'), `verify must need ${lane}`);
  }
});

test('verify: no job in pr.yml escapes the aggregate', () => {
  // A new lane added without wiring it into `verify` would be invisible to
  // branch protection, which requires only `verify`.
  const jobsBlock = prWorkflow.slice(prWorkflow.indexOf('\njobs:'));
  const jobs = [...jobsBlock.matchAll(/^ {2}([a-z0-9_]+):$/gm)].map(m => m[1]);
  const verifyJob = prWorkflow.slice(
    prWorkflow.indexOf('\n  verify:'),
    prWorkflow.indexOf('\n  build:'),
  );
  for (const job of jobs) {
    if (job === 'verify' || job === 'policy') continue;
    assert.match(verifyJob, new RegExp(`^      - ${job}$`, 'm'),
      `job "${job}" is not aggregated by verify, so failing it would not block merge`);
  }
});

test('verify: always() plus explicit per-lane comparison guarantees a terminal status', () => {
  const verifyJob = prWorkflow.slice(
    prWorkflow.indexOf('\n  verify:'),
    prWorkflow.indexOf('\n  build:'),
  );
  // Without always(), a failed dependency skips verify; a skipped required
  // context stays pending forever, which reads identically to "still running".
  assert.match(verifyJob, /if: \$\{\{ always\(\) \}\}/);
  // always() alone is not enough: the step must actively compare each result,
  // because a skipped dependency reports "skipped", not "failure".
  assert.match(verifyJob, /if \[ "\$result" = "success" \]/);
  assert.match(verifyJob, /exit 1/);
});

test('verify: it publishes exactly the context name branch protection requires', () => {
  const verifyJob = prWorkflow.slice(
    prWorkflow.indexOf('\n  verify:'),
    prWorkflow.indexOf('\n  build:'),
  );
  assert.match(verifyJob, /^ {4}name: verify$/m);
  assert.ok(REQUIRED_STATUS_CHECKS.includes('verify'));
});

// ── secret-scan: the required context is the gate, not the scanner ────────────

test('secret scan: the required context is published by an always()-run gate job', () => {
  assert.match(secretScanWorkflow, /^ {4}name: Secret Scan$/m);
  const gate = secretScanWorkflow.slice(secretScanWorkflow.indexOf('\n  secret-scan:'));
  assert.match(gate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(gate, /GITLEAKS_RESULT: \$\{\{ needs\.gitleaks\.result \}\}/);
  assert.match(gate, /\[ "\$GITLEAKS_RESULT" != "success" \]/);
  assert.match(gate, /exit 1/);
  assert.ok(REQUIRED_STATUS_CHECKS.includes('Secret Scan'));
});

// ── the governance carve-out is armed identically on both gates ───────────────

test('carve-out: both gates read the same PR-immutable repository variables', () => {
  // The App gate and the auto-merge gate must reach the same lane. If only one
  // received the variables, arming the carve-out would approve PRs that then
  // never auto-merged. Repository `vars` (not `secrets`, not anything in the
  // diff) is what makes the judge identity PR-immutable.
  for (const name of [
    'PAPERCLIP_GITHUB_CARVEOUT_MODE',
    'PAPERCLIP_GITHUB_CARVEOUT_JUDGE_APP_ID',
    'PAPERCLIP_GITHUB_CARVEOUT_JUDGE_APP_SLUG',
  ]) {
    for (const [label, source] of [
      ['commitperclip-review.yml', reviewWorkflow],
      ['paperclip-checker.yml', workflow('paperclip-checker.yml')],
    ]) {
      assert.ok(
        source.includes(`${name}: \${{ vars.${name} }}`),
        `${label} must pass ${name} from repository variables`,
      );
      assert.ok(!source.includes(`secrets.${name}`), `${name} must not come from secrets`);
    }
  }
});

// ── every governance test actually runs in CI ─────────────────────────────────

test('policy job: every test under .github/scripts/tests is registered in CI', () => {
  // A test that CI never invokes is not evidence. `check-branch-protection`
  // sat unregistered, so its assertions had never once run on a PR.
  const policyJob = prWorkflow.slice(
    prWorkflow.indexOf('\n  policy:'),
    prWorkflow.indexOf('\n  typecheck_release_registry:'),
  );
  const invoked = new Set(
    [...policyJob.matchAll(/\.\/\.github\/scripts\/tests\/([\w.-]+\.test\.mjs)/g)].map(m => m[1]),
  );
  const testsDir = fileURLToPath(new URL('.', import.meta.url));
  for (const file of readdirSync(testsDir).filter(f => f.endsWith('.test.mjs'))) {
    assert.ok(invoked.has(file), `${file} is never run by the policy job in pr.yml`);
  }
});
