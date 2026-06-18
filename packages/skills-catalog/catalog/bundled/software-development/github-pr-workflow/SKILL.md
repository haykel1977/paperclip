---
name: github-pr-workflow
description: Prepare a GitHub pull request from a feature branch — clean implementation, CI readiness, branch hygiene, commit shape, title/body, verification notes, screenshots for UI work, and replies to review comments.
key: paperclipai/bundled/software-development/github-pr-workflow
recommendedForRoles:
  - engineer
tags:
  - github
  - pull-requests
  - code-review
  - ci
  - release
---

# GitHub Pull Request Workflow

Ship a PR a reviewer can land without follow-up clarifying questions. The aim is a clean diff, green required checks, high-signal title/body, reproducible verification evidence, and clean replies when feedback comes in.

## When to use

- You are about to open a PR for a change that is functionally complete.
- You need to make a PR green after CI, typecheck, lint, build, or test failures.
- A reviewer left comments and you need to respond and push fixes.
- A PR has been open more than a day and needs to be brought back into shape (stale conflicts, missing description, missing verification).

## When not to use

- The change is not yet functionally complete. Finish the work first; draft PRs that bounce on review are noise.
- The repository uses a non-GitHub forge. Adjust to that forge's conventions; do not force GitHub-isms.

## Paperclip agent handoff

- Work from an isolated feature branch or Paperclip worktree by default; do not make task changes directly on the protected/base branch.
- If you are attached to an existing PR, keep using that branch and mention the PR URL in the task update.
- If you create a new PR, include the PR URL, branch name, base branch, local verification evidence, and CI status in the final Paperclip comment.
- If the work is incomplete, blocked, or not green, do not present it as ready for review; leave the branch pushed and clearly state what is missing.

## Clean implementation bar

Before opening or updating a PR, make the diff easy to review and unlikely to break CI:

- Keep the change scoped to the issue. Do not mix behavior changes with unrelated refactors, formatting sweeps, dependency bumps, or drive-by cleanup.
- Follow the repository's existing architecture, naming, error handling, and test style. Prefer small, direct changes over new abstractions unless the task requires them.
- Add or update tests for the changed behavior, including the regression path when fixing a bug. If tests are impractical, explain the reason and provide stronger manual verification.
- Do not weaken quality gates to make CI pass: no skipped tests, relaxed types, disabled lint rules, widened `any`, ignored errors, or reduced coverage unless the PR is explicitly about that policy and explains why.
- Remove debug prints, commented-out code, temporary flags, throwaway scripts, and untracked TODOs before handoff.
- Update docs, examples, migrations, generated artifacts, or snapshots only when the code change requires them; call out generated changes in the PR body.

## Branch hygiene before opening

- Rebase or merge from the target base so the diff is current.
- Squash WIP commits into reviewable units. Prefer one commit per logical change; do not force one-commit-per-PR if the work is genuinely multi-step.
- Confirm tests, typecheck, lint, and build pass locally where the repository provides those gates. Note any deliberate skips in the PR body.

## CI readiness loop

1. **Discover the expected gates.** Inspect the repository's CI workflows, package scripts, task runner config, and contribution docs. Do not assume `test` alone is enough.
2. **Run the smallest complete local gate set.** At minimum cover the touched package/app with its relevant unit tests plus typecheck/lint/build when available. For cross-cutting changes, run the broader workspace gate that CI will run.
3. **Fix failures at the cause.** Do not snapshot-update, skip, or loosen assertions until you understand why the failure changed. If the expected output changed, document why.
4. **Open or update the PR only after local gates are green**, unless a required external service or unavailable secret prevents running them. In that case, mark the PR or Paperclip update as blocked/partial and name the missing prerequisite.
5. **After the PR exists, watch required checks.** If CI fails, read the failing job, reproduce locally when possible, push a focused fix, and update the Paperclip comment with the new evidence. Repeat until required checks are green or the blocker is external and explicitly documented.

## PR title

- Imperative mood, under 70 characters.
- Lead with the user-visible change, not the file touched. `Allow CSV export from reports table` beats `Update reports.tsx`.
- If the repo uses an issue prefix convention (`PAP-1234:`, `[security]`), follow it.
- No trailing period.

## PR body

Use this structure:

```md
## Summary
- 1–3 bullets describing what changed and why.

## Implementation notes
- Anything non-obvious in the diff: trade-offs, dropped alternatives, gotchas.
- Migration, generated-file, dependency, or config implications.

## Verification
- Local gates: exact commands/steps run and their result.
- CI: link or name of required checks and current status.
- Screenshots or short clips for UI changes (required if pixels moved).
- Edge cases exercised by hand.

## Risk and rollback
- What breaks if this is reverted, and how to revert cleanly.
```

Skip the `Risk and rollback` section only for clearly trivial PRs (typos, docs).

## Verification evidence

- Required CI green is necessary, not sufficient. Reviewers also need to know the change behaves correctly end to end.
- Verification claims must be concrete: name the gate, scope, result, and any environment constraint. `Not run` is acceptable only with a reason and a follow-up/owner.
- For UI work, include screenshots of the golden path and one edge case. Tag dark and light mode if the project supports both.
- For migrations, include a dry-run plan and reversal steps.
- For performance changes, include a before/after measurement, not adjectives.

## Handling CI failures

- Treat red CI as part of the task, not a handoff detail. Do not ask for review while required checks are red unless the failure is external and documented.
- Read the first failing job and the most specific error first. Avoid broad rewrites based on guesses.
- Prefer one focused fix commit per failure class. If a fix changes behavior, update tests and PR notes accordingly.
- If CI differs from local results, document the environment difference and add a repo-level fix when appropriate.

## Replying to review comments

- Reply on every comment, even with just "fixed in <commit-sha>" — silent fixes leave the reviewer guessing.
- Push fixes as new commits while review is active; do not amend during review unless the reviewer agrees.
- If you disagree with feedback, say so with one sentence of rationale and let the reviewer decide. Don't escalate over comments.
- Re-request review explicitly after pushing changes.

## Merge checklist

- All required checks green.
- Local verification evidence is present and matches the current diff.
- All review comments resolved.
- PR title/body still accurate (update if scope changed mid-review).
- Linked issue moves to `in_review` or `done` per project convention.
- Delete the branch after merge unless it is a long-lived integration branch.

## Anti-patterns

- PR description that says "see commits". Reviewers should not need to read the log.
- Mixing refactor and behavior change in the same PR with no separation in the body.
- "Address feedback" commits that bundle unrelated edits. One commit per round of feedback is fine; one commit for everything in flight is not.
- Claiming "tests pass" without naming the gates, or claiming "green" before required CI checks have completed.
- Disabling, weakening, or skipping quality gates just to make the PR pass.
- Force-pushing during active review without telling the reviewer.
