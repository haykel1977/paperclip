#!/usr/bin/env node
/**
 * paperclip-app-token.mjs
 * Mints a short-lived, least-privilege GitHub App installation token for the
 * FUTURE independent "paperclip-checker" App. This is intentionally separate
 * from get-bot-token.mjs (the commitperclip App): the checker is a distinct
 * identity so its approvals are attributable and can be required as a
 * "last-push must not be by the approver" signal under branch protection.
 *
 * The App ID and PEM private key are read from configuration (env), never
 * hardcoded, because the App does not exist yet — activation is blocked until a
 * maintainer creates the App and installs the ID/key as secrets (see
 * doc/PAPERCLIP-CHECKER.md).
 *
 * Least privilege: the installation-token request DOWN-SCOPES permissions to
 * exactly what the checker WRITES, so even if the installed App is granted
 * more, the minted token cannot exceed this set. All READS (PR, files, labels,
 * check-runs, statuses, commit) are performed with the workflow's default
 * GITHUB_TOKEN, so this App token needs no read scopes beyond the mandatory
 * `metadata:read`. Its privileged capabilities are exactly two writes:
 *   - `checks:write` — the AUTHORITATIVE merge signal. The App creates/updates a
 *     distinct check run (`paperclip-checker/app`) on the exact PR head; only a
 *     write-privileged App identity can publish it, and it is what branch
 *     protection requires (a GitHub App review has author-association NONE and
 *     therefore can never satisfy required_approving_review_count).
 *   - `pull_requests:write` — submitting/dismissing the App's own PR review,
 *     retained only as an audit trail; merge eligibility does NOT depend on it.
 * This token is minted ONLY when the checker is about to write — never for
 * read-only evaluation.
 *
 * Exports: generateAppJwt, mintInstallationToken, LEAST_PRIVILEGE_PERMISSIONS,
 * resolveCheckerInstallationId.
 */
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

// The complete permission set the checker token is allowed to hold. Anything
// not listed is implicitly denied by GitHub. `metadata:read` is mandatory for
// any token. The two write scopes are the only capabilities the App exercises:
// `checks:write` publishes the authoritative `paperclip-checker/app` check run
// (the required merge signal), and `pull_requests:write` submits/dismisses the
// App's own audit review. No code/content/status/workflow/admin/issues scope is
// present: the checker never pushes code, never edits workflows, and never
// touches repo administration. Reads use the default GITHUB_TOKEN.
export const LEAST_PRIVILEGE_PERMISSIONS = Object.freeze({
  metadata: 'read',
  checks: 'write',
  pull_requests: 'write',
});

export function generateAppJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const id = String(appId ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new Error('paperclip-checker App ID is missing or not numeric.');
  }
  if (!String(privateKey ?? '').includes('PRIVATE KEY')) {
    throw new Error('paperclip-checker private key is missing or not a PEM block.');
  }
  // iat back-dated 60s to tolerate clock skew; exp capped at the 10-minute
  // GitHub maximum but kept short (9m) to minimize the JWT validity window.
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: id };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

export async function resolveCheckerInstallationId(ghFetch, jwt, repo) {
  if (!REPO_PATTERN.test(String(repo ?? ''))) {
    throw new Error('GH_REPO/GITHUB_REPOSITORY must be in owner/repo format.');
  }
  const installation = await ghFetch(`/repos/${repo}/installation`, jwt);
  if (!installation?.id) {
    throw new Error('paperclip-checker App is not installed on this repository.');
  }
  return installation.id;
}

/**
 * Request an installation access token restricted to LEAST_PRIVILEGE_PERMISSIONS
 * and (when a repo is known) to that single repository. Fails closed: any error
 * or an empty token throws so no caller can proceed with a bad token.
 */
export async function mintInstallationToken(ghFetch, jwt, installationId, { repositoryName } = {}) {
  const id = String(installationId ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new Error('Installation id is missing or not numeric.');
  }
  const body = { permissions: { ...LEAST_PRIVILEGE_PERMISSIONS } };
  if (repositoryName) body.repositories = [repositoryName];

  const result = await ghFetch(`/app/installations/${id}/access_tokens`, jwt, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!result?.token) {
    throw new Error('GitHub did not return an installation token for paperclip-checker.');
  }
  return { token: result.token, permissions: result.permissions ?? null, expiresAt: result.expires_at ?? null };
}

async function main() {
  // Imported lazily so this module has no hard dependency on the commitperclip
  // App id constant in get-bot-token.mjs; only the generic HTTP helper is used.
  const { ghFetch } = await import('./get-bot-token.mjs');

  const appId = process.env.PAPERCLIP_CHECKER_APP_ID;
  const privateKey = process.env.PAPERCLIP_CHECKER_PRIVATE_KEY;
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;

  const jwt = generateAppJwt(appId, privateKey);
  const installationId = await resolveCheckerInstallationId(ghFetch, jwt, repo);
  const repositoryName = repo.split('/')[1];
  const { token } = await mintInstallationToken(ghFetch, jwt, installationId, { repositoryName });
  process.stdout.write(token);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
