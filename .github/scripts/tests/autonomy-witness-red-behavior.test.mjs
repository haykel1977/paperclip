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

// The gh stub is jq-backed: without jq every test dies inside the stub with an
// opaque failure. Skip (with a reason) instead of misreporting a script bug.
const jqProbe = spawnSync('jq', ['--version'], { encoding: 'utf8' });
const skip = process.platform === 'win32'
  ? 'requires a Unix platform'
  : (jqProbe.status === 0 ? false : 'requires jq on PATH (the gh stub is jq-backed)');

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
  const unhandledLog = join(root, 'gh-unhandled.log');
  const realGit = run('bash', ['-c', 'command -v git']).stdout.trim();

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
  if [ "\${GH_LIST_EXIT_CODE:-0}" != "0" ]; then
    echo "gh stub: simulated pr list failure" >&2
    exit "\${GH_LIST_EXIT_CODE}"
  fi
  # Model real gh semantics: default state is OPEN-only; --state all exposes
  # closed/merged rows. A script that forgets --state all therefore never sees
  # terminal PRs, which the one-PR-per-run fail-closed tests would catch.
  state="\$(opt_value --state "\$@")"
  if [ "\${state:-open}" = "all" ]; then
    jq -r "\$(jq_expr "\$@")" "\$GH_PR_LIST_JSON"
  else
    jq '[.[] | select((.state // "OPEN") == "OPEN")]' "\$GH_PR_LIST_JSON" | jq -r "\$(jq_expr "\$@")"
  fi
  exit 0
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  if [ "\${GH_VIEW_CORRUPT:-0}" = "1" ]; then
    echo "gh stub: {corrupt json"
    exit 0
  fi
  num="\$(find_pr_number "\$@")"
  expr="\$(jq_expr "\$@")"
  if [ -n "\${GH_VIEW_COUNT_FILE:-}" ]; then
    count=0
    [ -f "\$GH_VIEW_COUNT_FILE" ] && count="\$(cat "\$GH_VIEW_COUNT_FILE")"
    count=\$((count + 1))
    printf '%s' "\$count" > "\$GH_VIEW_COUNT_FILE"
    if [ -n "\${GH_VIEW_CORRUPT_AT:-}" ] && [ "\$count" = "\$GH_VIEW_CORRUPT_AT" ]; then
      echo "gh stub: {transiently corrupt json"
      exit 0
    fi
    if [ -n "\${GH_VIEW_MUTATE_OID_AFTER:-}" ] && [ "\$count" -gt "\$GH_VIEW_MUTATE_OID_AFTER" ]; then
      jq --argjson n "\$num" '.[\$n|tostring].headRefOid = "cccccccccccccccccccccccccccccccccccccccc"' "\$GH_PR_STATE_JSON" | save_state
    fi
    if [ -n "\${GH_VIEW_MUTATE_DRAFT_AFTER:-}" ] && [ "\$count" -gt "\$GH_VIEW_MUTATE_DRAFT_AFTER" ]; then
      jq --argjson n "\$num" '.[\$n|tostring].isDraft = false' "\$GH_PR_STATE_JSON" | save_state
    fi
  fi
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
    # Model real gh pagination: pages of 100. Without --paginate only the FIRST
    # page is returned; with --paginate every page is emitted as its own JSON
    # array (which is exactly what the script's \`jq -s 'add // []'\` slurps).
    # A script that drops --paginate therefore under-counts >100-file PRs.
    has_paginate=0
    for arg in "\$@"; do
      if [ "\$arg" = "--paginate" ]; then has_paginate=1; fi
    done
    if [ "\$has_paginate" = "1" ]; then
      jq -c --argjson n "\$num" '(.[\$n|tostring].files // []) as \$f | if (\$f|length) == 0 then [[]] else [range(0; (\$f|length); 100) as \$i | \$f[\$i:\$i+100]] end | .[]' "\$GH_PR_STATE_JSON"
    else
      jq -c --argjson n "\$num" '(.[\$n|tostring].files // []) | .[0:100]' "\$GH_PR_STATE_JSON"
    fi
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

record_line "\${GH_UNHANDLED_LOG:-/dev/null}" "$*"
echo "unhandled gh: $*" >&2
exit 1
`;
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, stub);
  chmodSync(ghPath, 0o755);

  return { root, origin, binDir, listJson, stateJson, createLog, editLog, readyLog, closeLog, unhandledLog };
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
  listExitCode = 0,
  viewCorrupt = false,
  viewMutateOidAfter = 0,
  viewMutateDraftAfter = 0,
  viewCorruptAt = 0,
} = {}) {
  writeJson(repo.listJson, prList.map(pr => ({ state: 'OPEN', ...pr })));
  writeJson(repo.stateJson, prViews);
  const wd = mkdtempSync(join(repo.root, 'wd-'));
  run('git', ['clone', repo.origin, wd]); // checks out main (origin HEAD)
  const branchName = `autonomy-witness-red/${runId}`;
  // Ambient GH_*/GITHUB_*/GIT_* auth or config must never leak into the run,
  // and a wedged child (credential prompt, stub reading stdin) must fail fast
  // with captured output instead of hanging until the runner timeout.
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(GH_|GITHUB_|GIT_)/.test(k)),
  );
  const r = spawnSync('bash', [SCRIPT], {
    cwd: wd,
    encoding: 'utf8',
    timeout: 120_000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...cleanEnv,
      GIT_TERMINAL_PROMPT: '0',
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
      GH_UNHANDLED_LOG: repo.unhandledLog,
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
      GH_LIST_EXIT_CODE: String(listExitCode),
      GH_VIEW_CORRUPT: viewCorrupt ? '1' : '0',
      ...(viewMutateOidAfter > 0 || viewMutateDraftAfter > 0 || viewCorruptAt > 0
        ? {
            ...(viewMutateOidAfter > 0 ? { GH_VIEW_MUTATE_OID_AFTER: String(viewMutateOidAfter) } : {}),
            ...(viewMutateDraftAfter > 0 ? { GH_VIEW_MUTATE_DRAFT_AFTER: String(viewMutateDraftAfter) } : {}),
            ...(viewCorruptAt > 0 ? { GH_VIEW_CORRUPT_AT: String(viewCorruptAt) } : {}),
            GH_VIEW_COUNT_FILE: join(repo.root, 'view-count'),
          }
        : {}),
    },
  });
  return r;
}

function seedWitness(repo, opts = {}) {
  const r = runWitness(repo, { prList: [], ...opts });
  assert.equal(r.status, 0, `seed run failed: ${r.stderr}`);
  assert.deepEqual(unhandledCalls(repo), [],
    'a green run must never reach the gh stub catch-all (no unexpected gh invocation)');
  return r;
}

function unhandledCalls(repo) {
  return readLines(repo.unhandledLog);
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

test('partial create failure: a server-side-created PR is recovered and fail-closed-closed', { skip }, () => {
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
    assert.notEqual(r.status, 0, 'partial create failure must still fail the run');
    assert.match(r.stderr, /exists server-side on autonomy-witness-red\/123456; running fail-closed cleanup/,
      'recovery must announce the adopted server-side PR');
    assert.deepEqual(closedPrs(repo), ['close 1000'],
      'the single unambiguous server-side PR on this run branch must be revalidated and closed (no orphan draft)');
    const pr = prState(repo, 1000);
    assert.deepEqual(pr.labels.map(l => l.name), [], 'no label mutation may occur on the recovery path');
    assert.deepEqual(readyCalls(repo), [], 'recovery must never ready the recovered PR');
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

test('fail closed: create success followed by non-draft revalidation closes only the known created PR', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: {},
      createdPrAuthor: 'solidus-paperclip-delivery[bot]',
      createdPrDraft: false,
      headSha: SHA_A,
    });
    assert.notEqual(r.status, 0, 'non-draft create result must fail closed');
    assert.match(r.stderr, /must still be draft while validations run/);
    assert.deepEqual(closedPrs(repo), ['close 1000'], 'known created PR should be closed when it revalidates non-draft');
    assert.deepEqual(readyCalls(repo), [], 'non-draft create result must never be readied');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: create success followed by missing stable id closes only the known created PR', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      prList: [],
      prViews: {},
      createdPrId: '',
      createdPrAuthor: 'solidus-paperclip-delivery[bot]',
      createdPrDraft: true,
      headSha: SHA_A,
    });
    assert.notEqual(r.status, 0, 'missing stable id must fail closed');
    assert.match(r.stderr, /did not expose a stable id/);
    assert.deepEqual(closedPrs(repo), ['close 1000'], 'known created PR should be closed when id revalidation fails');
    assert.deepEqual(readyCalls(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: gh pr list failure aborts before ANY mutation (no commit, push, or create)', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { listExitCode: 1 });
    assert.notEqual(r.status, 0, 'a failed PR lookup must abort the run, never degrade to the create path');
    assert.equal(createCount(repo), 0, 'must not create a PR after a failed lookup');
    assert.equal(remoteBranchSha(repo), null, 'must not push the witness branch after a failed lookup');
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(readyCalls(repo), []);
    assert.deepEqual(closedPrs(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: NESTED post-create assertion failure still fires the cleanup trap (errtrace)', { skip }, () => {
  const repo = makeRepo();
  try {
    // The draft flips to ready between the first (top-level) validation and the
    // second (nested, inside assert_pr_shape) one. Without `set -E` the ERR
    // trap would not fire for the nested failure and the PR would leak open.
    const r = runWitness(repo, {
      createdPrAuthor: 'solidus-paperclip-delivery[bot]',
      createdPrDraft: true,
      viewMutateDraftAfter: 1,
      headSha: SHA_A,
    });
    assert.notEqual(r.status, 0, 'nested draft-flip revalidation must fail closed');
    assert.match(r.stderr, /must still be draft while validations run/);
    assert.deepEqual(closedPrs(repo), ['close 1000'],
      'cleanup must close the known created PR even when the failure is nested inside a function');
    assert.deepEqual(readyCalls(repo), [], 'the flipped PR must never be readied by this run');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: unreadable revalidation in the cleanup trap leaves the PR untouched (no blind close)', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      createdPrAuthor: 'solidus-paperclip-delivery[bot]',
      createdPrDraft: true,
      viewCorrupt: true,
      headSha: SHA_A,
    });
    assert.notEqual(r.status, 0, 'corrupt PR reads must fail closed');
    assert.match(r.stderr, /revalidation was unavailable; leaving it untouched/,
      'the trap handler must degrade to leave-untouched, not abort mid-handler');
    assert.deepEqual(closedPrs(repo), [], 'must never close a PR it cannot revalidate');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: create exits 0 without a PR URL — nothing is mutated afterwards', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      createExitCode: 0,
      createEmitUrl: false,
      createListAppend: false,
      createStateAppend: false,
    });
    assert.notEqual(r.status, 0, 'an unidentifiable created PR must fail closed');
    assert.match(r.stderr, /did not return a trustworthy PR identifier/);
    assert.deepEqual(appliedLabels(repo), [], 'must not label an unidentified PR');
    assert.deepEqual(readyCalls(repo), [], 'must not ready an unidentified PR');
    assert.deepEqual(closedPrs(repo), [], 'must not close anything it cannot identify');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: gh pr ready failure exits non-zero and leaves the labelled draft inert', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, {
      createdPrAuthor: 'solidus-paperclip-delivery[bot]',
      createdPrDraft: true,
      readyExitCode: 1,
      headSha: SHA_A,
    });
    assert.notEqual(r.status, 0, 'a failed ready transition must fail the run');
    assert.deepEqual(readyCalls(repo), ['ready 1000'], 'exactly one ready attempt');
    assert.deepEqual(closedPrs(repo), [],
      'post-disarm ready failure must not close the otherwise-valid labelled draft');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: transient view corruption fires the cleanup exactly ONCE (no duplicate close)', { skip }, () => {
  const repo = makeRepo();
  try {
    // View #2 (the post-label shape read) is corrupt; the handler's own re-read
    // succeeds. set -E makes the trap fire in the failing subshell AND at top
    // level — the sentinel must collapse that to a single close attempt.
    const r = runWitness(repo, {
      createdPrAuthor: 'solidus-paperclip-delivery[bot]',
      createdPrDraft: true,
      viewCorruptAt: 2,
      headSha: SHA_A,
    });
    assert.notEqual(r.status, 0, 'a corrupt authoritative read must fail closed');
    assert.deepEqual(closedPrs(repo), ['close 1000'],
      'the cleanup must close the created PR exactly once, not once per subshell nesting level');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: a label merely EMBEDDING risk:red on its own line does not satisfy the exact check', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const beforeSha = remoteBranchSha(repo);
    resetActionLogs(repo);
    const r = runWitness(repo, {
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({
          number: 101,
          headRefOid: beforeSha,
          author: 'solidus-paperclip-delivery[bot]',
          labels: ['evil\nrisk:red\nx'],
        }),
      },
    });
    assert.notEqual(r.status, 0, 'a crafted multi-line label must not pass the exact-label check');
    assert.match(r.stderr, /does not carry the required risk:red label/);
    assert.equal(remoteBranchSha(repo), beforeSha);
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(closedPrs(repo), []);
    assert.deepEqual(readyCalls(repo), []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('reuse path: REST status=renamed fails closed even with an empty previous_filename', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const beforeSha = remoteBranchSha(repo);
    resetActionLogs(repo);
    const r = runWitness(repo, {
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({
          number: 101,
          headRefOid: beforeSha,
          author: 'solidus-paperclip-delivery[bot]',
          files: [{ filename: DOC_PATH, status: 'renamed' }],
        }),
      },
    });
    assert.notEqual(r.status, 0, 'a renamed-status file must not count as a pure witness doc change');
    assert.match(r.stderr, /file has status 'renamed'/);
    assert.equal(remoteBranchSha(repo), beforeSha);
    assert.deepEqual(appliedLabels(repo), []);
    assert.deepEqual(closedPrs(repo), []);
    assert.deepEqual(readyCalls(repo), []);
    assert.deepEqual(readyCalls(repo), [], 'missing-id create result must never be readied');
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

test('reuse path: >100 changed files are fully counted across pages (pagination is real)', { skip }, () => {
  const repo = makeRepo();
  try {
    seedWitness(repo);
    const beforeSha = remoteBranchSha(repo);
    resetActionLogs(repo);
    // 150 files: the disallowed surplus lives on the SECOND page. The stub
    // returns pages of 100 (one JSON array per page under --paginate), so a
    // script that dropped --paginate would see only 100 and this assertion
    // on the exact total would fail.
    const manyFiles = [{ filename: DOC_PATH }];
    for (let i = 1; i < 150; i++) manyFiles.push({ filename: `src/extra-${i}.ts` });
    const r = runWitness(repo, {
      headSha: SHA_B,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
      prViews: {
        101: stubPr({
          number: 101,
          headRefOid: beforeSha,
          author: 'solidus-paperclip-delivery[bot]',
          files: manyFiles,
        }),
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /changes 150 files; expected exactly 1/,
      'total must reflect ALL pages, not just the first 100');
    assert.equal(remoteBranchSha(repo), beforeSha, 'invalid reuse must leave remote branch unchanged');
    assert.deepEqual(appliedLabels(repo), [], 'must not mutate reused invalid PR');
    assert.deepEqual(closedPrs(repo), [], 'must not close reused invalid PR');
    assert.deepEqual(readyCalls(repo), []);
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
