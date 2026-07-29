import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARVEOUT_ALLOWED_PATHS,
  CARVEOUT_JUDGE_APP_ID_ENV,
  CARVEOUT_JUDGE_APP_SLUG_ENV,
  CARVEOUT_MODE_ENV,
  FORBIDDEN_JUDGE_APP_IDS,
  GOVERNANCE_RED_LABEL,
  JUDGE_MODULE_BASENAMES,
  MAX_CARVEOUT_CHANGED_FILES,
  MAX_CARVEOUT_CHANGED_LINES,
  MODES,
  REQUIRED_BOOTSTRAP_SETTINGS,
  detectPermissionBroadening,
  evaluateGithubGovernanceCarveout,
  isAllowedCarveoutPath,
  isJudgeSurface,
  resolveJudge,
  resolveMode,
  summarizeCarveout,
} from '../github-governance-carveout.mjs';

// Adversarial tests for the `.github/**` governance carve-out. Every case here
// is an attempt to obtain the exemption without satisfying the property that
// makes it safe, so each assertion is a fail-closed assertion: the carve-out
// must WITHHOLD. The single "clears every condition" test exists only to prove
// the withholding is not vacuous — that the rules can in fact be satisfied, and
// that even then shadow mode does not grant.

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const AUTHOR = 'app/solidus-paperclip-delivery';

/** An external judge that is not the author, the runner, or the review App. */
const ENFORCE_ENV = Object.freeze({
  [CARVEOUT_MODE_ENV]: 'enforce',
  [CARVEOUT_JUDGE_APP_ID_ENV]: '4372695',
  [CARVEOUT_JUDGE_APP_SLUG_ENV]: 'solidus-paperclip-checker',
});

/** A minimal, in-bounds, non-judge `.github/**` change. */
function benignFile(overrides = {}) {
  return {
    filename: '.github/ISSUE_TEMPLATE/agent_task.yml',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: '@@ -1,2 +1,2 @@\n-  label: Old\n+  label: New\n+  description: why\n',
    ...overrides,
  };
}

function evaluate({ files = [benignFile()], env = ENFORCE_ENV, ...rest } = {}) {
  return evaluateGithubGovernanceCarveout({
    pr: { number: 1, head: { sha: SHA } },
    files,
    author: AUTHOR,
    headSha: SHA,
    expectedHeadSha: SHA,
    env,
    ...rest,
  });
}

/** Every withheld result must be inert: no exemption may leak out with it. */
function assertWithheld(result, reasonPattern) {
  assert.equal(result.eligible, false, 'the carve-out must not grant');
  assert.deepEqual(result.exemptRedPathLabels, [], 'a withheld carve-out must waive nothing');
  if (reasonPattern) {
    assert.match(result.reasons.join(' '), reasonPattern);
  }
}

test('baseline: a bounded, non-judge change clears every condition under enforce', () => {
  // Not a rubber stamp — this is the control. If this case did not pass, every
  // fail-closed assertion below would be trivially satisfied and would prove
  // nothing about the individual rules.
  const result = evaluate();
  assert.equal(result.applicable, true);
  assert.equal(result.mode, MODES.ENFORCE);
  assert.equal(result.eligible, true);
  assert.equal(result.wouldBeEligible, true);
  assert.deepEqual(result.exemptRedPathLabels, [GOVERNANCE_RED_LABEL]);
});

// ── Self-amendment ──────────────────────────────────────────────────────────

test('self-amendment: the carve-out cannot exempt a change to its own module', () => {
  const result = evaluate({
    files: [benignFile({ filename: '.github/scripts/github-governance-carveout.mjs' })],
  });
  assertWithheld(result, /Self-amendment/);
  assert.match(result.reasons.join(' '), /github-governance-carveout\.mjs/);
});

test('self-amendment: nor to its own tests (weakening the tests weakens the judge)', () => {
  const result = evaluate({
    files: [benignFile({ filename: '.github/scripts/tests/github-governance-carveout.test.mjs' })],
  });
  assertWithheld(result, /Self-amendment/);
});

test('self-amendment: every judge module basename is protected, including its test file', () => {
  for (const stem of JUDGE_MODULE_BASENAMES) {
    for (const path of [
      `.github/scripts/${stem}.mjs`,
      `.github/scripts/tests/${stem}.test.mjs`,
    ]) {
      assert.equal(isJudgeSurface(path), true, `${path} must be judge surface`);
      assertWithheld(evaluate({ files: [benignFile({ filename: path })] }), /Self-amendment/);
    }
  }
});

test('self-amendment: renaming a judge module away is still self-amendment', () => {
  // Only `previous_filename` names the judge; a rule that inspected `filename`
  // alone would let a PR neutralize the judge by moving it aside.
  const result = evaluate({
    files: [benignFile({
      filename: '.github/scripts/unrelated-helper.mjs',
      previous_filename: '.github/scripts/enable-agent-automerge.mjs',
      status: 'renamed',
    })],
  });
  assertWithheld(result, /Self-amendment/);
});

test('self-amendment: checker config, checker/review workflows and CODEOWNERS are judge surface', () => {
  for (const path of [
    '.github/paperclip-checker.config.json',
    '.github/workflows/paperclip-checker.yml',
    '.github/workflows/commitperclip-review.yml',
    '.github/CODEOWNERS',
  ]) {
    assert.equal(isJudgeSurface(path), true, path);
    assertWithheld(evaluate({ files: [benignFile({ filename: path })] }), /Self-amendment/);
  }
});

test('self-amendment: any credential-shaped file is judge surface regardless of basename', () => {
  for (const path of [
    '.github/scripts/mint-token.mjs',
    '.github/scripts/rotate-secret.sh',
    '.github/workflows/credential-refresh.yml',
  ]) {
    assert.equal(isJudgeSurface(path), true, path);
  }
});

// ── Judge identity ──────────────────────────────────────────────────────────

test('wrong App ID: a forbidden judge id can never act as the external judge', () => {
  for (const appId of FORBIDDEN_JUDGE_APP_IDS) {
    const result = evaluate({
      env: { ...ENFORCE_ENV, [CARVEOUT_JUDGE_APP_ID_ENV]: String(appId) },
    });
    assertWithheld(result, /not external to this decision/);
    assert.match(result.reasons.join(' '), new RegExp(String(appId)));
  }
});

test('wrong App ID: a non-numeric or empty judge id resolves to null, never a default', () => {
  for (const rawId of ['', '   ', 'abc', '4372695x', '-1', '0', '1e6']) {
    assert.equal(
      resolveJudge({ ...ENFORCE_ENV, [CARVEOUT_JUDGE_APP_ID_ENV]: rawId }),
      null,
      JSON.stringify(rawId),
    );
    assertWithheld(
      evaluate({ env: { ...ENFORCE_ENV, [CARVEOUT_JUDGE_APP_ID_ENV]: rawId } }),
      /No external judge identity is configured/,
    );
  }
});

test('wrong App ID: a missing slug fails closed even when the id is valid', () => {
  assert.equal(resolveJudge({ ...ENFORCE_ENV, [CARVEOUT_JUDGE_APP_SLUG_ENV]: '' }), null);
  assertWithheld(
    evaluate({ env: { ...ENFORCE_ENV, [CARVEOUT_JUDGE_APP_SLUG_ENV]: '' } }),
    /No external judge identity is configured/,
  );
});

test('wrong App ID: the judge may not clear a PR it authored itself', () => {
  const result = evaluate({
    author: 'solidus-paperclip-checker[bot]',
    env: { ...ENFORCE_ENV, [CARVEOUT_JUDGE_APP_SLUG_ENV]: 'solidus-paperclip-checker' },
  });
  assertWithheld(result, /IS the judge/);
});

test('unknown actor: a human or unrecognized bot never reaches the carve-out', () => {
  // The actor set is exact and finite (KNOWN_ACTORS), matching the witness
  // guard, so a lookalike login must not be admitted by prefix or substring.
  for (const author of [
    '',
    'attacker',
    'app/solidus-paperclip-delivery-evil',
    'solidus-paperclip-delivery',
    ' app/solidus-paperclip-delivery',
  ]) {
    assertWithheld(evaluate({ author }), /not a recognized autonomy identity/);
  }
});

// ── Head SHA ────────────────────────────────────────────────────────────────

test('wrong SHA: a head advance between the event and the API read fails closed', () => {
  const result = evaluate({ headSha: OTHER_SHA, expectedHeadSha: SHA });
  assertWithheld(result, /Head SHA mismatch/);
});

test('wrong SHA: a missing or malformed SHA on either source fails closed', () => {
  for (const [headSha, expectedHeadSha] of [
    ['', SHA],
    [SHA, ''],
    ['not-a-sha', SHA],
    [SHA, 'a'.repeat(39)],
    [SHA, `${SHA} `.repeat(2)],
  ]) {
    assertWithheld(evaluate({ headSha, expectedHeadSha }), /Head SHA is missing or malformed/);
  }
});

test('SHA comparison is case-insensitive but otherwise exact', () => {
  const result = evaluate({ headSha: SHA.toUpperCase(), expectedHeadSha: SHA });
  assert.equal(result.eligible, true, 'hex case must not be a spurious mismatch');
});

// ── Path bounds ─────────────────────────────────────────────────────────────

test('bounded paths: a change reaching outside .github/** fails closed', () => {
  const result = evaluate({
    files: [benignFile(), benignFile({ filename: 'src/server/auth.ts' })],
  });
  assertWithheld(result, /outside the bounded carve-out allowlist/);
});

test('bounded paths: nested or unrecognized shapes inside .github/** fail closed', () => {
  for (const path of [
    '.github/workflows/nested/deep.yml',
    '.github/scripts/lib/util.mjs',
    '.github/actions/custom/action.yml',
    '.github/settings.yml',
    '.github/workflows/evil.yml.bak',
  ]) {
    assert.equal(isAllowedCarveoutPath(path), false, path);
    assertWithheld(evaluate({ files: [benignFile({ filename: path })] }));
  }
});

test('bounded paths: traversal-style and backslash spellings do not evade the allowlist', () => {
  for (const path of ['.github/../src/evil.ts', '.github\\workflows\\..\\..\\evil.ts']) {
    assert.equal(isAllowedCarveoutPath(path), false, path);
  }
});

test('bounded paths: the allowlist stays narrow (no catch-all regex)', () => {
  for (const re of CARVEOUT_ALLOWED_PATHS) {
    assert.equal(re.test('src/index.ts'), false, `${re} must not match non-.github paths`);
    assert.equal(re.test('.github/workflows/a/b.yml'), false, `${re} must not match nested paths`);
  }
});

// ── Size bounds ─────────────────────────────────────────────────────────────

test('oversized diff: too many files fails closed', () => {
  const files = Array.from({ length: MAX_CARVEOUT_CHANGED_FILES + 1 }, (_, i) =>
    benignFile({ filename: `.github/ISSUE_TEMPLATE/t${i}.yml`, additions: 1, deletions: 0 }));
  assertWithheld(evaluate({ files }), /exceeds the carve-out bound/);
});

test('oversized diff: too many changed lines fails closed even in one file', () => {
  const result = evaluate({
    files: [benignFile({ additions: MAX_CARVEOUT_CHANGED_LINES, deletions: 1 })],
  });
  assertWithheld(result, /exceeds the carve-out bound/);
});

test('oversized diff: exactly at the bound is still allowed (the bound is not off-by-one)', () => {
  const perFile = Math.floor(MAX_CARVEOUT_CHANGED_LINES / MAX_CARVEOUT_CHANGED_FILES);
  const files = Array.from({ length: MAX_CARVEOUT_CHANGED_FILES }, (_, i) =>
    benignFile({ filename: `.github/ISSUE_TEMPLATE/t${i}.yml`, additions: perFile, deletions: 0 }));
  assert.equal(evaluate({ files }).eligible, true);
});

test('oversized diff: `changes` is honoured when additions/deletions are absent', () => {
  const result = evaluate({
    files: [benignFile({ additions: undefined, deletions: undefined, changes: MAX_CARVEOUT_CHANGED_LINES + 1 })],
  });
  assertWithheld(result, /exceeds the carve-out bound/);
});

// ── Permission broadening ───────────────────────────────────────────────────

test('permission broadening: an added write scope fails closed', () => {
  const result = evaluate({
    files: [benignFile({
      filename: '.github/workflows/pr.yml',
      patch: '@@\n permissions:\n-  contents: read\n+  contents: write\n',
    })],
  });
  assertWithheld(result, /added write scope: contents: write/);
});

test('permission broadening: `permissions: write-all` fails closed', () => {
  const result = evaluate({
    files: [benignFile({
      filename: '.github/workflows/pr.yml',
      patch: '@@\n+permissions: write-all\n',
    })],
  });
  assertWithheld(result, /write-all/);
});

test('permission broadening: DELETING the permissions block is broadening by omission', () => {
  // Removing `permissions:` reverts the job to the repository default, which may
  // be read/write on every scope. A scan that only looked at added lines would
  // read this maximally-privileged change as clean.
  const result = evaluate({
    files: [benignFile({
      filename: '.github/workflows/pr.yml',
      patch: '@@\n-permissions:\n-  contents: read\n',
    })],
  });
  assertWithheld(result, /permissions block removed/);
});

test('permission broadening: rewriting the permissions block in place is not flagged', () => {
  const findings = detectPermissionBroadening([{
    filename: '.github/workflows/pr.yml',
    patch: '@@\n-permissions:\n-  contents: write\n+permissions:\n+  contents: read\n',
  }]);
  assert.deepEqual(findings, [], 'a narrowing rewrite must not be a false positive');
});

test('permission broadening: an unavailable patch is a finding, not a pass', () => {
  // GitHub omits `patch` for very large or binary diffs. "We could not look"
  // must never be recorded as "we looked and it was clean".
  const result = evaluate({ files: [benignFile({ patch: undefined })] });
  assertWithheld(result, /diff unavailable \(cannot verify permissions\)/);
});

test('permission broadening: deleting a workflow is reported as such', () => {
  const findings = detectPermissionBroadening([
    { filename: '.github/workflows/secret-scan.yml', status: 'removed', patch: '' },
  ]);
  assert.deepEqual(findings, [{ file: '.github/workflows/secret-scan.yml', label: 'workflow deleted' }]);
});

test('escalation lines: privileged triggers, runners and mutations all fail closed', () => {
  const cases = [
    ['+on:\n+  pull_request_target:\n', /pull_request_target trigger/],
    ['+    runs-on: self-hosted\n', /self-hosted runner/],
    ['+  gh api repos/o/r/branches/main/protection\n', /branch-protection mutation/],
    ['+  gh api -X PATCH --method PUT /repos/o/r\n', /repository settings mutation/],
    ['+  gh pr merge 1 --squash\n', /direct merge/],
    ['+  gh pr merge --admin\n', /admin merge bypass/],
    ['+  git push origin main --force\n', /force push/],
    ['+  TOKEN: ${{ secrets.SOME_NEW_KEY }}\n', /new secret reference/],
    ['+      uses: actions/checkout@v6\n', /unpinned action reference/],
  ];
  for (const [patch, pattern] of cases) {
    const result = evaluate({
      files: [benignFile({ filename: '.github/workflows/pr.yml', patch: `@@\n${patch}` })],
    });
    assertWithheld(result, pattern);
  }
});

test('escalation lines: a SHA-pinned action reference is not flagged as unpinned', () => {
  const findings = detectPermissionBroadening([{
    filename: '.github/workflows/pr.yml',
    patch: `@@\n+      uses: actions/checkout@${'d'.repeat(40)} # v6.0.3\n`,
  }]);
  assert.deepEqual(findings, []);
});

// ── Mode / applicability ────────────────────────────────────────────────────

test('shadow mode is the default and NEVER grants, however clean the diff', () => {
  const result = evaluateGithubGovernanceCarveout({
    pr: { number: 1, head: { sha: SHA } },
    files: [benignFile()],
    author: AUTHOR,
    headSha: SHA,
    expectedHeadSha: SHA,
    env: {},
  });
  assert.equal(result.mode, MODES.SHADOW);
  assert.equal(result.shadow, true);
  assertWithheld(result);
  // Shadow mode still reports what enforce WOULD have decided, so the rules can
  // be observed against real PRs before anyone arms them. Here the judge
  // variables are unset, so even the would-be answer is "no".
  assert.equal(result.wouldBeEligible, false);
});

test('shadow mode with a fully valid configuration still withholds, and says why', () => {
  const result = evaluate({ env: { ...ENFORCE_ENV, [CARVEOUT_MODE_ENV]: 'shadow' } });
  assert.equal(result.wouldBeEligible, true, 'the rules were satisfied…');
  assertWithheld(result, /Shadow mode/); // …and the exemption was withheld anyway.
});

test('mode resolution accepts only the exact string "enforce"', () => {
  for (const raw of ['', 'Enforce', ' enforce ', 'ENFORCE']) {
    // Case and surrounding whitespace are normalized; anything else is shadow.
    const expected = raw.trim().toLowerCase() === 'enforce' ? MODES.ENFORCE : MODES.SHADOW;
    assert.equal(resolveMode({ [CARVEOUT_MODE_ENV]: raw }), expected, JSON.stringify(raw));
  }
  for (const raw of ['true', '1', 'yes', 'on', 'enforced', 'enforce-all']) {
    assert.equal(resolveMode({ [CARVEOUT_MODE_ENV]: raw }), MODES.SHADOW, JSON.stringify(raw));
  }
});

test('not applicable when no .github/** path is touched', () => {
  const result = evaluate({ files: [{ filename: 'src/index.ts', additions: 1, deletions: 0, patch: '@@\n+x\n' }] });
  assert.equal(result.applicable, false);
  assertWithheld(result, /does not apply/);
});

test('malformed input fails closed rather than throwing', () => {
  for (const files of [null, undefined, 'not-an-array', 42]) {
    const result = evaluateGithubGovernanceCarveout({ files, env: ENFORCE_ENV });
    assert.equal(result.eligible, false, String(files));
    assert.deepEqual(result.exemptRedPathLabels, []);
  }
});

test('multiple independent violations are all reported, not just the first', () => {
  const result = evaluate({
    files: [benignFile({ filename: '.github/scripts/paperclip-checker.mjs' })],
    headSha: OTHER_SHA,
    author: 'attacker',
    env: { ...ENFORCE_ENV, [CARVEOUT_JUDGE_APP_ID_ENV]: '15368' },
  });
  const joined = result.reasons.join(' ');
  assert.match(joined, /not external to this decision/);
  assert.match(joined, /Head SHA mismatch/);
  assert.match(joined, /not a recognized autonomy identity/);
  assert.match(joined, /Self-amendment/);
});

// ── Bootstrap reporting ─────────────────────────────────────────────────────

test('every result names the bootstrap settings an operator must create', () => {
  const names = REQUIRED_BOOTSTRAP_SETTINGS.map(s => s.name);
  assert.deepEqual(names, [
    CARVEOUT_JUDGE_APP_ID_ENV,
    CARVEOUT_JUDGE_APP_SLUG_ENV,
    CARVEOUT_MODE_ENV,
  ]);
  for (const setting of REQUIRED_BOOTSTRAP_SETTINGS) {
    // Repository *variables*, not secrets: a pull request cannot change them,
    // which is exactly the immutability the judge identity depends on.
    assert.equal(setting.kind, 'repository variable');
    assert.ok(setting.why.length > 0, `${setting.name} must explain itself`);
  }
  assert.deepEqual(evaluate().requiredSettings, REQUIRED_BOOTSTRAP_SETTINGS);
  assert.deepEqual(evaluate({ author: 'attacker' }).requiredSettings, REQUIRED_BOOTSTRAP_SETTINGS);
});

test('summarizeCarveout renders each verdict distinguishably', () => {
  assert.match(summarizeCarveout(null), /not evaluated/);
  assert.match(summarizeCarveout(evaluate({ files: [{ filename: 'src/a.ts' }] })), /not applicable/);
  assert.match(summarizeCarveout(evaluate()), /GRANTED/);
  assert.match(summarizeCarveout(evaluate({ author: 'attacker' })), /withheld \(ineligible\)/);
  assert.match(
    summarizeCarveout(evaluate({ env: { ...ENFORCE_ENV, [CARVEOUT_MODE_ENV]: 'shadow' } })),
    /withheld \(shadow; would-be eligible\)/,
  );
});
