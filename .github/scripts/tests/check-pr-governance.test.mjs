import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPrGovernance,
  isOpaqueTitle,
  isRawMemoryFile,
  MAX_CHANGED_FILES,
  MAX_CHANGED_LINES,
} from '../check-pr-governance.mjs';

const file = (filename, overrides = {}) => ({
  filename,
  status: 'modified',
  additions: 10,
  deletions: 0,
  changes: 10,
  ...overrides,
});

const basePr = (overrides = {}) => ({
  title: 'fix(cursor): bind anchor timestamp correctly',
  labels: [],
  author: 'contributor',
  files: [file('packages/server/src/cursor.ts')],
  ...overrides,
});

test('passes a focused reviewable PR', () => {
  const result = checkPrGovernance(basePr());
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('blocks hard-stop labels', () => {
  const result = checkPrGovernance(basePr({ labels: ['do-not-merge', 'prod-gate-required'] }));
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes('do-not-merge')));
  assert.ok(result.failures.some(failure => failure.includes('prod-gate-required')));
});

test('blocks opaque titles', () => {
  assert.equal(isOpaqueTitle('auto commit 1734567890'), true);
  assert.equal(isOpaqueTitle('update'), true);
  assert.equal(isOpaqueTitle('fix(cursor): bind anchor timestamp correctly'), false);

  const result = checkPrGovernance(basePr({ title: 'auto commit 1734567890' }));
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes('opaque')));
});

test('blocks empty PRs', () => {
  const result = checkPrGovernance(basePr({ files: [] }));
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes('no changed files')));
});

test('blocks PRs above changed-line limit without bulk exception', () => {
  const result = checkPrGovernance(basePr({
    files: [file('large.json', { additions: MAX_CHANGED_LINES + 1, deletions: 0, changes: MAX_CHANGED_LINES + 1 })],
  }));

  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes('reviewability limit')));
});

test('allows large deterministic PRs with bulk exception label', () => {
  const result = checkPrGovernance(basePr({
    labels: ['mechanical-change-approved'],
    files: [file('generated/snapshot.json', { additions: MAX_CHANGED_LINES + 1, deletions: 0, changes: MAX_CHANGED_LINES + 1 })],
  }));

  assert.equal(result.passed, true);
});

test('blocks PRs above file-count limit without bulk exception', () => {
  const files = Array.from({ length: MAX_CHANGED_FILES + 1 }, (_, index) => file(`src/file-${index}.ts`, { changes: 1 }));
  const result = checkPrGovernance(basePr({ files }));

  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes(`${MAX_CHANGED_FILES}-file`)));
});

test('detects raw memory dumps even with bulk exception label', () => {
  const raw = file('agent-memory/raw/session-001.jsonl', { additions: 50_000, changes: 50_000 });
  assert.equal(isRawMemoryFile(raw), true);

  const result = checkPrGovernance(basePr({
    labels: ['bulk-data-approved'],
    files: [raw],
  }));

  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes('Raw agent memory')));
});

test('allows deleting raw memory files when the deletion is explicitly bulk-approved', () => {
  const result = checkPrGovernance(basePr({
    labels: ['bulk-data-approved'],
    files: [file('memory/raw/old-session.json', { status: 'removed', additions: 0, deletions: 10_000, changes: 10_000 })],
  }));

  assert.equal(result.passed, true);
});

test('blocks auto-committed .ack proof files', () => {

  const result = checkPrGovernance(basePr({ files: [file('reviews/payment-change.ack')] }));
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes('.ack proof')));
});

test('requires dedicated bot identity for agent PRs', () => {
  const result = checkPrGovernance(basePr({ labels: ['agent-pr'], author: 'haykel1977' }));
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes('dedicated bot identity')));
});

test('allows agent PRs from dedicated bot identity', () => {
  const result = checkPrGovernance(basePr({ labels: ['agent-pr'], author: 'commitperclip[bot]' }));
  assert.equal(result.passed, true);
});
