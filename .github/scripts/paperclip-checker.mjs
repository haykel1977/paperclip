#!/usr/bin/env node
/**
 * paperclip-checker.mjs
 * Repository side of the FUTURE independent "paperclip-checker" GitHub App.
 *
 * It runs under pull_request_target from the trusted BASE branch and never
 * checks out or executes PR head code. It only reads PR metadata, changed
 * files, labels, the current head SHA, required check-runs/statuses, and the
 * existing risk-lane classifier (classify-pr-risk-lane.mjs) evaluated on base.
 * Its single privileged action is submitting or dismissing its own PR review.
 *
 * Fail-closed by construction:
 *   - blocked  → activation disabled or App config (ID/key) missing/invalid.
 *   - rejected → any non-GREEN lane, stale/mismatched head SHA, a required
 *                check that is not SUCCESS, a hard-block/contradictory label,
 *                a draft or fork PR, or an identity collision (the App is the
 *                PR author, the last pusher, or the head-commit author).
 *   - approved → ONLY a GREEN PR with a fresh exact head SHA and every
 *                configured blocking check SUCCESS, authored/pushed by someone
 *                other than the App.
 *
 * Neutral/skipped/missing/failure/cancelled/timed_out are never a pass. There
 * is deliberately no success/neutral escape hatch: the CLI exits 0 ONLY on
 * `approved`; every other decision exits non-zero so a misconfigured or
 * ambiguous run can never look like an approval.
 *
 * This module is disabled until a maintainer creates the App and installs
 * secrets — see doc/PAPERCLIP-CHECKER.md.
 */
import { fileURLToPath } from 'node:url';
import { classifyPrRiskLane, LANES } from './classify-pr-risk-lane.mjs';

// App identity of the future checker. Configurable so the login can be pinned
// once the App slug is registered; the trailing `[bot]` is GitHub's convention
// for App review authors.
export const DEFAULT_APP_SLUG = 'paperclip-checker[bot]';

export const DEFAULT_REQUIRED_CHECKS = Object.freeze(['verify', 'gitleaks']);

// PR-event actions that INVALIDATE a prior approval: the head advanced, the PR
// re-opened, its draft state changed, or its labels changed. On any of these an
// existing App approval must be dismissed/superseded before a new decision.
export const STALE_INDUCING_ACTIONS = Object.freeze(
  new Set(['synchronize', 'reopened', 'ready_for_review', 'converted_to_draft', 'labeled', 'unlabeled']),
);

const SHA_RE = /^[0-9a-f]{40}$/i;

function normalizeLogin(value) {
  return String(value ?? '').trim().toLowerCase();
}

function labelNames(pr) {
  return (pr?.labels ?? [])
    .map(label => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean);
}

/**
 * Validate activation config. Returns { active, reasons }. Missing/invalid
 * config is BLOCKED (never a pass): the explicit repository variable must be
 * exactly "true" AND both App-ID and private-key secrets must be non-empty and
 * well-formed. Anything else fails closed.
 */
export function readCheckerConfig(env = {}) {
  const reasons = [];
  const enabledRaw = String(env.PAPERCLIP_CHECKER_ENABLED ?? '').trim().toLowerCase();
  if (enabledRaw !== 'true') {
    reasons.push(
      `Checker is disabled: repository variable PAPERCLIP_CHECKER_ENABLED must equal "true" (got ${enabledRaw ? `"${enabledRaw}"` : 'unset'}).`,
    );
  }
  const appId = String(env.PAPERCLIP_CHECKER_APP_ID ?? '').trim();
  if (!/^\d+$/.test(appId)) {
    reasons.push('Checker App ID secret (PAPERCLIP_CHECKER_APP_ID) is missing or not numeric.');
  }
  const privateKey = String(env.PAPERCLIP_CHECKER_PRIVATE_KEY ?? '');
  if (!privateKey.includes('PRIVATE KEY')) {
    reasons.push('Checker private-key secret (PAPERCLIP_CHECKER_PRIVATE_KEY) is missing or not a PEM block.');
  }
  return { active: reasons.length === 0, reasons, appId, privateKey };
}

/**
 * Reduce head-SHA check-runs + commit statuses to a pass/fail verdict for the
 * required set. ONLY an explicit `success` conclusion (check-run) or `success`
 * state (status) passes. Missing, pending/in-progress, neutral, skipped,
 * failure, cancelled, timed_out, action_required, stale → fail closed.
 */
export function summarizeRequiredChecks(checkRuns, statuses, requiredChecks = DEFAULT_REQUIRED_CHECKS) {
  // Latest check-run per name, ordered by explicit timestamp (list order is not
  // contractually newest-first, so a stale success must not mask a newer fail).
  const recency = run => {
    const ts = run?.completed_at ?? run?.started_at ?? run?.created_at ?? null;
    const parsed = ts ? Date.parse(ts) : NaN;
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  const latestRun = new Map();
  for (const run of Array.isArray(checkRuns) ? checkRuns : []) {
    const name = String(run?.name ?? '').trim();
    if (!name) continue;
    const current = latestRun.get(name);
    if (!current || recency(run) > recency(current)) latestRun.set(name, run);
  }

  // Commit statuses: the combined API already collapses to the latest per
  // context, but guard anyway.
  const statusState = new Map();
  for (const status of Array.isArray(statuses) ? statuses : []) {
    const context = String(status?.context ?? '').trim();
    if (!context) continue;
    statusState.set(context, String(status?.state ?? '').trim().toLowerCase());
  }

  const failures = [];
  const evidence = [];
  for (const name of requiredChecks) {
    const run = latestRun.get(name);
    if (run) {
      const status = String(run.status ?? '').trim().toLowerCase();
      const conclusion = String(run.conclusion ?? 'missing').trim().toLowerCase() || 'missing';
      evidence.push({ name, conclusion });
      if (status !== 'completed') {
        failures.push(`Required check \`${name}\` is not completed (status=${status || 'unknown'}).`);
      } else if (conclusion !== 'success') {
        failures.push(`Required check \`${name}\` concluded \`${conclusion}\`, not \`success\`.`);
      }
      continue;
    }
    if (statusState.has(name)) {
      const state = statusState.get(name);
      evidence.push({ name, conclusion: state });
      if (state !== 'success') {
        failures.push(`Required status \`${name}\` is \`${state || 'pending'}\`, not \`success\`.`);
      }
      continue;
    }
    evidence.push({ name, conclusion: 'missing' });
    failures.push(`Required check/status \`${name}\` is missing.`);
  }
  return { passing: failures.length === 0, failures, evidence };
}

/**
 * Pure decision core. No I/O. Given the fully-fetched inputs it returns exactly
 * one decision plus whether a prior App approval must be dismissed.
 *
 * @returns {{ decision: 'blocked'|'rejected'|'approved', reasons: string[],
 *   riskLane: string|null, dismissStale: boolean }}
 */
export function evaluateChecker({
  config,
  pr,
  eventAction = '',
  eventHeadSha = '',
  files = [],
  checkRuns = [],
  statuses = [],
  requiredChecks = DEFAULT_REQUIRED_CHECKS,
  appSlug = DEFAULT_APP_SLUG,
  headCommitAuthorLogin = '',
  lastPusherLogin = '',
  existingAppReview = null,
} = {}) {
  // ── Activation gate (blocked, never a pass) ──────────────────────────────
  if (!config?.active) {
    return {
      decision: 'blocked',
      reasons: config?.reasons?.length ? config.reasons : ['Checker activation config is invalid.'],
      riskLane: null,
      dismissStale: false,
    };
  }

  const app = normalizeLogin(appSlug);
  const currentHead = String(pr?.head?.sha ?? '').trim();

  // A prior App approval is stale when it was submitted against a different
  // commit than the current head, OR when the event itself invalidates it
  // (new push, reopen, ready-for-review, label change). Report it so main()
  // can dismiss/supersede before any re-approval.
  const priorApprovalSha = String(existingAppReview?.commit_id ?? '').trim();
  const dismissStale = Boolean(
    existingAppReview &&
      (STALE_INDUCING_ACTIONS.has(eventAction) ||
        (priorApprovalSha && priorApprovalSha.toLowerCase() !== currentHead.toLowerCase())),
  );

  const reasons = [];

  // ── Draft / fork are never approved ──────────────────────────────────────
  if (pr?.draft) reasons.push('Draft PR is never approved.');
  const headRepo = pr?.head?.repo?.full_name;
  const baseRepo = pr?.base?.repo?.full_name;
  if (!headRepo || !baseRepo || headRepo !== baseRepo) {
    reasons.push('Fork PR (head repo differs from base repo) is never approved.');
  }

  // ── Identity separation of duties ────────────────────────────────────────
  // The App must never rubber-stamp its own work. Reject if it is the PR
  // author, the last pusher, or the author of the head commit.
  if (app && normalizeLogin(pr?.user?.login) === app) {
    reasons.push('App identity equals the PR author; approval withheld (self-approval).');
  }
  if (app && normalizeLogin(lastPusherLogin) === app) {
    reasons.push('App identity equals the last pusher; approval withheld (would approve its own push).');
  }
  if (app && normalizeLogin(headCommitAuthorLogin) === app) {
    reasons.push('App identity equals the head-commit author; approval withheld (would approve its own commit).');
  }

  // ── Fresh, exact head SHA ────────────────────────────────────────────────
  const expected = String(eventHeadSha ?? '').trim();
  if (!SHA_RE.test(expected) || !SHA_RE.test(currentHead)) {
    reasons.push('Head SHA is missing or malformed; cannot prove evidence freshness.');
  } else if (expected.toLowerCase() !== currentHead.toLowerCase()) {
    reasons.push(`Stale head SHA: evidence gathered for \`${expected}\` but current head is \`${currentHead}\`.`);
  }

  // ── Required checks all SUCCESS ──────────────────────────────────────────
  const checkSummary = summarizeRequiredChecks(checkRuns, statuses, requiredChecks);
  if (!checkSummary.passing) reasons.push(...checkSummary.failures);

  // ── Risk lane (delegated to the shared classifier) ───────────────────────
  // The classifier independently enforces labels, red paths, diff size, actor,
  // stale SHA and evidence. We pass the same evidence so a neutral/skipped
  // required check forces RED there too. Only GREEN is approvable.
  const classification = classifyPrRiskLane({
    title: pr?.title ?? '',
    labels: labelNames(pr),
    files,
    author: normalizeLogin(pr?.user?.login) ? String(pr.user.login) : '',
    headSha: currentHead,
    expectedHeadSha: expected,
    evidence: checkSummary.evidence,
    requiredEvidence: requiredChecks,
  });
  if (classification.lane !== LANES.GREEN) {
    reasons.push(`Risk lane is ${classification.lane}; only GREEN is eligible for App approval.`);
    reasons.push(...classification.reasons.map(reason => `lane: ${reason}`));
  }

  if (reasons.length > 0) {
    return { decision: 'rejected', reasons, riskLane: classification.lane, dismissStale };
  }
  return {
    decision: 'approved',
    reasons: ['GREEN PR, fresh exact head SHA, all required checks SUCCESS, distinct approver identity.'],
    riskLane: classification.lane,
    dismissStale,
  };
}

// ── Integration layer (network I/O; wired by main and integration tests) ─────

async function fetchAllPages(ghFetch, path, token) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await ghFetch(`${path}${sep}per_page=100&page=${page}`, token);
    const list = Array.isArray(batch) ? batch : [];
    items.push(...list);
    if (list.length < 100) return items;
  }
}

/**
 * Find the App's own most-recent review (any state). Used both to detect a
 * stale approval to dismiss and to avoid re-approving the same SHA twice.
 */
export function findAppReview(reviews, appSlug = DEFAULT_APP_SLUG) {
  const app = normalizeLogin(appSlug);
  let latest = null;
  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (normalizeLogin(review?.user?.login) !== app) continue;
    if (!latest || Number(review?.id ?? 0) > Number(latest?.id ?? 0)) latest = review;
  }
  return latest;
}

export function findApprovedAppReview(reviews, appSlug = DEFAULT_APP_SLUG) {
  const app = normalizeLogin(appSlug);
  let latest = null;
  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (normalizeLogin(review?.user?.login) !== app) continue;
    if (String(review?.state ?? '').toUpperCase() !== 'APPROVED') continue;
    if (!latest || Number(review?.id ?? 0) > Number(latest?.id ?? 0)) latest = review;
  }
  return latest;
}

async function gatherInputs(ghFetch, token, repo, prNumber) {
  const pr = await ghFetch(`/repos/${repo}/pulls/${prNumber}`, token);
  const headSha = pr?.head?.sha;
  if (!SHA_RE.test(String(headSha ?? ''))) {
    throw new Error('PR head SHA is missing or malformed.');
  }
  const [files, checkRunsRaw, statusesRaw, reviews, headCommit] = await Promise.all([
    fetchAllPages(ghFetch, `/repos/${repo}/pulls/${prNumber}/files`, token),
    ghFetch(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`, token),
    ghFetch(`/repos/${repo}/commits/${headSha}/status`, token),
    fetchAllPages(ghFetch, `/repos/${repo}/pulls/${prNumber}/reviews`, token),
    ghFetch(`/repos/${repo}/commits/${headSha}`, token),
  ]);
  return {
    pr,
    files,
    checkRuns: Array.isArray(checkRunsRaw?.check_runs) ? checkRunsRaw.check_runs : [],
    statuses: Array.isArray(statusesRaw?.statuses) ? statusesRaw.statuses : [],
    reviews,
    headCommitAuthorLogin: headCommit?.author?.login ?? '',
    // GitHub does not expose "last pusher" directly on the PR; the head commit's
    // committer is the closest attributable identity for the last push.
    lastPusherLogin: headCommit?.committer?.login ?? headCommit?.author?.login ?? '',
  };
}

async function submitApproval(ghFetch, token, repo, prNumber, headSha) {
  return ghFetch(`/repos/${repo}/pulls/${prNumber}/reviews`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commit_id: headSha,
      event: 'APPROVE',
      body: 'paperclip-checker: GREEN lane, fresh head SHA, all required checks SUCCESS.',
    }),
  });
}

async function dismissReview(ghFetch, token, repo, prNumber, reviewId) {
  return ghFetch(`/repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'paperclip-checker: superseding stale approval; PR changed since prior review.' }),
  });
}

async function main() {
  const config = readCheckerConfig(process.env);

  // Fail closed on config BEFORE any token minting or network call.
  if (!config.active) {
    console.log(JSON.stringify({ decision: 'blocked', reasons: config.reasons }, null, 2));
    console.error('paperclip-checker is BLOCKED (fail-closed). No approval performed.');
    process.exit(1);
  }

  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
  const prNumber = Number.parseInt(process.env.PR_NUMBER ?? '', 10);
  const eventAction = String(process.env.EVENT_ACTION ?? '').trim();
  const eventHeadSha = String(process.env.EVENT_HEAD_SHA ?? '').trim();
  const appSlug = process.env.PAPERCLIP_CHECKER_APP_SLUG || DEFAULT_APP_SLUG;
  const requiredChecks = (process.env.REQUIRED_CHECKS || DEFAULT_REQUIRED_CHECKS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(String(repo ?? ''))) {
    console.error('ERROR: GH_REPO must be owner/repo.');
    process.exit(1);
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('ERROR: PR_NUMBER must be a positive integer.');
    process.exit(1);
  }

  const { ghFetch } = await import('./get-bot-token.mjs');
  const { generateAppJwt, resolveCheckerInstallationId, mintInstallationToken } =
    await import('./paperclip-app-token.mjs');

  // Mint the least-privilege installation token. Any failure fails closed.
  let token;
  try {
    const jwt = generateAppJwt(config.appId, config.privateKey);
    const installationId = await resolveCheckerInstallationId(ghFetch, jwt, repo);
    ({ token } = await mintInstallationToken(ghFetch, jwt, installationId, { repositoryName: repo.split('/')[1] }));
  } catch (error) {
    console.log(JSON.stringify({ decision: 'blocked', reasons: [`Token minting failed: ${error.message}`] }, null, 2));
    console.error('paperclip-checker is BLOCKED (token minting failed). No approval performed.');
    process.exit(1);
  }

  const inputs = await gatherInputs(ghFetch, token, repo, prNumber);
  const existingAppReview = findApprovedAppReview(inputs.reviews, appSlug);

  const result = evaluateChecker({
    config,
    pr: inputs.pr,
    eventAction,
    eventHeadSha,
    files: inputs.files,
    checkRuns: inputs.checkRuns,
    statuses: inputs.statuses,
    requiredChecks,
    appSlug,
    headCommitAuthorLogin: inputs.headCommitAuthorLogin,
    lastPusherLogin: inputs.lastPusherLogin,
    existingAppReview,
  });

  // Dismiss/supersede a stale prior approval where the API permits. If dismissal
  // fails, fail closed (do not approve): branch protection's dismiss_stale +
  // last-push-approval rules are the documented backstop (doc/PAPERCLIP-CHECKER.md).
  if (result.dismissStale && existingAppReview) {
    try {
      await dismissReview(ghFetch, token, repo, prNumber, existingAppReview.id);
      console.log(`Dismissed stale App approval #${existingAppReview.id}.`);
    } catch (error) {
      console.log(JSON.stringify({ decision: 'blocked', reasons: [`Failed to dismiss stale approval: ${error.message}`] }, null, 2));
      console.error('paperclip-checker could not dismiss a stale approval; failing closed. Configure branch-protection dismiss_stale + last-push approval (see doc/PAPERCLIP-CHECKER.md).');
      process.exit(1);
    }
  }

  if (result.decision === 'approved') {
    await submitApproval(ghFetch, token, repo, prNumber, inputs.pr.head.sha);
    console.log(JSON.stringify({ decision: 'approved', riskLane: result.riskLane, reasons: result.reasons }, null, 2));
    process.exit(0);
  }

  console.log(JSON.stringify({ decision: result.decision, riskLane: result.riskLane, reasons: result.reasons }, null, 2));
  console.error(`paperclip-checker did not approve (decision=${result.decision}). Fail-closed.`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
