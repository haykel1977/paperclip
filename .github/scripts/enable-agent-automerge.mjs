#!/usr/bin/env node
/**
 * enable-agent-automerge.mjs
 * Enables GitHub native auto-merge only for explicitly opted-in agent/bot PRs.
 * It never merges directly; branch protection and required check-runs remain the
 * source of truth. Non-eligible PRs are skipped with exit 0.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, DEFAULT_BRANCH (optional, default: main),
 * REQUIRED_CHECKS (optional comma-separated list, default: verify,gitleaks),
 * EVENT_HEAD_SHA (optional; the event payload head SHA, compared against the
 * freshly-read API SHA to detect a stale/advanced head → RED).
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { HARD_BLOCK_LABELS } from './check-pr-governance.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';
import {
  classifyPrRiskLane,
  LANES,
  DEPENDENCY_MANIFEST_LABEL,
  isDependencyAutomationManifestOnly,
} from './classify-pr-risk-lane.mjs';

export const AUTOMERGE_LABEL = 'automerge';
export const AGENT_PR_LABEL = 'agent-pr';
export const DEFAULT_MERGE_METHOD = 'SQUASH';
export const DEFAULT_REQUIRED_CHECKS = ['verify', 'gitleaks'];

export const ALLOWED_AUTOMERGE_AUTHORS = new Set([
  // Dedicated autonomous delivery App (id 4384863) for this repo's witness PRs.
  'solidus-paperclip-delivery[bot]',
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

  // Deterministic risk-lane gate: only GREEN PRs may auto-merge. When a lane is
  // supplied it is enforced fail-closed; ORANGE/RED (and any non-GREEN value)
  // block auto-merge. When no lane is supplied the classifier is not consulted,
  // so callers that cannot classify (e.g. unit tests of the pure eligibility
  // rules) keep their existing behavior.
  if (options.riskLane !== undefined && options.riskLane !== LANES.GREEN) {
    failures.push(`Risk lane is ${options.riskLane || 'unknown'}, not GREEN; auto-merge is limited to the GREEN lane.`);
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
      Authorization: 'Bearer ' + token,
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
      Authorization: 'Bearer ' + token,
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

function labelNames(pr) {
  return (pr?.labels ?? [])
    .map(label => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean);
}

/**
 * Reduce the head-SHA check-runs into required-evidence the classifier can
 * judge. Only COMPLETED required checks are treated as evidence: a completed
 * neutral/skipped/failed required check fails closed to RED, while a check that
 * is still pending is left to branch protection (GitHub will not merge until it
 * is green). This makes the neutral/skipped fail-closed logic LIVE in
 * production without preventing native auto-merge from being enabled early.
 */
function checkRunRecency(run) {
  // Order by the most meaningful timestamp available. The GitHub check-runs list
  // order is NOT contractually newest-first, so we must sort explicitly — a
  // stale `success` must never mask a newer `neutral`/`skipped`/`failure`.
  const ts = run?.completed_at ?? run?.started_at ?? run?.created_at ?? null;
  const parsed = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

export function buildRequiredEvidence(checkRuns, requiredCheckNames) {
  const required = new Set(requiredCheckNames);
  const latestByName = new Map();
  for (const run of Array.isArray(checkRuns) ? checkRuns : []) {
    const name = String(run?.name ?? '').trim();
    if (!required.has(name)) continue;
    const current = latestByName.get(name);
    // Keep the most recent run per name by explicit timestamp comparison rather
    // than trusting response order. Ties keep the earlier-seen run.
    if (!current || checkRunRecency(run) > checkRunRecency(current)) {
      latestByName.set(name, run);
    }
  }
  const evidence = [];
  const requiredEvidenceNames = [];
  for (const [name, run] of latestByName) {
    if (String(run?.status ?? '') !== 'completed') continue; // pending → branch protection
    requiredEvidenceNames.push(name);
    evidence.push({ name, conclusion: run?.conclusion ?? 'missing' });
  }
  return { evidence, requiredEvidenceNames };
}

async function fetchCheckRuns(fetchFromGitHub, repo, sha, token) {
  if (!/^[0-9a-f]{40}$/i.test(String(sha ?? ''))) {
    throw new Error('Head SHA is missing or malformed; cannot fetch check-runs.');
  }
  const runs = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchFromGitHub(
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      token,
    );
    const checkRuns = Array.isArray(batch?.check_runs) ? batch.check_runs : [];
    runs.push(...checkRuns);
    if (checkRuns.length < 100) return runs;
  }
}

/**
 * Pure decision: given the fetched PR, files, check-runs, and the event's head
 * SHA, decide whether to enable/disable/skip native auto-merge. Shared by main()
 * and the integration tests so the production wiring is actually exercised.
 * On classificationError (e.g. a failed check-run/file fetch) the lane is forced
 * to RED — fail closed.
 */
export function planAutomerge({
  pr,
  files = [],
  checkRuns = [],
  eventHeadSha = '',
  branchProtection,
  requiredChecks = DEFAULT_REQUIRED_CHECKS,
  defaultBranch = 'main',
  classificationError = false,
}) {
  const author = authorLogin(pr);
  // Bounded, verifiable dependency exemption: an approved lockfile-refresh or
  // Dependabot PR whose changes are EXCLUSIVELY dependency manifests may treat
  // that one sacred surface as non-blocking. Any other touched surface (a
  // workflow, an auth file, …) makes this false, so the exemption evaporates and
  // the PR is RED as usual. Shared with the paperclip-checker App gate so both
  // apply the identical carve-out.
  const dependencyAutomation = isDependencyAutomationManifestOnly(pr, files);

  let riskLane = LANES.RED;
  let laneReasons = ['Risk-lane classification unavailable; failing closed to RED.'];
  if (!classificationError) {
    const { evidence, requiredEvidenceNames } = buildRequiredEvidence(checkRuns, requiredChecks);
    try {
      const classification = classifyPrRiskLane({
        title: pr?.title ?? '',
        labels: labelNames(pr),
        files,
        author,
        headSha: pr?.head?.sha ?? '',
        expectedHeadSha: eventHeadSha ?? '',
        evidence,
        requiredEvidence: requiredEvidenceNames,
        exemptRedPathLabels: dependencyAutomation ? [DEPENDENCY_MANIFEST_LABEL] : [],
      });
      riskLane = classification.lane;
      laneReasons = classification.reasons;
    } catch (error) {
      laneReasons = [`Risk-lane classification threw: ${error?.message ?? error}`];
    }
  }

  const options = { defaultBranch, branchProtection, requiredChecks, riskLane };

  const revocation = evaluateAutoMergeRevocation(pr, options);
  if (revocation.revoke) {
    return { action: 'disable', riskLane, laneReasons, reasons: revocation.reasons };
  }

  const eligibility = evaluateAutomergeEligibility(pr, options);
  if (!eligibility.eligible) {
    return { action: 'skip', riskLane, laneReasons, reasons: eligibility.failures };
  }

  return { action: 'enable', riskLane, laneReasons, reasons: [] };
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

  // The event payload's head SHA (captured when the workflow was triggered) is
  // an INDEPENDENT source from the freshly re-read pr.head.sha. If they differ,
  // the PR advanced mid-run and the classification is stale → RED. We do NOT
  // fall back to the API SHA: a missing/empty EVENT_HEAD_SHA would make the
  // stale-SHA guard compare the API SHA against itself (always equal), silently
  // disabling the entire mid-run-advance defense. Absent the independent source
  // we fail closed to RED instead.
  const eventHeadSha = String(process.env.EVENT_HEAD_SHA ?? '').trim();

  // Fetch the file list and head-SHA check-runs. Any failure here fails closed:
  // we never enable auto-merge on an unclassifiable PR.
  let files = [];
  let checkRuns = [];
  let classificationError = false;
  if (!eventHeadSha) {
    classificationError = true;
    console.log('::warning::[automerge] EVENT_HEAD_SHA missing/empty; the independent stale-SHA source is unavailable, failing closed to RED.');
  }
  try {
    files = await fetchAllPullRequestFiles(ghFetch, GH_REPO, prNumber, GH_TOKEN);
    checkRuns = await fetchCheckRuns(ghFetch, GH_REPO, pr?.head?.sha, GH_TOKEN);
  } catch (error) {
    classificationError = true;
    console.log(`::warning::[automerge] classification inputs unavailable, failing closed to RED: ${error.message}`);
  }

  const plan = planAutomerge({
    pr,
    files,
    checkRuns,
    eventHeadSha,
    branchProtection,
    requiredChecks,
    defaultBranch,
    classificationError,
  });

  if (plan.action === 'disable') {
    await disablePullRequestAutoMerge(fetch, GH_TOKEN, pr.node_id);
    console.log(JSON.stringify({ enabled: false, disabled: true, riskLane: plan.riskLane, reasons: plan.reasons }, null, 2));
    return;
  }

  if (plan.action === 'skip') {
    console.log(JSON.stringify({ enabled: false, skipped: true, riskLane: plan.riskLane, reasons: plan.reasons }, null, 2));
    return;
  }

  await enablePullRequestAutoMerge(fetch, GH_TOKEN, pr.node_id, DEFAULT_MERGE_METHOD);
  console.log(JSON.stringify({ enabled: true, riskLane: plan.riskLane, mergeMethod: DEFAULT_MERGE_METHOD }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
