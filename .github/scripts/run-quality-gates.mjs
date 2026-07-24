#!/usr/bin/env node
/**
 * run-quality-gates.mjs
 * Orchestrates all quality gates. Fetches PR data once, runs all gates,
 * posts or updates a single consolidated comment via commitperclip.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH
 * Exit: 0 if all quality gates pass, 1 if any fail.
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';
import { checkTemplate } from './check-pr-template.mjs';
import { checkLinkedIssue } from './check-pr-linked-issue.mjs';
import { checkDedupSearch } from './check-pr-dedup-search.mjs';
import { checkTestCoverage } from './check-pr-test-coverage.mjs';
import { checkLockfile } from './check-pr-lockfile.mjs';
import { checkDependencies } from './check-pr-dependencies.mjs';
import { checkPrGovernance } from './check-pr-governance.mjs';

const COMMENT_SIGNATURE = '— commitperclip';

// ── Autonomy-witness exemption ───────────────────────────────────────────────
// The autonomy witness PRs (green and RED) are deliberately docs-only: a single
// generated file under doc/autonomy-witness[-red]/<run_id>.md with no prose PR
// body. They therefore cannot satisfy the human-authored PR-template / linked-
// issue / dedup-search gates, which produced a false "changes needed" on genuine
// witness PRs. This is a NARROW exemption: it waives EXACTLY those three
// documentation-quality gates, and ONLY when the PR matches ALL THREE axes of the
// witness shape. Every security-relevant gate — test coverage, lockfile,
// governance, dependencies — stays fully active. It is not a bot bypass.
//
// Axis 1 — author: matched EXACTLY (no trimming, no `app/*` widening), mirroring
// the witness script's own author guard and the risk-lane classifier's
// KNOWN_ACTORS. GitHub surfaces the one Delivery App as
// `app/solidus-paperclip-delivery` (GraphQL/`gh pr view`) or
// `solidus-paperclip-delivery[bot]` (REST).
//
// Axis 2 — branch: matched by an anchored regex requiring the exact
// `autonomy-witness` or `autonomy-witness-red` namespace followed by `/` and a
// purely numeric run-id and NOTHING else. This rejects lookalikes such as
// `autonomy-witness-evil/…`, extra path segments (`autonomy-witness-red/1/2`),
// non-numeric suffixes (`autonomy-witness/abc`), and whitespace-padded copies.
//
// Axis 3 — file scope: the PR diff must be EXACTLY one file, at the generated
// witness doc path for that lane and run-id (`doc/autonomy-witness[-red]/<run_id>.md`
// where <run_id> equals the branch's numeric suffix). Any additional file, any
// non-doc change, or a mismatched run-id/path fails the exemption. File metadata
// comes from the trusted PR files API, not from anything user-controlled.
export const AUTONOMY_WITNESS_AUTHORS = new Set([
  'app/solidus-paperclip-delivery',
  'solidus-paperclip-delivery[bot]',
]);

// Retained for documentation/tests: the two exact branch namespaces. The
// authoritative match is the anchored regex below, which additionally pins the
// numeric run-id and rejects trailing segments.
export const AUTONOMY_WITNESS_BRANCH_PREFIXES = Object.freeze([
  'autonomy-witness/',
  'autonomy-witness-red/',
]);

// Anchored: exact namespace, a single `/`, a purely numeric run-id, end of
// string. The capture group is the run-id used to pin the expected doc path.
export const AUTONOMY_WITNESS_BRANCH_RE = /^autonomy-witness(-red)?\/([0-9]+)$/;

export function isAutonomyWitnessPr(author, branch, files) {
  const rawAuthor = String(author ?? '');
  const rawBranch = String(branch ?? '');

  if (!AUTONOMY_WITNESS_AUTHORS.has(rawAuthor)) return false;

  const match = AUTONOMY_WITNESS_BRANCH_RE.exec(rawBranch);
  if (!match) return false;

  const lane = match[1] ? 'autonomy-witness-red' : 'autonomy-witness';
  const runId = match[2];
  const expectedPath = `doc/${lane}/${runId}.md`;

  // Exactly one changed file, at the exact witness doc path for this lane/run-id.
  const list = Array.isArray(files) ? files : [];
  if (list.length !== 1) return false;
  const filename = typeof list[0]?.filename === 'string' ? list[0].filename : '';
  return filename === expectedPath;
}

const SKIPPED_GATE = Object.freeze({ passed: true, failures: [] });

function buildComment(author, failures, informational) {
  if (failures.length === 0 && informational.length === 0) {
    return `✅ Quality gates passing — ready for branch-protection checks and the configured review/auto-merge policy.\n\n${COMMENT_SIGNATURE}`;
  }

  const lines = [

    `Hey @${author}! Before this PR can be reviewed, a few things need attention:\n`,
  ];

  if (failures.length > 0) {
    lines.push('**Missing or incomplete:**');
    for (const f of failures) lines.push(`- [ ] ${f}`);
  }

  if (informational.length > 0) {
    if (failures.length > 0) lines.push('');
    lines.push('**Informational:**');
    for (const i of informational) lines.push(`- ${i}`);
  }

  lines.push(
    '\nOnce updated, push a new commit and these checks will re-run automatically.\n',
    COMMENT_SIGNATURE
  );

  return lines.join('\n');
}

export async function findExistingComment(fetchFromGitHub, token, repo, prNumber) {
  for (let page = 1; ; page += 1) {
    const comments = await fetchFromGitHub(
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      token
    );

    const existing = comments.find(
      c => (c.user.login === 'commitperclip[bot]' || c.user.login === 'commitperclip') &&
           c.body.includes(COMMENT_SIGNATURE)
    );
    if (existing) return existing;

    if (comments.length < 100) return null;
  }
}

async function upsertComment(token, repo, prNumber, body, existing) {
  if (existing) {
    await ghFetch(`/repos/${repo}/issues/comments/${existing.id}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  } else {
    await ghFetch(`/repos/${repo}/issues/${prNumber}/comments`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }
}

async function main() {
  const { GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH } = process.env;

  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER) {
    console.error('ERROR: GH_TOKEN, GH_REPO, PR_NUMBER env vars required');
    process.exit(1);
  }

  // Sanitize inputs before use in URL construction (prevents SSRF)
  const prNumber = parseInt(PR_NUMBER, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('ERROR: PR_NUMBER must be a positive integer');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    console.error('ERROR: GH_REPO must be in owner/repo format');
    process.exit(1);
  }

  // Fetch PR data once — gates use this, no redundant API calls
  const [pr, files] = await Promise.all([
    ghFetch(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN),
    fetchAllPullRequestFiles(ghFetch, GH_REPO, prNumber, GH_TOKEN),
  ]);

  const prBody = pr.body ?? '';
  const author = PR_AUTHOR ?? pr.user.login;
  const branch = PR_BRANCH ?? pr.head.ref;

  // Run all quality gates (pure functions run sync, deps check is async)
  const prTitle = pr.title ?? '';
  const prLabels = (pr.labels ?? []).map(label => label.name).filter(Boolean);

  // Narrow exemption for the docs-only autonomy witness PRs: waive ONLY the
  // documentation-quality gates (template / linked-issue / dedup) and keep every
  // security-relevant gate active. See isAutonomyWitnessPr above.
  const witnessExempt = isAutonomyWitnessPr(author, branch, files);
  const [templateResult, issueResult, dedupResult, testResult, lockfileResult, governanceResult, depsResult] =
    await Promise.all([
      Promise.resolve(witnessExempt ? SKIPPED_GATE : checkTemplate(prBody)),
      Promise.resolve(witnessExempt ? SKIPPED_GATE : checkLinkedIssue(prBody, prTitle)),
      Promise.resolve(witnessExempt ? SKIPPED_GATE : checkDedupSearch(prBody, prTitle)),
      Promise.resolve(checkTestCoverage(files, prTitle)),
      Promise.resolve(checkLockfile(files, author, branch)),
      Promise.resolve(checkPrGovernance({ title: prTitle, labels: prLabels, files, author })),
      checkDependencies(files, GH_TOKEN, GH_REPO, prNumber, pr.base?.ref),
    ]);

  const allFailures = [
    ...templateResult.failures,
    ...issueResult.failures,
    ...dedupResult.failures,
    ...testResult.failures,
    ...lockfileResult.failures,
    ...governanceResult.failures,
  ];

  const informational = depsResult.informational ?? [];
  const allPassed = allFailures.length === 0;

  const commentBody = buildComment(author, allFailures, informational);

  // Post comment if there are failures/informational, or update existing comment
  const existing = await findExistingComment(ghFetch, GH_TOKEN, GH_REPO, prNumber);
  if (allFailures.length > 0 || informational.length > 0 || existing) {
    await upsertComment(GH_TOKEN, GH_REPO, prNumber, commentBody, existing);
  }

  console.log(JSON.stringify({ passed: allPassed, failures: allFailures, informational }));
  process.exit(allPassed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
