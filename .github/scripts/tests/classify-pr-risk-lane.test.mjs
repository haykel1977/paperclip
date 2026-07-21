import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPrRiskLane,
  evaluateEvidence,
  matchRedPaths,
  LANES,
  MAX_GREEN_CHANGED_LINES,
  MAX_GREEN_CHANGED_FILES,
  DEFAULT_REQUIRED_EVIDENCE,
} from '../classify-pr-risk-lane.mjs';
import { MAX_CHANGED_FILES, MAX_CHANGED_LINES } from '../check-pr-governance.mjs';

const FRESH_SHA = 'a'.repeat(40);

const file = (filename, overrides = {}) => ({
  filename,
  status: 'modified',
  additions: 10,
  deletions: 0,
  changes: 10,
  ...overrides,
});

const greenEvidence = () => DEFAULT_REQUIRED_EVIDENCE.map(name => ({ name, conclusion: 'success' }));

// A baseline PR that should land GREEN so each adversarial test can flip a
// single dimension and prove it downgrades the lane.
const basePr = (overrides = {}) => ({
  title: 'fix(server): correct cursor anchor timestamp binding',
  labels: [],
  author: 'commitperclip[bot]',
  files: [file('server/src/services/cursor.ts')],
  headSha: FRESH_SHA,
  expectedHeadSha: FRESH_SHA,
  evidence: greenEvidence(),
  ...overrides,
});

test('GREEN: bounded low-risk diff by a known actor with green evidence', () => {
  const result = classifyPrRiskLane(basePr());
  assert.equal(result.lane, LANES.GREEN);
  assert.equal(result.autoMergeEligible, true);
});

// ── RED: sacred surfaces ─────────────────────────────────────────────────────

test('RED: .github/** workflow changes', () => {
  const result = classifyPrRiskLane(basePr({ files: [file('.github/workflows/pr.yml')] }));
  assert.equal(result.lane, LANES.RED);
  assert.equal(result.autoMergeEligible, false);
  assert.ok(result.reasons.some(r => r.includes('.github')));
});

test('RED: CODEOWNERS changes', () => {
  const result = classifyPrRiskLane(basePr({ files: [file('.github/CODEOWNERS')] }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('CODEOWNERS')));
});

test('RED: governance/checker code changes', () => {
  const result = classifyPrRiskLane(basePr({ files: [file('scripts/check-company-route-guards.mjs')] }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('governance/checker')));
});

test('RED: auth/authz code changes', () => {
  for (const path of ['server/src/routes/authz.ts', 'server/src/routes/workspace-command-authz.ts', 'packages/auth/index.ts']) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.RED, `expected RED for ${path}`);
  }
});

test('RED: secrets material changes', () => {
  for (const path of ['.env.production', '.gitleaks.toml', 'server/src/services/secrets.ts']) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.RED, `expected RED for ${path}`);
  }
});

test('RED: migrations/schema changes', () => {
  for (const path of ['packages/db/migrations/0007_add_column.sql', 'packages/db/src/schema/tasks.ts', 'packages/db/drizzle.config.ts']) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.RED, `expected RED for ${path}`);
  }
});

test('RED: infrastructure/release/production changes', () => {
  for (const path of ['Dockerfile', 'docker/entrypoint.sh', 'scripts/release.sh', 'releases/v1.json', 'infra/main.tf']) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.RED, `expected RED for ${path}`);
  }
});

test('RED: dependency manifests and lockfiles', () => {
  for (const path of ['package.json', 'server/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'yarn.lock']) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.RED, `expected RED for ${path}`);
    assert.ok(result.reasons.some(r => r.includes('dependency manifest/lockfile')));
  }
});

test('RED: excessive diff by line count', () => {
  const result = classifyPrRiskLane(basePr({
    files: [file('server/src/big.ts', { additions: MAX_CHANGED_LINES + 1, changes: MAX_CHANGED_LINES + 1 })],
  }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('Excessive diff size')));
});

test('RED: excessive diff by file count', () => {
  const files = Array.from({ length: MAX_CHANGED_FILES + 1 }, (_, i) => file(`server/src/f${i}.ts`, { changes: 1 }));
  const result = classifyPrRiskLane(basePr({ files }));
  assert.equal(result.lane, LANES.RED);
});

// ── RED: fail-closed conditions ──────────────────────────────────────────────

test('RED: unknown actor fails closed', () => {
  const result = classifyPrRiskLane(basePr({ author: 'random-contributor' }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('not a recognized autonomy identity')));
});

test('RED: hard-block label fails closed', () => {
  const result = classifyPrRiskLane(basePr({ labels: ['do-not-merge'] }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('do-not-merge')));
});

test('RED: contradictory lane-hint labels', () => {
  const result = classifyPrRiskLane(basePr({ labels: ['risk:green', 'risk:red'] }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('Contradictory risk-lane labels')));
});

test('RED: automerge requested alongside a hard-block label', () => {
  const result = classifyPrRiskLane(basePr({ labels: ['automerge', 'human-gate-required'] }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('Contradictory labels')));
});

test('RED: stale head SHA fails closed', () => {
  const result = classifyPrRiskLane(basePr({ headSha: 'b'.repeat(40), expectedHeadSha: FRESH_SHA }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('Stale PR head SHA')));
});

test('RED: malformed head SHA fails closed', () => {
  const result = classifyPrRiskLane(basePr({ headSha: 'not-a-sha', expectedHeadSha: FRESH_SHA }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('could not be validated')));
});

test('RED: neutral required evidence fails closed', () => {
  const result = classifyPrRiskLane(basePr({
    evidence: [{ name: 'verify', conclusion: 'neutral' }, { name: 'gitleaks', conclusion: 'success' }],
  }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('neutral/skipped/failing')));
});

test('RED: skipped required evidence fails closed', () => {
  const result = classifyPrRiskLane(basePr({
    evidence: [{ name: 'verify', conclusion: 'skipped' }, { name: 'gitleaks', conclusion: 'success' }],
  }));
  assert.equal(result.lane, LANES.RED);
});

test('RED: missing required evidence fails closed', () => {
  const result = classifyPrRiskLane(basePr({ evidence: [{ name: 'verify', conclusion: 'success' }] }));
  assert.equal(result.lane, LANES.RED);
  assert.ok(result.reasons.some(r => r.includes('Missing required evidence')));
});

test('RED: empty file list fails closed', () => {
  const result = classifyPrRiskLane(basePr({ files: [] }));
  assert.equal(result.lane, LANES.RED);
});

test('RED: opaque title fails closed', () => {
  const result = classifyPrRiskLane(basePr({ title: 'update' }));
  assert.equal(result.lane, LANES.RED);
});

test('RED: non-array files input fails closed', () => {
  const result = classifyPrRiskLane(basePr({ files: null }));
  assert.equal(result.lane, LANES.RED);
});

test('RED: explicit risk:red label with an otherwise-clean diff', () => {
  const result = classifyPrRiskLane(basePr({ labels: ['risk:red'] }));
  assert.equal(result.lane, LANES.RED);
});

// ── ORANGE ───────────────────────────────────────────────────────────────────

test('ORANGE: bounded-safe surface but larger than the GREEN size bound', () => {
  const result = classifyPrRiskLane(basePr({
    files: [file('server/src/moderate.ts', {
      additions: MAX_GREEN_CHANGED_LINES + 1,
      changes: MAX_GREEN_CHANGED_LINES + 1,
    })],
  }));
  assert.equal(result.lane, LANES.ORANGE);
  assert.equal(result.autoMergeEligible, false);
});

test('ORANGE: file count above the GREEN bound but below the RED limit', () => {
  const files = Array.from({ length: MAX_GREEN_CHANGED_FILES + 1 }, (_, i) => file(`ui/src/c${i}.tsx`, { changes: 1 }));
  const result = classifyPrRiskLane(basePr({ files }));
  assert.equal(result.lane, LANES.ORANGE);
});

test('ORANGE: explicit risk:orange label', () => {
  const result = classifyPrRiskLane(basePr({ labels: ['risk:orange'] }));
  assert.equal(result.lane, LANES.ORANGE);
});

test('ORANGE never auto-merges by default', () => {
  const result = classifyPrRiskLane(basePr({ labels: ['risk:orange'] }));
  assert.equal(result.autoMergeEligible, false);
});

// ── Precedence: RED wins over ORANGE ─────────────────────────────────────────

test('RED wins when a large diff also touches a sacred surface', () => {
  const result = classifyPrRiskLane(basePr({
    files: [
      file('package.json'),
      file('server/src/moderate.ts', { additions: MAX_GREEN_CHANGED_LINES + 1, changes: MAX_GREEN_CHANGED_LINES + 1 }),
    ],
  }));
  assert.equal(result.lane, LANES.RED);
});

// ── Unit helpers ─────────────────────────────────────────────────────────────

test('matchRedPaths ignores removed files', () => {
  assert.deepEqual(matchRedPaths([file('package.json', { status: 'removed' })]), []);
});

test('evaluateEvidence flags missing and non-passing separately', () => {
  const result = evaluateEvidence(
    [{ name: 'verify', conclusion: 'neutral' }],
    ['verify', 'gitleaks'],
  );
  assert.deepEqual(result.missing, ['gitleaks']);
  assert.equal(result.notPassing.length, 1);
  assert.equal(result.allPassing, false);
});

test('evaluateEvidence: undefined evidence is all missing (fail closed)', () => {
  const result = evaluateEvidence(undefined, ['verify']);
  assert.deepEqual(result.missing, ['verify']);
  assert.equal(result.allPassing, false);
});
