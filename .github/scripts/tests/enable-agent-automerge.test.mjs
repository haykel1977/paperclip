import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAutomergeEligibility, enablePullRequestAutoMerge } from '../enable-agent-automerge.mjs';

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

test('evaluateAutomergeEligibility: allows opted-in same-repo agent PRs', () => {
  const result = evaluateAutomergeEligibility(pr());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.failures, []);
});

test('evaluateAutomergeEligibility: rejects human-authored PRs even with labels', () => {
  const result = evaluateAutomergeEligibility(pr({ user: { login: 'haykel1977' } }));
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('not an allowed automation identity')));
});

test('evaluateAutomergeEligibility: rejects fork PRs', () => {
  const result = evaluateAutomergeEligibility(pr({
    head: { ref: 'fix/agent-change', repo: { full_name: 'someone/fork' } },
  }));
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('fork')));
});

test('evaluateAutomergeEligibility: rejects missing explicit opt-in labels', () => {
  const result = evaluateAutomergeEligibility(pr({ labels: [{ name: 'agent-pr' }] }));
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('Missing explicit auto-merge opt-in')));
});

test('evaluateAutomergeEligibility: rejects blocking labels', () => {
  const result = evaluateAutomergeEligibility(pr({ labels: [{ name: 'agent-pr' }, { name: 'automerge' }, { name: 'do-not-merge' }] }));
  assert.equal(result.eligible, false);
  assert.ok(result.failures.some(failure => failure.includes('Blocking label')));
});

test('evaluateAutomergeEligibility: allows lockfile automation branch without labels', () => {
  const result = evaluateAutomergeEligibility(pr({
    user: { login: 'github-actions[bot]' },
    head: { ref: 'chore/refresh-lockfile', repo: { full_name: 'paperclipai/paperclip' } },
    labels: [],
  }));
  assert.equal(result.eligible, true);
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
