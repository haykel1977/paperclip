import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime behavior tests for .github/scripts/autonomy-witness-red.sh. These stand
// up a throwaway git remote + working clone and a jq-backed `gh` stub, then run
// the real script to prove the RED witness bounds under adversarial conditions:
//   - docs-only, RED-branch-scoped output on a FRESH default-branch checkout;
//   - owner-scoped, SIGPIPE-safe PR lookup + re-run idempotency;
//   - fail-closed author guard (the label is applied ONLY after it passes);
//   - exactly the risk:red label is applied, and only to an allowlisted author.
// The script only runs on a Unix runner; skip elsewhere.

const SCRIPT = fileURLToPath(new URL('../autonomy-witness-red.sh', import.meta.url));
const OWNER = 'haykel1977';
const REPO = `${OWNER}/paperclip`;
const RUN_ID = '123456';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BRANCH_REF = `refs/heads/autonomy-witness-red/${RUN_ID}`;
const DOC_PATH = `doc/autonomy-witness-red/${RUN_ID}.md`;

const skip = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

function git(cwd, ...args) {
  return run('git', ['-C', cwd, ...args]).stdout.trim();
}

function readLines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function stubPr({
  number,
  headRepositoryOwner = OWNER,
  baseRefName = 'main',
  headRefName = `autonomy-witness-red/${RUN_ID}`,
  author = 'app/solidus-paperclip-delivery',
  labels = ['risk:red'],
  files = [{ path: DOC_PATH }],
} = {}) {
  return {
    number,
    headRepositoryOwner: { login: headRepositoryOwner },
    baseRefName,
    headRefName,
    author: { login: author },
    labels: labels.map(name => ({ name })),
    files,
  };
}

/** Build an isolated bare origin (default branch `main`) + a jq-backed gh stub. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'awr-'));
  const origin = join(root, 'origin.git');
  run('git', ['init', '--bare', '--initial-branch=main', origin]);

  const seed = join(root, 'seed');
  run('git', ['clone', origin, seed], { allowFail: true });
  git(seed, 'checkout', '-b', 'main');
  git(seed, 'config', 'user.name', 'seed');
  git(seed, 'config', 'user.email', 'seed@example.test');
  writeFileSync(join(seed, 'README.md'), '# base\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-m', 'base');
  git(seed, 'push', '-u', 'origin', 'main');
  run('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const listJson = join(root, 'pr-list.json');
  const createLog = join(root, 'gh-create.log');
  const labelLog = join(root, 'gh-label.log');
  const labelState = join(root, 'gh-label-state.log');
  const closeLog = join(root, 'gh-close.log');
  const viewJson = join(root, 'gh-pr-view.json');
  // gh stub: faithfully applies the script's `--jq` via system jq to a fixture.
  //   pr list   → runs the script's owner-scoping jq against the fixture.
  //   pr create → records the call, records any atomic `--label` value (to BOTH
  //               the attempt log and the authoritative label STATE), optionally
  //               appends a same-repo row so branch lookup would resolve it,
  //               and optionally emits a PR URL. This lets tests separate
  //               "branch-based PR discoverable" from "trustworthy id emitted by
  //               this exact create invocation".
  //   pr view   → replays a fixture row from GH_PR_VIEW_JSON and applies any
  //               requested `--jq` expression through system jq.
  //   pr edit   → records the `--add-label` value (attempt log + label STATE).
  //   pr close  → records the close so a test can prove a fresh green-shaped PR
  //               is torn down when label verification fails.
  // GH_SUPPRESS_LABEL=1 models a label that never sticks: the attempt is logged
  // but the authoritative STATE is left empty, so `pr view --json labels` returns
  // nothing and the script's fail-closed verification must trip.
  const stub = `#!/usr/bin/env bash
set -euo pipefail
jq_expr() {
  local expr="" args=("\$@") i
  for ((i=0;i<\${#args[@]};i++)); do
    if [ "\${args[\$i]}" = "--jq" ]; then expr="\${args[\$((i+1))]}"; fi
  done
  printf '%s' "\$expr"
}
json_fields() {
  local val="" args=("\$@") i
  for ((i=0;i<\${#args[@]};i++)); do
    if [ "\${args[\$i]}" = "--json" ]; then val="\${args[\$((i+1))]}"; fi
  done
  printf '%s' "\$val"
}
opt_value() {
  local flag="\$1"; shift
  local val="" args=("\$@") i
  for ((i=0;i<\${#args[@]};i++)); do
    if [ "\${args[\$i]}" = "\$flag" ]; then val="\${args[\$((i+1))]}"; fi
  done
  printf '%s' "\$val"
}
record_label() {
  local lbl="\$1"
  [ -n "\$lbl" ] || return 0
  echo "\$lbl" >> "\$GH_LABEL_LOG"
  if [ "\${GH_SUPPRESS_LABEL:-0}" != "1" ]; then echo "\$lbl" >> "\$GH_LABEL_STATE"; fi
}
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  jq -r "\$(jq_expr "\$@")" "\$GH_PR_LIST_JSON"
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  num="\${3:-0}"
  expr="\$(jq_expr "\$@")"
  pr_json="\$(jq -c --argjson n "\$num" '.[$n|tostring] // {}' "\$GH_PR_VIEW_JSON")"
  if [ -n "\$expr" ]; then
    printf '%s\n' "\$pr_json" | jq -r "\$expr"
  else
    if [ "\$pr_json" = "{}" ]; then
      printf '{"url":"https://example.test/pr/%s"}\n' "\$num"
    else
      printf '%s\n' "\$pr_json"
    fi
  fi
  exit 0
fi
if [ "\${1:-}" = "auth" ]; then
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "edit" ]; then
  record_label "\$(opt_value --add-label "\$@")"
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "close" ]; then
  echo "close \${3:-0}" >> "\$GH_CLOSE_LOG"
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "create" ]; then
  echo "create $*" >> "\$GH_CREATE_LOG"
  record_label "\$(opt_value --label "\$@")"
  if [ "\${GH_CREATE_LIST_APPEND:-1}" = "1" ]; then
    discoverable_pr="\${GH_CREATE_DISCOVERABLE_PR:-\$GH_CREATED_PR}"
    tmp="\$(mktemp)"
    jq --argjson n "\$discoverable_pr" --arg o "\$GH_STUB_OWNER" \
      '. + [{number:\$n, headRepositoryOwner:{login:\$o}}]' "\$GH_PR_LIST_JSON" > "\$tmp"
    mv "\$tmp" "\$GH_PR_LIST_JSON"
  fi
  if [ "\${GH_CREATE_EMIT_URL:-1}" = "1" ]; then
    echo "https://example.test/pull/\${GH_CREATED_PR}"
  fi
  exit "\${GH_CREATE_EXIT_CODE:-0}"
fi
echo "unhandled gh: $*" >&2
exit 1
`;
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, stub);
  chmodSync(ghPath, 0o755);

  return { root, origin, binDir, listJson, createLog, labelLog, labelState, closeLog, viewJson };
}

function runWitness(repo, {
  runId = RUN_ID,
  headSha = SHA_A,
  prList = [],
  prViews = {},
  createdPr = '1000',
  createExitCode = 0,
  createListAppend = true,
  createDiscoverablePr = null,
  createEmitUrl = true,
  suppressLabel = false,
} = {}) {
  writeFileSync(repo.listJson, JSON.stringify(prList));
  writeFileSync(repo.viewJson, JSON.stringify(prViews));
  const wd = mkdtempSync(join(repo.root, 'wd-'));
  run('git', ['clone', repo.origin, wd]); // checks out main (origin HEAD)
  const r = spawnSync('bash', [SCRIPT], {
    cwd: wd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${repo.binDir}:${process.env.PATH}`,
      GH_TOKEN: 'stub-token',
      RUN_ID: runId,
      HEAD_SHA: headSha,
      REPO,
      DEFAULT_BRANCH: 'main',
      GH_PR_LIST_JSON: repo.listJson,
      GH_CREATE_LOG: repo.createLog,
      GH_LABEL_LOG: repo.labelLog,
      GH_LABEL_STATE: repo.labelState,
      GH_CLOSE_LOG: repo.closeLog,
      GH_PR_VIEW_JSON: repo.viewJson,
      GH_STUB_OWNER: OWNER,
      GH_CREATED_PR: createdPr,
      GH_CREATE_EXIT_CODE: String(createExitCode),
      GH_CREATE_LIST_APPEND: createListAppend ? '1' : '0',
      ...(createDiscoverablePr === null ? {} : { GH_CREATE_DISCOVERABLE_PR: String(createDiscoverablePr) }),
      GH_CREATE_EMIT_URL: createEmitUrl ? '1' : '0',
      GH_SUPPRESS_LABEL: suppressLabel ? '1' : '0',
    },
  });
  return r;
}

function remoteBranchSha(repo) {
  const r = run('git', ['-C', repo.origin, 'rev-parse', BRANCH_REF], { allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function createCount(repo) {
  return readLines(repo.createLog).length;
}

function appliedLabels(repo) {
  return readLines(repo.labelLog);
}

function closedPrs(repo) {
  return readLines(repo.closeLog);
}

function commitCountOnBranch(repo) {
  return Number(run('git', ['-C', repo.origin, 'rev-list', '--count', BRANCH_REF]).stdout.trim());
}

test('branch absent: creates run-id branch, one docs commit, opens a PR, applies risk:red', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'app/solidus-paperclip-delivery' }) },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(remoteBranchSha(repo), 'run-id branch must be pushed to origin');
    assert.equal(commitCountOnBranch(repo), 2, 'base commit + one witness commit');
    const changed = run('git', ['-C', repo.origin, 'diff', '--name-only', 'main', BRANCH_REF]).stdout.trim().split('\n');
    assert.deepEqual(changed, [DOC_PATH], 'docs-only, RED-scoped file');
    assert.equal(createCount(repo), 1, 'a PR must be created when none exists');
    assert.deepEqual(appliedLabels(repo), ['risk:red'], 'exactly the risk:red label must be applied');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('idempotency: identical re-run makes no new commit, reuses PR, still applies risk:red', { skip }, () => {
  const repo = makeRepo();
  try {
    runWitness(repo, {
      headSha: SHA_A,
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'app/solidus-paperclip-delivery' }) },
    });
    const shaAfterFirst = remoteBranchSha(repo);
    const commitsAfterFirst = commitCountOnBranch(repo);

    const r = runWitness(repo, {
      headSha: SHA_A,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: { 101: stubPr({ number: 101, author: 'app/solidus-paperclip-delivery' }) },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No changes to commit \(idempotent re-run\)\./);
    assert.match(r.stdout, /Reusing existing witness PR #101/);
    assert.equal(remoteBranchSha(repo), shaAfterFirst, 'branch tip must be unchanged');
    assert.equal(commitCountOnBranch(repo), commitsAfterFirst, 'no extra commit on re-run');
    assert.equal(createCount(repo), 1, 'must not open a duplicate PR');
    assert.deepEqual(appliedLabels(repo), ['risk:red'], 'reuse path must not mutate a valid witness PR');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('changed content: branch exists but generated file differs → exactly one new commit', { skip }, () => {
  const repo = makeRepo();
  try {
    runWitness(repo, {
      headSha: SHA_A,
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'app/solidus-paperclip-delivery' }) },
    });
    const commitsAfterFirst = commitCountOnBranch(repo);
    const shaAfterFirst = remoteBranchSha(repo);

    const r = runWitness(repo, {
      headSha: SHA_B,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: { 101: stubPr({ number: 101, author: 'app/solidus-paperclip-delivery' }) },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /No changes to commit/);
    assert.equal(commitCountOnBranch(repo), commitsAfterFirst + 1, 'exactly one new commit');
    assert.notEqual(remoteBranchSha(repo), shaAfterFirst, 'branch tip must advance');
    const changed = run('git', ['-C', repo.origin, 'diff', '--name-only', 'main', BRANCH_REF]).stdout.trim().split('\n');
    assert.deepEqual(changed, [DOC_PATH]);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fix#2 duplicate PR rows: selects first owner match, exits 0 (no SIGPIPE)', { skip }, () => {
  const repo = makeRepo();
  try {
    runWitness(repo, {
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'app/solidus-paperclip-delivery' }) },
    }); // seed the branch
    const createsBefore = createCount(repo);
    const r = runWitness(repo, {
      prList: [
        { number: 77, headRepositoryOwner: { login: OWNER } },
        { number: 88, headRepositoryOwner: { login: OWNER } },
      ],
      prViews: { 77: stubPr({ number: 77, author: 'app/solidus-paperclip-delivery' }) },
    });
    assert.equal(r.status, 0, `must not fail under pipefail: ${r.stderr}`);
    assert.match(r.stdout, /Reusing existing witness PR #77/, 'first owner-scoped match wins');
    assert.doesNotMatch(r.stdout, /#88/);
    assert.equal(createCount(repo), createsBefore, 'reuse, not recreate');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('owner scoping: a same-named fork branch PR is ignored; owner PR is reused', { skip }, () => {
  const repo = makeRepo();
  try {
    runWitness(repo, {
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'app/solidus-paperclip-delivery' }) },
    });
    const createsBefore = createCount(repo);
    const r = runWitness(repo, {
      prList: [
        { number: 999, headRepositoryOwner: { login: 'attacker' } },
        { number: 42, headRepositoryOwner: { login: OWNER } },
      ],
      prViews: { 42: stubPr({ number: 42, author: 'app/solidus-paperclip-delivery' }) },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Reusing existing witness PR #42/);
    assert.doesNotMatch(r.stdout, /#999/, 'fork-owned PR must never be selected');
    assert.equal(createCount(repo), createsBefore, 'reuse, not recreate');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('owner scoping: ONLY fork-owned PRs → treated as none, so a real PR is opened', { skip }, () => {
  const repo = makeRepo();
  try {
    runWitness(repo, {
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'app/solidus-paperclip-delivery' }) },
    }); // creates branch + 1 PR
    const before = createCount(repo);
    const r = runWitness(repo, {
      prList: [{ number: 555, headRepositoryOwner: { login: 'attacker' } }],
      prViews: { 1000: stubPr({ number: 1000, author: 'app/solidus-paperclip-delivery' }) },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Reusing existing witness PR/, 'fork-only lookup must not count as existing');
    assert.equal(createCount(repo), before + 1, 'must open a PR when only fork PRs exist');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: a freshly created github-actions[bot] PR is rejected AND torn down', { skip }, () => {
  // A witness opened with the built-in GITHUB_TOKEN authors a github-actions[bot]
  // PR whose pull_request workflows are suppressed → the required checks never
  // run. It must fail closed. Because the label rides atomically with creation,
  // the PR is never green; and because WE created it under the wrong identity,
  // the script tears it down so no witness of any colour is left behind.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'github-actions[bot]' }) },
      createdPr: '1000',
    });
    assert.notEqual(r.status, 0, 'must fail closed on the event-suppressed identity');
    assert.match(r.stderr, /authored by 'github-actions\[bot\]'/,
      'error must name the forbidden, event-suppressed identity');
    assert.match(r.stderr, /minted solidus-paperclip-delivery App installation token/, 'error must point to the correct fix');
    assert.deepEqual(closedPrs(repo), ['close 1000'], 'the wrong-identity fresh PR must be closed, not left behind');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: any non-allowlisted author is rejected and the fresh PR is torn down', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'some-other-app[bot]' }) },
      createdPr: '1000',
    });
    assert.notEqual(r.status, 0, 'a non-allowlisted author must fail closed');
    assert.match(r.stderr, /authored by 'some-other-app\[bot\]'/, 'error names the actual (wrong) author');
    assert.match(r.stderr, /not the allowlisted App identity \('app\/solidus-paperclip-delivery' or 'solidus-paperclip-delivery\[bot\]'\)/,
      'error names both expected allowlisted forms');
    assert.deepEqual(closedPrs(repo), ['close 1000'], 'the wrong-identity fresh PR must be closed');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: a REUSED wrong-identity PR is rejected but NOT closed (we did not create it)', { skip }, () => {
  // On the reuse path the author guard runs BEFORE any label mutation, so no label
  // is applied to a wrong-identity PR — and the script must not close a PR it did
  // not create.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [{ number: 202, headRepositoryOwner: { login: OWNER } }],
      prViews: { 202: stubPr({ number: 202, author: 'github-actions[bot]' }) },
    });
    assert.notEqual(r.status, 0, 'must fail closed on a reused wrong-identity PR');
    assert.match(r.stderr, /authored by 'github-actions\[bot\]'/);
    assert.deepEqual(appliedLabels(repo), [], 'no label may be applied to a reused wrong-identity PR');
    assert.deepEqual(closedPrs(repo), [], 'a pre-existing PR must never be closed by this script');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed (Finding 1): gh pr create non-zero after emitting a trustworthy id → fresh PR torn down', { skip }, () => {
  // Models a partial `gh pr create --label` failure where create itself emits
  // the trustworthy PR id. That exact PR may be closed after authoritative
  // revalidation as the same-repo witness PR created by this invocation.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'solidus-paperclip-delivery[bot]' }) },
      createdPr: '1000',
      createExitCode: 1,
    });
    assert.notEqual(r.status, 0, 'partial create failure must fail closed');
    assert.match(r.stderr, /gh pr create exited 1 after emitting trustworthy PR #1000/,
      'must explain the partial-create cleanup');
    assert.deepEqual(closedPrs(repo), ['close 1000'], 'the fresh PR must be closed on partial create failure');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed (Finding 1): branch-discoverable PR without trustworthy create id is NOT closed', { skip }, () => {
  // Another same-branch PR may appear after create fails. Without an id emitted
  // by that exact create invocation, cleanup is forbidden.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: { 999: stubPr({ number: 999, author: 'solidus-paperclip-delivery[bot]' }) },
      createdPr: '1000',
      createExitCode: 1,
      createDiscoverablePr: '999',
      createEmitUrl: false,
      createListAppend: true,
    });
    assert.notEqual(r.status, 0, 'create failure without a trustworthy id must fail closed');
    assert.match(r.stderr, /without emitting a trustworthy PR identifier; refusing cleanup/,
      'must refuse cleanup without an emitted id');
    assert.deepEqual(closedPrs(repo), [], 'branch-discoverable PR #999 must not be closed');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed (Finding 1): label that never sticks → verification trips, fresh PR torn down', { skip }, () => {
  // Models `gh pr create --label` (and any re-add) silently NOT applying the
  // label. The authoritative re-read (`gh pr view --json labels`) returns nothing,
  // so the script must refuse to report success AND close the fresh, green-shaped
  // PR so no accidental green witness is left behind.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'solidus-paperclip-delivery[bot]', labels: [] }) },
      createdPr: '1000',
      suppressLabel: true,
    });
    assert.notEqual(r.status, 0, 'missing risk:red label must fail closed');
    assert.match(r.stderr, /does not carry the required risk:red label/, 'must explain the fail-closed reason');
    assert.match(r.stderr, /no green-shaped witness is left behind/, 'must announce the teardown');
    assert.deepEqual(closedPrs(repo), ['close 1000'], 'the unlabeled fresh PR must be closed');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('happy path (GraphQL form): an app/solidus-paperclip-delivery-authored PR passes and is labelled', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'app/solidus-paperclip-delivery' }) },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /authored by app\/solidus-paperclip-delivery/, 'the GraphQL-form login is accepted');
    assert.doesNotMatch(r.stderr, /not the allowlisted App identity/, 'must not trip the guard');
    assert.deepEqual(appliedLabels(repo), ['risk:red']);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('happy path (REST form): a solidus-paperclip-delivery[bot]-authored PR passes and is labelled', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: { 1000: stubPr({ number: 1000, author: 'solidus-paperclip-delivery[bot]' }) },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /authored by solidus-paperclip-delivery\[bot\]/, 'the REST-form login is accepted');
    assert.doesNotMatch(r.stderr, /not the allowlisted App identity/, 'must not trip the guard');
    assert.deepEqual(appliedLabels(repo), ['risk:red']);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: near-lookalike App logins are rejected (exact match, no prefix/substring)', { skip }, () => {
  const lookalikes = [
    'app/solidus-paperclip-delivery-evil',
    'app/solidus-paperclip-deliveryx',
    'app/solidus-paperclip',
    'solidus-paperclip-delivery',
    'app/solidus-paperclip-delivery[bot]',
    'solidus-paperclip-delivery[bot]-evil',
    ' app/solidus-paperclip-delivery',
    'app/Solidus-Paperclip-Delivery',
  ];
  for (const impostor of lookalikes) {
    const repo = makeRepo();
    try {
      const r = runWitness(repo, {
        prList: [],
        prViews: { 1000: stubPr({ number: 1000, author: impostor }) },
        createdPr: '1000',
      });
      assert.notEqual(r.status, 0, `lookalike must fail closed: ${JSON.stringify(impostor)}`);
      assert.match(r.stderr, /not the allowlisted App identity/, `guard must reject ${JSON.stringify(impostor)}`);
      assert.deepEqual(closedPrs(repo), ['close 1000'], `wrong-identity fresh PR must be torn down: ${JSON.stringify(impostor)}`);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }
});

test('RUN_ID guard: a non-numeric run id is rejected before any git/gh action', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { runId: '../../evil', prList: [] });
    assert.notEqual(r.status, 0, 'must fail closed on a non-numeric RUN_ID');
    assert.match(r.stderr, /RUN_ID must be a positive integer/);
    assert.equal(remoteBranchSha(repo), null, 'no branch may be created');
    assert.equal(createCount(repo), 0, 'no PR may be created');
    assert.deepEqual(appliedLabels(repo), [], 'no label may be applied');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: extra file fails closed with no mutation and no close', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({
          number: 101,
          author: 'solidus-paperclip-delivery[bot]',
          files: [{ path: DOC_PATH }, { path: 'src/pwn.ts' }],
        }),
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /changes 2 files; expected exactly 1/);
    assert.deepEqual(appliedLabels(repo), [], 'must not mutate reused invalid PR');
    assert.deepEqual(closedPrs(repo), [], 'must not close reused invalid PR');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: wrong base fails closed with no mutation and no close', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: { 101: stubPr({ number: 101, baseRefName: 'release', author: 'solidus-paperclip-delivery[bot]' }) },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /targets base 'release', expected 'main'/);
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(closedPrs(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: rename source fails closed with no mutation and no close', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({
          number: 101,
          author: 'solidus-paperclip-delivery[bot]',
          files: [{ path: DOC_PATH, previous_filename: '.github/workflows/pr.yml' }],
        }),
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /includes rename source '.github\/workflows\/pr\.yml'/);
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(closedPrs(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: wrong doc path fails closed with no mutation and no close', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({
          number: 101,
          author: 'solidus-paperclip-delivery[bot]',
          files: [{ path: 'doc/autonomy-witness-red/999999.md' }],
        }),
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /changes 'doc\/autonomy-witness-red\/999999\.md', expected 'doc\/autonomy-witness-red\/123456\.md'/);
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(closedPrs(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: missing label fails closed with no mutation and no close', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: { 101: stubPr({ number: 101, author: 'solidus-paperclip-delivery[bot]', labels: [] }) },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not carry the required risk:red label/);
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(closedPrs(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
