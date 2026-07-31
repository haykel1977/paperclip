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
  const labelsJson = join(root, 'pr-labels.json');
  writeFileSync(labelsJson, '[]');
  // gh stub: faithfully applies the script's `--jq` via system jq to a fixture.
  //   pr list   → runs the script's owner-scoping jq against the fixture.
  //   pr create → records the call AND appends an owner-scoped row to the fixture
  //               so the script's post-create `pr list` resolves the new number
  //               (mirrors reality: a just-created PR is immediately listable).
  //   pr view   → for `--json author` echoes GH_PR_AUTHOR (the identity under
  //               test); for `--json labels` applies the script's --jq to the
  //               accumulated label state; otherwise echoes a URL.
  //   pr edit   → records --add-label values into the label state, UNLESS
  //               GH_LABEL_APPLY_FAIL=1, which models the real failure mode the
  //               script guards against: the edit exits 0 but the label never
  //               actually lands.
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
  elif [[ "\$fields" == *labels* ]]; then
    jq -r "{labels: [.[] | {name: .}]} | \$(jq_expr "\$@")" "\$GH_PR_LABELS_JSON"
  else
    echo "https://example.test/pr/\${3:-0}"
  fi
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "edit" ]; then
  echo "edit $*" >> "\$GH_EDIT_LOG"
  if [ "\${GH_LABEL_APPLY_FAIL:-0}" != "1" ]; then
    args=("\$@")
    for ((i=0;i<\${#args[@]};i++)); do
      if [ "\${args[\$i]}" = "--add-label" ]; then
        tmp="\$(mktemp)"
        jq --arg l "\${args[\$((i+1))]}" '. + [\$l] | unique' "\$GH_PR_LABELS_JSON" > "\$tmp"
        mv "\$tmp" "\$GH_PR_LABELS_JSON"
      fi
    done
  fi
  exit 0
fi
if [ "\${1:-}" = "auth" ]; then
  # \`gh auth setup-git\` wires the token into git's credential helper. In this
  # sandbox the remote is file:// (no auth needed), so it is a harmless no-op.
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

  return { root, origin, binDir, listJson, createLog, labelsJson, editLog: join(root, 'gh-edit.log') };
}

/** Run the witness script from a FRESH clone (each dispatch is a fresh checkout).
 * `prAuthor` is the login the gh stub reports for `pr view --json author` — i.e.
 * the identity the fail-closed guard evaluates. It defaults to the exact login
 * GitHub actually returns for this App via the `gh pr view` (GraphQL) path,
 * `app/solidus-paperclip-delivery`; tests override it with the REST form or with
 * forbidden identities to exercise the fail-closed guard.
 * `createdPr` is the number the stub
 * assigns to a freshly created PR so the post-create lookup can resolve it. */
function runWitness(repo, {
  runId = RUN_ID,
  headSha = SHA_A,
  prList = [],
  prAuthor = 'app/solidus-paperclip-delivery',
  createdPr = '1000',
  labelApplyFail = false,
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
      GH_PR_LABELS_JSON: repo.labelsJson,
      GH_EDIT_LOG: repo.editLog,
      GH_LABEL_APPLY_FAIL: labelApplyFail ? '1' : '0',
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

function appliedLabels(repo) {
  return JSON.parse(readFileSync(repo.labelsJson, 'utf8'));
}

function editLines(repo) {
  return existsSync(repo.editLog)
    ? readFileSync(repo.editLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
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
    assert.match(r.stderr, /minted solidus-paperclip-delivery App installation token/, 'error must point to the correct fix');
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
  // The guard is a positive allowlist: the author MUST be
  // solidus-paperclip-delivery[bot]. Any other identity — e.g. a misconfigured
  // App, a wrong installation, or the now-inaccessible commitperclip[bot], not
  // just the github-actions[bot] signature — must be refused. This proves the
  // guard catches more than the single event-suppression case.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'some-other-app[bot]' });
    assert.notEqual(r.status, 0, 'a non-allowlisted author must fail closed');
    assert.match(r.stderr, /authored by 'some-other-app\[bot\]'/, 'error names the actual (wrong) author');
    assert.match(r.stderr, /not the allowlisted App identity \('app\/solidus-paperclip-delivery' or 'solidus-paperclip-delivery\[bot\]'\)/,
      'error names both expected allowlisted forms');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: the superseded commitperclip[bot] identity is now rejected', { skip }, () => {
  // Post-migration the witness is authored by solidus-paperclip-delivery[bot].
  // The previously-expected commitperclip[bot] (external, inaccessible App) must
  // now itself fail the positive allowlist — proving the migration flipped the
  // expected identity rather than merely widening it.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'commitperclip[bot]' });
    assert.notEqual(r.status, 0, 'the superseded identity must fail closed');
    assert.match(r.stderr, /authored by 'commitperclip\[bot\]'/, 'error names the superseded author');
    assert.match(r.stderr, /not the allowlisted App identity \('app\/solidus-paperclip-delivery' or 'solidus-paperclip-delivery\[bot\]'\)/,
      'error names the new expected forms');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('happy path (GraphQL form): an app/solidus-paperclip-delivery-authored PR passes the guard', { skip }, () => {
  // The `gh pr view` (GraphQL) path returns the App as `app/solidus-paperclip-delivery`.
  // This is the exact login the live witness run produced; it must be accepted.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'app/solidus-paperclip-delivery' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /authored by app\/solidus-paperclip-delivery/, 'the GraphQL-form login is accepted');
    assert.doesNotMatch(r.stderr, /not the allowlisted App identity/, 'must not trip the guard');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('happy path (REST form): a solidus-paperclip-delivery[bot]-authored PR passes the guard', { skip }, () => {
  // The REST webhook form of the SAME App must also be admitted.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'solidus-paperclip-delivery[bot]' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /authored by solidus-paperclip-delivery\[bot\]/, 'the REST-form login is accepted');
    assert.doesNotMatch(r.stderr, /not the allowlisted App identity/, 'must not trip the guard');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: near-lookalike App logins are rejected (exact match, no prefix/substring)', { skip }, () => {
  // Only the two exact canonical forms are admitted. Anything that merely resembles
  // them — a prefix/substring, a suffixed impostor, a whitespace-padded copy, or the
  // bare name without the `app/` or `[bot]` marker — must fail closed. This proves
  // the allowlist did not widen to `app/*` or accept partial matches.
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
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }
});

test('positive control: both opt-in labels are applied so the real auto-merge gate is exercised', { skip }, () => {
  // A witness that only opens a PR proves the App can create one, not that the
  // autonomy gate would clear it. evaluateAutomergeEligibility requires BOTH
  // `agent-pr` and `automerge`, so without them the gate would SKIP this PR and
  // the skip would be indistinguishable from a rejection.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [] });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(appliedLabels(repo).sort(), ['agent-pr', 'automerge']);
    assert.match(r.stdout, /labelled agent-pr \+ automerge/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('positive control: labels are applied to a REUSED PR too, idempotently', { skip }, () => {
  const repo = makeRepo();
  try {
    runWitness(repo, { prList: [] });
    const r = runWitness(repo, {
      prList: [{ number: 303, headRepositoryOwner: { login: OWNER } }],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Reusing existing witness PR #303/);
    // `--add-label` is idempotent, so the re-run adds nothing new.
    assert.deepEqual(appliedLabels(repo).sort(), ['agent-pr', 'automerge']);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('fail closed: a silently-dropped label fails the witness instead of proving the opposite', { skip }, () => {
  // `gh pr edit` can exit 0 while a label never lands (label definition missing,
  // permission scope). A witness quietly missing `automerge` would be SKIPPED by
  // the gate, and a skip masquerading as a pass is exactly the false green the
  // verification step exists to prevent.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], labelApplyFail: true });
    assert.notEqual(r.status, 0, 'a silently-dropped label must fail the witness');
    assert.match(r.stderr, /missing the required opt-in label 'agent-pr'/);
    assert.deepEqual(appliedLabels(repo), [], 'the stub modelled the silent drop');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('escalation guard: a non-allowlisted author is never labelled `automerge`', { skip }, () => {
  // Labelling a PR from an unexpected identity `automerge` is precisely the
  // privilege escalation the author guard exists to prevent, so the label step
  // MUST sit after that guard — not merely alongside it.
  const repo = makeRepo();
  try {
    const r = runWitness(repo, { prList: [], prAuthor: 'some-other-app[bot]' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(appliedLabels(repo), [], 'no label may be applied to a rejected identity');
    assert.deepEqual(editLines(repo), [], '`gh pr edit` must never even be invoked');
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
