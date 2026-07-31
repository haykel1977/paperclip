import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  disablePullRequestAutoMerge,
  evaluateAutoMergeRevocation,
  evaluateAutomergeEligibility,
  evaluateBranchProtection,
  enablePullRequestAutoMerge,
  fetchBranchProtection,
  buildRequiredEvidence,
  planAutomerge,
  ALLOWED_AUTOMERGE_AUTHORS,
  BRANCH_PROTECTION_FORBIDDEN,
  BRANCH_PROTECTION_FORBIDDEN_REASON,
  DEFAULT_EVIDENCE_CHECKS,
  DEFAULT_REQUIRED_CHECKS,
  branchProtectionErrorStatus,
  isBranchProtectionForbidden,
} from '../enable-agent-automerge.mjs';
import { ADVISORY_CHECKS } from '../required-checks.mjs';

test('ALLOWED_AUTOMERGE_AUTHORS: includes the dedicated delivery App, excludes humans', () => {
  assert.ok(ALLOWED_AUTOMERGE_AUTHORS.has('solidus-paperclip-delivery[bot]'));
  assert.ok(!ALLOWED_AUTOMERGE_AUTHORS.has('haykel1977'));
});

test('ALLOWED_AUTOMERGE_AUTHORS: recognizes BOTH exact canonical App forms, rejects lookalikes', () => {
  assert.ok(ALLOWED_AUTOMERGE_AUTHORS.has('app/solidus-paperclip-delivery'), 'GraphQL form');
  assert.ok(ALLOWED_AUTOMERGE_AUTHORS.has('solidus-paperclip-delivery[bot]'), 'REST form');
  for (const impostor of [
    'app/solidus-paperclip-delivery-evil',
    'app/solidus-paperclip-deliveryx',
    'app/solidus-paperclip',
    'solidus-paperclip-delivery',
    'app/solidus-paperclip-delivery[bot]',
    ' app/solidus-paperclip-delivery',
    'app/Solidus-Paperclip-Delivery',
  ]) {
    assert.ok(!ALLOWED_AUTOMERGE_AUTHORS.has(impostor), `must reject lookalike ${JSON.stringify(impostor)}`);
  }
});

// Branch protection must require every context in DEFAULT_REQUIRED_CHECKS. Drawn
// from the module rather than re-spelled, so a change to the live set fails the
// tests instead of silently leaving them asserting a stale name.
const protectedMain = {
  required_status_checks: {
    strict: true,
    contexts: [...DEFAULT_REQUIRED_CHECKS],
  },
};

function pr(overrides = {}) {
  return {
    state: 'open',
    draft: false,
    base: { ref: 'main', repo: { full_name: 'paperclipai/paperclip' } },
    head: { ref: 'fix/agent-change', repo: { full_name: 'paperclipai/paperclip' } },
    user: { login: 'paperclipai[bot]' },
    labels: [{ name: 'agent-pr' }, { name: 'automerge' }],
    auto_merge: null,
    node_id: 'PR_kwDOExample',
    ...overrides,
  };
}

// ── Production-wiring integration tests (planAutomerge) ──────────────────────
// These exercise the real path: file list + head-SHA check-runs + event SHA are
// fed through classifyPrRiskLane exactly as main() does, so the fixes below are
// covered end-to-end (not just in the pure classifier unit tests).

const HEAD_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function planPr(overrides = {}) {
  return pr({
    title: 'fix(server): correct cursor anchor timestamp binding',
    head: { ref: 'fix/agent-change', sha: HEAD_SHA, repo: { full_name: 'paperclipai/paperclip' } },
    ...overrides,
  });
}

const changedFile = (filename, o = {}) => ({ filename, status: 'modified', additions: 5, deletions: 0, changes: 5, ...o });
// Evidence is drawn only from the CI checks (DEFAULT_EVIDENCE_CHECKS), not from
// the checker's own two contexts: the checker publishes those from this very
// evaluation, so requiring them as evidence of it would deadlock the gate.
const greenChecks = () =>
  DEFAULT_EVIDENCE_CHECKS.map(name => ({ name, status: 'completed', conclusion: 'success' }));
const [FIRST_EVIDENCE, SECOND_EVIDENCE] = DEFAULT_EVIDENCE_CHECKS;

function plan(overrides = {}) {
  return planAutomerge({
    pr: planPr(overrides.pr),
    files: overrides.files ?? [changedFile('server/src/services/cursor.ts')],
    checkRuns: overrides.checkRuns ?? greenChecks(),
    eventHeadSha: 'eventHeadSha' in overrides ? overrides.eventHeadSha : HEAD_SHA,
    branchProtection: overrides.branchProtection ?? protectedMain,
    requiredChecks: overrides.requiredChecks,
    defaultBranch: 'main',
    classificationError: overrides.classificationError ?? false,
    ...('env' in overrides ? { env: overrides.env } : {}),
  });
}

// ── .github/** governance carve-out, as wired into the auto-merge gate ────────
// The checker and this gate must reach the SAME lane. A split verdict would let
// the App approve a PR that auto-merge then silently never arms — a half-open
// state that reads as "autonomy is broken" rather than "autonomy said no".

const CARVEOUT_ENFORCE_ENV = {
  PAPERCLIP_GITHUB_CARVEOUT_MODE: 'enforce',
  PAPERCLIP_GITHUB_CARVEOUT_JUDGE_APP_ID: '4372695',
  PAPERCLIP_GITHUB_CARVEOUT_JUDGE_APP_SLUG: 'solidus-paperclip-checker',
};

const carveoutFile = () => changedFile('.github/workflows/nightly-cache-warm.yml', {
  additions: 2,
  deletions: 1,
  changes: 3,
  patch: '@@ -3,3 +3,4 @@\n-  schedule: "0 3 * * *"\n+  schedule: "0 4 * * *"\n+  # retimed\n',
});

test('carve-out: shadow (default env) leaves a .github/** PR RED and unarmed', () => {
  const result = plan({ files: [carveoutFile()], env: {} });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'skip');
});

test('carve-out: enforce with an external judge arms one bounded .github edit', () => {
  const result = plan({ files: [carveoutFile()], env: CARVEOUT_ENFORCE_ENV });
  assert.equal(result.riskLane, 'GREEN', result.reasons.join('; '));
  assert.equal(result.action, 'enable', result.reasons.join('; '));
});

test('carve-out: enforce cannot arm a PR that edits the carve-out judge itself', () => {
  const result = plan({
    files: [changedFile('.github/scripts/github-governance-carveout.mjs', { additions: 1, deletions: 0, changes: 1 })],
    env: CARVEOUT_ENFORCE_ENV,
  });
  assert.equal(result.riskLane, 'RED', result.reasons.join('; '));
  assert.equal(result.action, 'skip');
});

test('carve-out: enforce cannot arm a permission-broadening workflow edit', () => {
  const result = plan({
    files: [changedFile('.github/workflows/nightly-cache-warm.yml', {
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: '@@ -1,3 +1,3 @@\n permissions:\n-  contents: read\n+  contents: write\n',
    })],
    env: CARVEOUT_ENFORCE_ENV,
  });
  assert.equal(result.riskLane, 'RED', result.reasons.join('; '));
  assert.equal(result.action, 'skip');
});

test('planAutomerge: GREEN happy path enables auto-merge', () => {
  const result = plan();
  assert.equal(result.riskLane, 'GREEN');
  assert.equal(result.action, 'enable');
});

test('planAutomerge: deleting a sacred surface is RED and skipped (not enabled)', () => {
  const result = plan({ files: [changedFile('.github/workflows/secret-scan.yml', { status: 'removed', additions: 0, deletions: 30, changes: 30 })] });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'skip');
});

test('planAutomerge: renaming a sacred file out of a matched path is RED and skipped', () => {
  const result = plan({ files: [changedFile('docs/notes.md', { status: 'renamed', previous_filename: 'server/src/routes/authz.ts', additions: 1, changes: 1 })] });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'skip');
});

test('planAutomerge: Dependabot lockfile-only PR is exempted to GREEN and enabled', () => {
  const result = plan({
    pr: {
      user: { login: 'dependabot[bot]' },
      labels: [{ name: 'automerge' }],
    },
    files: [changedFile('pnpm-lock.yaml'), changedFile('package.json')],
  });
  assert.equal(result.riskLane, 'GREEN');
  assert.equal(result.action, 'enable');
});

test('planAutomerge: lockfile-refresh automation PR is exempted to GREEN and enabled', () => {
  const result = plan({
    pr: {
      user: { login: 'github-actions[bot]' },
      head: { ref: 'chore/refresh-lockfile', sha: HEAD_SHA, repo: { full_name: 'paperclipai/paperclip' } },
      labels: [],
    },
    files: [changedFile('pnpm-lock.yaml')],
  });
  assert.equal(result.riskLane, 'GREEN');
  assert.equal(result.action, 'enable');
});

test('planAutomerge: Dependabot PR that ALSO touches a workflow is RED (exemption evaporates)', () => {
  const result = plan({
    pr: { user: { login: 'dependabot[bot]' }, labels: [{ name: 'automerge' }] },
    files: [changedFile('pnpm-lock.yaml'), changedFile('.github/workflows/pr.yml')],
  });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'skip');
});

test('planAutomerge: a completed neutral required check fails closed to RED', () => {
  const result = plan({ checkRuns: [
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'neutral' },
    { name: SECOND_EVIDENCE, status: 'completed', conclusion: 'success' },
  ] });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'skip');
});

test('planAutomerge: a completed skipped required check fails closed to RED', () => {
  const result = plan({ checkRuns: [
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'skipped' },
    { name: SECOND_EVIDENCE, status: 'completed', conclusion: 'success' },
  ] });
  assert.equal(result.riskLane, 'RED');
});

test('planAutomerge: pending required checks do not block enabling (branch protection backstops)', () => {
  const result = plan({ checkRuns: [
    { name: FIRST_EVIDENCE, status: 'in_progress', conclusion: null },
    { name: SECOND_EVIDENCE, status: 'queued', conclusion: null },
  ] });
  assert.equal(result.riskLane, 'GREEN');
  assert.equal(result.action, 'enable');
});

test('planAutomerge: stale head SHA (event SHA != API SHA) is RED and skipped', () => {
  const result = plan({ eventHeadSha: OTHER_SHA });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'skip');
});

test('planAutomerge: classificationError forces RED and skip (fail closed)', () => {
  const result = plan({ classificationError: true });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'skip');
});

test('planAutomerge: revokes already-enabled auto-merge when the live lane is RED', () => {
  const result = plan({
    pr: { auto_merge: { enabled_by: { login: 'paperclipai[bot]' } } },
    files: [changedFile('.github/workflows/pr.yml')],
  });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'disable');
});

test('buildRequiredEvidence: includes completed required checks and excludes pending ones', () => {
  const { evidence, requiredEvidenceNames } = buildRequiredEvidence([
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'success' },
    { name: SECOND_EVIDENCE, status: 'in_progress', conclusion: null },
    { name: 'unrelated', status: 'completed', conclusion: 'failure' },
  ], [FIRST_EVIDENCE, SECOND_EVIDENCE]);
  assert.deepEqual(requiredEvidenceNames, [FIRST_EVIDENCE]);
  assert.deepEqual(evidence, [{ name: FIRST_EVIDENCE, conclusion: 'success' }]);
});

test('buildRequiredEvidence: keeps the newest run per required check name', () => {
  const { evidence } = buildRequiredEvidence([
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'failure' },
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'success' },
  ], [FIRST_EVIDENCE]);
  assert.deepEqual(evidence, [{ name: FIRST_EVIDENCE, conclusion: 'failure' }]);
});

test('buildRequiredEvidence: an older success does NOT mask a newer neutral (explicit timestamp sort)', () => {
  // Supplied oldest-first — the OPPOSITE of the "newest first" assumption the
  // old code trusted. A stale `success` must not win over the newer `neutral`.
  const { evidence } = buildRequiredEvidence([
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'success', completed_at: '2026-01-01T00:00:00Z' },
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'neutral', completed_at: '2026-01-02T00:00:00Z' },
  ], [FIRST_EVIDENCE]);
  assert.deepEqual(evidence, [{ name: FIRST_EVIDENCE, conclusion: 'neutral' }]);
});

test('buildRequiredEvidence: an older success does NOT mask a newer failure (explicit timestamp sort)', () => {
  const { evidence } = buildRequiredEvidence([
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z' },
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'failure', started_at: '2026-01-03T00:00:00Z' },
  ], [FIRST_EVIDENCE]);
  assert.deepEqual(evidence, [{ name: FIRST_EVIDENCE, conclusion: 'failure' }]);
});

test('buildRequiredEvidence: falls back through completed_at → started_at → created_at for recency', () => {
  const { evidence } = buildRequiredEvidence([
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'neutral', created_at: '2026-01-05T00:00:00Z' },
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'success', created_at: '2026-01-04T00:00:00Z' },
  ], [FIRST_EVIDENCE]);
  assert.deepEqual(evidence, [{ name: FIRST_EVIDENCE, conclusion: 'neutral' }]);
});

test('planAutomerge: an older success check-run cannot mask a newer neutral (RED, skipped)', () => {
  const result = plan({ checkRuns: [
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'success', completed_at: '2026-01-01T00:00:00Z' },
    { name: FIRST_EVIDENCE, status: 'completed', conclusion: 'neutral', completed_at: '2026-01-02T00:00:00Z' },
    { name: SECOND_EVIDENCE, status: 'completed', conclusion: 'success', completed_at: '2026-01-02T00:00:00Z' },
  ] });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'skip');
});

test('evaluateAutomergeEligibility: allows opted-in same-repo agent PRs with protected required checks', () => {
  const result = evaluateAutomergeEligibility(pr(), { branchProtection: protectedMain });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.failures, []);
});

test('evaluateAutomergeEligibility: allows the delivery App under its GraphQL login form', () => {
  const result = evaluateAutomergeEligibility(pr({ user: { login: 'app/solidus-paperclip-delivery' } }), { branchProtection: protectedMain });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.failures, []);
});

test('evaluateAutomergeEligibility: rejects an app/* lookalike of the delivery App', () => {
  const result = evaluateAutomergeEligibility(pr({ user: { login: 'app/solidus-paperclip-delivery-evil' } }), { branchProtection: protectedMain });
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('not an allowed automation identity')));
});

test('evaluateAutomergeEligibility: whitespace-padded delivery-App logins are rejected (raw exact compare, no trim)', () => {
  // The login is compared RAW against the exact finite allowlist. Padding with
  // spaces, tabs, or newlines must NOT be trimmed into a match — consistent with
  // the witness guard and governance, which already reject padded identities.
  for (const base of ['app/solidus-paperclip-delivery', 'solidus-paperclip-delivery[bot]']) {
    for (const padded of [` ${base}`, `${base} `, `\t${base}`, `${base}\t`, `\n${base}`, `${base}\n`, `${base}\r\n`]) {
      const result = evaluateAutomergeEligibility(pr({ user: { login: padded } }), { branchProtection: protectedMain });
      assert.equal(result.eligible, false, `padded login must be ineligible: ${JSON.stringify(padded)}`);
      assert.ok(
        result.failures.some(failure => failure.includes('not an allowed automation identity')),
        `padded login must trip the identity guard: ${JSON.stringify(padded)}`,
      );
    }
    // The exact, unpadded canonical form remains eligible.
    const ok = evaluateAutomergeEligibility(pr({ user: { login: base } }), { branchProtection: protectedMain });
    assert.equal(ok.eligible, true, `exact form must remain eligible: ${base}`);
  }
});

test('evaluateAutomergeEligibility: rejects human-authored PRs even with labels', () => {
  const result = evaluateAutomergeEligibility(pr({ user: { login: 'haykel1977' } }), { branchProtection: protectedMain });
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('not an allowed automation identity')));
});

test('evaluateAutomergeEligibility: rejects fork PRs', () => {
  const result = evaluateAutomergeEligibility(pr({
    head: { ref: 'fix/agent-change', repo: { full_name: 'someone/fork' } },
  }), { branchProtection: protectedMain });
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('fork')));
});

test('evaluateAutomergeEligibility: rejects missing explicit opt-in labels', () => {
  const result = evaluateAutomergeEligibility(pr({ labels: [{ name: 'agent-pr' }] }), { branchProtection: protectedMain });
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('Missing explicit auto-merge opt-in')));
});

test('evaluateAutomergeEligibility: rejects blocking labels', () => {
  const result = evaluateAutomergeEligibility(pr({ labels: [{ name: 'agent-pr' }, { name: 'automerge' }, { name: 'do-not-merge' }] }), { branchProtection: protectedMain });
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('Blocking label')));
});

test('evaluateAutomergeEligibility: rejects PRs when branch protection is missing', () => {
  const result = evaluateAutomergeEligibility(pr(), { branchProtection: null });
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('Branch protection')));
});

test('evaluateAutomergeEligibility: rejects PRs when ANY required check is absent from branch protection', () => {
  // Every one of the four contexts must be independently load-bearing. A gate
  // that only noticed the first missing one would let the other three be
  // silently dropped from branch protection.
  for (const omitted of DEFAULT_REQUIRED_CHECKS) {
    const result = evaluateAutomergeEligibility(pr(), {
      branchProtection: {
        required_status_checks: {
          strict: true,
          contexts: DEFAULT_REQUIRED_CHECKS.filter(check => check !== omitted),
        },
      },
    });
    assert.equal(result.eligible, false, `${omitted} must be required`);
    assert.ok(
      result.failures.some(failure => failure.includes(`\`${omitted}\``)),
      `the failure must name the missing context ${omitted}`,
    );
  }
});

test('evaluateAutomergeEligibility: rejects PRs when branch protection does not require up-to-date branches', () => {
  const result = evaluateAutomergeEligibility(pr(), {
    branchProtection: { required_status_checks: { strict: false, contexts: [...DEFAULT_REQUIRED_CHECKS] } },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('up to date')));
});

test('evaluateAutomergeEligibility: blocks non-GREEN risk lane when a lane is supplied', () => {
  for (const lane of ['ORANGE', 'RED', 'unknown', '']) {
    const result = evaluateAutomergeEligibility(pr(), { branchProtection: protectedMain, riskLane: lane });
    assert.equal(result.eligible, false, `expected ineligible for lane ${lane}`);
    assert.ok(result.failures.some(failure => failure.includes('not GREEN')));
  }
});

test('evaluateAutomergeEligibility: allows GREEN risk lane', () => {
  const result = evaluateAutomergeEligibility(pr(), { branchProtection: protectedMain, riskLane: 'GREEN' });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.failures, []);
});

test('evaluateAutoMergeRevocation: revokes already-enabled auto-merge when the risk lane is no longer GREEN', () => {
  const result = evaluateAutoMergeRevocation(pr({
    auto_merge: { enabled_by: { login: 'paperclipai[bot]' } },
  }), { branchProtection: protectedMain, riskLane: 'RED' });
  assert.equal(result.revoke, true);
  assert.ok(result.reasons.some(reason => reason.includes('not GREEN')));
});

test('evaluateAutomergeEligibility: allows lockfile automation branch without labels when branch protection is configured', () => {
  const result = evaluateAutomergeEligibility(pr({
    user: { login: 'github-actions[bot]' },
    head: { ref: 'chore/refresh-lockfile', repo: { full_name: 'paperclipai/paperclip' } },
    labels: [],
  }), { branchProtection: protectedMain });
  assert.equal(result.eligible, true);
});

test('evaluateAutoMergeRevocation: revokes already-enabled auto-merge when a hard-block label is present', () => {
  const result = evaluateAutoMergeRevocation(pr({
    auto_merge: { enabled_by: { login: 'paperclipai[bot]' } },
    labels: [{ name: 'agent-pr' }, { name: 'automerge' }, { name: 'human-gate-required' }],
  }), { branchProtection: protectedMain });
  assert.equal(result.revoke, true);
  assert.ok(result.reasons.some(reason => reason.includes('human-gate-required')));
});

test('evaluateAutoMergeRevocation: revokes already-enabled automation PRs when opt-in labels are removed', () => {
  const result = evaluateAutoMergeRevocation(pr({
    auto_merge: { enabled_by: { login: 'paperclipai[bot]' } },
    labels: [{ name: 'agent-pr' }],
  }), { branchProtection: protectedMain });
  assert.equal(result.revoke, true);
  assert.ok(result.reasons.some(reason => reason.includes('Missing explicit auto-merge opt-in')));
});

test('evaluateAutoMergeRevocation: does not manage unrelated human auto-merge PRs', () => {
  const result = evaluateAutoMergeRevocation(pr({
    auto_merge: { enabled_by: { login: 'haykel1977' } },
    labels: [],
    user: { login: 'haykel1977' },
  }), { branchProtection: protectedMain });
  assert.equal(result.revoke, false);
  assert.deepEqual(result.reasons, []);
});

test('evaluateBranchProtection: accepts required checks declared via GitHub checks array', () => {
  const result = evaluateBranchProtection({
    required_status_checks: {
      strict: true,
      checks: DEFAULT_REQUIRED_CHECKS.map(context => ({ context })),
    },
  });
  assert.equal(result.protected, true);
  assert.deepEqual(result.failures, []);
});

// ── 403 vs 404: "cannot read" is not "does not exist" ────────────────────────
// Both statuses previously collapsed to `null`, so a token missing
// `administration: read` produced the message "no protection rule is
// configured" — sending an operator to reconfigure branch protection that was
// already correct. Both still fail closed, but they must say different things.

test('fetchBranchProtection: 404 means protection is genuinely absent → null', async () => {
  const result = await fetchBranchProtection(async () => {
    throw new Error('GitHub API GET /protection → 404: Not Found');
  }, 'paperclipai/paperclip', 'main', 'token');
  assert.equal(result, null);
  assert.equal(isBranchProtectionForbidden(result), false);
});

test('fetchBranchProtection: 403 means UNREADABLE → a distinct sentinel, not null', async () => {
  const result = await fetchBranchProtection(async () => {
    throw new Error('GitHub API GET /protection → 403: Resource not accessible by integration');
  }, 'paperclipai/paperclip', 'main', 'token');
  assert.notEqual(result, null, '403 must be distinguishable from 404');
  assert.equal(result, BRANCH_PROTECTION_FORBIDDEN);
  assert.equal(isBranchProtectionForbidden(result), true);
});

test('fetchBranchProtection: reads a numeric status property when the error carries one', async () => {
  for (const key of ['status', 'statusCode']) {
    const forbidden = await fetchBranchProtection(async () => {
      throw Object.assign(new Error('nope'), { [key]: 403 });
    }, 'paperclipai/paperclip', 'main', 'token');
    assert.equal(isBranchProtectionForbidden(forbidden), true, key);

    const missing = await fetchBranchProtection(async () => {
      throw Object.assign(new Error('nope'), { [key]: 404 });
    }, 'paperclipai/paperclip', 'main', 'token');
    assert.equal(missing, null, key);
  }
});

test('fetchBranchProtection: any other error propagates rather than being read as "unprotected"', async () => {
  // A 500 or a network fault must not be silently downgraded to "no protection
  // rule", which reads like a finding about the repository rather than a fault
  // in the read.
  await assert.rejects(
    fetchBranchProtection(async () => {
      throw new Error('GitHub API GET /protection → 500: Internal Server Error');
    }, 'paperclipai/paperclip', 'main', 'token'),
    /500/,
  );
});

test('branchProtectionErrorStatus: classifies message shapes without over-matching', () => {
  const cases = [
    ['GitHub API GET /protection → 403: Forbidden', 403],
    ['GitHub API GET /protection → 404: Not Found', 404],
    ['Resource not accessible by integration', 403],
    ['Not Found', 404],
    ['GitHub API GET /protection → 500: boom', null],
    ['connect ECONNREFUSED', null],
  ];
  for (const [message, expected] of cases) {
    assert.equal(branchProtectionErrorStatus(new Error(message)), expected, message);
  }
});

test('evaluateBranchProtection: the 403 sentinel fails closed with an actionable, distinct reason', () => {
  const result = evaluateBranchProtection(BRANCH_PROTECTION_FORBIDDEN);
  assert.equal(result.protected, false);
  assert.deepEqual(result.failures, [BRANCH_PROTECTION_FORBIDDEN_REASON]);
  // It must name the missing permission and say where to grant it — and say
  // that the workflow `permissions:` block CANNOT grant it, because
  // `administration` is not a GITHUB_TOKEN scope.
  assert.match(BRANCH_PROTECTION_FORBIDDEN_REASON, /administration: read/);
  assert.match(BRANCH_PROTECTION_FORBIDDEN_REASON, /GitHub App/);
  assert.match(BRANCH_PROTECTION_FORBIDDEN_REASON, /not a GITHUB_TOKEN scope/);
});

test('evaluateBranchProtection: a 404 reason is different from the 403 reason', () => {
  const absent = evaluateBranchProtection(null);
  assert.equal(absent.protected, false);
  assert.notDeepEqual(absent.failures, [BRANCH_PROTECTION_FORBIDDEN_REASON]);
  assert.ok(
    absent.failures.some(failure => failure.includes('No branch protection')
      || failure.includes('not configured')
      || failure.includes('Branch protection')),
    `404 must produce its own diagnostic: ${absent.failures.join(' ')}`,
  );
});

test('planAutomerge: an unreadable (403) branch protection is never treated as GREEN-mergeable', () => {
  const result = plan({ branchProtection: BRANCH_PROTECTION_FORBIDDEN });
  assert.notEqual(result.action, 'enable');
});

test('planAutomerge: an unreadable (403) branch protection REVOKES an already-armed auto-merge', () => {
  // Losing the ability to read protection is precisely when a stale armed
  // auto-merge is most dangerous, so it must revoke rather than merely skip.
  const result = plan({
    pr: { auto_merge: { enabled_by: { login: 'paperclipai[bot]' } } },
    branchProtection: BRANCH_PROTECTION_FORBIDDEN,
  });
  assert.equal(result.action, 'disable');
});

// ── Required-check reconciliation ────────────────────────────────────────────

test('the automerge gate binds to the live four required contexts', () => {
  assert.deepEqual([...DEFAULT_REQUIRED_CHECKS], [
    'verify',
    'Secret Scan',
    'paperclip-checker/app',
    'paperclip-checker-runner',
  ]);
});

test('evidence excludes the checker\'s own contexts (requiring them would deadlock the gate)', () => {
  // paperclip-checker publishes these two from this very evaluation. Treating
  // them as evidence *of* the evaluation is circular: the checker would wait for
  // a check it has not published yet.
  assert.deepEqual([...DEFAULT_EVIDENCE_CHECKS], ['verify', 'Secret Scan']);
  for (const checkerContext of ['paperclip-checker/app', 'paperclip-checker-runner']) {
    assert.ok(!DEFAULT_EVIDENCE_CHECKS.includes(checkerContext), checkerContext);
    assert.ok(DEFAULT_REQUIRED_CHECKS.includes(checkerContext), `${checkerContext} is still required`);
  }
});

test('advisory contexts are never required (verify already aggregates them)', () => {
  for (const advisory of ADVISORY_CHECKS) {
    assert.ok(!DEFAULT_REQUIRED_CHECKS.includes(advisory), advisory);
    assert.ok(!DEFAULT_EVIDENCE_CHECKS.includes(advisory), advisory);
  }
});

test('enablePullRequestAutoMerge: sends the native auto-merge GraphQL mutation', async () => {
  const calls = [];
  const result = await enablePullRequestAutoMerge(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ data: { enablePullRequestAutoMerge: { pullRequest: { number: 123 } } } });
      },
    };
  }, 'token', 'PR_kwDOExample', 'SQUASH');

  assert.deepEqual(result, { number: 123 });
  assert.equal(calls[0].url, 'https://api.github.com/graphql');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.variables.pullRequestId, 'PR_kwDOExample');
  assert.equal(body.variables.mergeMethod, 'SQUASH');
});

test('enablePullRequestAutoMerge: accepts classic padded GitHub GraphQL node IDs', async () => {
  const calls = [];
  await enablePullRequestAutoMerge(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ data: { enablePullRequestAutoMerge: { pullRequest: { number: 123 } } } });
      },
    };
  }, 'token', 'MDExOlB1bGxSZXF1ZXN0MQ==', 'SQUASH');

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.variables.pullRequestId, 'MDExOlB1bGxSZXF1ZXN0MQ==');
});

test('enablePullRequestAutoMerge: rejects unsafe pull request node IDs', async () => {
  await assert.rejects(
    enablePullRequestAutoMerge(async () => {
      throw new Error('fetch should not be called');
    }, 'token', 'PR_bad id', 'SQUASH'),
    /Invalid pull request node id/
  );
});

test('disablePullRequestAutoMerge: sends the native auto-merge revocation mutation', async () => {
  const calls = [];
  const result = await disablePullRequestAutoMerge(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ data: { disablePullRequestAutoMerge: { pullRequest: { number: 123 } } } });
      },
    };
  }, 'token', 'PR_kwDOExample');

  assert.deepEqual(result, { number: 123 });
  assert.equal(calls[0].url, 'https://api.github.com/graphql');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.variables.pullRequestId, 'PR_kwDOExample');
  assert.match(body.query, /disablePullRequestAutoMerge/);
});
