#!/usr/bin/env node
/**
 * get-bot-token.mjs
 * Generates a short-lived GitHub installation token for the commitperclip app.
 * Reads COMMITPERCLIP_KEY env var (PEM content of private key).
 * Prints the token to stdout.
 *
 * Also exports: generateJWT(privateKey), ghFetch(path, token, options)
 * These are used by all other gate scripts.
 */
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP_ID = '3718661';
const OWNER_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function generateJWT(privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 10, exp: now + 60, iss: APP_ID };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

export async function ghFetch(path, token, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GitHub API ${options.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
    /** @type {number} */
    err.statusCode = res.status;
    throw err;
  }
  return JSON.parse(text);
}

export async function resolveInstallationId(fetchInstallation, token, repo, owner) {
  if (repo) {
    if (!REPO_PATTERN.test(repo)) {
      throw new Error('ERROR: GH_REPO/GITHUB_REPOSITORY must be in owner/repo format.');
    }

    const installation = await fetchInstallation(`/repos/${repo}/installation`, token);
    return installation.id;
  }

  const installations = await fetchInstallation('/app/installations', token);
  if (!installations.length) {
    throw new Error(
      'ERROR: No installations found for commitperclip. Install URL: https://github.com/apps/commitperclip/installations/new'
    );
  }

  if (owner) {
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error('ERROR: GITHUB_REPOSITORY_OWNER must be a valid GitHub owner name.');
    }

    const match = installations.find(
      installation => installation.account?.login?.toLowerCase() === owner.toLowerCase()
    );

    if (match) {
      return match.id;
    }
  }

  if (installations.length === 1) {
    return installations[0].id;
  }

  throw new Error(
    'ERROR: Multiple commitperclip installations found. Set GH_REPO or GITHUB_REPOSITORY so the correct installation can be selected.'
  );
}

export function resolveFallbackToken(env = process.env) {
  const fallback = env.GITHUB_TOKEN;
  if (!fallback) return null;
  return {
    token: fallback,
    warning: 'COMMITPERCLIP_KEY is not set; using GITHUB_TOKEN fallback for PR review gates.',
  };
}

async function main() {
  const privateKey = process.env.COMMITPERCLIP_KEY;
  if (!privateKey) {
    const fallback = resolveFallbackToken();
    if (fallback) {
      console.error(`WARNING: ${fallback.warning}`);
      process.stdout.write(fallback.token);
      return;
    }
    console.error('ERROR: COMMITPERCLIP_KEY env var not set and GITHUB_TOKEN fallback is unavailable.');
    console.error('Add COMMITPERCLIP_KEY as a repository secret or run inside GitHub Actions with GITHUB_TOKEN.');
    process.exit(1);
  }

  try {
    const jwt = generateJWT(privateKey);

    const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
    const owner = process.env.GITHUB_REPOSITORY_OWNER ?? repo?.split('/')[0];

    const installationId = await resolveInstallationId(ghFetch, jwt, repo, owner);

    const { token } = await ghFetch(
      `/app/installations/${installationId}/access_tokens`,
      jwt,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } }
    );

    if (!token) {
      throw new Error('ERROR: Failed to get installation token from GitHub API.');
    }

    process.stdout.write(token);
  } catch (error) {
    const fallback = resolveFallbackToken();
    if (!fallback) throw error;

    console.error(`WARNING: Could not mint commitperclip installation token (${error.message}). Falling back to GITHUB_TOKEN.`);
    process.stdout.write(fallback.token);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
