import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findExistingComment,
  isAutonomyWitnessPr,
  AUTONOMY_WITNESS_AUTHORS,
  AUTONOMY_WITNESS_BRANCH_PREFIXES,
} from '../run-quality-gates.mjs';

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});

// ── Autonomy-witness exemption (isAutonomyWitnessPr) ─────────────────────────
// The exemption waives ONLY the docs-quality gates, and ONLY for the exact
// Delivery App author on the exact autonomy-witness branch namespace. It must be
// a positive, exact-match allowlist on BOTH axes — no bot bypass, no prefix/
// substring widening — so these adversarial cases prove it cannot be tricked.

test('isAutonomyWitnessPr: both exact App author forms on either witness branch are exempt', () => {
  for (const author of ['app/solidus-paperclip-delivery', 'solidus-paperclip-delivery[bot]']) {
    assert.equal(isAutonomyWitnessPr(author, 'autonomy-witness/123456'), true, `green lane: ${author}`);
    assert.equal(isAutonomyWitnessPr(author, 'autonomy-witness-red/123456'), true, `red lane: ${author}`);
  }
});

test('isAutonomyWitnessPr: exposes the exact author/prefix allowlists', () => {
  assert.deepEqual([...AUTONOMY_WITNESS_AUTHORS].sort(),
    ['app/solidus-paperclip-delivery', 'solidus-paperclip-delivery[bot]']);
  assert.deepEqual([...AUTONOMY_WITNESS_BRANCH_PREFIXES],
    ['autonomy-witness/', 'autonomy-witness-red/']);
});

test('isAutonomyWitnessPr: a correct branch with a NON-allowlisted author is NOT exempt', () => {
  for (const author of [
    'haykel1977',                              // a human
    'github-actions[bot]',                     // event-suppressed built-in token
    'commitperclip[bot]',                      // the checker identity, not the witness
    'dependabot[bot]',
    'app/solidus-paperclip-delivery-evil',     // suffixed impostor
    'app/solidus-paperclip-deliveryx',
    'app/solidus-paperclip',                   // truncated
    'solidus-paperclip-delivery',              // missing [bot]
    'app/solidus-paperclip-delivery[bot]',     // wrong combined form
    'solidus-paperclip-delivery[bot]-evil',
    ' app/solidus-paperclip-delivery',         // leading whitespace
    'app/Solidus-Paperclip-Delivery',          // case variant
  ]) {
    assert.equal(isAutonomyWitnessPr(author, 'autonomy-witness/123456'), false,
      `must NOT exempt author ${JSON.stringify(author)}`);
  }
});

test('isAutonomyWitnessPr: the exact App author on a lookalike/other branch is NOT exempt', () => {
  const author = 'solidus-paperclip-delivery[bot]';
  for (const branch of [
    'main',
    'fix/agent-change',
    'autonomy-witness',                        // no trailing slash
    'autonomy-witness-evil/123',               // stem+suffix, not the namespace
    'autonomy-witness-red-evil/123',           // red stem+suffix
    'autonomy-witnessX/123',
    ' autonomy-witness/123',                   // leading whitespace
    'x-autonomy-witness/123',                  // prefixed
    'AUTONOMY-WITNESS/123',                     // case variant
    'feature/autonomy-witness/123',            // namespace not at the start
  ]) {
    assert.equal(isAutonomyWitnessPr(author, branch), false,
      `must NOT exempt branch ${JSON.stringify(branch)}`);
  }
});

test('isAutonomyWitnessPr: missing/nullish inputs are not exempt (fail toward enforcing gates)', () => {
  assert.equal(isAutonomyWitnessPr(undefined, undefined), false);
  assert.equal(isAutonomyWitnessPr(null, null), false);
  assert.equal(isAutonomyWitnessPr('solidus-paperclip-delivery[bot]', undefined), false);
  assert.equal(isAutonomyWitnessPr(undefined, 'autonomy-witness/1'), false);
  assert.equal(isAutonomyWitnessPr('', ''), false);
});
