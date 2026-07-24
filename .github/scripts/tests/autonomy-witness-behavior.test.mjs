import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime behavior tests for .github/scripts/autonomy-witness.sh. These stand up a
// throwaway git remote + working clone and a jq-backed `gh` stub, then run the real
// script to prove the two review fixes hold under adversarial conditions:
//   fix#1 (Cursor): re-run idempotency across a FRESH default-branch checkout.
//   fix#2 (Copilot): owner-scoped first-match PR lookup with no SIGPIPE-prone pipe.
// The script only runs on a Unix runner; skip elsewhere.

const SCRIPT = fileURLToPath(new URL('../autonomy-witness.sh', import.meta.url));
const OWNER = 'haykel1977';
const REPO = `${OWNER}/paperclip`;
const RUN_ID = '123456';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BRANCH_REF = `refs/heads/autonomy-witness/${RUN_ID}`;

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
  const root = mkdtempSync(join(tmpdir(), 'aw-'));
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
  // Make `git clone` check out main by default (simulates actions/checkout@default).
  run('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const listJson = join(root, 'pr-list.json');
  const createLog = join(root, 'gh-create.log');
  // gh stub: faithfully applies the script's `--jq` via system jq to a fixture.
  //   pr list   → runs the script's owner-scoping jq against the fixture.
  //   pr create → records the call AND appends an owner-scoped row to the fixture
  //               so the script's post-create `pr list` resolves the new number
  //               (mirrors reality: a just-created PR is immediately listable).
  //   pr view   → for `--json author` echoes GH_PR_AUTHOR (the identity under
  //               test); otherwise echoes a URL. This is what the fail-closed
  //               author guard reads.
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

  return { root, origin, binDir, listJson, createLog };
}

/** Run the witness script from a FRESH clone (each dispatch is a fresh checkout).
 * `prAuthor` is the login the gh stub reports for `pr view --json author` — i.e.
 * the identity the fail-closed guard evaluates. It defaults to the allowlisted
 * App identity; tests override it with the forbidden github-actions[bot] to
 * exercise the event-suppression guard. `createdPr` is the number the stub
 * assigns to a freshly created PR so the post-create lookup can resolve it. */
function runWitness(repo, {
  runId = RUN_ID,
  headSha = SHA_A,
  prList = [],
  prAuthor = 'commitperclip[bot]',
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

function commitCountOnBranch(repo) {
  return Number(run('git', ['-C', repo.origin, 'rev-list', '--count', BRANCH_REF]).stdout.trim());
}

test('branch absent: creates run-id branch, one docs commit, opens a PR', { skip }, () => {
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [] });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(remoteBranchSha(repo), 'run-id branch must be pushed to origin');
    // Exactly the base commit + one witness commit.
    assert.equal(commitCountOnBranch(repo), 2);
    // Docs-only: only the run-id file was added versus main.
    const changed = run('git', ['-C', repo.origin, 'diff', '--name-only', 'main', BRANCH_REF]).stdout.trim().split('\n');
    assert.deepEqual(changed, [`doc/autonomy-witness/${RUN_ID}.md`]);
    assert.equal(createCount(repo), 1, 'a PR must be created when none exists');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fix#1 branch exists, identical content: FRESH checkout, no new commit, PR reused', { skip }, () => {
  const repo = makeRepo();
  try {
    // First dispatch creates the branch + PR.
    runWitness(repo, { headSha: SHA_A, prList: [] });
    const shaAfterFirst = remoteBranchSha(repo);
    const commitsAfterFirst = commitCountOnBranch(repo);

    // Second dispatch: a brand-new checkout of the default branch (the exact
    // condition that defeated the old `checkout -B` guard), same run metadata,
    // and the now-existing PR present in the lookup.
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
    const createsBefore = createCount(repo);

    // Different source SHA → different deterministic content → a fast-forward commit.
    const r = runWitness(repo, {
      headSha: SHA_B,
      prList: [{ number: 101, headRepositoryOwner: { login: OWNER } }],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /No changes to commit/);
    assert.equal(commitCountOnBranch(repo), commitsAfterFirst + 1, 'exactly one new commit');
    assert.notEqual(remoteBranchSha(repo), shaAfterFirst, 'branch tip must advance');
    // Still docs-only, still a single run-id file.
    const changed = run('git', ['-C', repo.origin, 'diff', '--name-only', 'main', BRANCH_REF]).stdout.trim().split('\n');
    assert.deepEqual(changed, [`doc/autonomy-witness/${RUN_ID}.md`]);
    assert.equal(createCount(repo), createsBefore, 'PR already exists → must be reused, not recreated');
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

test('fail closed: a freshly CREATED PR authored by github-actions[bot] is rejected', { skip }, () => {
  // A witness opened with the built-in GITHUB_TOKEN authors a github-actions[bot]
  // PR whose pull_request workflows are suppressed → the required checks never
  // run. Even though the script just created it, it must refuse to treat that
  // check-less PR as a valid witness.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'github-actions[bot]' });
    assert.notEqual(r.status, 0, 'must fail closed on the event-suppressed identity');
    assert.match(r.stderr, /authored by 'github-actions\[bot\]'/,
      'error must name the forbidden, event-suppressed identity');
    assert.match(r.stderr, /minted commitperclip App installation token/, 'error must point to the correct fix');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: a REUSED PR authored by github-actions[bot] is rejected', { skip }, () => {
  // The guard applies to reused PRs too: a pre-existing owner-scoped PR that was
  // (mis)opened by github-actions[bot] is still check-less and must be refused,
  // never silently reused as if green.
  const repo = makeRepo();
  try {
    runWitness(repo, { prList: [] }); // seed the branch
    const r = runWitness(repo, {
      prList: [{ number: 202, headRepositoryOwner: { login: OWNER } }],
      prAuthor: 'github-actions[bot]',
    });
    assert.notEqual(r.status, 0, 'a reused check-less PR must also fail closed');
    assert.match(r.stdout, /Reusing existing witness PR #202/, 'it did reuse the existing PR…');
    assert.match(r.stderr, /authored by 'github-actions\[bot\]'/, '…then refused it on the author guard');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: any non-allowlisted author is rejected (positive allowlist, not denylist)', { skip }, () => {
  // The guard is a positive allowlist: the author MUST be commitperclip[bot].
  // Any other identity — e.g. a misconfigured App or a wrong installation, not
  // just the github-actions[bot] signature — must be refused. This proves the
  // guard catches more than the single event-suppression case.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'some-other-app[bot]' });
    assert.notEqual(r.status, 0, 'a non-allowlisted author must fail closed');
    assert.match(r.stderr, /authored by 'some-other-app\[bot\]'/, 'error names the actual (wrong) author');
    assert.match(r.stderr, /not the allowlisted App identity 'commitperclip\[bot\]'/,
      'error names the expected allowlisted identity');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('happy path: a commitperclip[bot]-authored PR passes the allowlist guard', { skip }, () => {
  // The expected App identity must NOT be rejected — the allowlist admits it.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'commitperclip[bot]' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /authored by commitperclip\[bot\]/, 'the allowlisted author is accepted');
    assert.doesNotMatch(r.stderr, /not the allowlisted App identity/, 'must not trip the guard');
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
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
