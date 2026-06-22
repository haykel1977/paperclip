#!/usr/bin/env node
/**
 * enable-agent-automerge.mjs
 * Enables GitHub native auto-merge only for explicitly opted-in agent/bot PRs.
 * It never merges directly; branch protection and required check-runs remain the
 * source of truth. Non-eligible PRs are skipped with exit 0.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, DEFAULT_BRANCH (optional, default: main)
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { HARD_BLOCK_LABELS } from './check-pr-governance.mjs';

export const AUTOMERGE_LABEL = 'automerge';
export const AGENT_PR_LABEL = 'agent-pr';
export const DEFAULT_MERGE_METHOD = 'SQUASH';

export const ALLOWED_AUTOMERGE_AUTHORS = new Set([
  'commitperclip[bot]',
  'github-actions[bot]',
  'paperclipai[bot]',
  'dependabot[bot]',
]);

function labels(pr) {
  return (pr?.labels ?? [])
    .map(label => typeof label === 'string' ? label : label?.name)
    .filter(Boolean)
    .map(label => String(label).trim().toLowerCase());
}

function authorLogin(pr) {
  return String(pr?.user?.login ?? '').trim();
}

function isSameRepositoryPr(pr) {
  const headRepo = pr?.head?.repo?.full_name;
  const baseRepo = pr?.base?.repo?.full_name;
  return Boolean(headRepo && baseRepo && headRepo === baseRepo);
}

function isLockfileAutomation(pr) {
  return authorLogin(pr) === 'github-actions[bot]' && String(pr?.head?.ref ?? '') === 'chore/refresh-lockfile';
}

export function evaluateAutomergeEligibility(pr, options = {}) {
  const defaultBranch = options.defaultBranch ?? 'main';
  const prLabels = new Set(labels(pr));
  const failures = [];

  if (!pr || pr.state !== 'open') failures.push('PR is not open.');
  if (pr?.draft) failures.push('PR is draft.');
  if (pr?.base?.ref !== defaultBranch) failures.push(`PR base is ${pr?.base?.ref ?? 'unknown'}, not ${defaultBranch}.`);
  if (!isSameRepositoryPr(pr)) failures.push('PR comes from a fork; auto-merge is disabled for fork PRs.');
  if (pr?.auto_merge) failures.push('Auto-merge is already enabled.');

  const blockingLabels = [...prLabels].filter(label => HARD_BLOCK_LABELS.has(label));
  if (blockingLabels.length > 0) {
    failures.push(`Blocking label(s) present: ${blockingLabels.join(', ')}.`);
  }

  const author = authorLogin(pr);
  if (!ALLOWED_AUTOMERGE_AUTHORS.has(author)) {
    failures.push(`Author ${author || 'unknown'} is not an allowed automation identity.`);
  }

  const labelOptIn = prLabels.has(AGENT_PR_LABEL) && prLabels.has(AUTOMERGE_LABEL);
  const lockfileOptIn = isLockfileAutomation(pr);
  const dependabotOptIn = author === 'dependabot[bot]' && prLabels.has(AUTOMERGE_LABEL);
  if (!labelOptIn && !lockfileOptIn && !dependabotOptIn) {
    failures.push('Missing explicit auto-merge opt-in: require labels `agent-pr` + `automerge` (or approved lockfile/dependabot automation).');
  }

  return {
    eligible: failures.length === 0,
    failures,
  };
}

export async function enablePullRequestAutoMerge(fetchImpl, token, prNodeId, mergeMethod = DEFAULT_MERGE_METHOD) {
  if (!/^PR_[A-Za-z0-9_-]+$|^[A-Za-z0-9_-]+$/.test(String(prNodeId ?? ''))) {
    throw new Error('Invalid pull request node id.');
  }
  const res = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      query: `
        mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
          enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
            pullRequest { number }
          }
        }
      `,
      variables: { pullRequestId: prNodeId, mergeMethod },
    }),
  });

  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GitHub GraphQL returned non-JSON response: ${text}`);
  }

  if (!res.ok || payload.errors?.length) {
    const details = payload.errors?.map(error => error.message).join('; ') || text;
    throw new Error(`Failed to enable auto-merge: ${details}`);
  }

  return payload.data?.enablePullRequestAutoMerge?.pullRequest ?? null;
}

async function main() {
  const { GH_TOKEN, GH_REPO, PR_NUMBER } = process.env;
  const defaultBranch = process.env.DEFAULT_BRANCH || 'main';

  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER) {
    console.error('ERROR: GH_TOKEN, GH_REPO, PR_NUMBER env vars required');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    console.error('ERROR: GH_REPO must be in owner/repo format');
    process.exit(1);
  }
  const prNumber = Number.parseInt(PR_NUMBER, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('ERROR: PR_NUMBER must be a positive integer');
    process.exit(1);
  }

  const pr = await ghFetch(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN);
  const result = evaluateAutomergeEligibility(pr, { defaultBranch });
  if (!result.eligible) {
    console.log(JSON.stringify({ enabled: false, skipped: true, reasons: result.failures }, null, 2));
    return;
  }

  await enablePullRequestAutoMerge(fetch, GH_TOKEN, pr.node_id, DEFAULT_MERGE_METHOD);
  console.log(JSON.stringify({ enabled: true, mergeMethod: DEFAULT_MERGE_METHOD }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
