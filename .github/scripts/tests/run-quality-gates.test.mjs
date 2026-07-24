import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findExistingComment,
  isAutonomyWitnessPr,
  AUTONOMY_WITNESS_AUTHORS,
  AUTONOMY_WITNESS_BRANCH_PREFIXES,
  AUTONOMY_WITNESS_BRANCH_RE,
} from '../run-quality-gates.mjs';

// The single generated witness doc is the ONLY file a genuine witness PR touches.
function witnessFiles(path) {
  return [{ filename: path, status: 'added', additions: 6, deletions: 0, changes: 6 }];
}

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
// The exemption waives ONLY the docs-quality gates, and ONLY when a PR matches
// ALL THREE axes of the witness shape: the exact Delivery App author, the exact
// numeric branch namespace, AND a diff of exactly the one generated witness doc
// at the matching lane/run-id path. These adversarial cases prove it cannot be
// tricked by author lookalikes, branch lookalikes, extra segments, non-numeric
// run-ids, mismatched run-id/path, multiple files, or non-doc changes.

test('isAutonomyWitnessPr: exact author + numeric branch + matching single doc file is exempt', () => {
  for (const author of ['app/solidus-paperclip-delivery', 'solidus-paperclip-delivery[bot]']) {
    assert.equal(
      isAutonomyWitnessPr(author, 'autonomy-witness/123456', witnessFiles('doc/autonomy-witness/123456.md')),
      true, `green lane: ${author}`);
    assert.equal(
      isAutonomyWitnessPr(author, 'autonomy-witness-red/123456', witnessFiles('doc/autonomy-witness-red/123456.md')),
      true, `red lane: ${author}`);
  }
});

test('isAutonomyWitnessPr: exposes the exact author/prefix allowlists and the branch regex', () => {
  assert.deepEqual([...AUTONOMY_WITNESS_AUTHORS].sort(),
    ['app/solidus-paperclip-delivery', 'solidus-paperclip-delivery[bot]']);
  assert.deepEqual([...AUTONOMY_WITNESS_BRANCH_PREFIXES],
    ['autonomy-witness/', 'autonomy-witness-red/']);
  assert.equal(AUTONOMY_WITNESS_BRANCH_RE.source, '^autonomy-witness(-red)?\\/([0-9]+)$');
});

test('isAutonomyWitnessPr: a correct branch+file with a NON-allowlisted author is NOT exempt', () => {
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
    assert.equal(
      isAutonomyWitnessPr(author, 'autonomy-witness/123456', witnessFiles('doc/autonomy-witness/123456.md')),
      false, `must NOT exempt author ${JSON.stringify(author)}`);
  }
});

test('isAutonomyWitnessPr: the exact App author on a lookalike/malformed branch is NOT exempt', () => {
  const author = 'solidus-paperclip-delivery[bot]';
  for (const branch of [
    'main',
    'fix/agent-change',
    'autonomy-witness',                        // no trailing slash
    'autonomy-witness/',                        // no run-id
    'autonomy-witness/abc',                     // non-numeric run-id
    'autonomy-witness/123abc',                  // trailing non-digits
    'autonomy-witness/123/extra',               // extra path segment
    'autonomy-witness-red/1/2',                 // extra segment (red)
    'autonomy-witness-evil/123',               // stem+suffix, not the namespace
    'autonomy-witness-red-evil/123',           // red stem+suffix
    'autonomy-witnessX/123',
    ' autonomy-witness/123',                   // leading whitespace
    'autonomy-witness/123 ',                    // trailing whitespace
    'x-autonomy-witness/123',                  // prefixed
    'AUTONOMY-WITNESS/123',                     // case variant
    'feature/autonomy-witness/123',            // namespace not at the start
  ]) {
    // Provide a plausibly-matching file so the branch is the ONLY failing axis.
    assert.equal(
      isAutonomyWitnessPr(author, branch, witnessFiles('doc/autonomy-witness/123.md')),
      false, `must NOT exempt branch ${JSON.stringify(branch)}`);
  }
});

test('isAutonomyWitnessPr: exact author+branch but wrong FILE SCOPE is NOT exempt', () => {
  const author = 'solidus-paperclip-delivery[bot]';
  const branch = 'autonomy-witness-red/123456';
  const cases = [
    { label: 'no files', files: [] },
    { label: 'nullish files', files: undefined },
    { label: 'mismatched run-id path', files: witnessFiles('doc/autonomy-witness-red/999999.md') },
    { label: 'wrong lane path (green doc on red branch)', files: witnessFiles('doc/autonomy-witness/123456.md') },
    { label: 'non-doc file', files: witnessFiles('src/app.ts') },
    { label: 'doc but wrong subdir', files: witnessFiles('doc/other/123456.md') },
    { label: 'right file plus an extra file', files: [
      { filename: 'doc/autonomy-witness-red/123456.md', status: 'added', additions: 6, deletions: 0, changes: 6 },
      { filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
    ] },
    { label: 'two witness-shaped files', files: [
      { filename: 'doc/autonomy-witness-red/123456.md', status: 'added', additions: 6, deletions: 0, changes: 6 },
      { filename: 'doc/autonomy-witness-red/123457.md', status: 'added', additions: 6, deletions: 0, changes: 6 },
    ] },
    { label: 'path traversal lookalike', files: witnessFiles('doc/autonomy-witness-red/../../etc/passwd') },
  ];
  for (const { label, files } of cases) {
    assert.equal(isAutonomyWitnessPr(author, branch, files), false, `must NOT exempt: ${label}`);
  }
});

test('isAutonomyWitnessPr: missing/nullish inputs are not exempt (fail toward enforcing gates)', () => {
  const okFiles = witnessFiles('doc/autonomy-witness/1.md');
  assert.equal(isAutonomyWitnessPr(undefined, undefined, undefined), false);
  assert.equal(isAutonomyWitnessPr(null, null, null), false);
  assert.equal(isAutonomyWitnessPr('solidus-paperclip-delivery[bot]', undefined, okFiles), false);
  assert.equal(isAutonomyWitnessPr(undefined, 'autonomy-witness/1', okFiles), false);
  assert.equal(isAutonomyWitnessPr('', '', []), false);
});

// ── Orchestrator wiring: exactly the three docs-hygiene gates are waived ──────
// A static proof (the orchestrator's real main() does live network I/O) that the
// witness exemption gates ONLY checkTemplate / checkLinkedIssue / checkDedupSearch
// behind `witnessExempt`, and that every security-relevant gate — test coverage,
// lockfile, governance, dependencies — is invoked WITHOUT the exemption guard, so
// it can never be waived for a witness PR.
test('orchestrator: only template/linked-issue/dedup are guarded by witnessExempt', () => {
  const src = readFileSync(fileURLToPath(new URL('../run-quality-gates.mjs', import.meta.url)), 'utf8');

  for (const gate of ['checkTemplate(', 'checkLinkedIssue(', 'checkDedupSearch(']) {
    const re = new RegExp(`witnessExempt \\? SKIPPED_GATE : ${gate.replace('(', '\\(')}`);
    assert.match(src, re, `${gate} must be waived only when witnessExempt`);
  }
  for (const gate of ['checkTestCoverage(', 'checkLockfile(', 'checkPrGovernance(', 'checkDependencies(']) {
    const escaped = gate.replace('(', '\\(');
    assert.match(src, new RegExp(escaped), `${gate} must still be invoked`);
    assert.doesNotMatch(src, new RegExp(`witnessExempt \\? SKIPPED_GATE : ${escaped}`),
      `${gate} must NOT be behind the witness exemption`);
  }
});
