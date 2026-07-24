#!/usr/bin/env node
/**
 * paperclip-delivery-token.mjs
 * Mints a short-lived, least-privilege GitHub App installation token for the
 * dedicated "solidus-paperclip-delivery" App (installed only on this repo). The
 * Autonomy Witness workflow uses this token to BOTH push the witness branch and
 * open the witness PR, so the PR author is `solidus-paperclip-delivery[bot]` and
 * the normal `pull_request` CI events fire (events created with the built-in
 * GITHUB_TOKEN are suppressed and would leave the PR with zero required checks).
 *
 * Separation of duties: this delivery App is a DISTINCT identity from the
 * paperclip-checker App (which publishes the authoritative merge check) and from
 * the Actions runner — nothing here approves or gates its own PR.
 *
 * Fail closed: the App id + PEM are read from the two dedicated secrets
 * (PAPERCLIP_DELIVERY_APP_ID, PAPERCLIP_DELIVERY_PRIVATE_KEY). There is NO
 * GITHUB_TOKEN/PAT fallback — a missing or malformed key aborts with a non-zero
 * exit rather than silently producing an event-suppressed github-actions[bot]
 * PR. The private key and the minted token are never logged.
 *
 * Least privilege: the installation-token request DOWN-SCOPES permissions to
 * exactly what the witness needs, so even if the installed App were granted
 * more, the minted token cannot exceed this set:
 *   - `contents:write`      — push the docs-only witness branch as the App.
 *   - `pull_requests:write` — open/look-up the witness PR as the App.
 *   - `metadata:read`       — mandatory for any installation token.
 *
 * Exports: generateAppJwt, mintInstallationToken, LEAST_PRIVILEGE_PERMISSIONS,
 * resolveDeliveryInstallationId.
 */
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

// The complete permission set the delivery token is allowed to hold. Anything
// not listed is implicitly denied by GitHub. `metadata:read` is mandatory. The
// two write scopes are the only capabilities the witness exercises: push the
// branch (`contents:write`) and open/look-up the PR (`pull_requests:write`). No
// checks/admin/workflow/issues scope: the delivery App never gates a PR, never
// edits workflows, and never touches repo administration.
export const LEAST_PRIVILEGE_PERMISSIONS = Object.freeze({
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
});

export function generateAppJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const id = String(appId ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new Error('solidus-paperclip-delivery App ID is missing or not numeric.');
  }
  if (!String(privateKey ?? '').includes('PRIVATE KEY')) {
    throw new Error('solidus-paperclip-delivery private key is missing or not a PEM block.');
  }
  // iat back-dated 60s to tolerate clock skew; exp kept short (9m, under the
  // 10-minute GitHub maximum) to minimize the JWT validity window.
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: id };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

export async function resolveDeliveryInstallationId(ghFetch, jwt, repo) {
  if (!REPO_PATTERN.test(String(repo ?? ''))) {
    throw new Error('GH_REPO/GITHUB_REPOSITORY must be in owner/repo format.');
  }
  const installation = await ghFetch(`/repos/${repo}/installation`, jwt);
  if (!installation?.id) {
    throw new Error('solidus-paperclip-delivery App is not installed on this repository.');
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
    throw new Error('GitHub did not return an installation token for solidus-paperclip-delivery.');
  }
  return { token: result.token, permissions: result.permissions ?? null, expiresAt: result.expires_at ?? null };
}

async function main() {
  // Imported lazily for the generic HTTP helper only; this module has no hard
  // dependency on the commitperclip App id constant in get-bot-token.mjs.
  const { ghFetch } = await import('./get-bot-token.mjs');

  const appId = process.env.PAPERCLIP_DELIVERY_APP_ID;
  const privateKey = process.env.PAPERCLIP_DELIVERY_PRIVATE_KEY;
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;

  const jwt = generateAppJwt(appId, privateKey);
  const installationId = await resolveDeliveryInstallationId(ghFetch, jwt, repo);
  const repositoryName = repo.split('/')[1];
  const { token } = await mintInstallationToken(ghFetch, jwt, installationId, { repositoryName });
  process.stdout.write(token);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
