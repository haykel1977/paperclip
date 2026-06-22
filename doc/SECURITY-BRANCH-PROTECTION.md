# Branch Protection (main)

This document defines the branch-protection baseline for the active default branch
(`main`) and how to verify it. Repository settings are **not** changed by any
script in this repo — applying protection is a manual maintainer action through
the GitHub UI or API. The provided check script is read-only and only reports
the current state.

## Recommended settings

Enable the following on `main`
(Settings → Branches → Branch protection rules → `main`):

- **Require a pull request before merging** — no direct pushes to `main`.
- **Require at least one approving review** — `required_approving_review_count >= 1` when human review is required for the surface.
- **Require status checks to pass before merging** — at minimum the `verify`
  check produced by `.github/workflows/pr.yml` and the `gitleaks` check produced
  by `.github/workflows/secret-scan.yml`.
- **Dismiss stale approvals** when new commits are pushed.
- **Include administrators** (`enforce_admins`) — rules apply to admins too.
- **Block force pushes** — `allow_force_pushes` disabled.
- **Block branch deletion** — `allow_deletions` disabled.

These align with the CI gates that target `main`: `.github/workflows/pr.yml`,
`.github/workflows/secret-scan.yml`, `.github/workflows/docker.yml`,
`.github/workflows/release.yml`, and `.github/workflows/refresh-lockfile.yml`.
The `verify` job is the legacy required-check name for the split PR verification
lanes, and `.github/scripts/check-pr-security.mjs` performs the PR security
review signal.

Required status checks must be emitted on every PR to `main`. Do not configure a
required check behind a path filter or a trigger that can skip the PR entirely;
put any path-specific logic inside the job so the check-run still exists.

For the agent-authored PR automation lane, see `doc/AGENT-PR-FACTORY.md`. That
lane only enables GitHub native auto-merge; branch protection remains the final
merge authority.

## Verify current state (read-only)

Run the reporting script. It reads the branch-protection API and prints which
recommended protections are present or missing. It never mutates settings.

```sh
# Using a token (CI or local):
GH_REPO=haykel1977/paperclip GH_TOKEN=$GITHUB_TOKEN \
  node .github/scripts/check-branch-protection.mjs

# Or, locally with the GitHub CLI already authenticated (`gh auth login`):
GH_REPO=haykel1977/paperclip node .github/scripts/check-branch-protection.mjs
```

Environment variables:

| Variable   | Purpose                                                        | Default               |
| ---------- | -------------------------------------------------------------- | --------------------- |
| `GH_REPO`  | `owner/repo` to inspect (falls back to `GITHUB_REPOSITORY`)    | _required_            |
| `BRANCH`   | Branch to check                                                | `main`                |
| `GH_TOKEN` | Token with repo read access (falls back to `GITHUB_TOKEN`)     | uses `gh` CLI if unset |
| `STRICT`   | When `1`/`true`, exit non-zero if any protection is missing    | report-only (exit 0)  |

By default the script is **report-only** and exits `0` even when protections are
missing, so it is safe to run anywhere. Set `STRICT=1` if you want a missing
protection to fail the command in an audit job.

## Current expected state

The active production/default branch for Paperclip is `main`. Any stale
protection, CI trigger, release trigger, or documentation that still treats
`master` as the active branch should be considered configuration drift and fixed
before relying on CI as a merge gate.

## Apply the settings (manual)

Maintainers apply protection via the GitHub UI, or with the API:

```sh
gh api -X PUT repos/haykel1977/paperclip/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["verify", "gitleaks"] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

> This snippet is documentation only. Running it requires admin rights on the
> repository and is an intentional, manual maintainer step — no automation in
> this repo performs it.

## Repository security features (manual)

Two GitHub repository features must be enabled by a maintainer
(Settings → Code security). They cannot be toggled from a workflow or script:

- **Dependency graph** — required by the `Dependency Review` step in
  `.github/workflows/commitperclip-review.yml`. When it is disabled the action
  errors with _"Dependency review is not supported on this repository"_. That
  step is configured `continue-on-error: true` + `warn-only: true` so the review
  gate still passes while the feature is off, but enabling Dependency graph turns
  the dependency diff into an active signal.
- **Dependabot alerts / security updates** — pairs with `.github/dependabot.yml`.
  The grouped `npm-security` update flow only opens PRs once alerts are enabled.

Enabling these completes the supply-chain side of the hardening that the
committed config and workflows assume.

## Commitperclip review token

`.github/workflows/commitperclip-review.yml` runs on `pull_request_target`, so it
has access to repository secrets while reviewing untrusted pull requests. The
workflow intentionally checks out the PR base branch, not the PR head, and must
not execute code from the pull request.

Preferred configuration:

- set the repository secret `COMMITPERCLIP_KEY` to the private key for the
  commitperclip GitHub App installation
- keep the app installation scoped to the repository permissions needed by the
  review workflow

Fallback behavior:

- if `COMMITPERCLIP_KEY` is absent, the workflow uses the built-in
  `GITHUB_TOKEN`
- quality-gate comments are then authored by `github-actions[bot]` instead of
  `commitperclip[bot]`
- security checks still use the same base-branch checkout rule and must remain
  free of PR-code execution

The fallback keeps PR review from failing solely because the app secret is not
configured. Maintainers should still prefer the GitHub App token when available
because it gives the review automation a dedicated identity and narrower audit
trail.
