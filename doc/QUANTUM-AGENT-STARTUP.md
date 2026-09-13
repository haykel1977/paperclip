# Starting agents that deliver to Quantum

This is the consumer contract for `Beyn-SOLIDUS/quantum`. The generic Paperclip
auto-merge lane in `AGENT-PR-FACTORY.md` does not replace Quantum's governance.
Deployment readiness requires both the reviewed code and the live configuration.

## Workspaces and task ownership

- Deploy the Paperclip fixes for resolving local base refs to their refreshed
  upstream, including reuse and restoration of persisted workspaces (PR #123).
- Configure the Quantum project with `git_worktree` isolation and
  `baseRef: "origin/main"`. Require the board issue identifier in the branch
  policy. Use the assigned agent's canonical branch name from Quantum's current
  identity policy; a UUID-derived fallback is not identity evidence.
- Confirm the new worktree's base SHA against refreshed `origin/main`. Do not
  reset an existing worktree that contains unfinished agent work.
- Assign one real board ticket to the maker. Supply the actual GitHub issue
  number, expected paths, acceptance criteria and verification commands in the
  ticket. A board identifier is not a GitHub issue number.

## Identity must be ready before a maker can publish

Quantum's `docs/SSOT/AGENT_IDENTITY_MAP.json` is authoritative. For each enabled
maker, the operator must verify the machine login, its repository-scoped token,
the token rotation date and its registered signing key. Placeholder fingerprints
or rotation dates are a startup blocker, not evidence that credentials exist.

The delivery hook does not implement the full I1 identity selector. Its generic
bot-token setting does not establish that the caller matches the agent identity
map. Complete and test the wrapper's per-agent selection and login check before
enabling an unattended fleet. A test using an operator token on an agent branch
must be refused before any push. Keep secret values out of tickets, PRs and logs.

## The Quantum wrapper owns publication

`scripts/agent-pr-create.sh` must exist and be executable in the worktree. The
hook performs its local quality and configured signing checks, commits dirty
work when necessary, then invokes this wrapper. Already committed changes from
a clean working tree also pass the quality gate and applicable signature check.

All Quantum remote publication belongs to the wrapper: pre-push checks, push,
PR creation or refresh, review handoff and ticket disposition. A missing or
failing wrapper blocks delivery. An existing PR still goes through the wrapper
so new work is not reported as delivered before it is published.

The hook requires exactly one structured result line:

```text
result=created pr_url=https://github.com/Beyn-SOLIDUS/quantum/pull/<number>
```

`updated` and `exists` are also accepted. The URL must identify a positive PR
number in the configured repository. Exit zero without this evidence, a bare
URL, another repository's URL or duplicate result lines cannot claim delivery.
Local success does not establish hosted CI, review, merge or deployment success.

## First supervised run and fleet release

After the code is merged with required checks and deployed, use one assigned,
bounded task for a supervised run. Record the deployed Paperclip revision,
Quantum base SHA, agent identity, ticket, branch, final PR URL and head SHA.
Verify that the PR author and commit signature match the identity map, the body
matches its diff, required GitHub checks have completed and review findings are
handled on the final head. Keep the ticket in its governed review state until
the normal merge reconciliation completes.

Only expand to the other makers after this first run passes. Preserve Quantum's
model-routing doctrine, merge actuator and queue guards. A sacred-path PR needs
the authorization required by that guard; retrying an explicitly rejected queue
entry does not supply that authorization.
