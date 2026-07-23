import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readCheckerConfig,
  loadCheckerPolicy,
  summarizeRequiredChecks,
  evaluateChecker,
  findApprovedAppReview,
  resolvePrNumberForSha,
  fetchAllPagesFromKey,
  executeDecision,
  sanitizeError,
  DEFAULT_APP_SLUG,
  DEFAULT_REQUIRED_CHECK_POLICY,
} from '../paperclip-checker.mjs';
import {
  generateAppJwt,
  mintInstallationToken,
  resolveCheckerInstallationId,
  LEAST_PRIVILEGE_PERMISSIONS,
} from '../paperclip-app-token.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const APP = DEFAULT_APP_SLUG; // 'paperclip-checker[bot]'
const GH_ACTIONS = { slug: 'github-actions', id: 15368 };
const POLICY = DEFAULT_REQUIRED_CHECK_POLICY;

const activeConfig = () => ({ active: true, reasons: [], appId: '999', privateKey: 'x' });

// Check-runs from the EXPECTED producer (github-actions, id 15368).
const greenChecks = () => [
  { name: 'verify', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
  { name: 'gitleaks', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
];

function greenPr(overrides = {}) {
  return {
    title: 'fix(server): correct cursor anchor timestamp binding',
    draft: false,
    user: { login: 'paperclipai[bot]' },
    labels: [],
    base: { ref: 'main', repo: { full_name: 'paperclipai/paperclip' } },
    head: { sha: HEAD, repo: { full_name: 'paperclipai/paperclip' } },
    ...overrides,
  };
}

function evalGreen(overrides = {}) {
  return evaluateChecker({
    config: overrides.config ?? activeConfig(),
    pr: overrides.pr ?? greenPr(),
    eventAction: overrides.eventAction ?? 'opened',
    eventHeadSha: 'eventHeadSha' in overrides ? overrides.eventHeadSha : HEAD,
    files: overrides.files ?? [{ filename: 'server/src/services/cursor.ts', additions: 5, deletions: 0, changes: 5 }],
    checkRuns: overrides.checkRuns ?? greenChecks(),
    statuses: overrides.statuses ?? [],
    requiredChecks: overrides.requiredChecks ?? POLICY,
    appSlug: overrides.appSlug ?? APP,
    headCommitAuthorLogin: overrides.headCommitAuthorLogin ?? 'paperclipai[bot]',
    lastPusherLogin: overrides.lastPusherLogin ?? 'paperclipai[bot]',
    existingAppReview: overrides.existingAppReview ?? null,
  });
}

// ── readCheckerConfig: activation / secrets ─────────────────────────────────

test('readCheckerConfig: fully configured → active', () => {
  const c = readCheckerConfig({
    PAPERCLIP_CHECKER_ENABLED: 'true',
    PAPERCLIP_CHECKER_APP_ID: '12345',
    PAPERCLIP_CHECKER_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  });
  assert.equal(c.active, true);
  assert.deepEqual(c.reasons, []);
});

test('readCheckerConfig: variable unset → inactive (disabled)', () => {
  const c = readCheckerConfig({
    PAPERCLIP_CHECKER_APP_ID: '12345',
    PAPERCLIP_CHECKER_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  });
  assert.equal(c.active, false);
  assert.match(c.reasons.join(' '), /PAPERCLIP_CHECKER_ENABLED must equal "true"/);
});

test('readCheckerConfig: variable set but secrets missing → inactive', () => {
  const c = readCheckerConfig({ PAPERCLIP_CHECKER_ENABLED: 'true' });
  assert.equal(c.active, false);
  assert.match(c.reasons.join(' '), /App ID/);
  assert.match(c.reasons.join(' '), /private-key/);
});

test('readCheckerConfig: non-numeric app id and non-PEM key → inactive', () => {
  const c = readCheckerConfig({
    PAPERCLIP_CHECKER_ENABLED: 'true',
    PAPERCLIP_CHECKER_APP_ID: 'not-a-number',
    PAPERCLIP_CHECKER_PRIVATE_KEY: 'nope',
  });
  assert.equal(c.active, false);
});

// ── loadCheckerPolicy: producer binding source of truth ─────────────────────

test('loadCheckerPolicy: env JSON policy wins and is producer-bound', () => {
  const env = {
    REQUIRED_CHECKS_POLICY: JSON.stringify({
      appSlug: 'custom[bot]',
      requiredChecks: [{ name: 'verify', type: 'check_run', appSlug: 'github-actions', appId: 15368 }],
    }),
  };
  const p = loadCheckerPolicy(env, () => { throw new Error('should not read file'); });
  assert.equal(p.appSlug, 'custom[bot]');
  assert.equal(p.requiredChecks.length, 1);
  assert.equal(p.requiredChecks[0].appId, 15368);
  assert.equal(p.requiredChecks[0].type, 'check_run');
});

test('loadCheckerPolicy: reads committed config file when no env policy', () => {
  const fake = JSON.stringify({
    appSlug: 'paperclip-checker[bot]',
    requiredChecks: [{ name: 'gitleaks', type: 'check_run', appSlug: 'github-actions', appId: 15368 }],
  });
  const p = loadCheckerPolicy({ CHECKER_CONFIG_PATH: '/whatever.json' }, () => fake);
  assert.equal(p.requiredChecks[0].name, 'gitleaks');
  assert.equal(p.requiredChecks[0].appId, 15368);
});

test('loadCheckerPolicy: falls back to built-in default when file unreadable', () => {
  const p = loadCheckerPolicy({}, () => { throw new Error('ENOENT'); });
  assert.equal(p.appSlug, DEFAULT_APP_SLUG);
  assert.deepEqual(p.requiredChecks.map(c => c.name), ['verify', 'gitleaks']);
});

// ── summarizeRequiredChecks: only success from the EXPECTED producer passes ──

test('summarizeRequiredChecks: all success from expected producer → passing', () => {
  const r = summarizeRequiredChecks(greenChecks(), [], POLICY);
  assert.equal(r.state, 'passing');
  assert.deepEqual(r.failures, []);
});

for (const conclusion of ['neutral', 'skipped', 'failure', 'cancelled', 'timed_out', 'action_required']) {
  test(`summarizeRequiredChecks: ${conclusion} is not a pass (failed)`, () => {
    const r = summarizeRequiredChecks(
      [
        { name: 'verify', status: 'completed', conclusion, app: { ...GH_ACTIONS } },
        { name: 'gitleaks', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
      ],
      [],
      POLICY,
    );
    assert.equal(r.state, 'failed');
    assert.match(r.failures.join(' '), new RegExp(conclusion));
  });
}

test('summarizeRequiredChecks: missing required check → pending (not failed)', () => {
  const r = summarizeRequiredChecks(
    [{ name: 'verify', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } }],
    [],
    POLICY,
  );
  assert.equal(r.state, 'pending');
  assert.deepEqual(r.pendingNames, ['gitleaks']);
});

test('summarizeRequiredChecks: in-progress check → pending', () => {
  const r = summarizeRequiredChecks(
    [
      { name: 'verify', status: 'in_progress', conclusion: null, app: { ...GH_ACTIONS } },
      { name: 'gitleaks', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
    ],
    [], POLICY,
  );
  assert.equal(r.state, 'pending');
  assert.deepEqual(r.pendingNames, ['verify']);
});

test('summarizeRequiredChecks: newest run wins over stale success', () => {
  const r = summarizeRequiredChecks(
    [
      { name: 'verify', status: 'completed', conclusion: 'success', completed_at: '2024-01-01T00:00:00Z', app: { ...GH_ACTIONS } },
      { name: 'verify', status: 'completed', conclusion: 'failure', completed_at: '2024-02-01T00:00:00Z', app: { ...GH_ACTIONS } },
      { name: 'gitleaks', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
    ],
    [], POLICY,
  );
  assert.equal(r.state, 'failed');
});

// ── summarizeRequiredChecks: producer binding (spoof defense) ───────────────

test('summarizeRequiredChecks: same-name check-run from WRONG app → failed (spoof blocked)', () => {
  const r = summarizeRequiredChecks(
    [
      { name: 'verify', status: 'completed', conclusion: 'success', app: { slug: 'evil-app', id: 99999 } },
      { name: 'gitleaks', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
    ],
    [], POLICY,
  );
  assert.equal(r.state, 'failed');
  assert.match(r.failures.join(' '), /unexpected app/i);
});

test('summarizeRequiredChecks: no producer app info → not matched (spoof blocked)', () => {
  const r = summarizeRequiredChecks(
    [
      { name: 'verify', status: 'completed', conclusion: 'success' },
      { name: 'gitleaks', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
    ],
    [], POLICY,
  );
  assert.equal(r.state, 'failed');
  assert.match(r.failures.join(' '), /unexpected app/i);
});

test('summarizeRequiredChecks: commit status for a check_run-typed requirement does NOT satisfy it', () => {
  // No silent check-run↔status fallback: the policy expects a check_run, so a
  // same-named commit status is ignored and the requirement stays pending.
  const r = summarizeRequiredChecks(
    [],
    [{ context: 'verify', state: 'success' }, { context: 'gitleaks', state: 'success' }],
    POLICY,
  );
  assert.equal(r.state, 'pending');
});

test('summarizeRequiredChecks: status-typed requirement is satisfied only by expected creator', () => {
  const statusPolicy = [{ name: 'legacy-ci', type: 'status', appSlug: 'github-actions' }];
  const ok = summarizeRequiredChecks([], [{ context: 'legacy-ci', state: 'success', creator: { login: 'github-actions[bot]' } }], statusPolicy);
  assert.equal(ok.state, 'passing');
  const spoof = summarizeRequiredChecks([], [{ context: 'legacy-ci', state: 'success', creator: { login: 'evil' } }], statusPolicy);
  assert.equal(spoof.state, 'failed');
});

test('summarizeRequiredChecks: status-typed requirement with NO appSlug → fail closed (producer unprovable)', () => {
  // Parity with check_run/appMatches: a status whose expected producer is not
  // pinned must never be accepted regardless of creator.
  const statusPolicy = [{ name: 'legacy-ci', type: 'status' }];
  const r = summarizeRequiredChecks([], [{ context: 'legacy-ci', state: 'success', creator: { login: 'anyone' } }], statusPolicy);
  assert.equal(r.state, 'failed');
  assert.match(r.failures.join(' '), /no expected producer/i);
});

// ── evaluateChecker: activation gate (blocked, never a pass) ────────────────

test('evaluateChecker: inactive config → blocked (not rejected/approved)', () => {
  const r = evaluateChecker({ config: { active: false, reasons: ['disabled'] }, pr: greenPr() });
  assert.equal(r.decision, 'blocked');
});

// ── evaluateChecker: GREEN approval happy path ──────────────────────────────

test('evaluateChecker: GREEN + fresh SHA + green checks → approved', () => {
  const r = evalGreen();
  assert.equal(r.decision, 'approved', r.reasons.join('; '));
  assert.equal(r.riskLane, 'GREEN');
});

// ── evaluateChecker: identity separation of duties ──────────────────────────

test('evaluateChecker: App is PR author → rejected (self-approval)', () => {
  const r = evalGreen({ pr: greenPr({ user: { login: APP } }) });
  assert.equal(r.decision, 'rejected');
  assert.match(r.reasons.join(' '), /PR author/);
});

test('evaluateChecker: App is last pusher → rejected', () => {
  const r = evalGreen({ lastPusherLogin: APP });
  assert.equal(r.decision, 'rejected');
  assert.match(r.reasons.join(' '), /last pusher/);
});

test('evaluateChecker: App is head-commit author → rejected (own commit)', () => {
  const r = evalGreen({ headCommitAuthorLogin: APP });
  assert.equal(r.decision, 'rejected');
  assert.match(r.reasons.join(' '), /head-commit author/);
});

// ── real bound identity: solidus-paperclip-checker[bot] never self-approves ─
// These pin the LITERAL production identity (App `solidus-paperclip-checker`,
// App ID 4372695 → bot login `solidus-paperclip-checker[bot]`) so a future slug
// change cannot silently re-open a self-approval path.

const REAL_APP = 'solidus-paperclip-checker[bot]';

test('bound identity: DEFAULT_APP_SLUG is the real solidus-paperclip-checker[bot]', () => {
  assert.equal(DEFAULT_APP_SLUG, REAL_APP);
});

test('bound identity: committed config binds appSlug to solidus-paperclip-checker[bot]', () => {
  // Uses the real base-branch config file (default path), no env override.
  const p = loadCheckerPolicy({});
  assert.equal(p.appSlug, REAL_APP);
});

for (const login of [REAL_APP, 'solidus-paperclip-checker', 'Solidus-Paperclip-Checker[BOT]']) {
  test(`bound identity: real App as PR author (${login}) → never approved`, () => {
    const r = evalGreen({ appSlug: REAL_APP, pr: greenPr({ user: { login } }) });
    assert.notEqual(r.decision, 'approved');
    assert.equal(r.decision, 'rejected');
    assert.match(r.reasons.join(' '), /PR author/);
  });

  test(`bound identity: real App as last pusher (${login}) → never approved`, () => {
    const r = evalGreen({ appSlug: REAL_APP, lastPusherLogin: login });
    assert.notEqual(r.decision, 'approved');
    assert.equal(r.decision, 'rejected');
    assert.match(r.reasons.join(' '), /last pusher/);
  });

  test(`bound identity: real App as head-commit author (${login}) → never approved`, () => {
    const r = evalGreen({ appSlug: REAL_APP, headCommitAuthorLogin: login });
    assert.notEqual(r.decision, 'approved');
    assert.equal(r.decision, 'rejected');
    assert.match(r.reasons.join(' '), /head-commit author/);
  });
}

test('bound identity: real App author+pusher+committer simultaneously → rejected (all reasons)', () => {
  const r = evalGreen({
    appSlug: REAL_APP,
    pr: greenPr({ user: { login: REAL_APP } }),
    lastPusherLogin: REAL_APP,
    headCommitAuthorLogin: REAL_APP,
  });
  assert.equal(r.decision, 'rejected');
  const joined = r.reasons.join(' ');
  assert.match(joined, /PR author/);
  assert.match(joined, /last pusher/);
  assert.match(joined, /head-commit author/);
});

test('bound identity (mocked e2e): PR authored+committed by real App is rejected', async () => {
  const result = await drive({
    pr: greenPr({ user: { login: REAL_APP } }),
    files: [{ filename: 'server/src/services/cursor.ts', additions: 4, deletions: 1, changes: 5 }],
    checkRuns: greenChecks(),
    statuses: [],
    reviews: [],
    headCommit: { author: { login: REAL_APP }, committer: { login: REAL_APP } },
  });
  assert.equal(result.decision, 'rejected');
  assert.match(result.reasons.join(' '), /PR author|last pusher|head-commit author/);
});

// ── evaluateChecker: stale / mismatched head SHA ────────────────────────────

test('evaluateChecker: stale head SHA (new push after evidence) → rejected', () => {
  const r = evalGreen({ eventHeadSha: OTHER });
  assert.equal(r.decision, 'rejected');
  assert.match(r.reasons.join(' '), /Stale head SHA/);
});

test('evaluateChecker: malformed head SHA → rejected', () => {
  const r = evalGreen({ eventHeadSha: 'short', pr: greenPr({ head: { sha: 'short', repo: { full_name: 'paperclipai/paperclip' } } }) });
  assert.equal(r.decision, 'rejected');
});

// ── evaluateChecker: check conclusions gate approval ────────────────────────

test('evaluateChecker: neutral required check → rejected', () => {
  const r = evalGreen({ checkRuns: [
    { name: 'verify', status: 'completed', conclusion: 'neutral', app: { ...GH_ACTIONS } },
    { name: 'gitleaks', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
  ] });
  assert.equal(r.decision, 'rejected');
});

test('evaluateChecker: missing required check → pending (not approved, not rejected)', () => {
  const r = evalGreen({ checkRuns: [{ name: 'verify', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } }] });
  assert.equal(r.decision, 'pending');
  assert.match(r.reasons.join(' '), /gitleaks/);
});

test('evaluateChecker: spoofed same-name wrong-app check → rejected (blocked, never pending)', () => {
  const r = evalGreen({ checkRuns: [
    { name: 'verify', status: 'completed', conclusion: 'success', app: { slug: 'evil-app', id: 99999 } },
    { name: 'gitleaks', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
  ] });
  assert.equal(r.decision, 'rejected');
  assert.match(r.reasons.join(' '), /unexpected app/i);
});

// ── evaluateChecker: pending → approval after last check turns green ─────────

test('evaluateChecker: pending initially, then approved once last check completes green', () => {
  // First evaluation: gitleaks still in-progress → pending (no approval).
  const first = evalGreen({ checkRuns: [
    { name: 'verify', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
    { name: 'gitleaks', status: 'in_progress', conclusion: null, app: { ...GH_ACTIONS } },
  ] });
  assert.equal(first.decision, 'pending');

  // Re-evaluation after the CI workflow_run completes: both green → approved.
  const second = evalGreen({ eventAction: 'workflow_run', checkRuns: greenChecks() });
  assert.equal(second.decision, 'approved', second.reasons.join('; '));
});

// ── evaluateChecker: lane gates (RED/ORANGE/labels/draft/fork) ──────────────

test('evaluateChecker: RED path surface → rejected', () => {
  const r = evalGreen({ files: [{ filename: '.github/workflows/x.yml', additions: 3, deletions: 0, changes: 3 }] });
  assert.equal(r.decision, 'rejected');
  assert.notEqual(r.riskLane, 'GREEN');
});

test('evaluateChecker: hard-block label → rejected', () => {
  const r = evalGreen({ pr: greenPr({ labels: [{ name: 'do-not-merge' }] }) });
  assert.equal(r.decision, 'rejected');
});

test('evaluateChecker: contradictory risk labels → rejected', () => {
  const r = evalGreen({ pr: greenPr({ labels: [{ name: 'risk:green' }, { name: 'risk:red' }] }) });
  assert.equal(r.decision, 'rejected');
});

test('evaluateChecker: draft PR → rejected', () => {
  const r = evalGreen({ pr: greenPr({ draft: true }) });
  assert.equal(r.decision, 'rejected');
  assert.match(r.reasons.join(' '), /Draft/);
});

test('evaluateChecker: fork PR → rejected', () => {
  const r = evalGreen({ pr: greenPr({ head: { sha: HEAD, repo: { full_name: 'attacker/paperclip' } } }) });
  assert.equal(r.decision, 'rejected');
  assert.match(r.reasons.join(' '), /Fork/);
});

test('evaluateChecker: unknown human actor → rejected (classifier RED)', () => {
  const r = evalGreen({ pr: greenPr({ user: { login: 'random-human' } }), headCommitAuthorLogin: 'random-human', lastPusherLogin: 'random-human' });
  assert.equal(r.decision, 'rejected');
});

// ── evaluateChecker: stale-approval dismissal signal ────────────────────────

test('evaluateChecker: synchronize with prior approval → dismissStale true', () => {
  const r = evalGreen({ eventAction: 'synchronize', existingAppReview: { id: 7, commit_id: HEAD, state: 'APPROVED' } });
  assert.equal(r.dismissStale, true);
});

test('evaluateChecker: prior approval on older SHA → dismissStale true', () => {
  const r = evalGreen({ eventAction: 'opened', existingAppReview: { id: 7, commit_id: OTHER, state: 'APPROVED' } });
  assert.equal(r.dismissStale, true);
});

test('evaluateChecker: labeled event with prior approval → dismissStale true', () => {
  const r = evalGreen({ eventAction: 'labeled', existingAppReview: { id: 9, commit_id: HEAD, state: 'APPROVED' } });
  assert.equal(r.dismissStale, true);
});

test('evaluateChecker: no prior approval → dismissStale false', () => {
  const r = evalGreen({ eventAction: 'synchronize', existingAppReview: null });
  assert.equal(r.dismissStale, false);
});

test('evaluateChecker: edited event with prior approval → dismissStale true', () => {
  const r = evalGreen({ eventAction: 'edited', existingAppReview: { id: 11, commit_id: HEAD, state: 'APPROVED' } });
  assert.equal(r.dismissStale, true);
});

test('evaluateChecker: workflow_run re-run now failing at same SHA → rejected AND dismissStale true', () => {
  // A completed workflow_run re-trigger at the SAME head SHA where a required
  // check now fails must dismiss the prior approval, not leave it standing.
  const r = evalGreen({
    eventAction: 'workflow_run',
    existingAppReview: { id: 13, commit_id: HEAD, state: 'APPROVED' },
    checkRuns: [
      { name: 'verify', status: 'completed', conclusion: 'failure', app: { ...GH_ACTIONS } },
      { name: 'gitleaks', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
    ],
  });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.dismissStale, true);
});

test('evaluateChecker: workflow_run still-passing at same SHA with prior approval → approved, dismissStale false', () => {
  const r = evalGreen({
    eventAction: 'workflow_run',
    existingAppReview: { id: 14, commit_id: HEAD, state: 'APPROVED' },
  });
  assert.equal(r.decision, 'approved');
  assert.equal(r.dismissStale, false);
});

// ── review discovery helpers ────────────────────────────────────────────────

test('findApprovedAppReview: picks latest approved App review by id', () => {
  const reviews = [
    { id: 1, state: 'COMMENTED', user: { login: APP } },
    { id: 5, state: 'APPROVED', user: { login: APP } },
    { id: 3, state: 'APPROVED', user: { login: 'someone-else' } },
  ];
  assert.equal(findApprovedAppReview(reviews, APP).id, 5);
});

test('findApprovedAppReview: ignores non-approved App reviews', () => {
  const reviews = [{ id: 2, state: 'CHANGES_REQUESTED', user: { login: APP } }];
  assert.equal(findApprovedAppReview(reviews, APP), null);
});

// ── resolvePrNumberForSha: workflow_run PR resolution by head SHA ────────────

test('resolvePrNumberForSha: returns open same-repo PR whose head matches sha', async () => {
  const gh = async (path) => {
    assert.equal(path, `/repos/paperclipai/paperclip/commits/${HEAD}/pulls`);
    return [{ number: 42, state: 'open', head: { sha: HEAD, repo: { full_name: 'paperclipai/paperclip' } }, base: { repo: { full_name: 'paperclipai/paperclip' } } }];
  };
  const n = await resolvePrNumberForSha(gh, 'tok', 'paperclipai/paperclip', HEAD);
  assert.equal(n, 42);
});

test('resolvePrNumberForSha: ignores fork PRs and closed PRs and SHA mismatches', async () => {
  const gh = async () => [
    { number: 1, state: 'closed', head: { sha: HEAD, repo: { full_name: 'paperclipai/paperclip' } }, base: { repo: { full_name: 'paperclipai/paperclip' } } },
    { number: 2, state: 'open', head: { sha: HEAD, repo: { full_name: 'attacker/paperclip' } }, base: { repo: { full_name: 'paperclipai/paperclip' } } },
    { number: 3, state: 'open', head: { sha: OTHER, repo: { full_name: 'paperclipai/paperclip' } }, base: { repo: { full_name: 'paperclipai/paperclip' } } },
  ];
  const n = await resolvePrNumberForSha(gh, 'tok', 'paperclipai/paperclip', HEAD);
  assert.equal(n, null);
});

test('resolvePrNumberForSha: malformed sha → null (no network)', async () => {
  const n = await resolvePrNumberForSha(() => { throw new Error('should not call'); }, 'tok', 'paperclipai/paperclip', 'nope');
  assert.equal(n, null);
});

test('resolvePrNumberForSha: ambiguous — multiple open same-repo PRs share the head SHA → null (fail closed)', async () => {
  const gh = async () => [
    { number: 42, state: 'open', head: { sha: HEAD, repo: { full_name: 'paperclipai/paperclip' } }, base: { repo: { full_name: 'paperclipai/paperclip' } } },
    { number: 43, state: 'open', head: { sha: HEAD, repo: { full_name: 'paperclipai/paperclip' } }, base: { repo: { full_name: 'paperclipai/paperclip' } } },
  ];
  const n = await resolvePrNumberForSha(gh, 'tok', 'paperclipai/paperclip', HEAD);
  assert.equal(n, null);
});

test('resolvePrNumberForSha: same PR listed twice still resolves (unique candidate)', async () => {
  const pr = { number: 42, state: 'open', head: { sha: HEAD, repo: { full_name: 'paperclipai/paperclip' } }, base: { repo: { full_name: 'paperclipai/paperclip' } } };
  const gh = async () => [pr, pr];
  const n = await resolvePrNumberForSha(gh, 'tok', 'paperclipai/paperclip', HEAD);
  assert.equal(n, 42);
});

// ── sanitizeError: never leak raw API bodies ────────────────────────────────

test('sanitizeError: surfaces only HTTP status, not body', () => {
  const err = new Error('GET /repos/x → 403: {"message":"secret token detail"}');
  err.statusCode = 403;
  const msg = sanitizeError(err);
  assert.match(msg, /HTTP 403/);
  assert.doesNotMatch(msg, /secret token detail/);
});

test('sanitizeError: redacts response-body marker even without statusCode', () => {
  const msg = sanitizeError(new Error('GET /x → 500: {"leak":"do not show"}'));
  assert.match(msg, /redacted/);
  assert.doesNotMatch(msg, /do not show/);
});

test('sanitizeError: passes through a plain controlled message', () => {
  assert.equal(sanitizeError(new Error('PR head SHA is missing or malformed.')), 'PR head SHA is missing or malformed.');
});

// ── token module: JWT + least-privilege minting (mocked ghFetch) ────────────

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBOgIBAAAA\n-----END PRIVATE KEY-----';

test('generateAppJwt: rejects non-numeric app id', () => {
  assert.throws(() => generateAppJwt('abc', PEM), /App ID/);
});

test('generateAppJwt: rejects non-PEM key', () => {
  assert.throws(() => generateAppJwt('123', 'not-a-key'), /private key/);
});

test('resolveCheckerInstallationId: rejects bad repo format', async () => {
  await assert.rejects(() => resolveCheckerInstallationId(async () => ({ id: 1 }), 'jwt', 'not-a-repo'), /owner\/repo/);
});

test('resolveCheckerInstallationId: returns installation id', async () => {
  const id = await resolveCheckerInstallationId(async (path) => {
    assert.equal(path, '/repos/paperclipai/paperclip/installation');
    return { id: 424242 };
  }, 'jwt', 'paperclipai/paperclip');
  assert.equal(id, 424242);
});

test('mintInstallationToken: down-scopes to least-privilege permissions + single repo', async () => {
  let captured = null;
  const ghFetch = async (path, token, options) => {
    captured = { path, token, body: JSON.parse(options.body) };
    return { token: 'ghs_scoped', permissions: LEAST_PRIVILEGE_PERMISSIONS, expires_at: '2026-01-01T00:00:00Z' };
  };
  const result = await mintInstallationToken(ghFetch, 'jwt', '777', { repositoryName: 'paperclip' });
  assert.equal(result.token, 'ghs_scoped');
  assert.equal(captured.path, '/app/installations/777/access_tokens');
  assert.deepEqual(captured.body.permissions, { ...LEAST_PRIVILEGE_PERMISSIONS });
  assert.deepEqual(captured.body.repositories, ['paperclip']);
});

test('LEAST_PRIVILEGE_PERMISSIONS: only pull_requests:write, metadata:read; no unused read scopes', () => {
  assert.deepEqual({ ...LEAST_PRIVILEGE_PERMISSIONS }, { metadata: 'read', pull_requests: 'write' });
  const writeScopes = Object.entries(LEAST_PRIVILEGE_PERMISSIONS).filter(([, v]) => v === 'write').map(([k]) => k);
  assert.deepEqual(writeScopes, ['pull_requests']);
  // The reads-via-default-token design means the App token needs no
  // contents/issues/actions/checks/statuses scopes at all.
  for (const scope of ['contents', 'issues', 'actions', 'checks', 'statuses']) {
    assert.equal(LEAST_PRIVILEGE_PERMISSIONS[scope], undefined, `${scope} must not be granted`);
  }
});

test('mintInstallationToken: empty token fails closed', async () => {
  await assert.rejects(() => mintInstallationToken(async () => ({}), 'jwt', '777', {}), /did not return an installation token/);
});

// ── Mocked end-to-end wiring (the real integration path used by main) ───────
// Builds a fake ghFetch that serves the exact endpoints gatherInputs() calls,
// then drives evaluateChecker with those inputs — proving the fetch → classify
// → decide pipeline holds together across approval / rejection / race scenarios.

function fakeGitHub({ pr, files, checkRuns, statuses, reviews, headCommit }) {
  return async (path) => {
    if (/\/pulls\/\d+$/.test(path)) return pr;
    if (path.includes('/files')) return files;
    if (path.includes('/check-runs')) return { check_runs: checkRuns };
    if (path.endsWith('/status')) return { statuses };
    if (path.includes('/reviews')) return reviews;
    if (/\/commits\/[0-9a-f]{40}$/i.test(path)) return headCommit;
    throw new Error(`unexpected path ${path}`);
  };
}

async function drive(fixture, { eventAction = 'opened', eventHeadSha = HEAD } = {}) {
  const gh = fakeGitHub(fixture);
  const pr = await gh(`/repos/paperclipai/paperclip/pulls/1`);
  const headSha = pr.head.sha;
  const [filesRes, cr, st, reviews, headCommit] = await Promise.all([
    gh(`/repos/paperclipai/paperclip/pulls/1/files?per_page=100&page=1`),
    gh(`/repos/paperclipai/paperclip/commits/${headSha}/check-runs?per_page=100`),
    gh(`/repos/paperclipai/paperclip/commits/${headSha}/status`),
    gh(`/repos/paperclipai/paperclip/pulls/1/reviews?per_page=100&page=1`),
    gh(`/repos/paperclipai/paperclip/commits/${headSha}`),
  ]);
  const existingAppReview = findApprovedAppReview(reviews, APP);
  return evaluateChecker({
    config: activeConfig(),
    pr,
    eventAction,
    eventHeadSha,
    files: filesRes,
    checkRuns: cr.check_runs,
    statuses: st.statuses,
    requiredChecks: POLICY,
    appSlug: APP,
    headCommitAuthorLogin: headCommit.author?.login ?? '',
    lastPusherLogin: headCommit.committer?.login ?? headCommit.author?.login ?? '',
    existingAppReview,
  });
}

test('integration(mocked): GREEN PR is approved end-to-end', async () => {
  const result = await drive({
    pr: greenPr(),
    files: [{ filename: 'server/src/services/cursor.ts', additions: 4, deletions: 1, changes: 5 }],
    checkRuns: greenChecks(),
    statuses: [],
    reviews: [],
    headCommit: { author: { login: 'paperclipai[bot]' }, committer: { login: 'paperclipai[bot]' } },
  });
  assert.equal(result.decision, 'approved', result.reasons.join('; '));
});

test('integration(mocked): App-authored commit is rejected end-to-end', async () => {
  const result = await drive({
    pr: greenPr(),
    files: [{ filename: 'server/src/services/cursor.ts', additions: 4, deletions: 1, changes: 5 }],
    checkRuns: greenChecks(),
    statuses: [],
    reviews: [],
    headCommit: { author: { login: APP }, committer: { login: APP } },
  });
  assert.equal(result.decision, 'rejected');
  assert.match(result.reasons.join(' '), /head-commit author|last pusher/);
});

test('integration(mocked): new push after evidence (stale event SHA / race) rejected', async () => {
  const result = await drive({
    pr: greenPr(),
    files: [{ filename: 'server/src/services/cursor.ts', additions: 4, deletions: 1, changes: 5 }],
    checkRuns: greenChecks(),
    statuses: [],
    reviews: [],
    headCommit: { author: { login: 'paperclipai[bot]' }, committer: { login: 'paperclipai[bot]' } },
  }, { eventAction: 'synchronize', eventHeadSha: OTHER });
  assert.equal(result.decision, 'rejected');
  assert.match(result.reasons.join(' '), /Stale head SHA/);
});

test('integration(mocked): workflow_run completion — pending then approved after last check green', async () => {
  // Pass 1: gitleaks still running → pending (no approval).
  const pending = await drive({
    pr: greenPr(),
    files: [{ filename: 'server/src/services/cursor.ts', additions: 4, deletions: 1, changes: 5 }],
    checkRuns: [
      { name: 'verify', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
      { name: 'gitleaks', status: 'in_progress', conclusion: null, app: { ...GH_ACTIONS } },
    ],
    statuses: [],
    reviews: [],
    headCommit: { author: { login: 'paperclipai[bot]' }, committer: { login: 'paperclipai[bot]' } },
  }, { eventAction: 'workflow_run' });
  assert.equal(pending.decision, 'pending');

  // Pass 2: the Secret Scan workflow_run completes, gitleaks now green → approved.
  const approved = await drive({
    pr: greenPr(),
    files: [{ filename: 'server/src/services/cursor.ts', additions: 4, deletions: 1, changes: 5 }],
    checkRuns: greenChecks(),
    statuses: [],
    reviews: [],
    headCommit: { author: { login: 'paperclipai[bot]' }, committer: { login: 'paperclipai[bot]' } },
  }, { eventAction: 'workflow_run' });
  assert.equal(approved.decision, 'approved', approved.reasons.join('; '));
});

test('integration(mocked): spoofed same-name check from wrong app is rejected end-to-end', async () => {
  const result = await drive({
    pr: greenPr(),
    files: [{ filename: 'server/src/services/cursor.ts', additions: 4, deletions: 1, changes: 5 }],
    checkRuns: [
      { name: 'verify', status: 'completed', conclusion: 'success', app: { slug: 'evil-app', id: 99999 } },
      { name: 'gitleaks', status: 'completed', conclusion: 'success', app: { ...GH_ACTIONS } },
    ],
    statuses: [],
    reviews: [],
    headCommit: { author: { login: 'paperclipai[bot]' }, committer: { login: 'paperclipai[bot]' } },
  });
  assert.equal(result.decision, 'rejected');
  assert.match(result.reasons.join(' '), /unexpected app/i);
});

// ── object-keyed pagination (check-runs / combined status) ──────────────────

test('fetchAllPagesFromKey: follows pages until a short page and concatenates the keyed arrays', async () => {
  const pageOne = Array.from({ length: 100 }, (_, i) => ({ name: `verify-${i}` }));
  const pageTwo = [{ name: 'gitleaks' }];
  const calls = [];
  const gh = async (path) => {
    calls.push(path);
    const page = Number(new URL(`https://x${path}`).searchParams.get('page'));
    return { total_count: 101, check_runs: page === 1 ? pageOne : page === 2 ? pageTwo : [] };
  };
  const all = await fetchAllPagesFromKey(gh, '/repos/o/r/commits/abc/check-runs', 'tok', 'check_runs');
  assert.equal(all.length, 101);
  assert.equal(all[100].name, 'gitleaks');
  // Stopped after the short page 2; did not request page 3.
  assert.equal(calls.length, 2);
  assert.match(calls[0], /per_page=100&page=1/);
});

test('fetchAllPagesFromKey: missing/invalid key yields empty (fail-closed, no crash)', async () => {
  const gh = async () => ({ total_count: 0 });
  const all = await fetchAllPagesFromKey(gh, '/repos/o/r/commits/abc/status', 'tok', 'statuses');
  assert.deepEqual(all, []);
});

// ── workflow-level trust guard: executed checker code must be the default branch ──

test('workflow: checkout pins the repository default branch, never the PR-selected base', () => {
  const wfPath = fileURLToPath(new URL('../../workflows/paperclip-checker.yml', import.meta.url));
  const wf = readFileSync(wfPath, 'utf8');
  const refLine = wf.split('\n').find(l => /^\s*ref:\s/.test(l));
  assert.ok(refLine, 'checkout step must declare a ref');
  // The executed code (checker script + policy + classifier) must come from the
  // branch-protected default branch. A PR-influenceable base.sha would let a PR
  // targeting a malicious base branch swap in a different checker script that
  // runs with the App private key in step env.
  assert.match(refLine, /github\.event\.repository\.default_branch/);
  assert.doesNotMatch(wf, /ref:.*pull_request\.base\.sha/);
  assert.doesNotMatch(wf, /ref:.*head\.sha/);
});

test('workflow: checker job pins the check name to the documented paperclip-checker label', () => {
  const wfPath = fileURLToPath(new URL('../../workflows/paperclip-checker.yml', import.meta.url));
  const wf = readFileSync(wfPath, 'utf8');
  const lines = wf.split('\n');
  // Scope to the `jobs.checker` block specifically: from its 2-space-indented
  // `checker:` header to the next job (another 2-space-indented `key:`). A
  // whole-file match could be satisfied by some other job's name.
  const start = lines.findIndex(l => /^ {2}checker:\s*$/.test(l));
  assert.ok(start !== -1, 'workflow must define a jobs.checker block');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) { end = i; break; }
  }
  const checkerBlock = lines.slice(start, end).join('\n');
  // The emitted check-run name must be `paperclip-checker` (the label the
  // runbook/branch-protection reference), not the bare job id `checker`.
  assert.match(checkerBlock, /^ {4}name:\s*paperclip-checker\s*$/m);
});

// ── secret-scan workflow: required "Secret Scan" context must be produced ──
// Branch protection on `main` requires the context "Secret Scan", while
// internal tooling (producer binding, classifier, automerge, protection audit)
// binds to "gitleaks". Both contexts must exist: the scanning job keeps its
// `gitleaks` id/context, and a gate job publishes "Secret Scan" gated on it.

function secretScanBlock(jobKey) {
  const wfPath = fileURLToPath(new URL('../../workflows/secret-scan.yml', import.meta.url));
  const wf = readFileSync(wfPath, 'utf8');
  const lines = wf.split('\n');
  const start = lines.findIndex(l => new RegExp(`^ {2}${jobKey}:\\s*$`).test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

test('secret-scan: gitleaks job/context is preserved for internal producer binding', () => {
  // The checker producer binding, classifier, automerge, and protection audit
  // all key on the check-run name `gitleaks`. Renaming this job would silently
  // break every one of those bindings, so the id (== emitted context) must
  // remain `gitleaks` with no overriding `name:`.
  const block = secretScanBlock('gitleaks');
  assert.ok(block, 'secret-scan workflow must keep a jobs.gitleaks block');
  assert.doesNotMatch(block, /^ {4}name:\s/m, 'gitleaks job must not override its context name');
});

test('secret-scan: a gate job publishes the "Secret Scan" required context, gated on gitleaks', () => {
  const block = secretScanBlock('secret-scan');
  assert.ok(block, 'secret-scan workflow must define a jobs.secret-scan gate');
  // Emits the exact context required by branch protection on `main`.
  assert.match(block, /^ {4}name:\s*Secret Scan\s*$/m);
  // Depends on the real scan so it cannot pass independently of gitleaks.
  assert.match(block, /^ {4}needs:\s*\[gitleaks\]\s*$/m);
  // Fails closed: only a `success` gitleaks result passes the gate.
  assert.match(block, /needs\.gitleaks\.result/);
  assert.match(block, /!=\s*"success"/);
  assert.match(block, /exit 1/);
});

// ── executeDecision: post-decision side-effect sequencing (approve/dismiss) ──
// Injected deps record every mint/dismiss/approve so we can assert the exact
// side effects, including the anti-TOCTOU + stale-dismiss coupling.

function recordingDeps() {
  const calls = { mint: 0, dismiss: [], approve: [] };
  return {
    calls,
    deps: {
      mintAppToken: async () => { calls.mint += 1; return 'app-token'; },
      dismissReview: async (_gh, _tok, _repo, _pr, id) => { calls.dismiss.push(id); },
      submitApproval: async (_gh, _tok, _repo, _pr, sha) => { calls.approve.push(sha); },
    },
  };
}

const baseArgs = (over = {}) => ({
  ghFetch: async () => ({ head: { sha: HEAD } }),
  readToken: 'read',
  config: activeConfig(),
  repo: 'paperclipai/paperclip',
  prNumber: 1,
  eventHeadSha: HEAD,
  existingAppReview: null,
  ...over,
});

test('executeDecision: approved + fresh head + no prior review → approves at head, no dismiss', async () => {
  const { calls, deps } = recordingDeps();
  const outcome = await executeDecision(baseArgs({
    result: { decision: 'approved', dismissStale: false, riskLane: 'GREEN', reasons: ['ok'] },
    deps,
  }));
  assert.equal(outcome.status, 'approved');
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(calls.approve, [HEAD]);
  assert.deepEqual(calls.dismiss, []);
  assert.equal(outcome.dismissed, false);
});

test('executeDecision: TOCTOU — head advances mid-run with a prior (non-stale) approval → dismisses it, rejects, no approve', async () => {
  const { calls, deps } = recordingDeps();
  // Freshness re-read returns a DIFFERENT head than eventHeadSha.
  const outcome = await executeDecision(baseArgs({
    ghFetch: async () => ({ head: { sha: OTHER } }),
    result: { decision: 'approved', dismissStale: false, riskLane: 'GREEN', reasons: ['ok'] },
    existingAppReview: { id: 77, commit_id: HEAD, state: 'APPROVED' },
    deps,
  }));
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.reasons.join(' '), /Head advanced during evaluation/);
  // The now-stale approval MUST be dismissed even though dismissStale was false.
  assert.deepEqual(calls.dismiss, [77]);
  assert.equal(outcome.dismissed, true);
  // And it must NOT approve the advanced commit.
  assert.deepEqual(calls.approve, []);
});

test('executeDecision: TOCTOU after a stale dismiss already ran → does not double-dismiss', async () => {
  const { calls, deps } = recordingDeps();
  const outcome = await executeDecision(baseArgs({
    ghFetch: async () => ({ head: { sha: OTHER } }),
    // dismissStale true → dismissed once up front; then head advance is detected.
    result: { decision: 'approved', dismissStale: true, riskLane: 'GREEN', reasons: ['ok'] },
    existingAppReview: { id: 88, commit_id: OTHER, state: 'APPROVED' },
    deps,
  }));
  assert.equal(outcome.status, 'rejected');
  assert.deepEqual(calls.dismiss, [88]); // exactly once, not twice
  assert.deepEqual(calls.approve, []);
});

test('executeDecision: rejected decision with prior approval and dismissStale → dismisses, no approve', async () => {
  const { calls, deps } = recordingDeps();
  const outcome = await executeDecision(baseArgs({
    result: { decision: 'rejected', dismissStale: true, riskLane: 'RED', reasons: ['red lane'] },
    existingAppReview: { id: 5, commit_id: HEAD, state: 'APPROVED' },
    deps,
  }));
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(calls.dismiss, [5]);
  assert.deepEqual(calls.approve, []);
});

test('executeDecision: TOCTOU dismiss failure → blocked (fail closed), still no approve', async () => {
  const calls = { dismiss: 0, approve: 0 };
  const deps = {
    mintAppToken: async () => 'app-token',
    dismissReview: async () => { calls.dismiss += 1; throw new Error('GET /x → 403'); },
    submitApproval: async () => { calls.approve += 1; },
  };
  const outcome = await executeDecision(baseArgs({
    ghFetch: async () => ({ head: { sha: OTHER } }),
    result: { decision: 'approved', dismissStale: false, riskLane: 'GREEN', reasons: ['ok'] },
    existingAppReview: { id: 9, commit_id: HEAD, state: 'APPROVED' },
    deps,
  }));
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.exitCode, 1);
  assert.equal(calls.approve, 0);
  // Error is sanitized to status only, never the raw body.
  assert.match(outcome.reasons.join(' '), /HTTP 403|dismissing the now-stale approval failed/);
  assert.doesNotMatch(outcome.reasons.join(' '), /403:.*\{/);
});
