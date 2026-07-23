# paperclip-checker (independent App gate)

This document is the setup/runbook for the **paperclip-checker** GitHub App
gate. The repository side is implemented and merged, but the App is **not yet
created** and the gate is **disabled by default**. Nothing in this repo creates
an App, secret, variable, approval, comment, or label — activation is a manual
maintainer action performed only after a live witness PR (see
[Activation](#activation)).

## What it is

An independent, least-privilege GitHub App whose authoritative action is to
publish a distinct **check run** (`paperclip-checker/app`) on the exact PR head
— the signal branch protection actually enforces. It runs from the trusted base
branch and **never checks out or executes PR head code**. It evaluates only:

- PR metadata (title, draft state, base/head repo, author),
- changed files and labels,
- the current head SHA (compared against the trigger-time SHA for freshness),
- required check-runs / commit statuses on the head SHA, **bound to the app that
  is expected to produce each check** (see [Producer binding](#producer-binding)),
- the existing base-branch risk-lane classifier
  (`.github/scripts/classify-pr-risk-lane.mjs`).

**All reads use the workflow's default `GITHUB_TOKEN`.** The privileged App
installation token is minted **only** when the checker is about to write — it
publishes the authoritative check run and (best-effort) an audit review.

### Why a check run, not a review

A GitHub App review has `author_association: NONE` and its author has no write
access, so it can **never** count toward branch protection's
`required_approving_review_count`. The enforceable merge signal is therefore an
**App-authored check run** (`paperclip-checker/app`) on the exact PR head:
branch protection requires that context (pinned to the App's `app_id`, so a
same-named check from any other identity cannot spoof success). The App still
submits a PR review, but **only as an audit trail** — merge eligibility does not
depend on it.

### Triggers (base-branch code only)

- `pull_request_target` — reacts to PR lifecycle and label changes.
- `workflow_run` (`completed`) of the base-branch CI workflows that produce the
  required checks (`PR` → `verify`, `Secret Scan` → `gitleaks`). This is what
  lets a **pending** gate become an **approval** once the last required check
  reaches a terminal state. `workflow_run` always runs the base-branch workflow
  file with base-branch code and never checks out PR head; because it carries no
  PR context, the script resolves the open, same-repo PR from the run's head SHA
  (`resolvePrNumberForSha`) and ignores fork/closed/mismatched-SHA PRs.

It is intentionally a **separate identity** from commitperclip so its check run
and audit review are attributable and its actions satisfy a branch-protection
"last push was not by the approver" rule. The bound identity is the GitHub App **`solidus-paperclip-checker`**
(App ID **4372695**), whose bot login is **`solidus-paperclip-checker[bot]`**.
Separation of duties compares this login against the PR author, last pusher, and
head-commit author, so the App can **never** approve a PR it authored, pushed, or
committed. The identity is pinned in code (`DEFAULT_APP_SLUG`) and in the
committed policy file's top-level `appSlug`.

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
| `.github/scripts/paperclip-checker.mjs` | Fail-closed decision logic + integration (fetch → classify → decide → publish check run + audit review). |
| `.github/scripts/paperclip-app-token.mjs` | Mints a short-lived, down-scoped installation token (`checks:write` + `pull_requests:write`). |
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
| Checks | **read/write** | publish the authoritative `paperclip-checker/app` check run on the exact PR head — the enforceable merge signal |
| Pull requests | **read/write** | submit/dismiss the App's own review — retained as an **audit trail only**, not relied on for merge |

`checks` and `pull_requests` are the **only** write scopes. `checks:write`
publishes the required check run (the merge signal); `pull_requests:write`
writes the audit-only review. There is deliberately **no** `contents`, `issues`,
`actions`, or `statuses` grant: those reads (changed files, labels, check-runs,
statuses, commit) all go through the default `GITHUB_TOKEN`, so granting them to
the App would be unused privilege. **No** code/content write, **no** status
write, **no** workflow write, **no** administration — the App can never push
code, write commit statuses, edit workflows, or change repo settings.

The App token is also minted **as late as possible** — only after the decision
is reached and a write is about to happen (publish the check run, submit the
audit review, or dismiss a stale review). It is minted **at most once** per run
and reused across writes. Fork/draft/identity/lane rejections still publish a
`failure` check (best-effort) but never mint a token before evaluation completes.

## Diagnostics (no raw API bodies)

All error output is passed through `sanitizeError`, which surfaces only the HTTP
status code (`GitHub API error (HTTP 403).`) or a redaction marker. Raw GitHub
response bodies are never echoed to CI logs, and the private key / minted token
are never logged.

## Decision model

Each decision maps to a specific state of the `paperclip-checker/app` check run
on the exact head SHA. `success` is the **only** conclusion that satisfies the
required context; `neutral` is deliberately **never** emitted because GitHub
treats a neutral required check as passing (that would defeat fail-closed).

- **approved** → check run `completed`/**`success`**. ONLY when: the PR is GREEN
  per the classifier, not draft, not a fork, the trigger-time head SHA equals the
  freshly-read head SHA (evidence is fresh for the exact commit), every configured
  blocking check (`verify`, `gitleaks`) concluded `success` **from its expected
  producing app**, and the App is **not** the PR author, last pusher, or
  head-commit author. A final head-SHA re-read immediately before publishing
  re-confirms freshness (anti-TOCTOU); a mid-run head advance fails closed. The
  success check **must land**, or the decision degrades to `blocked` (there would
  otherwise be no green required check). An audit review is then submitted
  best-effort.
- **pending** → check run **`in_progress`** (no conclusion): the required context
  exists but is not satisfied. No disqualifier, but a required check has not yet
  reached a terminal state (missing or still running from the expected producer).
  Exits `0` so the completing CI `workflow_run` can re-invoke the checker when the
  last required check turns green. Pending is not a pass.
- **rejected** → check run `completed`/**`failure`**. Any non-GREEN lane
  (RED/ORANGE), a stale/mismatched/malformed head SHA, any required check that
  concluded `neutral`/`skipped`/`failure`/`cancelled`/`timed_out`, a same-named
  check produced by an **unexpected app** (spoof), a hard-block or contradictory
  label, a draft or fork PR, or an identity collision with the App.
- **blocked** → check run `completed`/**`failure`** (best-effort). Activation
  disabled or App ID/key missing/invalid, or token minting/dismissal/publish
  failed.

`approved` and `pending` exit `0` (pending publishes no success); `rejected` and
`blocked` exit non-zero. Publishing the check run for a non-approval is
best-effort **only when no App-authored `success` already stands at the exact
head**: the **absence** of a `success` check already fails closed, so a publish
error cannot turn a non-approval into a pass. A misconfigured or ambiguous run
can never be mistaken for a success, and a not-yet-complete run waits
(`in_progress`) rather than failing the PR.

**Mandatory stale-success revocation.** If a prior App-authored `success` check
(matched by name **and** `app_id`, bound to this exact head) *does* stand and the
current decision is a non-approval, that green would still satisfy branch
protection — so downgrading it is **not** best-effort, it **must land**. The
checker first PATCHes the standing run to the non-approval conclusion
(`failure`, or `in_progress` for pending); if that write fails it POSTs a fresh
same-named run at the same head, relying on GitHub evaluating the **most recent**
check run of a given name (latest-wins supersede). Only if **both** independent
writes fail does the checker refuse to return the requested outcome and instead
fails closed to `blocked`/exit 1 — even a `pending` (normally exit 0) fails
closed here, because no path may report "safe" while a satisfiable stale
`success` might still stand.

**Idempotency.** If THIS App's own check run (matched by name **and** `app_id`,
so a spoofed same-named check is ignored) already reports `success` for the
freshness-confirmed head and no stale dismissal intervened, the checker does
nothing — no token mint, no re-publish, no review — so a transient write error
can never flip a standing green check to a failure.

## Stale-approval handling

The check run is bound to a specific head SHA, so it cannot itself go stale: a
new commit simply has no `success` check until the checker re-evaluates and
publishes one at the new head. Stale handling therefore concerns the **audit
review** (which GitHub could otherwise count under some configurations) and the
freshness of any write.

On `synchronize`, `reopened`, `ready_for_review`, `converted_to_draft`,
`labeled`, `unlabeled`, and `edited` (title/body/base-branch changes feed the
risk-lane classifier) — or whenever a prior App review points at an older
commit, or whenever the current re-evaluation does **not** re-approve (e.g. a
`workflow_run` CI re-run that now fails at the same head SHA) — the checker
**dismisses/supersedes** its stale review before re-deciding. If the dismissal
API call fails, the checker **fails closed** (publishes no success check) and
relies on the documented branch-protection backstop below.

If the head advances **during** evaluation (the anti-TOCTOU pre-write re-read
sees a different SHA than the trigger-time SHA), the checker refuses to publish a
`success` check for the now-stale commit **and** dismisses any existing App
review that was not already dismissed above — a push mid-run can never leave a
stale approval standing while the new commit is refused.

### Required branch-protection backstop

The enforceable signal is the `paperclip-checker/app` check run, which is bound
to a head SHA and cannot carry to a new commit. Still configure `main` protection
so the audit review can never accidentally carry a merge:

- **Dismiss stale pull request approvals when new commits are pushed**
  (`dismiss_stale_reviews: true`).
- **Require approval from someone other than the last pusher**
  (`require_last_push_approval: true`) — pairs with the App's identity
  separation so the App can never approve its own push.

See `doc/SECURITY-BRANCH-PROTECTION.md` for the full baseline. Do **not** add
`paperclip-checker/app` as a required status check until after the witness PR
below. When you do, require the context **`paperclip-checker/app`** produced by
the App (`app_id` 4372695) — never the runner Actions job `paperclip-checker
(runner)`, whose success only means "the script ran", not "the gate approved".

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
   workflow reaches a live decision and publishes a `success`
   `paperclip-checker/app` check run attributed to the App identity (and, as an
   audit trail, the App review). Confirm a RED/ORANGE PR and an App-authored PR
   both get a `failure` check and are refused.
5. Only after the witness PR behaves correctly, set the repository variable
   `PAPERCLIP_CHECKER_ENABLED=true`.
6. Optionally, add the App-produced context `paperclip-checker/app` to `main`
   required checks once trust is established (pin to `app_id` 4372695; never the
   runner job `paperclip-checker (runner)`).

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
- **Full rollback:** remove `paperclip-checker/app` from required checks (if
  added), unset the variable, and — if desired — revert the PR that introduced
  these files. Reverting is safe because the gate is inert while the variable is
  off.
