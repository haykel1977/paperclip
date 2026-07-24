import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPrRiskLane,
  evaluateEvidence,
  matchRedPaths,
  isDependencyManifestOnly,
  isDependencyAutomationManifestOnly,
  resolveNumstatNewPath,
  parseNameStatusOutput,
  parseNumstatOutput,
  LANES,
  MAX_GREEN_CHANGED_LINES,
  MAX_GREEN_CHANGED_FILES,
  DEFAULT_REQUIRED_EVIDENCE,
  DEPENDENCY_MANIFEST_LABEL,
  KNOWN_ACTORS,
} from '../classify-pr-risk-lane.mjs';
import { MAX_CHANGED_FILES, MAX_CHANGED_LINES } from '../check-pr-governance.mjs';

test('KNOWN_ACTORS: the dedicated delivery App is an autonomous actor; humans are not', () => {
  assert.ok(KNOWN_ACTORS.has('solidus-paperclip-delivery[bot]'),
    'the witness author must be able to reach the autonomous GREEN lane');
  assert.ok(!KNOWN_ACTORS.has('haykel1977'), 'humans must not be autonomous actors');
});

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

test('a docs-only witness PR authored by the delivery App reaches GREEN', () => {
  const result = classifyPrRiskLane({
    title: 'docs(autonomy-witness): witness run 123',
    labels: [],
    author: 'solidus-paperclip-delivery[bot]',
    files: [file('doc/autonomy-witness/123.md', { additions: 12, changes: 12 })],
    headSha: FRESH_SHA,
    expectedHeadSha: FRESH_SHA,
    evidence: DEFAULT_REQUIRED_EVIDENCE.map(name => ({ name, conclusion: 'success' })),
    requiredEvidence: [...DEFAULT_REQUIRED_EVIDENCE],
  });
  assert.equal(result.lane, LANES.GREEN);
});

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
  for (const path of ['package.json', 'server/package.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.RED, `expected RED for ${path}`);
    assert.ok(result.reasons.some(r => r.includes('dependency manifest/lockfile')));
  }
});

test('RED: install-hook/registry configs are RED under their own non-exemptable label', () => {
  for (const path of ['pnpm-workspace.yaml', '.npmrc', 'pnpmfile.cjs']) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.RED, `expected RED for ${path}`);
    assert.ok(result.reasons.some(r => r.includes('install-hook/registry')));
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

// ── RED: deleting a sacred surface (fail-open hole the review caught) ─────────

test('RED: deleting a sacred surface reaches RED, never GREEN', () => {
  const deletions = [
    '.github/workflows/secret-scan.yml',
    '.github/CODEOWNERS',
    '.gitleaks.toml',
    'server/src/routes/authz.ts',
    'packages/shared/src/validators/access.ts',
    'packages/db/migrations/0007_add_column.sql',
    'pnpm-lock.yaml',
  ];
  for (const path of deletions) {
    const result = classifyPrRiskLane(basePr({
      files: [file(path, { status: 'removed', additions: 0, deletions: 20, changes: 20 })],
    }));
    assert.equal(result.lane, LANES.RED, `expected RED for deletion of ${path}`);
  }
});

test('RED: renaming a sacred file out of a matched path stays RED', () => {
  const result = classifyPrRiskLane(basePr({
    files: [file('docs/notes.md', {
      status: 'renamed',
      previous_filename: '.github/workflows/deploy.yml',
      additions: 1,
      changes: 1,
    })],
  }));
  assert.equal(result.lane, LANES.RED);
});

// ── RED: broadened auth/authz vocabulary against the repo's real paths ────────

test('RED: repo-realistic authorization surfaces classify RED', () => {
  const authzPaths = [
    'packages/adapters/claude-local/src/server/permissions.ts',
    'server/src/services/access.ts',
    'packages/shared/src/validators/access.ts',
    'packages/shared/src/types/access.ts',
    'packages/db/src/schema/principal_permission_grants.ts',
    'server/src/services/agent-permissions.ts',
    'server/src/services/invite-grants.ts',
    'cli/src/client/board-auth.ts',
  ];
  for (const path of authzPaths) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.RED, `expected RED for ${path}`);
    assert.ok(result.reasons.some(r => r.includes('auth/authz')), `expected auth/authz reason for ${path}`);
  }
});

test('GREEN: authz-adjacent names are not false-positived', () => {
  for (const path of [
    'ui/src/components/Accessibility.tsx',
    'server/src/services/data-access.ts',
    'server/src/lib/grantham.ts',
  ]) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.GREEN, `expected GREEN (no false positive) for ${path}`);
  }
});

// ── Dependency-manifest exemption (bounded, verifiable) ───────────────────────

test('isDependencyManifestOnly: true only when every path is a manifest', () => {
  assert.equal(isDependencyManifestOnly([file('pnpm-lock.yaml'), file('server/package.json')]), true);
  assert.equal(isDependencyManifestOnly([file('pnpm-lock.yaml'), file('.github/workflows/pr.yml')]), false);
  assert.equal(isDependencyManifestOnly([]), false);
});

test('dependency exemption: manifest-only diff can reach GREEN when exempted', () => {
  const result = classifyPrRiskLane(basePr({
    author: 'dependabot[bot]',
    files: [file('pnpm-lock.yaml'), file('package.json')],
    exemptRedPathLabels: [DEPENDENCY_MANIFEST_LABEL],
  }));
  assert.equal(result.lane, LANES.GREEN);
});

test('dependency exemption does NOT rescue a diff that also touches another sacred surface', () => {
  const result = classifyPrRiskLane(basePr({
    author: 'dependabot[bot]',
    files: [file('pnpm-lock.yaml'), file('.github/workflows/pr.yml')],
    exemptRedPathLabels: [DEPENDENCY_MANIFEST_LABEL],
  }));
  assert.equal(result.lane, LANES.RED);
});

// ── Unit helpers ─────────────────────────────────────────────────────────────

test('matchRedPaths catches removed sacred files (deletion is high-blast-radius)', () => {
  const hits = matchRedPaths([file('package.json', { status: 'removed' })]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, DEPENDENCY_MANIFEST_LABEL);
});

test('matchRedPaths judges the rename source (previous_filename), not just the new path', () => {
  // Renaming a sacred file to an innocuous path must still be RED.
  const hits = matchRedPaths([
    file('server/src/services/notes.ts', { status: 'renamed', previous_filename: 'server/src/routes/authz.ts' }),
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, 'auth/authz');
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

// ── Exemption subset: install-hook / registry configs stay RED ────────────────

test('RED: .npmrc and pnpmfile.* are RED even when the exemption label is applied', () => {
  for (const path of ['.npmrc', 'server/.npmrc', 'pnpmfile.cjs', 'pnpmfile.js', 'pnpmfile.mjs', 'packages/x/pnpmfile.cjs', 'pnpm-workspace.yaml']) {
    const result = classifyPrRiskLane(basePr({
      author: 'dependabot[bot]',
      files: [file(path)],
      exemptRedPathLabels: [DEPENDENCY_MANIFEST_LABEL],
    }));
    assert.equal(result.lane, LANES.RED, `expected RED for ${path} despite exemption`);
    assert.ok(
      result.reasons.some(r => r.includes('install-hook/registry')),
      `expected install-hook/registry reason for ${path}`,
    );
  }
});

test('isDependencyManifestOnly: install-hook/registry configs are NOT manifest-only', () => {
  assert.equal(isDependencyManifestOnly([file('.npmrc')]), false);
  assert.equal(isDependencyManifestOnly([file('pnpmfile.cjs')]), false);
  assert.equal(isDependencyManifestOnly([file('pnpm-workspace.yaml')]), false);
  assert.equal(isDependencyManifestOnly([file('pnpm-lock.yaml'), file('.npmrc')]), false);
});

// ── isDependencyAutomationManifestOnly: shared, narrowly-bounded carve-out ──
// The single precondition both enable-agent-automerge and the paperclip-checker
// App gate use to exempt the dependency-manifest RED surface. It must be true
// ONLY for a trusted producer whose diff is exclusively manifests.

const manifestFiles = () => [file('pnpm-lock.yaml'), file('server/package.json')];
const depPr = (over = {}) => ({ user: { login: 'dependabot[bot]' }, head: { ref: 'dependabot/npm_and_yarn/x' }, ...over });

test('isDependencyAutomationManifestOnly: Dependabot + manifest-only diff → true', () => {
  assert.equal(isDependencyAutomationManifestOnly(depPr(), manifestFiles()), true);
});

test('isDependencyAutomationManifestOnly: lockfile-refresh bot on chore/refresh-lockfile + manifest-only → true', () => {
  const pr = { user: { login: 'github-actions[bot]' }, head: { ref: 'chore/refresh-lockfile' } };
  assert.equal(isDependencyAutomationManifestOnly(pr, manifestFiles()), true);
});

test('isDependencyAutomationManifestOnly: github-actions on a DIFFERENT branch → false', () => {
  const pr = { user: { login: 'github-actions[bot]' }, head: { ref: 'feature/whatever' } };
  assert.equal(isDependencyAutomationManifestOnly(pr, manifestFiles()), false);
});

test('isDependencyAutomationManifestOnly: untrusted author, even manifest-only → false', () => {
  const pr = { user: { login: 'mallory' }, head: { ref: 'chore/refresh-lockfile' } };
  assert.equal(isDependencyAutomationManifestOnly(pr, manifestFiles()), false);
});

test('isDependencyAutomationManifestOnly: Dependabot touching a non-manifest path → false', () => {
  assert.equal(isDependencyAutomationManifestOnly(depPr(), [file('pnpm-lock.yaml'), file('.github/workflows/pr.yml')]), false);
  assert.equal(isDependencyAutomationManifestOnly(depPr(), [file('pnpm-lock.yaml'), file('server/src/auth.ts')]), false);
  // .npmrc / pnpmfile are NOT manifests → precondition fails outright.
  assert.equal(isDependencyAutomationManifestOnly(depPr(), [file('pnpm-lock.yaml'), file('.npmrc')]), false);
});

test('isDependencyAutomationManifestOnly: empty/missing inputs → false (fail closed)', () => {
  assert.equal(isDependencyAutomationManifestOnly(depPr(), []), false);
  assert.equal(isDependencyAutomationManifestOnly(undefined, manifestFiles()), false);
});

test('exemption does NOT rescue a pnpmfile/.npmrc even for a lockfile-only-looking diff', () => {
  // A dependency-automation actor editing pnpmfile.cjs must not reach GREEN: the
  // exemption label only waives the lockfile/package.json label, and pnpmfile
  // carries the distinct non-exemptable install-hook label.
  const result = classifyPrRiskLane(basePr({
    author: 'dependabot[bot]',
    files: [file('pnpm-lock.yaml'), file('pnpmfile.cjs')],
    exemptRedPathLabels: [DEPENDENCY_MANIFEST_LABEL],
  }));
  assert.equal(result.lane, LANES.RED);
});

// ── camelCase / PascalCase auth vocabulary (future-facing) ───────────────────

test('RED: camelCase/PascalCase authorization file names classify RED', () => {
  const authzPaths = [
    'server/src/authMiddleware.ts',
    'server/src/AuthGuard.ts',
    'server/src/authorizationService.ts',
    'server/src/permissionsService.ts',
    'ui/src/PermissionChecker.tsx',
    'ui/src/AccessControl.tsx',
    'server/src/oauthProvider.ts',
    'server/src/agent.permissions.ts',
  ];
  for (const path of authzPaths) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.RED, `expected RED for ${path}`);
    assert.ok(result.reasons.some(r => r.includes('auth/authz')), `expected auth/authz reason for ${path}`);
  }
});

test('GREEN: camelCase look-alikes are not false-positived', () => {
  for (const path of [
    'ui/src/components/Accessibility.tsx',
    'server/src/services/data-access.ts',
    'server/src/lib/grantham.ts',
    'server/src/models/author.ts',
    'ui/src/components/AuthorCard.tsx',
  ]) {
    const result = classifyPrRiskLane(basePr({ files: [file(path)] }));
    assert.equal(result.lane, LANES.GREEN, `expected GREEN (no false positive) for ${path}`);
  }
});

// ── CLI rename/diff parsers (brace + subdirectory reconstruction) ────────────

test('resolveNumstatNewPath: reconstructs brace-form renames with prefix/suffix', () => {
  assert.equal(resolveNumstatNewPath('.github/workflows/{old.yml => new.yml}'), '.github/workflows/new.yml');
  assert.equal(resolveNumstatNewPath('server/src/{routes => svc}/authz.ts'), 'server/src/svc/authz.ts');
  assert.equal(resolveNumstatNewPath('{old => new}/file.ts'), 'new/file.ts');
  assert.equal(resolveNumstatNewPath('old/path.ts => new/path.ts'), 'new/path.ts');
  assert.equal(resolveNumstatNewPath('server/src/plain.ts'), 'server/src/plain.ts');
});

test('parseNumstatOutput: subdirectory brace rename keeps its directory prefix (no matcher evasion)', () => {
  const counts = parseNumstatOutput('3\t1\tserver/src/{routes => svc}/authz.ts\n0\t0\t.github/workflows/{a.yml => b.yml}');
  assert.deepEqual([...counts.keys()], ['server/src/svc/authz.ts', '.github/workflows/b.yml']);
  assert.deepEqual(counts.get('server/src/svc/authz.ts'), { additions: 3, deletions: 1 });
});

test('parseNumstatOutput: binary files resolve to zero counts', () => {
  const counts = parseNumstatOutput('-\t-\tassets/logo.png');
  assert.deepEqual(counts.get('assets/logo.png'), { additions: 0, deletions: 0 });
});

test('parseNameStatusOutput: renames expose previous_filename (rename source is judged sacred)', () => {
  const files = parseNameStatusOutput('R096\tserver/src/routes/authz.ts\tserver/src/services/notes.ts\nM\tserver/src/app.ts\nD\tpnpm-lock.yaml\nA\tserver/src/new.ts');
  assert.deepEqual(files, [
    { filename: 'server/src/services/notes.ts', status: 'renamed', previous_filename: 'server/src/routes/authz.ts' },
    { filename: 'server/src/app.ts', status: 'modified' },
    { filename: 'pnpm-lock.yaml', status: 'removed' },
    { filename: 'server/src/new.ts', status: 'added' },
  ]);
});

test('RED: a brace/subdirectory rename INTO .github is still caught (matcher not evaded)', () => {
  // The classifier receives the resolved name-status list, so a numstat brace
  // form can no longer strip the .github/ prefix and slip to GREEN.
  const files = parseNameStatusOutput('R100\tdocs/old.md\t.github/workflows/deploy.yml');
  const withCounts = files.map(f => ({ ...f, additions: 1, deletions: 0, changes: 1 }));
  const result = classifyPrRiskLane(basePr({ files: withCounts }));
  assert.equal(result.lane, LANES.RED);
});
