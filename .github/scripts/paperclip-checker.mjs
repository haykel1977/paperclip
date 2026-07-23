#!/usr/bin/env node
/**
 * paperclip-checker.mjs
 * Repository side of the FUTURE independent "paperclip-checker" GitHub App.
 *
 * Trust model. The workflow runs from the trusted BASE branch under two safe
 * triggers and NEVER checks out or executes PR head code:
 *   - pull_request_target (PR lifecycle) — reacts to metadata/label changes.
 *   - workflow_run (completed) of the base-branch CI workflows that PRODUCE the
 *     required checks — this is what lets the gate re-evaluate once checks reach
 *     a terminal state. workflow_run always runs the base-branch workflow file
 *     with base-branch code; the PR is resolved from the head SHA, so no PR
 *     context is lost and no head code runs.
 *
 * It reads only PR metadata, changed files, labels, the current head SHA,
 * required check-runs/commit statuses, and the base-branch risk-lane classifier.
 * ALL reads use the workflow's default GITHUB_TOKEN. The least-privilege App
 * installation token is minted ONLY when the checker is about to approve or
 * dismiss — its single privileged action is submitting/dismissing its own
 * review.
 *
 * Decisions:
 *   - blocked  → activation disabled or App config (ID/key) missing/invalid, or
 *                token minting failed. Exit 1. Never a pass.
 *   - rejected → a disqualifier: non-GREEN lane, stale/malformed head SHA, a
 *                required check that completed non-success OR was produced by an
 *                UNEXPECTED app, a hard-block/contradictory label, a draft or
 *                fork PR, or an identity collision (App is the PR author, last
 *                pusher, or head-commit author). Exit 1.
 *   - pending  → no disqualifier, but a required check has not reached a
 *                terminal state yet. NO approval; exit 0 so the completed CI
 *                workflow_run can re-invoke us cleanly when the last check
 *                turns green. Pending is not a pass and never approves.
 *   - approved → GREEN, fresh exact head SHA, every required check SUCCESS from
 *                its EXPECTED producer, distinct approver identity. Exit 0.
 *
 * Fresh-evidence / anti-TOCTOU: the trigger-time head SHA is compared against a
 * freshly re-read API head SHA, and re-read once more immediately before the
 * approval POST; any divergence fails closed. Disabled until a maintainer
 * creates the App and installs secrets — see doc/PAPERCLIP-CHECKER.md.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classifyPrRiskLane,
  LANES,
  DEPENDENCY_MANIFEST_LABEL,
  isDependencyAutomationManifestOnly,
} from './classify-pr-risk-lane.mjs';

// The checker's OWN bot identity. The real GitHub App is
// `solidus-paperclip-checker` (App ID 4372695); its bot login is therefore
// `solidus-paperclip-checker[bot]`. This slug is what separation-of-duties
// compares the PR author / last pusher / head-commit author against, so the App
// can never approve a PR it authored, pushed, or committed. Overridable by the
// committed config file's top-level `appSlug`.
export const DEFAULT_APP_SLUG = 'solidus-paperclip-checker[bot]';

// Default producer-bound policy. Each required check is pinned to the app that
// is expected to produce it; a same-named check-run/status from any other app
// CANNOT satisfy the gate (it is treated as a failure, not silently ignored).
// Overridable by the committed .github/paperclip-checker.config.json on base.
export const DEFAULT_REQUIRED_CHECK_POLICY = Object.freeze([
  Object.freeze({ name: 'verify', type: 'check_run', appSlug: 'github-actions', appId: 15368 }),
  Object.freeze({ name: 'gitleaks', type: 'check_run', appSlug: 'github-actions', appId: 15368 }),
]);

export const STALE_INDUCING_ACTIONS = Object.freeze(
  new Set(['synchronize', 'reopened', 'ready_for_review', 'converted_to_draft', 'labeled', 'unlabeled', 'edited']),
);

const SHA_RE = /^[0-9a-f]{40}$/i;

function normalizeLogin(value) {
  // App slugs appear with or without the trailing `[bot]` across APIs; compare
  // on the bare slug so `github-actions` and `github-actions[bot]` unify.
  return String(value ?? '').trim().toLowerCase().replace(/\[bot\]$/, '');
}

function labelNames(pr) {
  return (pr?.labels ?? [])
    .map(label => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean);
}

/**
 * Redact API bodies from diagnostics. ghFetch attaches `statusCode`; we surface
 * only the HTTP status, never the raw response text (which can be verbose and
 * echo request context). Our own controlled messages (no `→ <status>:` body
 * marker) are passed through single-line.
 */
export function sanitizeError(error) {
  const status = Number(error?.statusCode);
  if (Number.isFinite(status) && status > 0) return `GitHub API error (HTTP ${status}).`;
  const message = String(error?.message ?? error ?? 'Unexpected error.').split('\n')[0];
  if (/→\s*\d+\s*:/.test(message)) return 'GitHub API error (response body redacted).';
  return message || 'Unexpected error.';
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
 * Load the producer-bound required-check policy. Preference order:
 *   1. REQUIRED_CHECKS_POLICY env (JSON) — used by tests.
 *   2. the committed base-branch config file (machine-readable, reviewable).
 *   3. DEFAULT_REQUIRED_CHECK_POLICY.
 * Returns { requiredChecks, appSlug }.
 */
export function loadCheckerPolicy(env = {}, readFile = readFileSync) {
  const coerce = raw => {
    const checks = Array.isArray(raw?.requiredChecks) ? raw.requiredChecks : [];
    const requiredChecks = checks
      .filter(c => c && typeof c.name === 'string' && c.name.trim())
      .map(c => ({
        name: String(c.name).trim(),
        type: c.type === 'status' ? 'status' : 'check_run',
        appSlug: c.appSlug ? String(c.appSlug) : undefined,
        appId: Number.isFinite(Number(c.appId)) && c.appId != null ? Number(c.appId) : undefined,
      }));
    return { requiredChecks, appSlug: raw?.appSlug ? String(raw.appSlug) : undefined };
  };

  if (env.REQUIRED_CHECKS_POLICY) {
    const parsed = coerce(JSON.parse(env.REQUIRED_CHECKS_POLICY));
    if (parsed.requiredChecks.length) return { requiredChecks: parsed.requiredChecks, appSlug: parsed.appSlug ?? DEFAULT_APP_SLUG };
  }
  const path = env.CHECKER_CONFIG_PATH || '.github/paperclip-checker.config.json';
  try {
    const parsed = coerce(JSON.parse(readFile(path, 'utf8')));
    if (parsed.requiredChecks.length) return { requiredChecks: parsed.requiredChecks, appSlug: parsed.appSlug ?? DEFAULT_APP_SLUG };
  } catch {
    // fall through to the built-in default
  }
  return { requiredChecks: DEFAULT_REQUIRED_CHECK_POLICY.map(c => ({ ...c })), appSlug: DEFAULT_APP_SLUG };
}

function appMatches(runApp, cfg) {
  // A run satisfies a policy entry only if its producing app matches by id
  // (authoritative) or, when no id is configured, by slug. Missing app info
  // never matches — fail closed.
  if (!runApp) return false;
  if (cfg.appId != null) return Number(runApp.id) === Number(cfg.appId);
  if (cfg.appSlug) return normalizeLogin(runApp.slug) === normalizeLogin(cfg.appSlug);
  return false;
}

function recency(run) {
  const ts = run?.completed_at ?? run?.started_at ?? run?.updated_at ?? run?.created_at ?? null;
  const parsed = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

/**
 * Producer-bound evidence evaluation. For each required check the ONLY evidence
 * considered is from the EXPECTED producer and the EXPECTED type; there is no
 * silent check-run↔status fallback.
 *
 * Per-check outcome:
 *   - success       → latest matching run/status is completed + success.
 *   - failed        → latest matching completed run/status is non-success, OR a
 *                     same-named run/status exists but ONLY from an unexpected
 *                     app (spoof attempt → block).
 *   - pending       → no matching evidence yet, or matching run not completed.
 *
 * Aggregate state: `failed` if any check failed; else `pending` if any pending;
 * else `passing`.
 */
export function summarizeRequiredChecks(checkRuns, statuses, requiredChecks = DEFAULT_REQUIRED_CHECK_POLICY) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const sts = Array.isArray(statuses) ? statuses : [];
  const failures = [];
  const pendingNames = [];
  const evidence = [];

  for (const cfg of requiredChecks) {
    if (cfg.type === 'status') {
      const named = sts.filter(s => String(s?.context ?? '').trim() === cfg.name);
      // Producer binding, fail-closed: a status matches only when the policy
      // pins an expected creator (appSlug) AND the status's creator matches it.
      // With no appSlug configured, nothing matches — a status with no provable
      // producer can never satisfy the gate (parity with check_run/appMatches).
      const matching = named.filter(s => cfg.appSlug && normalizeLogin(s?.creator?.login) === normalizeLogin(cfg.appSlug));
      if (named.length > 0 && matching.length === 0) {
        failures.push(cfg.appSlug
          ? `Required status \`${cfg.name}\` exists only from an unexpected creator; expected \`${cfg.appSlug}\`. Blocking.`
          : `Required status \`${cfg.name}\` has no expected producer (appSlug) configured, so its creator cannot be verified. Blocking.`);
        evidence.push({ name: cfg.name, conclusion: 'unexpected_producer' });
        continue;
      }
      if (matching.length === 0) { pendingNames.push(cfg.name); evidence.push({ name: cfg.name, conclusion: 'missing' }); continue; }
      const latest = matching.reduce((a, b) => (recency(b) >= recency(a) ? b : a));
      const state = String(latest?.state ?? '').trim().toLowerCase();
      evidence.push({ name: cfg.name, conclusion: state || 'missing' });
      if (state === 'success') continue;
      if (state === 'pending' || state === '') pendingNames.push(cfg.name);
      else failures.push(`Required status \`${cfg.name}\` is \`${state}\`, not \`success\`.`);
      continue;
    }

    // check_run
    const named = runs.filter(r => String(r?.name ?? '').trim() === cfg.name);
    const matching = named.filter(r => appMatches(r?.app, cfg));
    if (named.length > 0 && matching.length === 0) {
      const seen = [...new Set(named.map(r => r?.app?.slug ?? r?.app?.id ?? 'unknown'))].join(', ');
      failures.push(`Required check \`${cfg.name}\` exists only from unexpected app(s) [${seen}]; expected \`${cfg.appSlug ?? cfg.appId}\`. Blocking.`);
      evidence.push({ name: cfg.name, conclusion: 'unexpected_producer' });
      continue;
    }
    if (matching.length === 0) { pendingNames.push(cfg.name); evidence.push({ name: cfg.name, conclusion: 'missing' }); continue; }
    const latest = matching.reduce((a, b) => (recency(b) >= recency(a) ? b : a));
    const status = String(latest?.status ?? '').trim().toLowerCase();
    const conclusion = String(latest?.conclusion ?? '').trim().toLowerCase();
    if (status !== 'completed') { pendingNames.push(cfg.name); evidence.push({ name: cfg.name, conclusion: `pending:${status || 'unknown'}` }); continue; }
    evidence.push({ name: cfg.name, conclusion: conclusion || 'missing' });
    if (conclusion !== 'success') {
      failures.push(`Required check \`${cfg.name}\` concluded \`${conclusion || 'missing'}\`, not \`success\`.`);
    }
  }

  let state = 'passing';
  if (failures.length > 0) state = 'failed';
  else if (pendingNames.length > 0) state = 'pending';
  return { state, failures, pendingNames, evidence };
}

/**
 * Pure decision core. No I/O.
 * @returns {{ decision:'blocked'|'rejected'|'pending'|'approved', reasons:string[],
 *   riskLane:string|null, dismissStale:boolean }}
 */
export function evaluateChecker({
  config,
  pr,
  eventAction = '',
  eventHeadSha = '',
  files = [],
  checkRuns = [],
  statuses = [],
  requiredChecks = DEFAULT_REQUIRED_CHECK_POLICY,
  appSlug = DEFAULT_APP_SLUG,
  headCommitAuthorLogin = '',
  lastPusherLogin = '',
  existingAppReview = null,
  defaultBranch = 'main',
} = {}) {
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

  // A prior approval is stale by CHANGE when the PR advanced (head SHA differs)
  // or a stale-inducing lifecycle action fired (push, label, metadata edit, …).
  const priorApprovalSha = String(existingAppReview?.commit_id ?? '').trim();
  const staleByChange = Boolean(
    existingAppReview &&
      (STALE_INDUCING_ACTIONS.has(eventAction) ||
        (priorApprovalSha && priorApprovalSha.toLowerCase() !== currentHead.toLowerCase())),
  );
  // Any prior approval must also be dismissed whenever this evaluation does NOT
  // re-approve — otherwise a re-run that now fails at the same head SHA (e.g. a
  // workflow_run re-trigger) would leave a now-invalid approval standing. The
  // final value is resolved per decision below.
  const finalize = (decision, extra) => ({
    decision,
    dismissStale: Boolean(existingAppReview) && (staleByChange || decision !== 'approved'),
    ...extra,
  });

  const reasons = [];

  if (pr?.draft) reasons.push('Draft PR is never approved.');

  // Only OPEN PRs are eligible. A pull_request_target job can be queued and then
  // run after the PR is closed/merged; approving then is meaningless at best and
  // could re-open an approval race at worst. Mirrors automerge's `state === 'open'`
  // gate. Strict equality fails closed on a missing/unknown state.
  if (pr?.state !== 'open') {
    reasons.push(`PR state is \`${pr?.state ?? 'unknown'}\`, not \`open\`; only open PRs are approved.`);
  }

  // The PR must target the protected default branch. Branch protection (and thus
  // the required-check/anti-stale backstops the whole gate relies on) only
  // applies to the default branch; a same-repo PR retargeted at an unprotected
  // branch could otherwise be approved without those guarantees. Mirrors
  // automerge's `base.ref === defaultBranch` gate. `edited` (base-branch change)
  // is already a STALE_INDUCING_ACTION, so a mid-life retarget re-triggers here.
  const baseRef = pr?.base?.ref;
  if (baseRef !== defaultBranch) {
    reasons.push(`PR base ref \`${baseRef ?? 'unknown'}\` is not the protected default branch \`${defaultBranch}\`; only ${defaultBranch}-targeted PRs are approved.`);
  }

  const headRepo = pr?.head?.repo?.full_name;
  const baseRepo = pr?.base?.repo?.full_name;
  if (!headRepo || !baseRepo || headRepo !== baseRepo) {
    reasons.push('Fork PR (head repo differs from base repo) is never approved.');
  }

  if (app && normalizeLogin(pr?.user?.login) === app) {
    reasons.push('App identity equals the PR author; approval withheld (self-approval).');
  }
  if (app && normalizeLogin(lastPusherLogin) === app) {
    reasons.push('App identity equals the last pusher; approval withheld (would approve its own push).');
  }
  if (app && normalizeLogin(headCommitAuthorLogin) === app) {
    reasons.push('App identity equals the head-commit author; approval withheld (would approve its own commit).');
  }

  const expected = String(eventHeadSha ?? '').trim();
  if (!SHA_RE.test(expected) || !SHA_RE.test(currentHead)) {
    reasons.push('Head SHA is missing or malformed; cannot prove evidence freshness.');
  } else if (expected.toLowerCase() !== currentHead.toLowerCase()) {
    reasons.push(`Stale head SHA: evidence gathered for \`${expected}\` but current head is \`${currentHead}\`.`);
  }

  // Risk lane judges SHAPE only (title/labels/paths/size/actor); evidence is
  // evaluated separately below so we can distinguish "pending" from "failed".
  //
  // Bounded dependency-automation carve-out, IDENTICAL to enable-agent-automerge
  // (shared isDependencyAutomationManifestOnly): a Dependabot or lockfile-refresh
  // PR whose diff is EXCLUSIVELY dependency manifests/lockfiles may exempt that
  // one RED surface, so the App gate treats it as GREEN just like the rest of
  // autonomy. The exemption is exactly one label and evaporates the moment any
  // source/workflow/sacred non-manifest path (or .npmrc/pnpmfile/pnpm-workspace,
  // which carry a distinct non-exemptable label) appears — fail closed to RED.
  const exemptRedPathLabels = isDependencyAutomationManifestOnly(pr, files)
    ? [DEPENDENCY_MANIFEST_LABEL]
    : [];
  const classification = classifyPrRiskLane({
    title: pr?.title ?? '',
    labels: labelNames(pr),
    files,
    author: pr?.user?.login ? String(pr.user.login) : '',
    headSha: currentHead,
    expectedHeadSha: expected,
    evidence: [],
    requiredEvidence: [],
    exemptRedPathLabels,
  });
  if (classification.lane !== LANES.GREEN) {
    reasons.push(`Risk lane is ${classification.lane}; only GREEN is eligible for App approval.`);
    reasons.push(...classification.reasons.map(reason => `lane: ${reason}`));
  }

  const checkSummary = summarizeRequiredChecks(checkRuns, statuses, requiredChecks);
  if (checkSummary.state === 'failed') reasons.push(...checkSummary.failures);

  if (reasons.length > 0) {
    return finalize('rejected', { reasons, riskLane: classification.lane });
  }
  if (checkSummary.state === 'pending') {
    return finalize('pending', {
      reasons: [`Awaiting terminal state of required check(s): ${checkSummary.pendingNames.map(n => `\`${n}\``).join(', ')}.`],
      riskLane: classification.lane,
    });
  }
  return finalize('approved', {
    reasons: ['GREEN PR, fresh exact head SHA, all required checks SUCCESS from expected producers, distinct approver identity.'],
    riskLane: classification.lane,
  });
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

// Object-shaped list endpoints (check-runs: { check_runs }, combined status:
// { statuses }) are paginated too. A single page can silently drop a required
// check on commits with large build matrices, degrading the gate into a false
// negative. Page until a short page proves the list is exhausted.
export async function fetchAllPagesFromKey(ghFetch, path, token, key) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await ghFetch(`${path}${sep}per_page=100&page=${page}`, token);
    const list = Array.isArray(batch?.[key]) ? batch[key] : [];
    items.push(...list);
    if (list.length < 100) return items;
  }
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

/**
 * Resolve the OPEN, same-repo PR whose head is exactly `sha`. Used by the
 * workflow_run trigger (which lacks PR context). Returns the PR number or null.
 * Fork PRs (head repo != base repo) are ignored here and rejected downstream.
 *
 * Fail closed on ambiguity: GitHub's commits/{sha}/pulls can list several open
 * same-repo PRs when multiple branches point at the same commit. Approving is a
 * per-PR-number action, so guessing risks classifying one PR's diff and posting
 * the App approval on a different PR. If more than one candidate matches, return
 * null (no-op); each such PR is still evaluated with real context via its own
 * pull_request_target events.
 *
 * The listing is paginated: a busy commit can be the head of more than one page
 * of open PRs. Reading only page 1 would both miss a sole matching PR that
 * happens to sort onto a later page (false null → gate never approves) AND hide
 * cross-page ambiguity (two matches split across pages → a single page shows one,
 * so we'd wrongly pick it). Page fully so exact-SHA matching and the ambiguity
 * guard see every candidate.
 */
export async function resolvePrNumberForSha(ghFetch, token, repo, sha) {
  if (!SHA_RE.test(String(sha ?? ''))) return null;
  const prs = await fetchAllPages(ghFetch, `/repos/${repo}/commits/${sha}/pulls`, token);
  const matches = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (pr?.state !== 'open') continue;
    if (String(pr?.head?.sha ?? '').toLowerCase() !== String(sha).toLowerCase()) continue;
    if (pr?.head?.repo?.full_name && pr?.base?.repo?.full_name && pr.head.repo.full_name !== pr.base.repo.full_name) continue;
    matches.push(pr.number);
  }
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

async function gatherInputs(ghFetch, token, repo, prNumber) {
  const pr = await ghFetch(`/repos/${repo}/pulls/${prNumber}`, token);
  const headSha = pr?.head?.sha;
  if (!SHA_RE.test(String(headSha ?? ''))) {
    throw new Error('PR head SHA is missing or malformed.');
  }
  const [files, checkRuns, statuses, reviews, headCommit] = await Promise.all([
    fetchAllPages(ghFetch, `/repos/${repo}/pulls/${prNumber}/files`, token),
    fetchAllPagesFromKey(ghFetch, `/repos/${repo}/commits/${headSha}/check-runs`, token, 'check_runs'),
    fetchAllPagesFromKey(ghFetch, `/repos/${repo}/commits/${headSha}/status`, token, 'statuses'),
    fetchAllPages(ghFetch, `/repos/${repo}/pulls/${prNumber}/reviews`, token),
    ghFetch(`/repos/${repo}/commits/${headSha}`, token),
  ]);
  return {
    pr,
    files,
    checkRuns,
    statuses,
    reviews,
    headCommitAuthorLogin: headCommit?.author?.login ?? '',
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
      body: 'paperclip-checker: GREEN lane, fresh head SHA, all required checks SUCCESS from expected producers.',
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

async function mintAppToken(ghFetch, config, repo) {
  const { generateAppJwt, resolveCheckerInstallationId, mintInstallationToken } =
    await import('./paperclip-app-token.mjs');
  const jwt = generateAppJwt(config.appId, config.privateKey);
  const installationId = await resolveCheckerInstallationId(ghFetch, jwt, repo);
  const { token } = await mintInstallationToken(ghFetch, jwt, installationId, { repositoryName: repo.split('/')[1] });
  return token;
}

function emit(decision, extra = {}) {
  console.log(JSON.stringify({ decision, ...extra }, null, 2));
}

/**
 * Perform the post-decision side effects (dismiss stale approval → anti-TOCTOU
 * pre-submit re-read → approve) and return a structured outcome. No process.exit
 * / no logging here so the side-effect SEQUENCING is unit-testable; main() maps
 * the outcome to emit()/exit. Token minting and the three write calls are
 * injectable via `deps` for tests.
 *
 * Anti-TOCTOU + stale-dismiss coupling: `result.dismissStale` is computed from
 * the gatherInputs snapshot. If the head advances DURING evaluation, the
 * pre-submit re-read refuses to approve the now-stale commit — and, crucially,
 * also dismisses any existing App approval that was NOT already dismissed above.
 * A push mid-run can therefore never leave a stale approval standing while we
 * refuse to approve the new commit.
 */
export async function executeDecision({
  ghFetch,
  readToken,
  config,
  repo,
  prNumber,
  eventHeadSha,
  result,
  existingAppReview,
  deps = {},
}) {
  const mint = deps.mintAppToken ?? mintAppToken;
  const dismiss = deps.dismissReview ?? dismissReview;
  const approve = deps.submitApproval ?? submitApproval;
  let dismissed = false;

  // Dismiss/supersede a stale prior approval. The App token is minted here
  // (write needed). If dismissal fails, fail closed and rely on the documented
  // branch-protection backstop (dismiss_stale + last-push approval).
  if (result.dismissStale && existingAppReview) {
    try {
      const appToken = await mint(ghFetch, config, repo);
      await dismiss(ghFetch, appToken, repo, prNumber, existingAppReview.id);
      dismissed = true;
    } catch (error) {
      return { status: 'blocked', exitCode: 1, dismissed, reasons: [`Failed to dismiss stale approval: ${sanitizeError(error)}`] };
    }
  }

  if (result.decision === 'approved') {
    // Anti-TOCTOU: re-read the head SHA immediately before approving.
    let fresh;
    try {
      fresh = await ghFetch(`/repos/${repo}/pulls/${prNumber}`, readToken);
    } catch (error) {
      return { status: 'blocked', exitCode: 1, dismissed, reasons: [`Freshness re-read failed: ${sanitizeError(error)}`] };
    }
    const freshSha = String(fresh?.head?.sha ?? '').trim();
    if (!SHA_RE.test(freshSha) || freshSha.toLowerCase() !== String(eventHeadSha).toLowerCase()) {
      // Head advanced mid-run. Any existing App approval is necessarily for an
      // older commit and is now stale; dismiss it (unless already dismissed
      // above) before failing closed, so the refusal cannot coexist with a
      // standing stale approval.
      if (existingAppReview && !dismissed) {
        try {
          const appToken = await mint(ghFetch, config, repo);
          await dismiss(ghFetch, appToken, repo, prNumber, existingAppReview.id);
          dismissed = true;
        } catch (error) {
          return { status: 'blocked', exitCode: 1, dismissed, reasons: [`Head advanced during evaluation and dismissing the now-stale approval failed: ${sanitizeError(error)}`] };
        }
      }
      return { status: 'rejected', exitCode: 1, dismissed, riskLane: result.riskLane, reasons: [`Head advanced during evaluation (now ${freshSha || 'unknown'}); refusing to approve a stale commit.`] };
    }
    // Idempotency: a valid App approval may already stand for this exact,
    // freshness-confirmed head (typical on a second workflow_run at the same
    // SHA). It was NOT dismissed above (dismissStale false), so re-POSTing APPROVE
    // is redundant — and a failed resubmit would exit `blocked` and fail the
    // check despite a standing valid approval. Skip the resubmit; the guarantees
    // still hold because the anti-TOCTOU re-read above already re-confirmed the
    // head, and the standing approval targets that same commit. Only reached when
    // the prior approval's commit_id equals the fresh head and it survived the
    // dismiss-stale phase, so it can never mask a stale approval.
    const priorSha = String(existingAppReview?.commit_id ?? '').trim();
    if (existingAppReview && !dismissed && SHA_RE.test(priorSha) && priorSha.toLowerCase() === String(eventHeadSha).toLowerCase()) {
      return {
        status: 'approved',
        exitCode: 0,
        dismissed,
        riskLane: result.riskLane,
        reasons: [...result.reasons, `Existing App approval #${existingAppReview.id} already targets the current head; not resubmitting (idempotent).`],
      };
    }
    try {
      const appToken = await mint(ghFetch, config, repo);
      await approve(ghFetch, appToken, repo, prNumber, eventHeadSha);
    } catch (error) {
      return { status: 'blocked', exitCode: 1, dismissed, reasons: [`Approval token/submit failed: ${sanitizeError(error)}`] };
    }
    return { status: 'approved', exitCode: 0, dismissed, riskLane: result.riskLane, reasons: result.reasons };
  }

  if (result.decision === 'pending') {
    // Not a pass: no approval. Exit 0 so the completing CI workflow_run can
    // re-invoke us cleanly when the last required check turns green.
    return { status: 'pending', exitCode: 0, dismissed, riskLane: result.riskLane, reasons: result.reasons };
  }

  return { status: result.decision, exitCode: 1, dismissed, riskLane: result.riskLane, reasons: result.reasons };
}

async function main() {
  const config = readCheckerConfig(process.env);

  // Fail closed on config BEFORE any token mint or network call.
  if (!config.active) {
    emit('blocked', { reasons: config.reasons });
    console.error('paperclip-checker is BLOCKED (fail-closed). No approval performed.');
    process.exit(1);
  }

  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
  const eventName = String(process.env.EVENT_NAME ?? '').trim();
  const appSlugEnv = process.env.PAPERCLIP_CHECKER_APP_SLUG || '';
  const readToken = process.env.GH_READ_TOKEN;
  // Protected default branch the PR must target. Sourced from the workflow's
  // repository.default_branch (the same ref the job checks out); falls back to
  // 'main' to fail closed on a conservative default rather than skipping the gate.
  const defaultBranch = String(process.env.DEFAULT_BRANCH || 'main').trim() || 'main';

  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(String(repo ?? ''))) {
    console.error('ERROR: GH_REPO must be owner/repo.');
    process.exit(1);
  }
  if (!readToken) {
    console.error('ERROR: GH_READ_TOKEN (default GITHUB_TOKEN) is required for read access.');
    process.exit(1);
  }

  const { ghFetch } = await import('./get-bot-token.mjs');
  const policy = loadCheckerPolicy(process.env);
  const appSlug = appSlugEnv || policy.appSlug || DEFAULT_APP_SLUG;

  // ── Resolve PR + trigger-time head SHA from whichever event fired ────────
  let prNumber;
  let eventHeadSha;
  let eventAction;
  if (eventName === 'workflow_run') {
    eventHeadSha = String(process.env.WORKFLOW_RUN_HEAD_SHA ?? '').trim();
    eventAction = 'workflow_run';
    try {
      prNumber = await resolvePrNumberForSha(ghFetch, readToken, repo, eventHeadSha);
    } catch (error) {
      console.error(`paperclip-checker could not resolve a PR for the completed run: ${sanitizeError(error)}`);
      process.exit(1);
    }
    if (!prNumber) {
      // No open same-repo PR at this SHA (e.g. push build, fork, or already
      // advanced). Nothing to act on — clean no-op, not an approval.
      emit('noop', { reasons: [`No open same-repo PR found for head ${eventHeadSha}.`] });
      process.exit(0);
    }
  } else {
    prNumber = Number.parseInt(process.env.PR_NUMBER ?? '', 10);
    eventHeadSha = String(process.env.EVENT_HEAD_SHA ?? '').trim();
    eventAction = String(process.env.EVENT_ACTION ?? '').trim();
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      console.error('ERROR: PR_NUMBER must be a positive integer.');
      process.exit(1);
    }
  }

  // ── All reads use the default GITHUB_TOKEN (no App token yet) ─────────────
  let inputs;
  try {
    inputs = await gatherInputs(ghFetch, readToken, repo, prNumber);
  } catch (error) {
    console.error(`paperclip-checker read phase failed (fail-closed): ${sanitizeError(error)}`);
    process.exit(1);
  }
  const existingAppReview = findApprovedAppReview(inputs.reviews, appSlug);

  const result = evaluateChecker({
    config,
    pr: inputs.pr,
    eventAction,
    eventHeadSha,
    files: inputs.files,
    checkRuns: inputs.checkRuns,
    statuses: inputs.statuses,
    requiredChecks: policy.requiredChecks,
    appSlug,
    headCommitAuthorLogin: inputs.headCommitAuthorLogin,
    lastPusherLogin: inputs.lastPusherLogin,
    existingAppReview,
    defaultBranch,
  });

  const outcome = await executeDecision({
    ghFetch,
    readToken,
    config,
    repo,
    prNumber,
    eventHeadSha,
    result,
    existingAppReview,
  });

  if (outcome.dismissed && existingAppReview) {
    console.log(`Dismissed stale App approval #${existingAppReview.id}.`);
  }
  emit(outcome.status, {
    ...(outcome.riskLane !== undefined ? { riskLane: outcome.riskLane } : {}),
    reasons: outcome.reasons,
  });
  if (outcome.exitCode !== 0) {
    console.error(`paperclip-checker did not approve (decision=${outcome.status}). Fail-closed.`);
  }
  process.exit(outcome.exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(sanitizeError(error)); process.exit(1); });
}
