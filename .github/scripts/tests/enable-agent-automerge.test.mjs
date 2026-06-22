import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAutomergeEligibility,
  evaluateBranchProtection,
  enablePullRequestAutoMerge,
  fetchBranchProtection,
} from '../enable-agent-automerge.mjs';

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

test('evaluateAutomergeEligibility: allows lockfile automation branch without labels when branch protection is configured', () => {
  const result = evaluateAutomergeEligibility(pr({
    user: { login: 'github-actions[bot]' },
    head: { ref: 'chore/refresh-lockfile', repo: { full_name: 'paperclipai/paperclip' } },
    labels: [],
  }), { branchProtection: protectedMain });
  assert.equal(result.eligible, true);
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
