# Agent PR Factory

Paperclip supports agent-authored pull requests, but the factory is deliberately
fail-closed: agents may prepare changes and request auto-merge, while GitHub
branch protection and check-runs remain the source of truth.

## Goals

- Agent PRs are reviewable: focused diff, non-opaque title, filled PR template.
- Agent claims are falsifiable: PR bodies must not self-certify that CI is green.
- Unsafe labels block merge: `do-not-merge`, `human-gate-required`,
  `prod-gate-required`, and sacred-path labels are hard stops.
- Auto-merge is native GitHub auto-merge, not a direct merge command.
- Auto-merge is enabled only for same-repository automation PRs with explicit
  opt-in labels.

## Agent PR contract

An agent-generated PR must include:

1. A conventional, reviewable title, for example `fix(authz): block unsafe agent workspace commands`.
2. A fully completed PR template.
3. `CI status: Pending — GitHub required checks are the source of truth.` in the
   readiness gate until GitHub check-runs actually complete.
4. Verification evidence that matches the diff.
5. A concrete model identity in **Model Used**.
6. Labels:
   - `agent-pr`
   - `automerge` only when the PR is intended to enter the auto-merge lane.

## Auto-merge lane

`.github/workflows/commitperclip-review.yml` runs from the PR base branch under
`pull_request_target` and never executes PR code. After quality and security gates
pass, it calls `.github/scripts/enable-agent-automerge.mjs`.

The script enables GitHub native auto-merge only when all conditions are true:

- PR is open and not draft.
- PR targets `main`.
- PR comes from the same repository, not a fork.
- Author is a dedicated automation identity:
  - `commitperclip[bot]`
  - `github-actions[bot]`
  - `paperclipai[bot]`
  - `dependabot[bot]`
- PR has explicit opt-in labels `agent-pr` and `automerge`, except for the
  lockfile refresh branch `chore/refresh-lockfile`.
- No hard-block label is present.
- Branch protection for the target branch is readable, requires branches to be
  up to date before merging, and requires the expected checks (`verify` and
  `gitleaks` by default).
- Auto-merge is not already enabled.

The script does **not** merge immediately. It only enables GitHub auto-merge with
squash merge. The PR merges later only if branch protection permits it. If branch
protection is absent, unreadable, or missing required checks, the script exits 0
with a skip reason and does not enable auto-merge.

## Required branch protection

Protect `main` with at least:

- pull request required before merge
- required status checks, including `verify` and `gitleaks`
- branches required to be up to date before merging
- stale approvals dismissed when new commits are pushed
- force pushes and deletion disabled

If GitHub branch protection is absent or required checks are misconfigured,
this factory is not production-safe even if the workflow files are present.

## No-fake rules

Agents must not write PR bodies that say checks are green, verified, successful,
or passing before GitHub has actually emitted those check-runs. The template gate
blocks green/self-certified CI claims in the readiness section because CI status
must be read from GitHub, not from the agent's text.

## Manual operations still required

Repository administrators still own:

- connecting this repository to GitHub/Vercel
- branch-protection settings on `main`
- required-check context selection
- emergency disabling of `automerge` labels or branch protection rules
