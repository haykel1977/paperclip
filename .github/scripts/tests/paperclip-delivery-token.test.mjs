import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  generateAppJwt,
  mintInstallationToken,
  resolveDeliveryInstallationId,
  LEAST_PRIVILEGE_PERMISSIONS,
} from '../paperclip-delivery-token.mjs';

// Adversarial unit tests for the dedicated delivery-App token minter. This is
// the fail-closed trust boundary: a bad/missing key or an empty token must
// abort rather than silently fall back to the event-suppressing GITHUB_TOKEN.

const SRC = readFileSync(fileURLToPath(new URL('../paperclip-delivery-token.mjs', import.meta.url)), 'utf8');
// Executable code only (block + line comments stripped) so the docstring, which
// legitimately explains WHY there is no GITHUB_TOKEN fallback, cannot trip the
// negative scans below.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(l => l.replace(/\/\/.*$/, ''))
  .join('\n');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

test('LEAST_PRIVILEGE_PERMISSIONS is exactly metadata:read, contents:write, pull_requests:write and frozen', () => {
  assert.deepEqual({ ...LEAST_PRIVILEGE_PERMISSIONS }, {
    metadata: 'read',
    contents: 'write',
    pull_requests: 'write',
  });
  assert.ok(Object.isFrozen(LEAST_PRIVILEGE_PERMISSIONS), 'permission set must be frozen');
  // No gate/admin scope — the delivery App must never approve or gate a PR.
  for (const forbidden of ['checks', 'administration', 'workflows', 'actions', 'issues']) {
    assert.ok(!(forbidden in LEAST_PRIVILEGE_PERMISSIONS), `must not request ${forbidden}`);
  }
});

test('no GITHUB_TOKEN/PAT fallback exists in the minter code (fail closed)', () => {
  assert.doesNotMatch(CODE, /GITHUB_TOKEN/, 'code must not reference GITHUB_TOKEN');
  assert.doesNotMatch(CODE, /resolveFallbackToken|fallback/i, 'must not import or implement a token fallback');
  assert.doesNotMatch(CODE, /\bPAT\b|personal.access.token/i, 'no PAT');
  // Reads ONLY the two dedicated delivery secrets.
  assert.match(CODE, /PAPERCLIP_DELIVERY_APP_ID/, 'reads the delivery App ID env');
  assert.match(CODE, /PAPERCLIP_DELIVERY_PRIVATE_KEY/, 'reads the delivery private key env');
  assert.doesNotMatch(CODE, /COMMITPERCLIP_KEY/, 'must not read the inaccessible commitperclip key');
});

test('generateAppJwt: rejects a missing/non-numeric App ID', () => {
  assert.throws(() => generateAppJwt('', PEM), /App ID is missing or not numeric/);
  assert.throws(() => generateAppJwt('not-a-number', PEM), /App ID is missing or not numeric/);
  assert.throws(() => generateAppJwt(undefined, PEM), /App ID is missing or not numeric/);
});

test('generateAppJwt: rejects a missing/malformed private key', () => {
  assert.throws(() => generateAppJwt('4384863', ''), /private key is missing or not a PEM block/);
  assert.throws(() => generateAppJwt('4384863', 'garbage'), /private key is missing or not a PEM block/);
});

test('generateAppJwt: mints a well-formed RS256 JWT bound to the App ID with a short expiry', () => {
  const now = 1_700_000_000;
  const jwt = generateAppJwt('4384863', PEM, now);
  const [header, body, sig] = jwt.split('.');
  assert.ok(header && body && sig, 'JWT has three parts');
  assert.deepEqual(decodeJwtPart(header), { alg: 'RS256', typ: 'JWT' });
  const payload = decodeJwtPart(body);
  assert.equal(payload.iss, '4384863');
  assert.equal(payload.iat, now - 60, 'iat back-dated for clock skew');
  assert.ok(payload.exp - now <= 10 * 60, 'exp within GitHub 10-minute maximum');
});

test('resolveDeliveryInstallationId: rejects a non owner/repo string', async () => {
  await assert.rejects(
    resolveDeliveryInstallationId(async () => ({ id: 1 }), 'jwt', 'not-a-repo'),
    /owner\/repo format/,
  );
});

test('resolveDeliveryInstallationId: fails closed when the App is not installed', async () => {
  await assert.rejects(
    resolveDeliveryInstallationId(async () => ({}), 'jwt', 'haykel1977/paperclip'),
    /not installed on this repository/,
  );
});

test('resolveDeliveryInstallationId: returns the installation id', async () => {
  const id = await resolveDeliveryInstallationId(async (path) => {
    assert.equal(path, '/repos/haykel1977/paperclip/installation');
    return { id: 555 };
  }, 'jwt', 'haykel1977/paperclip');
  assert.equal(id, 555);
});

test('mintInstallationToken: down-scopes to least privilege + single repo and returns the token', async () => {
  let sentBody = null;
  const result = await mintInstallationToken(async (path, jwt, opts) => {
    assert.equal(path, '/app/installations/555/access_tokens');
    assert.equal(opts.method, 'POST');
    sentBody = JSON.parse(opts.body);
    return { token: 'ghs_minted', permissions: sentBody.permissions, expires_at: '2026-07-24T00:00:00Z' };
  }, 'jwt', '555', { repositoryName: 'paperclip' });

  assert.equal(result.token, 'ghs_minted');
  assert.deepEqual(sentBody.permissions, { metadata: 'read', contents: 'write', pull_requests: 'write' });
  assert.deepEqual(sentBody.repositories, ['paperclip'], 'token scoped to the single repo');
});

test('mintInstallationToken: fails closed when GitHub returns no token', async () => {
  await assert.rejects(
    mintInstallationToken(async () => ({ token: '' }), 'jwt', '555', { repositoryName: 'paperclip' }),
    /did not return an installation token/,
  );
});

test('mintInstallationToken: rejects a non-numeric installation id', async () => {
  await assert.rejects(
    mintInstallationToken(async () => ({ token: 'x' }), 'jwt', 'abc', {}),
    /Installation id is missing or not numeric/,
  );
});
