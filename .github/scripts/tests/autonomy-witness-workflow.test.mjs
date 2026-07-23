import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Static policy tests for the Autonomy Witness infrastructure. The workflow
// (autonomy-witness.yml) is the trust boundary — trigger, permissions, actions,
// token — while the bounded work lives in autonomy-witness.sh. These read both as
// text (the repo has no YAML parser dependency; matches paperclip-checker.test.mjs)
// and the sibling behavior test exercises the script at runtime.

const wfPath = fileURLToPath(new URL('../../workflows/autonomy-witness.yml', import.meta.url));
const shPath = fileURLToPath(new URL('../autonomy-witness.sh', import.meta.url));
const wf = readFileSync(wfPath, 'utf8');
const sh = readFileSync(shPath, 'utf8');
const lines = wf.split('\n');

// Executable lines only (comments stripped) for negative content scans, so prose
// that legitimately names a forbidden token (e.g. "PAT", "<run_id>", "--force")
// cannot trip an assertion.
function stripComments(src) {
  return src
    .split('\n')
    .filter(l => !/^\s*#/.test(l))
    .map(l => l.replace(/\s+#.*$/, ''))
    .join('\n');
}
const wfCode = stripComments(wf);
const shCode = stripComments(sh);

/** Top-level `permissions:` block children (2-space indented). */
function topLevelPermissionsBlock() {
  const start = lines.findIndex(l => /^permissions:\s*$/.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).filter(l => l.trim() !== '');
}

// ── workflow trust boundary ──────────────────────────────────────────────────

test('workflow: trigger is workflow_dispatch and takes NO inputs', () => {
  assert.match(wf, /^on:\s*$/m, 'must declare an on: block');
  assert.match(wf, /^\s{2}workflow_dispatch:\s*$/m, 'must be dispatched manually');
  assert.doesNotMatch(wf, /^\s*inputs:\s*$/m, 'workflow_dispatch must not declare inputs');
  assert.doesNotMatch(wf, /^\s{2}pull_request(_target)?:\s*$/m);
  assert.doesNotMatch(wf, /^\s{2}push:\s*$/m);
});

test('workflow: minimal permissions — contents:write + pull-requests:write only', () => {
  const block = topLevelPermissionsBlock();
  assert.ok(block, 'must declare a top-level permissions block');
  const perms = block
    .map(l => l.split('#')[0].trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(perms, ['contents: write', 'pull-requests: write'],
    'exactly contents:write and pull-requests:write, nothing broader');
  assert.doesNotMatch(wf, /\b(id-token|packages|actions|checks|deployments|security-events|statuses|issues|pages|discussions):\s*write\b/,
    'no additional write scopes may be granted');
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

/** Env keys (`KEY: ${{ ... }}`) declared inside the step block that runs cmd.
 * Splits the comment-stripped workflow so a filename named in a comment cannot
 * misidentify the step. */
function stepEnvKeys(cmdMatcher) {
  const blocks = wfCode.split(/^\s{6}- name:/m);
  const block = blocks.find(b => cmdMatcher.test(b));
  assert.ok(block, `no step block matched ${cmdMatcher}`);
  return [...block.matchAll(/^\s{10}([A-Z_]+):\s*\$\{\{/gm)].map(m => m[1]).sort();
}

test('workflow: opens the PR with a minted App token — never the built-in GITHUB_TOKEN', () => {
  assert.match(wfCode, /run:\s*bash \.github\/scripts\/autonomy-witness\.sh/, 'must invoke the bounded script');
  // gh authenticates with the App installation token output — an App-created PR
  // fires pull_request workflows. github.token would suppress them.
  assert.match(wfCode, /GH_TOKEN:\s*\$\{\{\s*steps\.apptoken\.outputs\.value\s*\}\}/,
    'PR must be opened with the minted App token so the required PR workflows run');
  assert.doesNotMatch(wfCode, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/,
    'must NOT open the PR with the event-suppressing built-in GITHUB_TOKEN');
  // The env passed to the script is exactly the trusted, non-user-controlled set.
  assert.deepEqual(stepEnvKeys(/autonomy-witness\.sh/),
    ['DEFAULT_BRANCH', 'GH_TOKEN', 'HEAD_SHA', 'REPO', 'RUN_ID']);
});

test('workflow: App token minted fail-closed — COMMITPERCLIP_KEY only, no GITHUB_TOKEN fallback', () => {
  assert.match(wfCode, /node \.github\/scripts\/get-bot-token\.mjs/, 'mints via get-bot-token.mjs');
  const mintEnv = stepEnvKeys(/get-bot-token\.mjs/);
  // The App key must be present; GITHUB_TOKEN must be absent so get-bot-token.mjs
  // cannot silently fall back to the event-suppressing default token.
  assert.ok(mintEnv.includes('COMMITPERCLIP_KEY'), 'mint step needs the App key');
  assert.ok(!mintEnv.includes('GITHUB_TOKEN'),
    'mint step must NOT receive GITHUB_TOKEN, else a mint failure silently falls back to it');
});

test('workflow: the only secret referenced is COMMITPERCLIP_KEY', () => {
  const secrets = [...new Set([...wf.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(secrets, ['COMMITPERCLIP_KEY'], 'exactly one secret — the App key — may be referenced');
  assert.doesNotMatch(wf, /PAPERCLIP_DELIVERY_BOT_TOKEN|PAPERCLIP_AUTONOMOUS_DELIVERY/, 'no delivery secrets');
  assert.doesNotMatch(wfCode, /\bPAT\b|personal.access.token/i, 'no PAT');
});

// ── script bounds ────────────────────────────────────────────────────────────

test('script: docs-only — writes only doc/autonomy-witness/<run_id>.md', () => {
  assert.match(sh, /DOC_DIR="doc\/autonomy-witness"/, 'fixed docs directory');
  assert.match(sh, /DOC_PATH="\$\{DOC_DIR\}\/\$\{RUN_ID\}\.md"/, 'run-id-scoped docs path');
  // File-write redirects only: exclude fd dups (`2>&1`) and discards (`/dev/null`).
  const redirects = [...shCode.matchAll(/(?<![0-9&])>\s*("?[^"\s;|&]+"?)/g)]
    .map(m => m[1].replace(/"/g, ''))
    .filter(t => t !== '/dev/null');
  assert.ok(redirects.length >= 1, 'script must write the doc file');
  for (const target of redirects) {
    assert.equal(target, '$DOC_PATH', `unexpected write target: ${target}`);
  }
  const adds = [...shCode.matchAll(/git add\s+(.+)$/gm)].map(m => m[1].trim());
  assert.deepEqual(adds, ['"$DOC_PATH"'], 'only the generated doc file may be staged');
  assert.doesNotMatch(shCode, /git add\s+(-A|--all|\.)\b/, 'must not bulk-stage');
});

test('script: fixed safe branch prefix autonomy-witness/ and numeric RUN_ID guard', () => {
  assert.match(sh, /BRANCH="autonomy-witness\/\$\{RUN_ID\}"/, 'branch prefix is fixed and run-id scoped');
  // RUN_ID must be validated numeric so neither the branch nor the path can be
  // steered to an arbitrary ref/path.
  assert.match(shCode, /\[\[ ! "\$RUN_ID" =~ \^\[0-9\]\+\$ \]\]/, 'RUN_ID must be validated as an integer');
});

test('script: docs commit uses a fixed bot commit identity', () => {
  // This is the git COMMIT identity for the docs commit. The PR *author* — the
  // identity the autonomy allowlist evaluates — is set separately by the App
  // token when `gh pr create` runs.
  assert.match(sh, /git config user\.name "github-actions\[bot\]"/);
  assert.match(sh, /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/);
});

test('script: never auto-merges, auto-approves, or changes settings', () => {
  assert.doesNotMatch(shCode, /gh pr merge/, 'must not merge');
  assert.doesNotMatch(shCode, /--auto\b/, 'must not enable auto-merge');
  assert.doesNotMatch(shCode, /gh pr review/, 'must not approve');
  assert.doesNotMatch(shCode, /enable-agent-automerge/, 'must not invoke the automerge gate');
  assert.doesNotMatch(shCode, /branches\/.*protection/, 'must not touch branch protection');
  assert.doesNotMatch(shCode, /gh (repo|api) .*(--method (PUT|PATCH|DELETE)|settings)/, 'must not mutate repo settings');
});

test('script: references no secrets, PAT, or App-key minting (token is injected via env)', () => {
  // The script never touches secrets itself — the workflow mints the App token
  // and injects it as GH_TOKEN. This keeps the trust boundary in the workflow.
  assert.doesNotMatch(shCode, /secrets\./, 'no secrets context');
  assert.doesNotMatch(shCode, /COMMITPERCLIP_KEY|PAPERCLIP_DELIVERY_BOT_TOKEN|PAPERCLIP_AUTONOMOUS_DELIVERY/, 'no delivery/App secrets');
  assert.doesNotMatch(shCode, /\bPAT\b|personal.access.token/i, 'no PAT');
  assert.doesNotMatch(shCode, /get-bot-token|generateJWT|installations\/.*access_tokens/, 'no App token minting in the script');
});

test('script: fails closed on the GITHUB_TOKEN event-suppression signature', () => {
  // A PR authored by github-actions[bot] can only come from the built-in
  // GITHUB_TOKEN, whose pull_request workflows are suppressed → the required
  // checks never ran. The script must refuse such a PR rather than treat a
  // check-less PR as a valid witness.
  assert.match(shCode, /FORBIDDEN_AUTHOR="github-actions\[bot\]"/, 'names the suppressed identity');
  assert.match(shCode, /gh pr view "\$pr_number" --repo "\$REPO" --json author --jq \.author\.login/,
    'must read the resolved PR author');
  assert.match(shCode, /if \[ "\$author" = "\$FORBIDDEN_AUTHOR" \]; then[\s\S]*?exit 1/,
    'must exit non-zero (fail closed) when the author is the forbidden identity');
});

// ── the two fixes ─────────────────────────────────────────────────────────────

test('fix#1 idempotency: resumes existing run-id branch, no-op commit guard, FF push (no --force)', () => {
  // Resume from the remote run-id branch when it exists, so an unchanged re-run
  // leaves the index identical to HEAD and creates no commit.
  assert.match(shCode, /git ls-remote --exit-code --heads origin "refs\/heads\/\$\{BRANCH\}"/,
    'must probe for the existing run-id branch');
  assert.match(shCode, /git checkout -B "\$BRANCH" "refs\/remotes\/origin\/\$\{BRANCH\}"/,
    'must resume from the existing remote branch tip when present');
  assert.match(shCode, /git diff --cached --quiet/, 'no-op commit guard for identical re-runs');
  // Only the fixed run-id refspec is ever fetched — never an arbitrary ref.
  const fetches = [...shCode.matchAll(/git fetch[^\n]*$/gm)].map(m => m[0]);
  for (const f of fetches) {
    assert.match(f, /\+refs\/heads\/\$\{BRANCH\}:refs\/remotes\/origin\/\$\{BRANCH\}/,
      `fetch must use the literal run-id refspec: ${f}`);
  }
  // Fast-forward push only: no force can clobber a divergent remote.
  assert.match(shCode, /git push origin "\$BRANCH"/, 'plain fast-forward push');
  assert.doesNotMatch(shCode, /git push\s+(-f|--force|--force-with-lease)\b/, 'must not force-push');
});

test('fix#2 SIGPIPE: PR lookup selects first owner match inside jq, no early-terminating pipe', () => {
  // The selection must happen inside --jq (first // empty), with no `head`/other
  // consumer that could SIGPIPE `gh pr list` under `set -o pipefail`.
  assert.match(shCode, /--jq "\[\.\[\] \| select\(\.headRepositoryOwner\.login == \\"\$\{OWNER\}\\"\) \| \.number\] \| first \/\/ empty"/,
    'owner-scoped first-match selection must live entirely in jq');
  assert.doesNotMatch(shCode, /\|\s*head\b/, 'no head (or any early-terminating consumer) after gh pr list');
});

test('script: runs under strict mode (set -euo pipefail)', () => {
  assert.match(sh, /^set -euo pipefail$/m, 'must fail fast under strict mode');
});
