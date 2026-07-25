import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findExistingComment,
  isAutonomyWitnessPr,
  buildComment,
  getQualityGatePlan,
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
  assert.equal(Object.isFrozen(AUTONOMY_WITNESS_AUTHORS), true, 'author allowlist export must be immutable');
  assert.throws(() => AUTONOMY_WITNESS_AUTHORS.push('github-actions[bot]'), TypeError);
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

test('isAutonomyWitnessPr: rename-source evasion is NOT exempt even when the destination path matches', () => {
  for (const { branch, path } of [
    { branch: 'autonomy-witness/123456', path: 'doc/autonomy-witness/123456.md' },
    { branch: 'autonomy-witness-red/123456', path: 'doc/autonomy-witness-red/123456.md' },
  ]) {
    assert.equal(
      isAutonomyWitnessPr('solidus-paperclip-delivery[bot]', branch, [{
        filename: path,
        previous_filename: '.github/workflows/pr.yml',
        status: 'renamed',
        additions: 6,
        deletions: 0,
        changes: 6,
      }]),
      false,
      `must NOT exempt sacred rename into ${path}`
    );
    // A rename entry whose previous_filename is empty/absent must STILL be
    // rejected via its status — the two signals are independent defenses.
    for (const previousFilename of ['', undefined]) {
      assert.equal(
        isAutonomyWitnessPr('solidus-paperclip-delivery[bot]', branch, [{
          filename: path,
          previous_filename: previousFilename,
          status: 'renamed',
        }]),
        false,
        `must NOT exempt status=renamed with empty previous_filename into ${path}`
      );
    }
    assert.equal(
      isAutonomyWitnessPr('solidus-paperclip-delivery[bot]', branch, [{
        filename: path,
        status: 'copied',
      }]),
      false,
      `must NOT exempt status=copied into ${path}`
    );
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

test('getQualityGatePlan: witnessExempt skips only docs-hygiene gates', () => {
  assert.deepEqual(getQualityGatePlan(true), {
    template: true,
    linkedIssue: true,
    dedupSearch: true,
    testCoverage: false,
    lockfile: false,
    governance: false,
    dependencies: false,
  });
  assert.deepEqual(getQualityGatePlan(false), {
    template: false,
    linkedIssue: false,
    dedupSearch: false,
    testCoverage: false,
    lockfile: false,
    governance: false,
    dependencies: false,
  });
});

test('buildComment: a waived run is visibly distinct from a clean pass (audit trail)', () => {
  const clean = buildComment('someone', [], [], false);
  const waived = buildComment('solidus-paperclip-delivery[bot]', [], [], true);
  assert.doesNotMatch(clean, /exemption applied/i, 'a normal pass must not claim an exemption');
  assert.match(waived, /Autonomy-witness exemption applied/, 'a waived pass must say so explicitly');
  assert.match(waived, /security-relevant gates ran/i, 'the waiver note must state what still ran');
});

test('orchestrator: main consults getQualityGatePlan as a coarse backstop', () => {
  const src = readFileSync(fileURLToPath(new URL('../run-quality-gates.mjs', import.meta.url)), 'utf8');

  assert.match(src, /const gatePlan = getQualityGatePlan\(\s*witnessExempt\s*\)/,
    'main must derive gate selection from the exported pure plan');
  for (const key of ['template', 'linkedIssue', 'dedupSearch', 'testCoverage', 'lockfile', 'governance', 'dependencies']) {
    assert.match(src, new RegExp(`gatePlan\\.${key}`), `main must consult gatePlan.${key}`);
  }
});
