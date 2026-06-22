#!/usr/bin/env node
/**
 * check-branch-protection.mjs
 * Reports whether the default branch (main) has the recommended protections.
 * READ-ONLY: this script never changes repository settings — it only reads the
 * branch-protection API and prints a report. Enforcement of the settings remains
 * a manual maintainer action (see doc/SECURITY-BRANCH-PROTECTION.md).
 *
 * Env:
 *   GH_TOKEN (or GITHUB_TOKEN) — token with repo read access
 *   GH_REPO                    — owner/repo (defaults to GITHUB_REPOSITORY)
 *   BRANCH                     — branch to check (default: main)

 *   STRICT                     — when "1"/"true", exit non-zero if any
 *                                recommended protection is missing. Default is
 *                                report-only (always exit 0) so it is safe to
 *                                wire into CI without blocking.
 *
 * Usage:
 *   GH_REPO=owner/repo GH_TOKEN=… node .github/scripts/check-branch-protection.mjs
 *   node .github/scripts/check-branch-protection.mjs   # uses `gh api` auth
 */
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// ── Pure evaluation (exported for testing) ────────────────────────────────────

export const REQUIRED_STATUS_CHECKS = ['verify', 'gitleaks'];

function requiredCheckNames(protection) {
  const requiredStatusChecks = protection?.required_status_checks;
  const contexts = Array.isArray(requiredStatusChecks?.contexts) ? requiredStatusChecks.contexts : [];
  const checks = Array.isArray(requiredStatusChecks?.checks)
    ? requiredStatusChecks.checks.map(check => check?.context).filter(Boolean)
    : [];
  return new Set([...contexts, ...checks].map(check => String(check)));
}

/**
 * Recommended protections for the default branch. Each entry maps a
 * human-readable requirement to a predicate over the GitHub branch-protection
 * payload (https://docs.github.com/rest/branches/branch-protection).
 */
export const RECOMMENDED = [
  {
    id: 'required-pull-request-reviews',
    label: 'Require a pull request before merging',
    ok: (p) => Boolean(p?.required_pull_request_reviews),
  },
  {
    id: 'required-approving-reviews',
    label: 'Require at least one approving review',
    ok: (p) => (p?.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1,
  },
  {
    id: 'required-status-checks',
    label: 'Require status checks to pass before merging',
    ok: (p) => Boolean(p?.required_status_checks),
  },
  {
    id: 'strict-status-checks',
    label: 'Require branches to be up to date before merging',
    ok: (p) => p?.required_status_checks?.strict === true,
  },
  ...REQUIRED_STATUS_CHECKS.map(check => ({
    id: `required-check-${check}`,
    label: `Require status check \`${check}\``,
    ok: (p) => requiredCheckNames(p).has(check),
  })),
  {
    id: 'enforce-admins',
    label: 'Include administrators (enforce_admins)',
    ok: (p) => Boolean(p?.enforce_admins?.enabled),
  },
  {
    id: 'block-force-pushes',
    label: 'Block force pushes',
    ok: (p) => p?.allow_force_pushes?.enabled === false,
  },
  {
    id: 'block-deletions',
    label: 'Block branch deletion',
    ok: (p) => p?.allow_deletions?.enabled === false,
  },
];

/**
 * Evaluate a branch-protection payload against the recommended settings.
 * @param {object|null} protection - payload from the branch-protection API, or
 *   null when protection is entirely absent (API returned 404).
 * @returns {{ protected: boolean, missing: string[], satisfied: string[] }}
 */
export function evaluateProtection(protection) {
  if (!protection) {
    return {
      protected: false,
      missing: RECOMMENDED.map((r) => r.label),
      satisfied: [],
    };
  }

  const missing = [];
  const satisfied = [];
  for (const rule of RECOMMENDED) {
    (rule.ok(protection) ? satisfied : missing).push(rule.label);
  }
  return { protected: true, missing, satisfied };
}

/**
 * Build a human-readable multi-line report from an evaluation result.
 */
export function formatReport(repo, branch, result) {
  const lines = [`Branch protection report for ${repo}@${branch}`, ''];

  if (!result.protected) {
    lines.push('  ✗ No branch protection rule is configured for this branch.');
    lines.push('');
    lines.push('  Recommended protections (all missing):');
    for (const label of result.missing) lines.push(`    - ${label}`);
    lines.push('');
    lines.push('  See doc/SECURITY-BRANCH-PROTECTION.md to enable these settings.');
    return lines.join('\n');
  }

  for (const label of result.satisfied) lines.push(`  ✓ ${label}`);
  for (const label of result.missing) lines.push(`  ✗ ${label}`);
  lines.push('');
  lines.push(
    result.missing.length === 0
      ? '  All recommended protections are enabled.'
      : `  ${result.missing.length} recommended protection(s) missing — see doc/SECURITY-BRANCH-PROTECTION.md.`,
  );
  return lines.join('\n');
}

// ── GitHub access ─────────────────────────────────────────────────────────────

function isTruthy(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Fetch the branch-protection payload. Returns null on 404 (no protection).
 * Prefers a token+fetch path; falls back to the `gh` CLI when no token is set.
 */
async function fetchProtection(repo, branch, token) {
  const path = `/repos/${repo}/branches/${branch}/protection`;

  if (token) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'paperclip-branch-protection-check',
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} for ${path}: ${await res.text()}`);
    }
    return res.json();
  }

  // No token: fall back to the `gh` CLI, which carries its own auth.
  try {
    const out = execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (err) {
    const stderr = String(err.stderr ?? err.message ?? '');
    if (stderr.includes('Not Found') || stderr.includes('404')) return null;
    throw new Error(`gh api ${path} failed: ${stderr.trim()}`);
  }
}

async function main() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const branch = process.env.BRANCH || 'main';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

  const strict = isTruthy((process.env.STRICT || '').toLowerCase());

  if (!repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    console.error('ERROR: GH_REPO (or GITHUB_REPOSITORY) must be set to owner/repo.');
    process.exit(2);
  }

  const protection = await fetchProtection(repo, branch, token);
  const result = evaluateProtection(protection);
  console.log(formatReport(repo, branch, result));

  if (strict && (!result.protected || result.missing.length > 0)) {
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(2);
  });
}
