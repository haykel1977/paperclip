import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCheckerConfig,
  summarizeRequiredChecks,
  evaluateChecker,
  findAppReview,
  findApprovedAppReview,
  DEFAULT_APP_SLUG,
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

const activeConfig = () => ({ active: true, reasons: [], appId: '999', privateKey: 'x' });

const greenChecks = () => [
  { name: 'verify', status: 'completed', conclusion: 'success' },
  { name: 'gitleaks', status: 'completed', conclusion: 'success' },
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

// ── summarizeRequiredChecks: only success passes ────────────────────────────

test('summarizeRequiredChecks: all success → passing', () => {
  const r = summarizeRequiredChecks(greenChecks(), [], ['verify', 'gitleaks']);
  assert.equal(r.passing, true);
});

for (const conclusion of ['neutral', 'skipped', 'failure', 'cancelled', 'timed_out', 'action_required']) {
  test(`summarizeRequiredChecks: ${conclusion} is not a pass`, () => {
    const r = summarizeRequiredChecks(
      [{ name: 'verify', status: 'completed', conclusion }, { name: 'gitleaks', status: 'completed', conclusion: 'success' }],
      [],
      ['verify', 'gitleaks'],
    );
    assert.equal(r.passing, false);
    assert.match(r.failures.join(' '), new RegExp(conclusion));
  });
}

test('summarizeRequiredChecks: missing required check fails closed', () => {
  const r = summarizeRequiredChecks([{ name: 'verify', status: 'completed', conclusion: 'success' }], [], ['verify', 'gitleaks']);
  assert.equal(r.passing, false);
  assert.match(r.failures.join(' '), /gitleaks` is missing/);
});

test('summarizeRequiredChecks: pending/in-progress check fails closed', () => {
  const r = summarizeRequiredChecks(
    [{ name: 'verify', status: 'in_progress', conclusion: null }, { name: 'gitleaks', status: 'completed', conclusion: 'success' }],
    [], ['verify', 'gitleaks'],
  );
  assert.equal(r.passing, false);
});

test('summarizeRequiredChecks: newest run wins over stale success', () => {
  const r = summarizeRequiredChecks(
    [
      { name: 'verify', status: 'completed', conclusion: 'success', completed_at: '2024-01-01T00:00:00Z' },
      { name: 'verify', status: 'completed', conclusion: 'failure', completed_at: '2024-02-01T00:00:00Z' },
      { name: 'gitleaks', status: 'completed', conclusion: 'success' },
    ],
    [], ['verify', 'gitleaks'],
  );
  assert.equal(r.passing, false);
});

test('summarizeRequiredChecks: commit status success satisfies requirement', () => {
  const r = summarizeRequiredChecks([], [{ context: 'verify', state: 'success' }, { context: 'gitleaks', state: 'success' }], ['verify', 'gitleaks']);
  assert.equal(r.passing, true);
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
  const r = evalGreen({ checkRuns: [{ name: 'verify', status: 'completed', conclusion: 'neutral' }, { name: 'gitleaks', status: 'completed', conclusion: 'success' }] });
  assert.equal(r.decision, 'rejected');
});

test('evaluateChecker: missing required check → rejected', () => {
  const r = evalGreen({ checkRuns: [{ name: 'verify', status: 'completed', conclusion: 'success' }] });
  assert.equal(r.decision, 'rejected');
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

// ── review discovery helpers ────────────────────────────────────────────────

test('findAppReview: picks latest App review by id', () => {
  const reviews = [
    { id: 1, state: 'COMMENTED', user: { login: APP } },
    { id: 5, state: 'APPROVED', user: { login: APP } },
    { id: 3, state: 'APPROVED', user: { login: 'someone-else' } },
  ];
  assert.equal(findAppReview(reviews, APP).id, 5);
  assert.equal(findApprovedAppReview(reviews, APP).id, 5);
});

test('findApprovedAppReview: ignores non-approved App reviews', () => {
  const reviews = [{ id: 2, state: 'CHANGES_REQUESTED', user: { login: APP } }];
  assert.equal(findApprovedAppReview(reviews, APP), null);
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
  // No write scope beyond pull_requests.
  assert.equal(captured.body.permissions.pull_requests, 'write');
  const writeScopes = Object.entries(captured.body.permissions).filter(([, v]) => v === 'write').map(([k]) => k);
  assert.deepEqual(writeScopes, ['pull_requests']);
});

test('mintInstallationToken: empty token fails closed', async () => {
  await assert.rejects(() => mintInstallationToken(async () => ({}), 'jwt', '777', {}), /did not return an installation token/);
});

// ── Mocked end-to-end wiring (the real integration path used by main) ───────
// Builds a fake ghFetch that serves the exact endpoints gatherInputs() calls,
// then drives evaluateChecker with those inputs — proving the fetch → classify
// → decide pipeline holds together for GREEN approval and self-author rejection.

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

test('integration(mocked): new push after evidence (stale event SHA) rejected', async () => {
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
