# paperclip-checker (independent App gate)

This document is the setup/runbook for the **paperclip-checker** GitHub App
gate. The repository side is implemented and merged, but the App is **not yet
created** and the gate is **disabled by default**. Nothing in this repo creates
an App, secret, variable, approval, comment, or label — activation is a manual
maintainer action performed only after a live witness PR (see
[Activation](#activation)).

## What it is

An independent, least-privilege GitHub App whose sole privileged action is to
submit or dismiss **its own** PR review. It runs from the trusted base branch
and **never checks out or executes PR head code**. It evaluates only:

- PR metadata (title, draft state, base/head repo, author),
- changed files and labels,
- the current head SHA (compared against the trigger-time SHA for freshness),
- required check-runs / commit statuses on the head SHA, **bound to the app that
  is expected to produce each check** (see [Producer binding](#producer-binding)),
- the existing base-branch risk-lane classifier
  (`.github/scripts/classify-pr-risk-lane.mjs`).

**All reads use the workflow's default `GITHUB_TOKEN`.** The privileged App
installation token is minted **only** when the checker is about to approve or
dismiss — its single capability is writing its own review.

### Triggers (base-branch code only)

- `pull_request_target` — reacts to PR lifecycle and label changes.
- `workflow_run` (`completed`) of the base-branch CI workflows that produce the
  required checks (`PR` → `verify`, `Secret Scan` → `gitleaks`). This is what
  lets a **pending** gate become an **approval** once the last required check
  reaches a terminal state. `workflow_run` always runs the base-branch workflow
  file with base-branch code and never checks out PR head; because it carries no
  PR context, the script resolves the open, same-repo PR from the run's head SHA
  (`resolvePrNumberForSha`) and ignores fork/closed/mismatched-SHA PRs.

It is intentionally a **separate identity** from commitperclip so its approval
is attributable and can satisfy a branch-protection "last push was not by the
approver" rule.

### Producer binding

Each required check is pinned to its expected producing app via the
machine-readable, base-branch-only policy file
`.github/paperclip-checker.config.json` (default: `verify` and `gitleaks`, both
produced by GitHub Actions, app id `15368`). A same-named check-run **or** commit
status from any *other* app does **not** satisfy the gate — it is treated as a
**failure (blocked)**, never silently ignored. There is **no** silent
check-run↔status fallback: a requirement typed `check_run` is satisfied only by a
check-run from the expected app; a `status`-typed requirement only by a status
from the expected creator.

## Components

| Path | Role |
| --- | --- |
| `.github/workflows/paperclip-checker.yml` | `pull_request_target` + `workflow_run` workflow, base-branch only, gated by the activation variable. |
| `.github/scripts/paperclip-checker.mjs` | Fail-closed decision logic + integration (fetch → classify → decide → approve/dismiss). |
| `.github/scripts/paperclip-app-token.mjs` | Mints a short-lived, down-scoped installation token (write-only capability). |
| `.github/paperclip-checker.config.json` | Machine-readable producer-binding policy (required checks → expected app id/slug). |
| `.github/scripts/tests/paperclip-checker.test.mjs` | Unit + mocked integration tests. |

## Required configuration

Nothing below exists yet. Create it only during [Activation](#activation).

### Repository variable (kill switch)

| Name | Value to activate | Default (disabled) |
| --- | --- | --- |
| `PAPERCLIP_CHECKER_ENABLED` | `true` (exact string) | unset / any other value |

The workflow job is skipped unless this variable equals `true`. This is the
kill switch and the fast rollback: unset it (or set to `false`) to disable the
gate immediately with no code change.

### Repository secrets

| Name | Contents |
| --- | --- |
| `PAPERCLIP_CHECKER_APP_ID` | Numeric App ID of the created App. |
| `PAPERCLIP_CHECKER_PRIVATE_KEY` | Full PEM private key (`-----BEGIN PRIVATE KEY-----` … ). |

If the variable is `true` but either secret is missing or malformed, the
checker resolves to **blocked** (exit non-zero, clear diagnostic) — never
success/neutral, never an approval.

## Expected App permissions (least privilege)

Because **every read is performed with the workflow's default `GITHUB_TOKEN`**,
the App itself needs no read scopes beyond the mandatory baseline. Grant it
exactly these when creating it. The minted installation token additionally
**down-scopes** to this set, so an over-granted App still cannot exceed it
(`LEAST_PRIVILEGE_PERMISSIONS` in `paperclip-app-token.mjs`):

| Scope | Access | Why |
| --- | --- | --- |
| Metadata | read | baseline required by GitHub for any token |
| Pull requests | **read/write** | submit/dismiss the App's own review — the **only** capability the App exercises |

`pull_requests` is the **only** write scope and the **only** scope the App
actually uses. There is deliberately **no** `contents`, `issues`, `actions`,
`checks`, or `statuses` grant: those reads (changed files, labels, check-runs,
statuses, commit) all go through the default `GITHUB_TOKEN`, so granting them to
the App would be unused privilege. **No** code/content write, **no** check
write, **no** workflow write, **no** administration — the App can never push
code, create check-runs, edit workflows, or change repo settings.

The App token is also minted **as late as possible** — only after the decision
is `approved` (or a stale approval must be dismissed). Fork/draft/identity/lane
rejections are reached during read-only evaluation and never mint a token.

## Diagnostics (no raw API bodies)

All error output is passed through `sanitizeError`, which surfaces only the HTTP
status code (`GitHub API error (HTTP 403).`) or a redaction marker. Raw GitHub
response bodies are never echoed to CI logs, and the private key / minted token
are never logged.

## Decision model

- **approved** — ONLY when: the PR is GREEN per the classifier, not draft, not a
  fork, the trigger-time head SHA equals the freshly-read head SHA (evidence is
  fresh for the exact commit), every configured blocking check
  (`verify`, `gitleaks`) concluded `success` **from its expected producing app**,
  and the App is **not** the PR author, last pusher, or head-commit author. A
  final head-SHA re-read immediately before the approval POST re-confirms
  freshness (anti-TOCTOU); a mid-run head advance fails closed.
- **pending** — no disqualifier, but a required check has not yet reached a
  terminal state (missing or still running from the expected producer). **No
  approval.** Exits `0` as a clean no-op so the completing CI `workflow_run` can
  re-invoke the checker when the last required check turns green. Pending is not
  a pass.
- **rejected** — any non-GREEN lane (RED/ORANGE), a stale/mismatched/malformed
  head SHA, any required check that concluded `neutral`/`skipped`/`failure`/
  `cancelled`/`timed_out`, a same-named check produced by an **unexpected app**
  (spoof), a hard-block or contradictory label, a draft or fork PR, or an
  identity collision with the App.
- **blocked** — activation disabled or App ID/key missing/invalid, or token
  minting/dismissal failed.

`approved` and `pending` exit `0` (pending performs no approval); `rejected` and
`blocked` exit non-zero. A misconfigured or ambiguous run can never be mistaken
for an approval, and a not-yet-complete run waits rather than failing the PR.

## Stale-approval handling

On `synchronize`, `reopened`, `ready_for_review`, `converted_to_draft`,
`labeled`, and `unlabeled` — or whenever a prior App approval points at an older
commit — the checker **dismisses/supersedes** its stale approval before
re-deciding. If the dismissal API call fails, the checker **fails closed**
(no approval) and relies on the documented branch-protection backstop below.

### Required branch-protection backstop

Because a re-run cannot retroactively unwind an approval GitHub already counted,
configure `main` protection so a stale App approval cannot carry a merge:

- **Dismiss stale pull request approvals when new commits are pushed**
  (`dismiss_stale_reviews: true`).
- **Require approval from someone other than the last pusher**
  (`require_last_push_approval: true`) — pairs with the App's identity
  separation so the App can never approve its own push.

See `doc/SECURITY-BRANCH-PROTECTION.md` for the full baseline. Do **not** add
`paperclip-checker` as a required status check until after the witness PR below.

## Activation

External App creation requires GitHub **sudo (2FA) authentication** and cannot
be performed by automation. A maintainer must:

1. Create the GitHub App with the [expected permissions](#expected-app-permissions-least-privilege)
   and subscribe to Pull request events. Note the numeric App ID; generate and
   download a private key.
2. Install the App on this repository only.
3. Add `PAPERCLIP_CHECKER_APP_ID` and `PAPERCLIP_CHECKER_PRIVATE_KEY` as
   repository secrets.
4. **Witness PR (dry check first):** open a throwaway GREEN PR and confirm the
   workflow reaches a live decision and, when it approves, the review is
   attributed to the App identity. Confirm a RED/ORANGE PR and an App-authored
   PR are both refused.
5. Only after the witness PR behaves correctly, set the repository variable
   `PAPERCLIP_CHECKER_ENABLED=true`.
6. Optionally, add `paperclip-checker` to `main` required checks once trust is
   established.

## Key rotation

1. In the App settings, generate a **new** private key (keep the old one valid).
2. Update the `PAPERCLIP_CHECKER_PRIVATE_KEY` secret with the new PEM.
3. Trigger a witness PR run and confirm token minting succeeds.
4. Delete the old key from the App settings.

Tokens are installation tokens minted per run with a short (~9 min) JWT window
and expire automatically; there is no long-lived token to revoke beyond the
private key itself.

## Kill switch & rollback

- **Kill switch:** set `PAPERCLIP_CHECKER_ENABLED` to anything other than
  `true` (or unset it). The job is skipped on the next event; no code change.
- **Secret compromise:** delete/replace the private key in App settings and
  update the secret. Existing minted tokens expire within minutes.
- **Full rollback:** remove `paperclip-checker` from required checks (if added),
  unset the variable, and — if desired — revert the PR that introduced these
  files. Reverting is safe because the gate is inert while the variable is off.
