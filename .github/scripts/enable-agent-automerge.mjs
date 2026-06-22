#!/usr/bin/env node
/**
 * enable-agent-automerge.mjs
 * Enables GitHub native auto-merge only for explicitly opted-in agent/bot PRs.
 * It never merges directly; branch protection and required check-runs remain the
 * source of truth. Non-eligible PRs are skipped with exit 0.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, DEFAULT_BRANCH (optional, default: main),
 * REQUIRED_CHECKS (optional comma-separated list, default: verify,gitleaks)
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { HARD_BLOCK_LABELS } from './check-pr-governance.mjs';

export const AUTOMERGE_LABEL = 'automerge';
export const AGENT_PR_LABEL = 'agent-pr';
export const DEFAULT_MERGE_METHOD = 'SQUASH';
export const DEFAULT_REQUIRED_CHECKS = ['verify', 'gitleaks'];

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

function isAutomationManagedPr(pr, prLabels = new Set(labels(pr))) {
  const author = authorLogin(pr);
  return (
    isSameRepositoryPr(pr) &&
    ALLOWED_AUTOMERGE_AUTHORS.has(author) &&
    (prLabels.has(AGENT_PR_LABEL) || prLabels.has(AUTOMERGE_LABEL) || isLockfileAutomation(pr) || author === 'dependabot[bot]')
  );
}

function validatePullRequestNodeId(prNodeId) {
  if (!/^[A-Za-z0-9_+=:/-]{1,256}$/.test(String(prNodeId ?? ''))) {
    throw new Error('Invalid pull request node id.');
  }
}

function requiredCheckNames(protection) {
  const requiredStatusChecks = protection?.required_status_checks;
  const contexts = Array.isArray(requiredStatusChecks?.contexts) ? requiredStatusChecks.contexts : [];
  const checks = Array.isArray(requiredStatusChecks?.checks)
    ? requiredStatusChecks.checks.map(check => check?.context).filter(Boolean)
    : [];
  return new Set([...contexts, ...checks].map(check => String(check)));
}

export function evaluateBranchProtection(protection, requiredChecks = DEFAULT_REQUIRED_CHECKS) {
  const failures = [];
  if (!protection) {
    return {
      protected: false,
      failures: ['Branch protection is not configured or could not be read.'],
    };
  }

  if (!protection.required_status_checks) {
    failures.push('Branch protection does not require status checks.');
  } else if (protection.required_status_checks.strict !== true) {
    failures.push('Branch protection must require branches to be up to date before merging.');
  }

  const checkNames = requiredCheckNames(protection);
  for (const requiredCheck of requiredChecks) {
    if (!checkNames.has(requiredCheck)) {
      failures.push(`Branch protection is missing required check \`${requiredCheck}\`.`);
    }
  }

  return {
    protected: failures.length === 0,
    failures,
  };
}

export async function fetchBranchProtection(fetchFromGitHub, repo, branch, token) {
  try {
    return await fetchFromGitHub(
      `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
      token,
    );
  } catch (error) {
    const message = String(error?.message ?? error);
    if (
      message.includes('→ 404') ||
      message.includes(' 404:') ||
      message.includes('Not Found') ||
      message.includes('→ 403') ||
      message.includes(' 403:') ||
      message.includes('Resource not accessible by integration')
    ) {
      return null;
    }
    throw error;
  }
}

function parseRequiredChecks(value) {
  if (!value) return DEFAULT_REQUIRED_CHECKS;
  const parsed = value.split(',').map(check => check.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_REQUIRED_CHECKS;
}

export function evaluateAutomergeEligibility(pr, options = {}) {
  const defaultBranch = options.defaultBranch ?? 'main';
  const requiredChecks = options.requiredChecks ?? DEFAULT_REQUIRED_CHECKS;
  const prLabels = new Set(labels(pr));
  const failures = [];

  if (!pr || pr.state !== 'open') failures.push('PR is not open.');
  if (pr?.draft) failures.push('PR is draft.');
  if (pr?.base?.ref !== defaultBranch) failures.push(`PR base is ${pr?.base?.ref ?? 'unknown'}, not ${defaultBranch}.`);
  if (!isSameRepositoryPr(pr)) failures.push('PR comes from a fork; auto-merge is disabled for fork PRs.');
  if (pr?.auto_merge) failures.push('Auto-merge is already enabled.');

  const branchProtection = evaluateBranchProtection(options.branchProtection, requiredChecks);
  failures.push(...branchProtection.failures);

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

export function evaluateAutoMergeRevocation(pr, options = {}) {
  if (!pr?.auto_merge) return { revoke: false, reasons: [] };

  const prLabels = new Set(labels(pr));
  const blockingLabels = [...prLabels].filter(label => HARD_BLOCK_LABELS.has(label));
  if (blockingLabels.length > 0) {
    return { revoke: true, reasons: [`Blocking label(s) present: ${blockingLabels.join(', ')}.`] };
  }

  if (!isAutomationManagedPr(pr, prLabels)) {
    return { revoke: false, reasons: [] };
  }

  const eligibility = evaluateAutomergeEligibility({ ...pr, auto_merge: null }, options);
  return {
    revoke: !eligibility.eligible,
    reasons: eligibility.failures,
  };
}

export async function enablePullRequestAutoMerge(fetchImpl, token, prNodeId, mergeMethod = DEFAULT_MERGE_METHOD) {
  validatePullRequestNodeId(prNodeId);
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

export async function disablePullRequestAutoMerge(fetchImpl, token, prNodeId) {
  validatePullRequestNodeId(prNodeId);
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
        mutation DisableAutoMerge($pullRequestId: ID!) {
          disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
            pullRequest { number }
          }
        }
      `,
      variables: { pullRequestId: prNodeId },
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
    throw new Error(`Failed to disable auto-merge: ${details}`);
  }

  return payload.data?.disablePullRequestAutoMerge?.pullRequest ?? null;
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
  const branch = pr?.base?.ref ?? defaultBranch;
  const requiredChecks = parseRequiredChecks(process.env.REQUIRED_CHECKS);
  const branchProtection = await fetchBranchProtection(ghFetch, GH_REPO, branch, GH_TOKEN);
  const options = {
    defaultBranch,
    branchProtection,
    requiredChecks,
  };
  const revocation = evaluateAutoMergeRevocation(pr, options);
  if (revocation.revoke) {
    await disablePullRequestAutoMerge(fetch, GH_TOKEN, pr.node_id);
    console.log(JSON.stringify({ enabled: false, disabled: true, reasons: revocation.reasons }, null, 2));
    return;
  }

  const result = evaluateAutomergeEligibility(pr, options);
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
