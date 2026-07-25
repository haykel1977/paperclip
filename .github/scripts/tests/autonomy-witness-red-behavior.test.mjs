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
//   - fail-closed author/shape/label validation on both create and reuse paths;
//   - create-as-draft first, request label, verify, and only then mark ready.
// The script only runs on a Unix runner; skip elsewhere.

const SCRIPT = fileURLToPath(new URL('../autonomy-witness-red.sh', import.meta.url));
const OWNER = 'haykel1977';
const REPO = `${OWNER}/paperclip`;
const RUN_ID = '123456';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BRANCH_REF = `refs/heads/autonomy-witness-red/${RUN_ID}`;
const DOC_PATH = `doc/autonomy-witness-red/${RUN_ID}.md`;
const PR_ID_1000 = 'PR_kwDORED1000';

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

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
}

function stubPr({
  number,
  id = `PR_kwDORED${number}`,
  headRepositoryOwner = OWNER,
  baseRefName = 'main',
  headRefName = `autonomy-witness-red/${RUN_ID}`,
  headRefOid = SHA_A,
  author = 'app/solidus-paperclip-delivery',
  isDraft = false,
  labels = ['risk:red'],
  files = [{ filename: DOC_PATH }],
  url = `https://example.test/pull/${number}`,
} = {}) {
  return {
    number,
    id,
    headRepositoryOwner: { login: headRepositoryOwner },
    baseRefName,
    headRefName,
    headRefOid,
    author: { login: author },
    isDraft,
    labels: labels.map(name => ({ name })),
    files,
    url,
  };
}

/** Build an isolated bare origin (default branch `main`) + a jq-backed gh stub. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'awr-'));
  const origin = join(root, 'origin.git');
  run('git', ['init', '--bare', '--initial-branch=main', origin]);

  const seed = join(root, 'seed');
  run('git', ['clone', origin, seed]);
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
  const stateJson = join(root, 'pr-state.json');
  const createLog = join(root, 'gh-create.log');
  const editLog = join(root, 'gh-edit.log');
  const readyLog = join(root, 'gh-ready.log');
  const closeLog = join(root, 'gh-close.log');
  const realGit = run('bash', ['-lc', 'command -v git']).stdout.trim();

  const gitWrapper = `#!/usr/bin/env bash
set -euo pipefail
REAL_GIT="${realGit}"
if [ "\${1:-}" = "push" ] && [ "\${2:-}" = "origin" ] && [ -n "\${3:-}" ]; then
  "\$REAL_GIT" "$@"
  branch="\${3#refs/heads/}"
  head_oid="\$("\$REAL_GIT" rev-parse HEAD)"
  if [ -f "\$GH_PR_STATE_JSON" ]; then
    jq --arg branch "\$branch" --arg oid "\$head_oid" '
      with_entries(
        if .value.headRefName == \$branch then
          .value.headRefOid = \$oid
        else
          .
        end
      )
    ' "\$GH_PR_STATE_JSON" > "\$GH_PR_STATE_JSON.tmp"
    mv "\$GH_PR_STATE_JSON.tmp" "\$GH_PR_STATE_JSON"
  fi
  exit 0
fi
"\$REAL_GIT" "$@"
`;
  const gitPath = join(binDir, 'git');
  writeFileSync(gitPath, gitWrapper);
  chmodSync(gitPath, 0o755);

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

find_pr_number() {
  local args=("\$@") i
  for ((i=0;i<\${#args[@]};i++)); do
    if [[ "\${args[\$i]}" =~ ^[0-9]+$ ]]; then
      printf '%s' "\${args[\$i]}"
      return 0
    fi
  done
  printf '%s' "0"
}

record_line() {
  local path="\$1"; shift
  echo "\$*" >> "\$path"
}

load_state() {
  cat "\$GH_PR_STATE_JSON"
}

save_state() {
  local tmp
  tmp="\$(mktemp)"
  cat > "\$tmp"
  mv "\$tmp" "\$GH_PR_STATE_JSON"
}

find_api_path() {
  local args=("\$@") i
  for ((i=0;i<\${#args[@]};i++)); do
    if [[ "\${args[\$i]}" == /repos/* ]]; then
      printf '%s' "\${args[\$i]}"
      return 0
    fi
  done
  return 1
}

upsert_list_row() {
  local number="\$1"
  local owner="\$2"
  local tmp
  tmp="\$(mktemp)"
  jq --argjson n "\$number" --arg o "\$owner" '
    (map(select(.number != \$n))) + [{number:\$n, state:"OPEN", headRepositoryOwner:{login:\$o}}]
  ' "\$GH_PR_LIST_JSON" > "\$tmp"
  mv "\$tmp" "\$GH_PR_LIST_JSON"
}

close_list_row() {
  local number="\$1"
  local tmp
  tmp="\$(mktemp)"
  jq --argjson n "\$number" '
    map(
      if .number == \$n then
        .state = "CLOSED"
      else
        .
      end
    )
  ' "\$GH_PR_LIST_JSON" > "\$tmp"
  mv "\$tmp" "\$GH_PR_LIST_JSON"
}

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  jq -r "\$(jq_expr "\$@")" "\$GH_PR_LIST_JSON"
  exit 0
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  num="\$(find_pr_number "\$@")"
  expr="\$(jq_expr "\$@")"
  pr_json="\$(jq -c --argjson n "\$num" '.[$n|tostring] // {}' "\$GH_PR_STATE_JSON")"
  if [ -n "\$expr" ]; then
    printf '%s\n' "\$pr_json" | jq -r "\$expr"
  else
    printf '%s\n' "\$pr_json"
  fi
  exit 0
fi

if [ "\${1:-}" = "api" ]; then
  path="\$(find_api_path "\$@")"
  if [[ "\$path" =~ ^/repos/.+/pulls/([0-9]+)/files\\?per_page=100$ ]]; then
    num="\${BASH_REMATCH[1]}"
    jq -c --argjson n "\$num" '.[$n|tostring].files // []' "\$GH_PR_STATE_JSON"
    exit 0
  fi
fi

if [ "\${1:-}" = "auth" ]; then
  exit 0
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "edit" ]; then
  num="\$(find_pr_number "\$@")"
  lbl="\$(opt_value --add-label "\$@")"
  record_line "\$GH_EDIT_LOG" "edit \$num \$lbl"
  if [ "\${GH_SUPPRESS_LABEL:-0}" = "1" ]; then
    exit 0
  fi
  jq --argjson n "\$num" --arg lbl "\$lbl" '
    .[\$n|tostring].labels = (
      ((.[\$n|tostring].labels // []) | map(.name))
      + [\$lbl]
      | unique
      | map({name:.})
    ) | .
  ' "\$GH_PR_STATE_JSON" | save_state
  exit 0
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "ready" ]; then
  num="\$(find_pr_number "\$@")"
  record_line "\$GH_READY_LOG" "ready \$num"
  if [ "\${GH_READY_EXIT_CODE:-0}" != "0" ]; then
    exit "\${GH_READY_EXIT_CODE}"
  fi
  jq --argjson n "\$num" '.[$n|tostring].isDraft = false | .' "\$GH_PR_STATE_JSON" | save_state
  exit 0
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "close" ]; then
  num="\$(find_pr_number "\$@")"
  record_line "\$GH_CLOSE_LOG" "close \$num"
  close_list_row "\$num"
  exit 0
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "create" ]; then
  record_line "\$GH_CREATE_LOG" "create $*"
  if [ "\${GH_CREATE_LIST_APPEND:-1}" = "1" ]; then
    upsert_list_row "\$GH_CREATED_PR" "\$GH_STUB_OWNER"
  fi
  if [ "\${GH_CREATE_STATE_APPEND:-1}" = "1" ]; then
    head_oid="\$(git rev-parse HEAD)"
    jq --argjson n "\$GH_CREATED_PR" \
       --arg id "\${GH_CREATED_PR_ID}" \
       --arg owner "\$GH_STUB_OWNER" \
       --arg base "\$GH_DEFAULT_BRANCH" \
       --arg head "\$GH_BRANCH_NAME" \
       --arg oid "\$head_oid" \
       --arg author "\$GH_CREATED_PR_AUTHOR" \
       --argjson draft "\${GH_CREATED_PR_DRAFT:-true}" \
       --arg doc "\$GH_DOC_PATH" \
       '
         . + {
           (\$n|tostring): {
             number: \$n,
             id: \$id,
             isDraft: \$draft,
             baseRefName: \$base,
             headRefName: \$head,
             headRepositoryOwner: { login: \$owner },
             headRefOid: \$oid,
             author: { login: \$author },
             labels: [],
             files: [{ filename: \$doc }],
             url: ("https://example.test/pull/" + (\$n|tostring))
           }
         }
       ' "\$GH_PR_STATE_JSON" | save_state
  fi
  if [ "\${GH_CREATE_EMIT_URL:-1}" = "1" ]; then
    echo "https://example.test/pull/\${GH_CREATED_PR}"
  fi
  if [ -n "\${GH_CREATE_STDERR_TEXT:-}" ]; then
    printf '%s\n' "\${GH_CREATE_STDERR_TEXT}" >&2
  fi
  exit "\${GH_CREATE_EXIT_CODE:-0}"
fi

echo "unhandled gh: $*" >&2
exit 1
`;
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, stub);
  chmodSync(ghPath, 0o755);

  return { root, origin, binDir, listJson, stateJson, createLog, editLog, readyLog, closeLog };
}

function runWitness(repo, {
  runId = RUN_ID,
  headSha = SHA_A,
  prList = [],
  prViews = {},
  createdPr = '1000',
  createdPrId = PR_ID_1000,
  createdPrAuthor = 'app/solidus-paperclip-delivery',
  createdPrDraft = true,
  createExitCode = 0,
  createListAppend = true,
  createStateAppend = true,
  createEmitUrl = true,
  createStderrText = '',
  suppressLabel = false,
  readyExitCode = 0,
} = {}) {
  writeJson(repo.listJson, prList.map(pr => ({ state: 'OPEN', ...pr })));
  writeJson(repo.stateJson, prViews);
  const wd = mkdtempSync(join(repo.root, 'wd-'));
  run('git', ['clone', repo.origin, wd]); // checks out main (origin HEAD)
  const branchName = `autonomy-witness-red/${runId}`;
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
      GH_DEFAULT_BRANCH: 'main',
      GH_BRANCH_NAME: branchName,
      GH_DOC_PATH: `doc/autonomy-witness-red/${runId}.md`,
      GH_PR_LIST_JSON: repo.listJson,
      GH_PR_STATE_JSON: repo.stateJson,
      GH_CREATE_LOG: repo.createLog,
      GH_EDIT_LOG: repo.editLog,
      GH_READY_LOG: repo.readyLog,
      GH_CLOSE_LOG: repo.closeLog,
      GH_STUB_OWNER: OWNER,
      GH_CREATED_PR: createdPr,
      GH_CREATED_PR_ID: createdPrId,
      GH_CREATED_PR_AUTHOR: createdPrAuthor,
      GH_CREATED_PR_DRAFT: createdPrDraft ? 'true' : 'false',
      GH_CREATE_EXIT_CODE: String(createExitCode),
      GH_CREATE_LIST_APPEND: createListAppend ? '1' : '0',
      GH_CREATE_STATE_APPEND: createStateAppend ? '1' : '0',
      GH_CREATE_EMIT_URL: createEmitUrl ? '1' : '0',
      GH_CREATE_STDERR_TEXT: createStderrText,
      GH_SUPPRESS_LABEL: suppressLabel ? '1' : '0',
      GH_READY_EXIT_CODE: String(readyExitCode),
    },
  });
  return r;
}

function seedWitness(repo, opts = {}) {
  const r = runWitness(repo, { prList: [], ...opts });
  assert.equal(r.status, 0, `seed run failed: ${r.stderr}`);
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
  return readLines(repo.editLog);
}

function readyCalls(repo) {
  return readLines(repo.readyLog);
}

function closedPrs(repo) {
  return readLines(repo.closeLog);
}

function resetActionLogs(repo) {
  writeFileSync(repo.editLog, '');
  writeFileSync(repo.readyLog, '');
  writeFileSync(repo.closeLog, '');
}

function prState(repo, number) {
  return readJson(repo.stateJson)[String(number)];
}

function commitCountOnBranch(repo) {
  return Number(run('git', ['-C', repo.origin, 'rev-list', '--count', BRANCH_REF]).stdout.trim());
}

test('branch absent: creates run-id branch, one docs commit, opens a DRAFT PR, applies risk:red, then marks ready', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: {},
      createdPrAuthor: 'app/solidus-paperclip-delivery',
      headSha: SHA_A,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(remoteBranchSha(repo), 'run-id branch must be pushed to origin');
    assert.equal(commitCountOnBranch(repo), 2, 'base commit + one witness commit');
    const changed = run('git', ['-C', repo.origin, 'diff', '--name-only', 'main', BRANCH_REF]).stdout.trim().split('\n');
    assert.deepEqual(changed, [DOC_PATH], 'docs-only, RED-scoped file');
    assert.equal(createCount(repo), 1, 'a PR must be created when none exists');
    assert.deepEqual(appliedLabels(repo), ['edit 1000 risk:red'], 'risk:red is requested after draft creation');
    assert.deepEqual(readyCalls(repo), ['ready 1000'], 'draft is made ready only after validation');
    const pr = prState(repo, 1000);
    assert.equal(pr.isDraft, false, 'created PR should end ready');
    assert.deepEqual(pr.labels.map(l => l.name), ['risk:red'], 'created PR should carry exact risk:red');
    assert.equal(pr.headRefOid, remoteBranchSha(repo), 'created PR should point at the pushed witness head');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('idempotency: identical re-run makes no new commit, reuses PR, and already-ready PR stays ready', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const shaAfterFirst = remoteBranchSha(repo);
    const commitsAfterFirst = commitCountOnBranch(repo);
    resetActionLogs(repo);

    const r = runWitness(repo, {
      headSha: SHA_A,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({ number: 101, headRefOid: shaAfterFirst, author: 'app/solidus-paperclip-delivery', isDraft: false }),
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No changes to commit \(idempotent re-run\)\./);
    assert.match(r.stdout, /Reusing existing witness PR #101/);
    assert.equal(remoteBranchSha(repo), shaAfterFirst, 'branch tip must be unchanged');
    assert.equal(commitCountOnBranch(repo), commitsAfterFirst, 'no extra commit on re-run');
    assert.equal(createCount(repo), 1, 'must not open a duplicate PR');
    assert.deepEqual(appliedLabels(repo), [], 'reuse path must not mutate labels');
    assert.deepEqual(readyCalls(repo), [], 'already-ready PR must remain untouched');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: valid draft is only marked ready after complete validation', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const beforeSha = remoteBranchSha(repo);
    resetActionLogs(repo);
    const r = runWitness(repo, {
      headSha: SHA_A,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({ number: 101, headRefOid: beforeSha, author: 'solidus-paperclip-delivery[bot]', isDraft: true }),
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(appliedLabels(repo), [], 'valid reuse draft should not be label-mutated');
    assert.deepEqual(readyCalls(repo), ['ready 101'], 'valid reuse draft may become ready');
    assert.equal(prState(repo, 101).isDraft, false, 'reused draft should become ready');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('changed content: branch exists but generated file differs → exactly one new commit', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo, { headSha: SHA_A });
    const commitsAfterFirst = commitCountOnBranch(repo);
    const shaAfterFirst = remoteBranchSha(repo);
    resetActionLogs(repo);

    const r = runWitness(repo, {
      headSha: SHA_B,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({ number: 101, headRefOid: shaAfterFirst, author: 'app/solidus-paperclip-delivery', isDraft: false }),
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /No changes to commit/);
    assert.equal(commitCountOnBranch(repo), commitsAfterFirst + 1, 'exactly one new commit');
    assert.notEqual(remoteBranchSha(repo), shaAfterFirst, 'branch tip must advance');
    const changed = run('git', ['-C', repo.origin, 'diff', '--name-only', 'main', BRANCH_REF]).stdout.trim().split('\n');
    assert.deepEqual(changed, [DOC_PATH]);
    assert.equal(prState(repo, 101).headRefOid, remoteBranchSha(repo), 'reused PR should still point at the updated branch head');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('multiple same-repo open PR rows fail closed without guessing or recreating', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo); // seed the branch
    const createsBefore = createCount(repo);
    const beforeSha = remoteBranchSha(repo);
    const beforeCommits = commitCountOnBranch(repo);
    resetActionLogs(repo);
    const r = runWitness(repo, {
      prList: [
        { number: 77, headRepositoryOwner: { login: OWNER } },
        { number: 88, headRepositoryOwner: { login: OWNER } },
      ],
      prViews: {},
    });
    assert.notEqual(r.status, 0, 'multiple same-repo open PRs must fail closed');
    assert.match(r.stderr, /matching open witness PRs/, 'must explain the ambiguity');
    assert.equal(createCount(repo), createsBefore, 'must not create a duplicate PR');
    assert.equal(remoteBranchSha(repo), beforeSha, 'ambiguous reuse must leave the branch untouched');
    assert.equal(commitCountOnBranch(repo), beforeCommits, 'ambiguous reuse must not add commits');
    assert.deepEqual(appliedLabels(repo), [], 'ambiguous reuse must not mutate labels');
    assert.deepEqual(closedPrs(repo), [], 'ambiguous reuse must not close any PR');
    assert.deepEqual(readyCalls(repo), [], 'ambiguous reuse must not ready any PR');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('owner scoping: a same-named fork branch PR is ignored; owner PR is reused', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const createsBefore = createCount(repo);
    const beforeSha = remoteBranchSha(repo);
    const r = runWitness(repo, {
      prList: [
        { number: 999, headRepositoryOwner: { login: 'attacker' } },
        { number: 42, headRepositoryOwner: { login: OWNER } },
      ],
      prViews: {
        42: stubPr({ number: 42, headRefOid: beforeSha, author: 'app/solidus-paperclip-delivery' }),
      },
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
    seedWitness(repo);
    const before = createCount(repo);
    const r = runWitness(repo, {
      prList: [{ number: 555, headRepositoryOwner: { login: 'attacker' } }],
      prViews: {},
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Reusing existing witness PR/, 'fork-only lookup must not count as existing');
    assert.equal(createCount(repo), before + 1, 'must open a PR when only fork PRs exist');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('closed same-branch same-repo PR fails closed before any mutation or recreate', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const beforeSha = remoteBranchSha(repo);
    const beforeCommits = commitCountOnBranch(repo);
    const createsBefore = createCount(repo);
    resetActionLogs(repo);
    const r = runWitness(repo, {
      headSha: SHA_B,
      prList: [{ number: 101, state: 'CLOSED', headRepositoryOwner: { login: OWNER } }],
      prViews: {},
    });
    assert.notEqual(r.status, 0, 'closed prior witness PR must fail closed');
    assert.match(r.stderr, /matching closed\/terminal witness PR/, 'must explain the terminal-state refusal');
    assert.equal(createCount(repo), createsBefore, 'must not create a duplicate PR');
    assert.equal(remoteBranchSha(repo), beforeSha, 'closed prior PR must leave the branch untouched');
    assert.equal(commitCountOnBranch(repo), beforeCommits, 'closed prior PR must not add commits');
    assert.deepEqual(appliedLabels(repo), [], 'closed prior PR must not mutate labels');
    assert.deepEqual(closedPrs(repo), [], 'closed prior PR must not close any PR');
    assert.deepEqual(readyCalls(repo), [], 'closed prior PR must not ready any PR');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('ambiguous create failure: duplicate-PR stderr mentioning /pull/999 is never closed and never readied', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: {},
      createExitCode: 1,
      createEmitUrl: false,
      createStderrText: 'a pull request for branch "autonomy-witness-red/123456" into branch "main" already exists:\nhttps://github.com/haykel1977/paperclip/pull/999',
      createListAppend: false,
      createStateAppend: false,
    });
    assert.notEqual(r.status, 0, 'ambiguous create failure must fail closed');
    assert.match(r.stderr, /pull\/999/, 'stderr should surface the duplicate PR message');
    assert.deepEqual(closedPrs(repo), [], '#999 must never be closed on ambiguous create failure');
    assert.deepEqual(readyCalls(repo), [], 'partial/ambiguous create failure must never ready any PR');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('ambiguous create failure: partial create leaves draft, never ready, never closed', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: {},
      createExitCode: 1,
      createEmitUrl: true,
      createListAppend: true,
      createStateAppend: true,
      createdPrAuthor: 'solidus-paperclip-delivery[bot]',
      createdPrDraft: true,
    });
    assert.notEqual(r.status, 0, 'partial create failure must fail closed');
    const pr = prState(repo, 1000);
    assert.equal(pr.isDraft, true, 'partially created PR remains draft/inert');
    assert.deepEqual(pr.labels.map(l => l.name), [], 'no label mutation should occur after ambiguous create failure');
    assert.deepEqual(closedPrs(repo), [], 'ambiguous create failure must not close the partial draft');
    assert.deepEqual(readyCalls(repo), [], 'ambiguous create failure must not ready the partial draft');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: successfully created draft with wrong identity is closed after revalidation', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: {},
      createdPrAuthor: 'github-actions[bot]',
      createdPrDraft: true,
      headSha: SHA_A,
    });
    assert.notEqual(r.status, 0, 'must fail closed on the event-suppressed identity');
    assert.match(r.stderr, /authored by 'github-actions\[bot\]'/);
    assert.deepEqual(closedPrs(repo), ['close 1000'], 'known created draft should be closed after revalidation');
    assert.deepEqual(readyCalls(repo), [], 'wrong-identity draft must never be readied');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: label that never sticks closes only the known created draft', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: {},
      createdPrAuthor: 'solidus-paperclip-delivery[bot]',
      suppressLabel: true,
      headSha: SHA_A,
    });
    assert.notEqual(r.status, 0, 'missing risk:red label must fail closed');
    assert.match(r.stderr, /does not carry the required risk:red label/);
    assert.deepEqual(closedPrs(repo), ['close 1000'], 'known created draft should be closed when label verification fails');
    assert.deepEqual(readyCalls(repo), [], 'draft must not be readied when label verification fails');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('ready transition occurs only after all checks pass', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: {},
      createdPrAuthor: 'solidus-paperclip-delivery[bot]',
      headSha: SHA_A,
    });
    assert.equal(r.status, 0, r.stderr);
    const edits = appliedLabels(repo);
    const ready = readyCalls(repo);
    assert.deepEqual(edits, ['edit 1000 risk:red']);
    assert.deepEqual(ready, ['ready 1000']);
    const pr = prState(repo, 1000);
    assert.equal(pr.isDraft, false, 'ready happens only after validations pass');
    assert.deepEqual(pr.labels.map(l => l.name), ['risk:red']);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
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
    assert.deepEqual(readyCalls(repo), [], 'no ready transition may occur');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: extra file fails closed with branch SHA and commit count unchanged', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const beforeSha = remoteBranchSha(repo);
    const beforeCommits = commitCountOnBranch(repo);
    resetActionLogs(repo);
    const r = runWitness(repo, {
      headSha: SHA_B,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({
          number: 101,
          headRefOid: beforeSha,
          author: 'solidus-paperclip-delivery[bot]',
          files: [{ filename: DOC_PATH }, { filename: 'src/pwn.ts' }],
        }),
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /changes 2 files; expected exactly 1/);
    assert.equal(remoteBranchSha(repo), beforeSha, 'invalid reuse must leave remote branch unchanged');
    assert.equal(commitCountOnBranch(repo), beforeCommits, 'invalid reuse must leave commit count unchanged');
    assert.deepEqual(appliedLabels(repo), [], 'must not mutate reused invalid PR');
    assert.deepEqual(closedPrs(repo), [], 'must not close reused invalid PR');
    assert.deepEqual(readyCalls(repo), [], 'must not ready reused invalid PR');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: wrong base fails closed with branch SHA and commit count unchanged', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const beforeSha = remoteBranchSha(repo);
    const beforeCommits = commitCountOnBranch(repo);
    resetActionLogs(repo);
    const r = runWitness(repo, {
      headSha: SHA_B,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({ number: 101, headRefOid: beforeSha, baseRefName: 'release', author: 'solidus-paperclip-delivery[bot]' }),
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /targets base 'release', expected 'main'/);
    assert.equal(remoteBranchSha(repo), beforeSha, 'invalid reuse must leave remote branch unchanged');
    assert.equal(commitCountOnBranch(repo), beforeCommits, 'invalid reuse must leave commit count unchanged');
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(closedPrs(repo), []);
    assert.deepEqual(readyCalls(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: rename source fails closed with no mutation and no close', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const beforeSha = remoteBranchSha(repo);
    const beforeCommits = commitCountOnBranch(repo);
    resetActionLogs(repo);
    const r = runWitness(repo, {
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({
          number: 101,
          headRefOid: beforeSha,
          author: 'solidus-paperclip-delivery[bot]',
          files: [{ filename: DOC_PATH, previous_filename: '.github/workflows/pr.yml' }],
        }),
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /includes rename source '.github\/workflows\/pr\.yml'/);
    assert.equal(remoteBranchSha(repo), beforeSha);
    assert.equal(commitCountOnBranch(repo), beforeCommits);
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(closedPrs(repo), []);
    assert.deepEqual(readyCalls(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: wrong doc path fails closed with no mutation and no close', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const beforeSha = remoteBranchSha(repo);
    const beforeCommits = commitCountOnBranch(repo);
    resetActionLogs(repo);
    const r = runWitness(repo, {
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({
          number: 101,
          headRefOid: beforeSha,
          author: 'solidus-paperclip-delivery[bot]',
          files: [{ filename: 'doc/autonomy-witness-red/999999.md' }],
        }),
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /changes 'doc\/autonomy-witness-red\/999999\.md', expected 'doc\/autonomy-witness-red\/123456\.md'/);
    assert.equal(remoteBranchSha(repo), beforeSha);
    assert.equal(commitCountOnBranch(repo), beforeCommits);
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(closedPrs(repo), []);
    assert.deepEqual(readyCalls(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: missing label fails closed with no mutation and no close', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const beforeSha = remoteBranchSha(repo);
    const beforeCommits = commitCountOnBranch(repo);
    resetActionLogs(repo);
    const r = runWitness(repo, {
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({ number: 101, headRefOid: beforeSha, author: 'solidus-paperclip-delivery[bot]', labels: [] }),
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not carry the required risk:red label/);
    assert.equal(remoteBranchSha(repo), beforeSha);
    assert.equal(commitCountOnBranch(repo), beforeCommits);
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(closedPrs(repo), []);
    assert.deepEqual(readyCalls(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
