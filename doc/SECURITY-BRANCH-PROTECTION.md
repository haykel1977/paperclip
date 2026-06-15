# Branch Protection (master)

This document defines the branch-protection baseline for the default branch
(`master`) and how to verify it. Repository settings are **not** changed by any
script in this repo — applying protection is a manual maintainer action through
the GitHub UI or API. The provided check script is read-only and only reports
the current state.

## Recommended settings

Enable the following on `master`
(Settings → Branches → Branch protection rules → `master`):

- **Require a pull request before merging** — no direct pushes to `master`.
- **Require at least one approving review** — `required_approving_review_count >= 1`.
- **Require status checks to pass before merging** — at minimum the `verify`
  check produced by `.github/workflows/pr.yml`.
- **Include administrators** (`enforce_admins`) — rules apply to admins too.
- **Block force pushes** — `allow_force_pushes` disabled.
- **Block branch deletion** — `allow_deletions` disabled.

These align with the existing CI gates in `.github/workflows/pr.yml` (the
`verify` job is the legacy required-check name) and the silent security review
performed by `.github/scripts/check-pr-security.mjs`.

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
| `BRANCH`   | Branch to check                                                | `master`              |
| `GH_TOKEN` | Token with repo read access (falls back to `GITHUB_TOKEN`)     | uses `gh` CLI if unset |
| `STRICT`   | When `1`/`true`, exit non-zero if any protection is missing    | report-only (exit 0)  |

By default the script is **report-only** and exits `0` even when protections are
missing, so it is safe to run anywhere. Set `STRICT=1` if you want a missing
protection to fail the command (e.g. in an audit job).

## Apply the settings (manual)

Maintainers apply protection via the GitHub UI, or with the API:

```sh
gh api -X PUT repos/haykel1977/paperclip/branches/master/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["verify"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
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
