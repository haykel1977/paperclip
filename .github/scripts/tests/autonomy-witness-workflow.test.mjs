import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Policy tests for the Autonomy Witness workflow. This workflow is permanent
// infrastructure that opens docs-only PRs as the allowlisted autonomous identity
// github-actions[bot]. These tests are the enforced contract that it stays
// tightly bounded: docs-only, no auto-merge, no arbitrary inputs, minimal
// permissions, and no privileged credentials. They read the workflow as text
// (the repo has no YAML parser dependency; this matches paperclip-checker.test.mjs).

const wfPath = fileURLToPath(new URL('../../workflows/autonomy-witness.yml', import.meta.url));
const wf = readFileSync(wfPath, 'utf8');
const lines = wf.split('\n');

// Executable YAML only (comments stripped): negative content scans must inspect
// real directives, not explanatory prose that legitimately names the very tokens
// the policy forbids in code (e.g. "PAT", "<run_id>").
const wfCode = lines
  .filter(l => !/^\s*#/.test(l))
  .map(l => l.replace(/\s+#.*$/, ''))
  .join('\n');

/** Return the top-level `permissions:` block (2-space indented children). */
function topLevelPermissionsBlock() {
  const start = lines.findIndex(l => /^permissions:\s*$/.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).filter(l => l.trim() !== '');
}

test('workflow: trigger is workflow_dispatch and takes NO inputs', () => {
  assert.match(wf, /^on:\s*$/m, 'must declare an on: block');
  assert.match(wf, /^\s{2}workflow_dispatch:\s*$/m, 'must be dispatched manually');
  // No arbitrary user-supplied path/content/shell: the dispatch must define no
  // inputs at all. An `inputs:` key would open an injection surface.
  assert.doesNotMatch(wf, /^\s*inputs:\s*$/m, 'workflow_dispatch must not declare inputs');
  // Never auto-triggered by PR/push events that could open PRs on their own.
  assert.doesNotMatch(wf, /^\s{2}pull_request(_target)?:\s*$/m);
  assert.doesNotMatch(wf, /^\s{2}push:\s*$/m);
});

test('workflow: minimal permissions — contents:write + pull-requests:write only', () => {
  const block = topLevelPermissionsBlock();
  assert.ok(block, 'must declare a top-level permissions block');
  const perms = block
    .map(l => l.trim())
    .map(l => l.split('#')[0].trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(perms, ['contents: write', 'pull-requests: write'],
    'exactly contents:write and pull-requests:write, nothing broader');
  // No write access to any other scope anywhere in the file.
  assert.doesNotMatch(wf, /\b(id-token|packages|actions|checks|deployments|security-events|statuses|issues|pages|discussions):\s*write\b/,
    'no additional write scopes may be granted');
});

test('workflow: docs-only — writes only under doc/autonomy-witness/<run_id>.md', () => {
  assert.match(wf, /DOC_DIR="doc\/autonomy-witness"/, 'fixed docs directory');
  assert.match(wf, /DOC_PATH="\$\{DOC_DIR\}\/\$\{RUN_ID\}\.md"/, 'run-id-scoped docs path');
  // The only redirected file write targets $DOC_PATH.
  const redirects = [...wfCode.matchAll(/>\s*"?([^"\n]+)"?\s*$/gm)].map(m => m[1].trim());
  for (const target of redirects) {
    assert.equal(target, '$DOC_PATH', `unexpected write target: ${target}`);
  }
  // Only $DOC_PATH is staged; no `git add -A`/`.`/other paths.
  const adds = [...wfCode.matchAll(/git add\s+(.+)$/gm)].map(m => m[1].trim());
  assert.deepEqual(adds, ['"$DOC_PATH"'], 'only the generated doc file may be staged');
  assert.doesNotMatch(wfCode, /git add\s+(-A|--all|\.)\b/, 'must not bulk-stage');
});

test('workflow: fixed safe branch prefix autonomy-witness/', () => {
  assert.match(wf, /BRANCH="autonomy-witness\/\$\{RUN_ID\}"/, 'branch prefix is fixed and run-id scoped');
});

test('workflow: PR is authored by the allowlisted github-actions[bot] identity', () => {
  assert.match(wf, /git config user\.name "github-actions\[bot\]"/);
  assert.match(wf, /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/);
});

test('workflow: never auto-merges, auto-approves, or changes settings', () => {
  assert.doesNotMatch(wfCode, /gh pr merge/, 'must not merge');
  assert.doesNotMatch(wfCode, /--auto\b/, 'must not enable auto-merge');
  assert.doesNotMatch(wfCode, /gh pr review/, 'must not approve');
  assert.doesNotMatch(wfCode, /enable-agent-automerge/, 'must not invoke the automerge gate');
  assert.doesNotMatch(wfCode, /gh api .*branches\/.*protection/, 'must not touch branch protection');
  assert.doesNotMatch(wfCode, /gh (repo|api) .*(--method (PUT|PATCH|DELETE)|settings)/, 'must not mutate repo settings');
});

test('workflow: uses only the built-in GITHUB_TOKEN — no secrets, PAT, or App key', () => {
  assert.doesNotMatch(wfCode, /secrets\./, 'no secrets context may be referenced');
  assert.doesNotMatch(wfCode, /COMMITPERCLIP_KEY|PAPERCLIP_DELIVERY_BOT_TOKEN|PAPERCLIP_AUTONOMOUS_DELIVERY/, 'no delivery/App secrets');
  assert.doesNotMatch(wfCode, /\bPAT\b|personal.access.token/i, 'no PAT');
  assert.doesNotMatch(wfCode, /get-bot-token|generateJWT|installations\/.*access_tokens/, 'no App installation token minting');
  assert.match(wfCode, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/, 'authenticates with the built-in token');
});

test('workflow: only first-party actions, pinned by full commit SHA', () => {
  const uses = [...wf.matchAll(/^\s*uses:\s*(\S+)/gm)].map(m => m[1]);
  assert.ok(uses.length >= 1, 'expected at least one action');
  for (const ref of uses) {
    const [name, sha] = ref.split('@');
    assert.match(name, /^actions\//, `only first-party actions/* allowed, got: ${name}`);
    assert.match(sha ?? '', /^[0-9a-f]{40}$/, `action ${name} must be pinned to a 40-char commit SHA`);
  }
});

test('workflow: idempotent / re-run safe — one PR per run id, no duplicate create', () => {
  // Same run id → same branch, force-push, and reuse of an existing open PR.
  assert.match(wf, /git push --force origin "\$BRANCH"/, 'force-push keeps the run-id branch in sync');
  assert.match(wf, /gh pr list --repo "\$REPO" --state open --head "\$BRANCH"/, 'looks up an existing PR before creating');
  assert.match(wf, /if \[ -n "\$existing" \]/, 'skips creation when a witness PR already exists');
  // Skips committing when content is unchanged.
  assert.match(wf, /git diff --cached --quiet/, 'no-op commit guard for identical re-runs');
});

test('workflow: reuse guard is scoped to this repo owner, not fork branches', () => {
  assert.match(wf, /select\(\.headRepositoryOwner\.login == \\"\$\{OWNER\}\\"\)/,
    'existing-PR lookup must be constrained to the repo owner');
});
