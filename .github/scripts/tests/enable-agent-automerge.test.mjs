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
} from '../enable-agent-automerge.mjs';

test('ALLOWED_AUTOMERGE_AUTHORS: includes the dedicated delivery App, excludes humans', () => {
  assert.ok(ALLOWED_AUTOMERGE_AUTHORS.has('solidus-paperclip-delivery[bot]'));
  assert.ok(!ALLOWED_AUTOMERGE_AUTHORS.has('haykel1977'));
});

const protectedMain = {
  required_status_checks: {
    strict: true,
    contexts: ['verify', 'gitleaks'],
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
const greenChecks = () => [
  { name: 'verify', status: 'completed', conclusion: 'success' },
  { name: 'gitleaks', status: 'completed', conclusion: 'success' },
];

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
  });
}

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
    { name: 'verify', status: 'completed', conclusion: 'neutral' },
    { name: 'gitleaks', status: 'completed', conclusion: 'success' },
  ] });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'skip');
});

test('planAutomerge: a completed skipped required check fails closed to RED', () => {
  const result = plan({ checkRuns: [
    { name: 'verify', status: 'completed', conclusion: 'skipped' },
    { name: 'gitleaks', status: 'completed', conclusion: 'success' },
  ] });
  assert.equal(result.riskLane, 'RED');
});

test('planAutomerge: pending required checks do not block enabling (branch protection backstops)', () => {
  const result = plan({ checkRuns: [
    { name: 'verify', status: 'in_progress', conclusion: null },
    { name: 'gitleaks', status: 'queued', conclusion: null },
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
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'gitleaks', status: 'in_progress', conclusion: null },
    { name: 'unrelated', status: 'completed', conclusion: 'failure' },
  ], ['verify', 'gitleaks']);
  assert.deepEqual(requiredEvidenceNames, ['verify']);
  assert.deepEqual(evidence, [{ name: 'verify', conclusion: 'success' }]);
});

test('buildRequiredEvidence: keeps the newest run per required check name', () => {
  const { evidence } = buildRequiredEvidence([
    { name: 'verify', status: 'completed', conclusion: 'failure' },
    { name: 'verify', status: 'completed', conclusion: 'success' },
  ], ['verify']);
  assert.deepEqual(evidence, [{ name: 'verify', conclusion: 'failure' }]);
});

test('buildRequiredEvidence: an older success does NOT mask a newer neutral (explicit timestamp sort)', () => {
  // Supplied oldest-first — the OPPOSITE of the "newest first" assumption the
  // old code trusted. A stale `success` must not win over the newer `neutral`.
  const { evidence } = buildRequiredEvidence([
    { name: 'verify', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T00:00:00Z' },
    { name: 'verify', status: 'completed', conclusion: 'neutral', completed_at: '2026-01-02T00:00:00Z' },
  ], ['verify']);
  assert.deepEqual(evidence, [{ name: 'verify', conclusion: 'neutral' }]);
});

test('buildRequiredEvidence: an older success does NOT mask a newer failure (explicit timestamp sort)', () => {
  const { evidence } = buildRequiredEvidence([
    { name: 'verify', status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z' },
    { name: 'verify', status: 'completed', conclusion: 'failure', started_at: '2026-01-03T00:00:00Z' },
  ], ['verify']);
  assert.deepEqual(evidence, [{ name: 'verify', conclusion: 'failure' }]);
});

test('buildRequiredEvidence: falls back through completed_at → started_at → created_at for recency', () => {
  const { evidence } = buildRequiredEvidence([
    { name: 'verify', status: 'completed', conclusion: 'neutral', created_at: '2026-01-05T00:00:00Z' },
    { name: 'verify', status: 'completed', conclusion: 'success', created_at: '2026-01-04T00:00:00Z' },
  ], ['verify']);
  assert.deepEqual(evidence, [{ name: 'verify', conclusion: 'neutral' }]);
});

test('planAutomerge: an older success check-run cannot mask a newer neutral (RED, skipped)', () => {
  const result = plan({ checkRuns: [
    { name: 'verify', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T00:00:00Z' },
    { name: 'verify', status: 'completed', conclusion: 'neutral', completed_at: '2026-01-02T00:00:00Z' },
    { name: 'gitleaks', status: 'completed', conclusion: 'success', completed_at: '2026-01-02T00:00:00Z' },
  ] });
  assert.equal(result.riskLane, 'RED');
  assert.equal(result.action, 'skip');
});

test('evaluateAutomergeEligibility: allows opted-in same-repo agent PRs with protected required checks', () => {
  const result = evaluateAutomergeEligibility(pr(), { branchProtection: protectedMain });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.failures, []);
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

test('evaluateAutomergeEligibility: rejects PRs when a required check is absent from branch protection', () => {
  const result = evaluateAutomergeEligibility(pr(), {
    branchProtection: { required_status_checks: { strict: true, contexts: ['verify'] } },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('`gitleaks`')));
});

test('evaluateAutomergeEligibility: rejects PRs when branch protection does not require up-to-date branches', () => {
  const result = evaluateAutomergeEligibility(pr(), {
    branchProtection: { required_status_checks: { strict: false, contexts: ['verify', 'gitleaks'] } },
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
      checks: [{ context: 'verify' }, { context: 'gitleaks' }],
    },
  });
  assert.equal(result.protected, true);
  assert.deepEqual(result.failures, []);
});

test('fetchBranchProtection: returns null for missing branch protection', async () => {
  const result = await fetchBranchProtection(async () => {
    throw new Error('GitHub API GET /protection → 404: Not Found');
  }, 'paperclipai/paperclip', 'main', 'token');
  assert.equal(result, null);
});

test('fetchBranchProtection: returns null when branch protection is unreadable', async () => {
  const result = await fetchBranchProtection(async () => {
    throw new Error('GitHub API GET /protection → 403: Resource not accessible by integration');
  }, 'paperclipai/paperclip', 'main', 'token');
  assert.equal(result, null);
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
