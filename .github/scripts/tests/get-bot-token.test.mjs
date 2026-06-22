import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFallbackToken, resolveInstallationId } from '../get-bot-token.mjs';

test('resolveFallbackToken: returns GITHUB_TOKEN with an explicit fallback warning', () => {
  assert.deepEqual(resolveFallbackToken({ GITHUB_TOKEN: 'ghs_test' }), {
    token: 'ghs_test',
    warning: 'COMMITPERCLIP_KEY is not set; using GITHUB_TOKEN fallback for PR review gates.',
  });
});

test('resolveFallbackToken: returns null when GITHUB_TOKEN is unavailable', () => {
  assert.equal(resolveFallbackToken({}), null);
});

test('resolveInstallationId: uses the repo installation endpoint when repo context is available', async () => {

  const seenPaths = [];
  const installationId = await resolveInstallationId(async (path) => {
    seenPaths.push(path);
    return { id: 42 };
  }, 'jwt', 'paperclipai/paperclip', 'paperclipai');

  assert.equal(installationId, 42);
  assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/installation']);
});

test('resolveInstallationId: falls back to the matching owner installation', async () => {
  const installationId = await resolveInstallationId(async () => ([
    { id: 1, account: { login: 'someone-else' } },
    { id: 7, account: { login: 'PaperclipAI' } },
  ]), 'jwt', undefined, 'paperclipai');

  assert.equal(installationId, 7);
});

test('resolveInstallationId: rejects ambiguous installations without repo or owner context', async () => {
  await assert.rejects(
    resolveInstallationId(async () => ([
      { id: 1, account: { login: 'org-one' } },
      { id: 2, account: { login: 'org-two' } },
    ]), 'jwt'),
    /Multiple commitperclip installations found/
  );
});
