---
name: task-planning
description: Turn a Paperclip issue or request into a structured implementation plan with child task graph, blockers, owners, acceptance criteria, and verification/CI gates, then save it as the issue `plan` document.
key: paperclipai/bundled/paperclip-operations/task-planning
recommendedForRoles:
  - manager
  - engineer
  - product
tags:
  - paperclip
  - planning
  - issues
  - delegation
  - ci
---

# Task Planning

Produce implementation plans that the Paperclip executor can actually run: explicit child issues, real blockers, named owners, a defined acceptance bar, and the verification gates required for a green PR. Avoid plans that read well but cannot be split into work.

## When to use

- An issue asks you to "plan", "scope", "break down", "design the rollout", "propose the work", or similar.
- A user wants a written plan before approving implementation.
- A manager needs to delegate non-trivial work and the shape of the work is not obvious yet.
- You inherited an issue too large to deliver in one heartbeat and need to split it.

## When not to use

- The issue is a single small change you can ship in the same heartbeat. Just ship it.
- The issue is forensic ("why did this break"). Use a diagnosis skill first; plan only after the root cause is named.
- A current `plan` document already exists and the change is minor. Update that document; do not start fresh.

## Outputs

1. An updated issue document with key `plan` (markdown).
2. A short comment on the issue that links to the plan document and names the next action.
3. Where the plan requires approval, an issue-thread interaction of kind `request_confirmation` bound to the latest plan revision.

Do not create implementation subtasks until the plan is accepted.

## Plan structure

Required sections, in order:

1. **Goal** — one paragraph. What changes for the user, the operator, or the system once this work lands.
2. **Context reviewed** — bullet list of documents, files, and prior issues you read. Lets reviewers spot missing inputs.
3. **Constraints and non-goals** — what must hold (compatibility, security, performance) and what this plan deliberately will not do.
4. **Approach** — the chosen path, with a short rationale. If you considered alternatives, name them and why you rejected them.
5. **Work breakdown** — ordered list of child issues. Each child has:
   - Title in imperative form.
   - Owner specialty (Engineer, QA, Designer, Security, DevRel, Manager, etc.).
   - Scope and deliverables.
   - Acceptance criteria.
   - Verification gates: relevant tests, typecheck, lint, build, migration dry-run, manual QA, or `N/A: <why>`.
   - CI/PR readiness note: whether this child must produce a PR, feed another child, or only update docs/plan artifacts.
   - Blocks/blocked-by relationships expressed by phase letter or child title.
6. **Acceptance** — the bar for the parent issue. How the user knows the whole thing is done, including required CI checks green for repo-changing work.
7. **Risks and mitigations** — short list. Skip if there are none.
8. **Deferrals** — what is intentionally pushed to follow-up issues, with why.

## Verification planning

- Discover expected quality gates from repository workflows, scripts, and contribution docs during planning, not after implementation.
- Put the smallest complete gate set on the child issue that owns the code change. Cross-cutting work should name the broader workspace gate expected to match CI.
- Separate implementation children from QA/review children when manual validation or screenshots are required.
- Do not plan acceptance as "PR opened". A repo-changing child is complete only when its required local gates are evidenced and the PR is green or an external blocker is explicitly named.
- If a gate cannot be run in the agent environment because of secrets or external services, plan a blocker/owner instead of treating the gap as optional.

## Rules of thumb for splitting

- One child issue, one specialty. If two specialties have to coordinate inside the same issue, split it.
- One child issue, one acceptance verdict. If a reviewer would say "this is half done", split it.
- A child must be checkout-able by the owner from its title and description alone. Reviewers should not have to re-read the parent plan to understand a child.
- Order children by real blocker chains, not by author preference. Parallel children should explicitly say `blockers: none`.
- Avoid `polish` or `cleanup` child issues without acceptance criteria — they never close.

## Filing the plan

Use the Paperclip API to write the plan document, then comment:

- `PUT /api/issues/{issueId}/documents/plan` with the markdown body. If `plan` already exists, include the latest `baseRevisionId`.
- `POST /api/issues/{issueId}/comments` with a short summary that links the plan: `/<prefix>/issues/<issue-id>#document-plan`.
- If approval is required: `POST /api/issues/{issueId}/interactions` with `kind: request_confirmation`, `targetRevisionId` set to the new plan revision, `continuationPolicy: wake_assignee`, and `idempotencyKey: "confirmation:{issueId}:plan:{revisionId}"`.
- Set the issue to `in_review` after creating the confirmation. Stay assigned so the acceptance wakes the planner.

When the plan is accepted, see the companion skill for converting accepted plans into Paperclip executable tasks.

## Anti-patterns

- Plan disguised as a description edit. Use the `plan` document.
- "Phases A–Z" with no work breakdown inside the phases.
- Children with descriptions that say "see parent" — they fail at delegation time.
- Acceptance written as "code review approval" or "open PR". Reviewers need a behavior bar and green-gate bar, not a process bar.
- Verification listed as generic "run tests" without naming the relevant gates or scope.
- Plans that bury blocker chains in prose. Use explicit blocked-by lines.
