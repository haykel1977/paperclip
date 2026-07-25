import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planAutomerge } from '../enable-agent-automerge.mjs';

// Static policy tests for the RED Autonomy Witness infrastructure. The workflow
// (autonomy-witness-red.yml) is the trust boundary — trigger, permissions,
// actions, token — while the bounded work lives in autonomy-witness-red.sh. These
// read both as text (the repo has no YAML parser dependency; matches the green
// autonomy-witness-workflow.test.mjs) and the sibling behavior test exercises the
// script at runtime. A final planAutomerge proof shows that the labelled RED
// witness PR is skipped (never enabled) end-to-end.

const wfPath = fileURLToPath(new URL('../../workflows/autonomy-witness-red.yml', import.meta.url));
const shPath = fileURLToPath(new URL('../autonomy-witness-red.sh', import.meta.url));
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

function hasMutatingGhRestCall(src) {
  // Explicit method forms — case-insensitive, tolerant of -XPUT (no space).
  if (/gh\s+(repo|api)\b[\s\S]{0,200}?(?:-X\s*(PUT|PATCH|POST|DELETE)\b|--method(?:=|\s+)(PUT|PATCH|POST|DELETE)\b)/i.test(src)) return true;
  // GraphQL mutations are implicit POSTs and evade REST-method scanning.
  if (/gh\s+api\s+graphql[\s\S]{0,300}?\bmutation\b/i.test(src)) return true;
  // gh api defaults to POST whenever body fields are supplied — no -X needed.
  if (/gh\s+api\b(?![\s\S]{0,200}?--method(?:=|\s+)GET\b)[\s\S]{0,200}?(?:\s-(?:f|F)\s|--field\b|--raw-field\b|--input\b)/.test(src)) return true;
  // gh repo edit/delete/rename mutate repository state without gh api at all.
  if (/gh\s+repo\s+(edit|delete|rename|archive)\b/.test(src)) return true;
  return false;
}

function touchesGhSettings(src) {
  return /gh\s+(repo|api)\b[\s\S]{0,200}?settings\b/.test(src);
}

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

test('workflow: minimal workflow-token permissions — contents:read only', () => {
  const block = topLevelPermissionsBlock();
  assert.ok(block, 'must declare a top-level permissions block');
  const perms = block
    .map(l => l.split('#')[0].trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(perms, ['contents: read'],
    'GITHUB_TOKEN needs only contents:read (checkout fetch); the App token does the push AND the PR');
  assert.doesNotMatch(wfCode, /^\s*contents:\s*write\b/m,
    'workflow token must not be granted contents:write (the App token pushes)');
  assert.doesNotMatch(wfCode, /^\s*pull-requests:\s*write\b/m,
    'workflow token must not be granted pull-requests:write');
  assert.doesNotMatch(wf, /\b(id-token|packages|actions|checks|deployments|security-events|statuses|issues|pages|discussions):\s*write\b/,
    'no additional write scopes may be granted');
  assert.match(wfCode, /persist-credentials:\s*false/,
    'checkout must not persist the ambient GITHUB_TOKEN; the App token authenticates git');
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

/** Env keys (`KEY: ${{ ... }}`) declared inside the step block that runs cmd. */
function stepEnvKeys(cmdMatcher) {
  const blocks = wfCode.split(/^\s{6}- name:/m);
  const block = blocks.find(b => cmdMatcher.test(b));
  assert.ok(block, `no step block matched ${cmdMatcher}`);
  return [...block.matchAll(/^\s{10}([A-Z_]+):\s*\$\{\{/gm)].map(m => m[1]).sort();
}

test('workflow: opens the PR with a minted App token — never the built-in GITHUB_TOKEN', () => {
  assert.match(wfCode, /run:\s*bash \.github\/scripts\/autonomy-witness-red\.sh/, 'must invoke the bounded RED script');
  assert.match(wfCode, /GH_TOKEN:\s*\$\{\{\s*steps\.apptoken\.outputs\.value\s*\}\}/,
    'PR must be opened with the minted App token so the required PR workflows run');
  assert.doesNotMatch(wfCode, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/,
    'must NOT open the PR with the event-suppressing built-in GITHUB_TOKEN');
  assert.deepEqual(stepEnvKeys(/autonomy-witness-red\.sh/),
    ['DEFAULT_BRANCH', 'GH_TOKEN', 'HEAD_SHA', 'REPO', 'RUN_ID']);
});

test('workflow: App token minted fail-closed — delivery secrets only, no GITHUB_TOKEN fallback', () => {
  assert.match(wfCode, /node \.github\/scripts\/paperclip-delivery-token\.mjs/, 'mints via paperclip-delivery-token.mjs');
  assert.doesNotMatch(wfCode, /node \.github\/scripts\/get-bot-token\.mjs/,
    'must NOT mint via the commitperclip get-bot-token.mjs (that App is inaccessible here)');
  const mintEnv = stepEnvKeys(/paperclip-delivery-token\.mjs/);
  assert.ok(mintEnv.includes('PAPERCLIP_DELIVERY_APP_ID'), 'mint step needs the delivery App ID');
  assert.ok(mintEnv.includes('PAPERCLIP_DELIVERY_PRIVATE_KEY'), 'mint step needs the delivery private key');
  assert.ok(!mintEnv.includes('GITHUB_TOKEN'),
    'mint step must NOT receive GITHUB_TOKEN, else a mint failure silently falls back to it');
});

test('workflow: the only secrets referenced are the two delivery App secrets', () => {
  const secrets = [...new Set([...wf.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(secrets, ['PAPERCLIP_DELIVERY_APP_ID', 'PAPERCLIP_DELIVERY_PRIVATE_KEY'],
    'exactly the two dedicated delivery App secrets may be referenced');
  assert.doesNotMatch(wf, /COMMITPERCLIP_KEY/, 'the inaccessible commitperclip App key must not be referenced');
  assert.doesNotMatch(wf, /PAPERCLIP_DELIVERY_BOT_TOKEN|PAPERCLIP_AUTONOMOUS_DELIVERY/, 'no PAT-style delivery secrets');
  assert.doesNotMatch(wfCode, /\bPAT\b|personal.access.token/i, 'no PAT');
});

// ── script bounds ────────────────────────────────────────────────────────────

test('script: docs-only — writes only doc/autonomy-witness-red/<run_id>.md', () => {
  assert.match(sh, /DOC_DIR="doc\/autonomy-witness-red"/, 'fixed RED docs directory');
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

test('script: fixed safe branch prefix autonomy-witness-red/ and numeric RUN_ID guard', () => {
  assert.match(sh, /BRANCH="autonomy-witness-red\/\$\{RUN_ID\}"/, 'branch prefix is fixed and run-id scoped');
  assert.match(shCode, /\[\[ ! "\$RUN_ID" =~ \^\[0-9\]\+\$ \]\]/, 'RUN_ID must be validated as an integer');
});

test('script: docs commit uses a fixed bot commit identity', () => {
  assert.match(sh, /git config user\.name "github-actions\[bot\]"/);
  assert.match(sh, /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/);
});

test('script: applies EXACTLY the risk:red label and nothing else', () => {
  // The RED lane is forced by exactly one label. The label must be a lane hint,
  // not a hard-block label, so governance still passes while both checker
  // contexts fail by policy.
  assert.match(shCode, /RISK_RED_LABEL="risk:red"/, 'names the exact risk:red label');
  const addLabels = [...shCode.matchAll(/--add-label\s+("?[^"\s]+"?)/g)].map(m => m[1].replace(/"/g, ''));
  assert.deepEqual(addLabels, ['$RISK_RED_LABEL'], 'exactly one label request, for the exact risk:red label');
  assert.doesNotMatch(shCode, /--remove-label\b/, 'must not remove any label');
  const editIdx = shCode.indexOf('gh pr edit "$pr_number" --repo "$REPO" --add-label "$RISK_RED_LABEL"');
  const reuseIdx = shCode.indexOf('if [ -n "$pr_number" ]; then');
  assert.ok(editIdx !== -1 && reuseIdx !== -1 && editIdx > reuseIdx,
    'label request must exist only on the create path, never before reuse selection');
});

test('fix#1 create path: new witness PR is created as a DRAFT first', () => {
  assert.match(shCode, /gh pr create[\s\S]*?--draft[\s\S]*?--base "\$DEFAULT_BRANCH"[\s\S]*?--head "\$BRANCH"/,
    'create path must open a draft PR before validations run');
  assert.doesNotMatch(shCode, /gh pr create[\s\S]*?--label\s+"\$RISK_RED_LABEL"/,
    'create path must not attach the label atomically; label request happens after draft creation');
});

test('fix#1 fail-closed verification: re-reads authoritative labels and refuses success if absent', () => {
  assert.match(shCode, /load_pr_json\(\) \{[\s\S]*?--json id,number,isDraft,baseRefName,headRefName,headRepositoryOwner,headRefOid,author,labels,url/,
    'must fetch authoritative PR core data');
  assert.match(shCode, /gh api --paginate "\/repos\/\$\{REPO\}\/pulls\/\$1\/files\?per_page=100"[\s\S]*?jq -s 'add \/\/ \[\]'/,
    'must fetch rename-aware PR files from the REST pull-files API');
  assert.match(shCode, /jq -e --arg l "\$RISK_RED_LABEL" 'any\(\.labels\[\]\?; \.name == \$l\)'/, 'must check for the EXACT risk:red label via structural jq equality (newline-immune)');
  assert.match(shCode, /assert_pr_shape "\$pr_json" "\$pr_id_resolved" "yes" "\$expected_head_oid"/,
    'fresh draft must be fully validated before any ready transition');
  assert.match(sh, /does not carry the required \$\{RISK_RED_LABEL\} label/,
    'must fail closed (exit 1) when the label is not authoritatively present');
});

test('fix#1 teardown: ambiguous create failure closes nothing, verified post-create failure closes only the known draft', () => {
  assert.match(shCode, /gh pr close "\$pr_number" --repo "\$REPO"/, 'must be able to close a fresh PR');
  assert.match(shCode, /if \[ "\$create_status" -ne 0 \]; then[\s\S]*?leaving any partial draft untouched and refusing further mutation/,
    'ambiguous create failure must leave any partial draft untouched');
  assert.match(shCode, /created_pr_number="\$\(extract_created_pr_number "\$create_output"\)"/,
    'successful create path should rely on the exact emitted PR number');
  assert.match(shCode, /pr_number="\$created_pr_number"[\s\S]*?created=1[\s\S]*?pr_id_resolved=""[\s\S]*?trap 'close_created_pr_if_revalidated "\$\{pr_id_resolved:-\}" "\$expected_head_oid"' ERR[\s\S]*?pr_json="\$\(load_pr_json "\$pr_number"\)"[\s\S]*?assert_pr_core "\$pr_json" "" "yes" "\$expected_head_oid"/,
    'post-create cleanup must be armed immediately after the trustworthy created PR number is recorded and before any post-create assertion can fail');
  assert.ok(shCode.includes('if [ -n "$expected_id" ] && [ "$pr_id" != "$expected_id" ]; then'),
    'cleanup must refuse to close when a known created id revalidates to a different PR id');
  assert.ok(shCode.includes('if [ "$pr_base" = "$DEFAULT_BRANCH" ] && [ "$pr_head" = "$BRANCH" ] && [ "$pr_head_owner" = "$OWNER" ] && [ "$pr_head_oid" = "$expected_head_oid" ]; then'),
    'close must still be gated by authoritative base/head/owner/head sha revalidation');
  assert.doesNotMatch(shCode, /gh pr close[\s\S]*?--delete-branch/, 'teardown closes the PR; it does not delete refs');
});

test('script: never auto-merges, auto-approves, or changes settings', () => {
  assert.doesNotMatch(shCode, /gh pr merge/, 'must not merge');
  assert.doesNotMatch(shCode, /--auto\b/, 'must not enable auto-merge');
  assert.doesNotMatch(shCode, /gh pr review/, 'must not approve');
  assert.doesNotMatch(shCode, /enable-agent-automerge/, 'must not invoke the automerge gate');
  assert.doesNotMatch(shCode, /branches\/.*protection/, 'must not touch branch protection');
  assert.equal(hasMutatingGhRestCall(shCode), false, 'script must not issue mutating REST calls');
  assert.equal(touchesGhSettings(shCode), false, 'must not mutate repo settings');
});

test('mutation guard helper catches gh api mutators across inline and continued syntaxes', () => {
  for (const sample of [
    'gh api -X PUT /repos/o/r/hooks',
    'gh api -XPUT /repos/o/r/hooks',
    'gh api --method delete /repos/o/r/hooks/1',
    'gh api \\\n      -X PATCH /repos/o/r/hooks/1',
    'gh api \\\n      --method DELETE /repos/o/r/hooks/1',
    'gh api \\\n      --method POST \\\n      /repos/o/r/hooks',
    'gh repo \\\n      --method PATCH /repos/o/r',
    'gh api /repos/o/r/pulls/9/reviews -f event=APPROVE',
    'gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {}) }"',
    'gh repo edit o/r --enable-auto-merge',
  ]) {
    assert.equal(hasMutatingGhRestCall(sample), true, `must detect ${JSON.stringify(sample)}`);
  }
  assert.equal(hasMutatingGhRestCall('gh api /repos/o/r/pulls/71/files?per_page=100'), false);
});

test('script: references no secrets, PAT, or App-key minting (token is injected via env)', () => {
  assert.doesNotMatch(shCode, /secrets\./, 'no secrets context');
  assert.doesNotMatch(shCode, /COMMITPERCLIP_KEY|PAPERCLIP_DELIVERY_APP_ID|PAPERCLIP_DELIVERY_PRIVATE_KEY|PAPERCLIP_DELIVERY_BOT_TOKEN|PAPERCLIP_AUTONOMOUS_DELIVERY/, 'no delivery/App secrets');
  assert.doesNotMatch(shCode, /\bPAT\b|personal.access.token/i, 'no PAT');
  assert.doesNotMatch(shCode, /get-bot-token|paperclip-delivery-token|generateJWT|generateAppJwt|installations\/.*access_tokens/, 'no App token minting in the script');
});

test('script: fails closed unless the PR is authored by the allowlisted App identity', () => {
  assert.match(shCode, /EXPECTED_AUTHOR_GRAPHQL="app\/solidus-paperclip-delivery"/, 'names the GraphQL-form identity');
  assert.match(shCode, /EXPECTED_AUTHOR_REST="solidus-paperclip-delivery\[bot\]"/, 'names the REST-form identity');
  assert.match(shCode, /pr_author="\$\(jq -r '\.author\.login \/\/ empty' <<<"\$pr_json"\)"/,
    'must read the resolved PR author');
  assert.match(shCode, /if \[ "\$pr_author" != "\$EXPECTED_AUTHOR_GRAPHQL" \] && \[ "\$pr_author" != "\$EXPECTED_AUTHOR_REST" \]; then[\s\S]*?return 1/,
    'must exit non-zero (fail closed) unless the author is one of the two exact expected forms');
});

test('reuse path: revalidates the complete witness shape before success', () => {
  assert.match(shCode, /gh api --paginate "\/repos\/\$\{REPO\}\/pulls\/\$1\/files\?per_page=100"/,
    'reuse path must fetch rename-aware PR files authoritatively');
  assert.match(shCode, /if \[ "\$pr_base" != "\$DEFAULT_BRANCH" \]; then[\s\S]*?exit 1/,
    'reuse path must pin the base branch');
  assert.match(shCode, /if \[ "\$pr_head" != "\$BRANCH" \]; then[\s\S]*?exit 1/,
    'reuse path must pin the head branch');
  assert.match(shCode, /if \[ -n "\$reused_head_sha" \]; then[\s\S]*?current_head_sha="\$\(git rev-parse HEAD\)"/,
    'reuse path must compare the remote branch head before any mutation');
  assert.match(shCode, /if \[ "\$files_count" -ne 1 \]; then[\s\S]*?exit 1/,
    'reuse path must require exactly one changed file');
  assert.match(shCode, /file_path="\$\(jq -r '\.files\[0\]\.filename \/\/ empty' <<<"\$pr_json"\)"/,
    'reuse path must read the authoritative REST filename field');
  assert.match(shCode, /if \[ "\$file_path" != "\$DOC_PATH" \]; then[\s\S]*?exit 1/,
    'reuse path must require the exact witness doc path');
  assert.match(shCode, /if \[ -n "\$file_previous_filename" \]; then[\s\S]*?exit 1/,
    'reuse path must reject rename sources');
  assert.match(shCode, /if ! jq -e --arg l "\$RISK_RED_LABEL" 'any\(\.labels\[\]\?; \.name == \$l\)' <<<"\$pr_json" >\/dev\/null; then[\s\S]*?exit 1/,
    'reuse path must require the exact risk:red label');
});

test('fix#1 idempotency: resumes existing run-id branch, no-op commit guard, FF push (no --force)', () => {
  const resolveIdx = shCode.indexOf('pr_number="$(resolve_pr_number)"');
  const mkdirIdx = shCode.indexOf('mkdir -p "$DOC_DIR"');
  assert.ok(resolveIdx !== -1 && mkdirIdx !== -1 && resolveIdx < mkdirIdx,
    'existing same-branch PR must be resolved before writing docs');
  assert.match(shCode, /git ls-remote --exit-code --heads origin "refs\/heads\/\$\{BRANCH\}"/,
    'must probe for the existing run-id branch');
  assert.match(shCode, /git checkout -B "\$BRANCH" "refs\/remotes\/origin\/\$\{BRANCH\}"/,
    'must resume from the existing remote branch tip when present');
  assert.match(shCode, /git diff --cached --quiet/, 'no-op commit guard for identical re-runs');
  const fetches = [...shCode.matchAll(/git fetch[^\n]*$/gm)].map(m => m[0]);
  for (const f of fetches) {
    assert.match(f, /\+refs\/heads\/\$\{BRANCH\}:refs\/remotes\/origin\/\$\{BRANCH\}/,
      `fetch must use the literal run-id refspec: ${f}`);
  }
  assert.match(shCode, /git push origin "\$BRANCH"/, 'plain fast-forward push');
  assert.doesNotMatch(shCode, /git push\s+(-f|--force|--force-with-lease)\b/, 'must not force-push');
});

test('coherent provenance: the branch is pushed with the App token, not the ambient credential', () => {
  assert.match(shCode, /gh auth setup-git/, 'must wire the App token into git for the push');
  const setupIdx = shCode.indexOf('gh auth setup-git');
  const pushIdx = shCode.indexOf('git push origin');
  assert.ok(setupIdx !== -1 && pushIdx !== -1 && setupIdx < pushIdx,
    'gh auth setup-git must run before git push');
});

test('ready transition: only after full validation, and only for drafts', () => {
  assert.match(shCode, /if \[ "\$pr_is_draft_resolved" = "true" \]; then[\s\S]*?gh pr ready "\$pr_number" --repo "\$REPO"/,
    'only draft PRs may be marked ready');
  assert.match(shCode, /gh pr edit "\$pr_number" --repo "\$REPO" --add-label "\$RISK_RED_LABEL"[\s\S]*?assert_pr_shape "\$pr_json" "\$pr_id_resolved" "yes" "\$expected_head_oid"[\s\S]*?mark_ready_if_still_draft/,
    'ready transition must occur only after full draft validation passes');
});

test('PR lookup: queries all states, fails closed on non-open or duplicate matches, and avoids early-terminating pipes', () => {
  assert.match(shCode, /gh pr list --repo "\$REPO" --state all --head "\$BRANCH"/,
    'must query all PR states for the exact witness branch');
  assert.match(shCode, /select\(\.headRepositoryOwner\.login == \\"\$\{OWNER\}\\"\)/,
    'must scope matches to the current repo owner');
  assert.match(shCode, /select\(\.state != "OPEN"\)/,
    'must fail closed on terminal matches');
  assert.match(shCode, /select\(\.state == "OPEN"\)/,
    'must only reuse a unique open PR');
  assert.doesNotMatch(shCode, /\|\s*head\b/, 'no head (or any early-terminating consumer) after gh pr list');
});

test('script: runs under strict mode (set -euo pipefail)', () => {
  assert.match(sh, /^set -Eeuo pipefail$/m, 'must fail fast under strict mode WITH errtrace (ERR trap must fire inside functions)');
  assert.match(sh, /^shopt -s inherit_errexit$/m, 'command substitutions must inherit errexit (a failed gh lookup must abort, not degrade to empty)');
});

// ── the RED outcome is real: planAutomerge skips the labelled witness ─────────

test('planAutomerge: a risk:red-labelled witness PR classifies RED and is skipped (never enabled)', () => {
  // End-to-end proof that the witnessed outcome is genuine: even for the
  // allowlisted delivery App, on the default branch, with green required checks
  // and the auto-merge opt-in labels present, the explicit risk:red label forces
  // the RED lane, so auto-merge is SKIPPED — never enabled.
  const HEAD = 'a'.repeat(40);
  const result = planAutomerge({
    pr: {
      state: 'open',
      draft: false,
      title: 'docs(autonomy-witness-red): witness run 123456',
      base: { ref: 'main', repo: { full_name: 'haykel1977/paperclip' } },
      head: { ref: 'autonomy-witness-red/123456', sha: HEAD, repo: { full_name: 'haykel1977/paperclip' } },
      user: { login: 'solidus-paperclip-delivery[bot]' },
      labels: [{ name: 'agent-pr' }, { name: 'automerge' }, { name: 'risk:red' }],
      auto_merge: null,
      node_id: 'PR_kwDORedWitness',
    },
    files: [{ filename: 'doc/autonomy-witness-red/123456.md', status: 'added', additions: 12, deletions: 0, changes: 12 }],
    checkRuns: [
      { name: 'verify', status: 'completed', conclusion: 'success' },
      { name: 'gitleaks', status: 'completed', conclusion: 'success' },
    ],
    eventHeadSha: HEAD,
    branchProtection: { required_status_checks: { strict: true, contexts: ['verify', 'gitleaks'] } },
    defaultBranch: 'main',
  });
  assert.equal(result.riskLane, 'RED', 'the explicit risk:red label must force the RED lane');
  assert.equal(result.action, 'skip', 'a RED PR must be skipped, never enabled for auto-merge');
  assert.notEqual(result.action, 'enable');
});
