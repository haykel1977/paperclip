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
  // gh stub: faithfully applies the script's `--jq` via system jq to a fixture.
  //   pr list   → runs the script's owner-scoping jq against the fixture.
  //   pr create → records the call AND appends an owner-scoped row to the fixture
  //               so the script's post-create `pr list` resolves the new number.
  //   pr view   → for `--json author` echoes GH_PR_AUTHOR (the identity under
  //               test); otherwise echoes a URL.
  //   pr edit   → records the `--add-label` argument so a test can assert exactly
  //               the risk:red label was applied (and only after the guard).
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
add_label() {
  local lbl="" args=("\$@") i
  for ((i=0;i<\${#args[@]};i++)); do
    if [ "\${args[\$i]}" = "--add-label" ]; then lbl="\${args[\$((i+1))]}"; fi
  done
  printf '%s' "\$lbl"
}
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  jq -r "\$(jq_expr "\$@")" "\$GH_PR_LIST_JSON"
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  fields="\$(json_fields "\$@")"
  if [[ "\$fields" == *author* ]]; then
    echo "\${GH_PR_AUTHOR}"
  else
    echo "https://example.test/pr/\${3:-0}"
  fi
  exit 0
fi
if [ "\${1:-}" = "auth" ]; then
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "edit" ]; then
  echo "\$(add_label "\$@")" >> "\$GH_LABEL_LOG"
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "create" ]; then
  echo "create $*" >> "\$GH_CREATE_LOG"
  tmp="\$(mktemp)"
  jq --argjson n "\$GH_CREATED_PR" --arg o "\$GH_STUB_OWNER" \
    '. + [{number:\$n, headRepositoryOwner:{login:\$o}}]' "\$GH_PR_LIST_JSON" > "\$tmp"
  mv "\$tmp" "\$GH_PR_LIST_JSON"
  echo "https://example.test/pr/\${GH_CREATED_PR}"
  exit 0
fi
echo "unhandled gh: $*" >&2
exit 1
`;
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, stub);
  chmodSync(ghPath, 0o755);

  return { root, origin, binDir, listJson, createLog, labelLog };
}

function runWitness(repo, {
  runId = RUN_ID,
  headSha = SHA_A,
  prList = [],
  prAuthor = 'app/solidus-paperclip-delivery',
  createdPr = '1000',
} = {}) {
  writeFileSync(repo.listJson, JSON.stringify(prList));
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
      GH_PR_AUTHOR: prAuthor,
      GH_STUB_OWNER: OWNER,
      GH_CREATED_PR: createdPr,
    },
  });
  return r;
}

function remoteBranchSha(repo) {
  const r = run('git', ['-C', repo.origin, 'rev-parse', BRANCH_REF], { allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function createCount(repo) {
  return existsSync(repo.createLog) ? readFileSync(repo.createLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

function appliedLabels(repo) {
  return existsSync(repo.labelLog) ? readFileSync(repo.labelLog, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function commitCountOnBranch(repo) {
  return Number(run('git', ['-C', repo.origin, 'rev-list', '--count', BRANCH_REF]).stdout.trim());
}

test('branch absent: creates run-id branch, one docs commit, opens a PR, applies risk:red', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [] });
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
    runWitness(repo, { headSha: SHA_A, prList: [] });
    const shaAfterFirst = remoteBranchSha(repo);
    const commitsAfterFirst = commitCountOnBranch(repo);

    const r = runWitness(repo, {
      headSha: SHA_A,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No changes to commit \(idempotent re-run\)\./);
    assert.match(r.stdout, /Reusing existing witness PR #101/);
    assert.equal(remoteBranchSha(repo), shaAfterFirst, 'branch tip must be unchanged');
    assert.equal(commitCountOnBranch(repo), commitsAfterFirst, 'no extra commit on re-run');
    assert.equal(createCount(repo), 1, 'must not open a duplicate PR');
    // The label add is idempotent at the GitHub layer; the script still issues it
    // on reuse so a manually-removed label is reasserted.
    assert.deepEqual(appliedLabels(repo), ['risk:red', 'risk:red'], 'risk:red reasserted on reuse');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('changed content: branch exists but generated file differs → exactly one new commit', { skip }, () => {
  const repo = makeRepo();
  try {
    runWitness(repo, { headSha: SHA_A, prList: [] });
    const commitsAfterFirst = commitCountOnBranch(repo);
    const shaAfterFirst = remoteBranchSha(repo);

    const r = runWitness(repo, {
      headSha: SHA_B,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
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
    runWitness(repo, { prList: [] }); // seed the branch
    const createsBefore = createCount(repo);
    const r = runWitness(repo, {
      prList: [
        { number: 77, headRepositoryOwner: { login: OWNER } },
        { number: 88, headRepositoryOwner: { login: OWNER } },
      ],
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
    runWitness(repo, { prList: [] });
    const createsBefore = createCount(repo);
    const r = runWitness(repo, {
      prList: [
        { number: 999, headRepositoryOwner: { login: 'attacker' } },
        { number: 42, headRepositoryOwner: { login: OWNER } },
      ],
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
    runWitness(repo, { prList: [] }); // creates branch + 1 PR
    const before = createCount(repo);
    const r = runWitness(repo, {
      prList: [{ number: 555, headRepositoryOwner: { login: 'attacker' } }],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Reusing existing witness PR/, 'fork-only lookup must not count as existing');
    assert.equal(createCount(repo), before + 1, 'must open a PR when only fork PRs exist');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: a github-actions[bot]-authored PR is rejected BEFORE any label is applied', { skip }, () => {
  // A witness opened with the built-in GITHUB_TOKEN authors a github-actions[bot]
  // PR whose pull_request workflows are suppressed → the required checks never
  // run. It must fail closed, and crucially the risk:red label must NOT be applied
  // to a PR that failed the author guard.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'github-actions[bot]' });
    assert.notEqual(r.status, 0, 'must fail closed on the event-suppressed identity');
    assert.match(r.stderr, /authored by 'github-actions\[bot\]'/,
      'error must name the forbidden, event-suppressed identity');
    assert.match(r.stderr, /minted solidus-paperclip-delivery App installation token/, 'error must point to the correct fix');
    assert.deepEqual(appliedLabels(repo), [], 'no label may be applied when the author guard fails');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: any non-allowlisted author is rejected, no label applied', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'some-other-app[bot]' });
    assert.notEqual(r.status, 0, 'a non-allowlisted author must fail closed');
    assert.match(r.stderr, /authored by 'some-other-app\[bot\]'/, 'error names the actual (wrong) author');
    assert.match(r.stderr, /not the allowlisted App identity \('app\/solidus-paperclip-delivery' or 'solidus-paperclip-delivery\[bot\]'\)/,
      'error names both expected allowlisted forms');
    assert.deepEqual(appliedLabels(repo), [], 'no label may be applied to a non-allowlisted author');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('happy path (GraphQL form): an app/solidus-paperclip-delivery-authored PR passes and is labelled', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'app/solidus-paperclip-delivery' });
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
    const r = runWitness(repo, { prList: [], prAuthor: 'solidus-paperclip-delivery[bot]' });
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
      const r = runWitness(repo, { prList: [], prAuthor: impostor });
      assert.notEqual(r.status, 0, `lookalike must fail closed: ${JSON.stringify(impostor)}`);
      assert.match(r.stderr, /not the allowlisted App identity/, `guard must reject ${JSON.stringify(impostor)}`);
      assert.deepEqual(appliedLabels(repo), [], `no label for lookalike ${JSON.stringify(impostor)}`);
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
