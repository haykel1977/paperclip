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

### Two-key model (why two required checks)

The gate publishes **two** required check runs on the exact PR head, from **two
different identities using two different tokens** — deliberately independent
failure domains:

| Key | Context name | Author (app id) | Token | Published when |
| --- | --- | --- | --- | --- |
| **App key** | `paperclip-checker/app` | `solidus-paperclip-checker` (**4372695**) | minted least-privilege **App installation token** | after the decision, by `executeDecision` |
| **Runner key** | `paperclip-checker-runner` | `github-actions` (**15368**) | the workflow's **default `GITHUB_TOKEN`** | after the decision, by `main()` |

Both are **API-published onto the exact PR head SHA** (not the job's base-SHA
native check), both are **pinned to their app id** (a same-named check from any
other identity is non-authoritative), and both are `success` **only** for an
`approved` decision (`in_progress` for pending, `failure` otherwise; `neutral` is
never emitted). Branch protection must require **both** contexts.

**Why two keys are necessary.** A single App-authored key has an irreducible
residual: if `checks:write` for the App token is unreachable for *both* an
in-place PATCH *and* a latest-wins POST, a stale App `success` at the head can
survive and keep satisfying branch protection despite a non-approval decision
(the checker's exit code is not itself a merge gate). The runner key closes this:
it is published by a **separate token** (the default `GITHUB_TOKEN`, no App JWT /
installation mint), so the same non-approval decision drives the runner key to
`failure` **independently**. For a stale green to authorize a merge now, *both*
keys' writes must fail *simultaneously* across *both* tokens — a far smaller,
honestly-bounded window than a single key's. The runner key mirrors the **final**
outcome of `executeDecision`, so when the App key fails closed to `blocked`
(e.g. its mandatory revocation could not land), the runner key is published as a
`failure` and two-key protection blocks the merge.

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

### Fork & missing-secrets behavior (fail-closed)

Both required keys are published on the exact PR head from **base-branch code**,
so the trigger choice matters:

- **Fork PRs.** The workflow uses `pull_request_target` (not `pull_request`), so
  the job runs **base-branch** code with the repo's secrets and a **writable**
  default token **even for fork-authored PRs**. That means both keys *can* be
  published for a fork PR — and they are published as **`failure`**, because the
  decision core rejects any PR whose head repo differs from the base repo ("Fork
  PR … is never approved"). A fork PR therefore gets two red required checks and
  is blocked. This is why `pull_request_target` is safer here than
  `pull_request`: under `pull_request` a fork's token is read-only with no
  secrets, so **neither** key could be written and the gate would depend on the
  *absence* of a check — correct but fragile. Publishing an affirmative
  `failure` from `pull_request_target` is the stronger, unambiguous signal, and
  no PR-head code is ever executed (the job pins the checkout to the default
  branch).
- **Missing / malformed App secrets while enabled.** If `PAPERCLIP_CHECKER_ENABLED`
  is `true` but `PAPERCLIP_CHECKER_APP_ID` / `PAPERCLIP_CHECKER_PRIVATE_KEY` are
  missing or malformed, config is **invalid** → decision `blocked`. The App key
  cannot be produced (no token to mint), so `main()` publishes only the **runner
  key** = `failure` with the default token on the exact head (revoking any stale
  runner `success`) and exits 1. The App context stays whatever it was; the
  runner key going red blocks the merge. If a stale App `success` also stands and
  is required, the runner-key failure still blocks — fail-closed.
- **Disabled (default).** When the variable is not `true`, the job is **skipped**
  entirely, so **neither** key is published. Pre-migration this must not block
  merges — see [Activation](#activation) for the ordering that adds the required
  contexts only *after* the gate is enabled.

## Components

| Path | Role |
| --- | --- |
| `.github/workflows/paperclip-checker.yml` | `pull_request_target` + `workflow_run` workflow, base-branch only, gated by the activation variable. Grants the default token `checks:write` to publish the runner key. |
| `.github/scripts/paperclip-checker.mjs` | Fail-closed decision logic + integration (fetch → classify → decide → publish App key + runner key + audit review). |
| `.github/scripts/paperclip-app-token.mjs` | Mints a short-lived, down-scoped installation token (`checks:write` + `pull_requests:write`). |
| `.github/paperclip-checker.config.json` | Machine-readable producer-binding policy (required checks → expected app id/slug; `appCheckName` + `runnerCheckName`). |
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

Each decision maps to a specific state of **both** required check runs
(`paperclip-checker/app` and `paperclip-checker-runner`) on the exact head SHA:
the runner key mirrors the App key's terminal state. `success` is the **only**
conclusion that satisfies a required context; `neutral` is deliberately **never**
emitted because GitHub treats a neutral required check as passing (that would
defeat fail-closed). Below, "check run" means both keys unless noted.

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

**Mandatory stale-success revocation (per key).** If a prior `success` check
(matched by name **and** `app_id`, bound to this exact head) *does* stand and the
current decision is a non-approval, that green would still satisfy branch
protection — so downgrading it is **not** best-effort, it **must land**. Applied
to **each** key independently: the App key uses the App token, the runner key
uses the default token. The checker first PATCHes the standing run to the
non-approval conclusion (`failure`, or `in_progress` for pending); if that write
fails it POSTs a fresh same-named run at the same head, relying on GitHub
evaluating the **most recent** check run of a given name (latest-wins supersede).

If **both** writes for the **App key** fail, `executeDecision` fails closed to
`blocked`/exit 1 and does **not** claim the stale App green was superseded — it
was not. What actually blocks the merge in that residual is the **runner key**:
`main()` then publishes `paperclip-checker-runner` = `failure` with the default
token (a separate failure domain), so two-key branch protection blocks despite
the surviving App green. If the runner key **also** cannot land its non-success
over a standing runner `success` (both default-token writes fail too), `main()`
forces exit 1 — even a `pending` (normally exit 0) fails closed here. Only when
**all four** writes fail simultaneously — across **both** tokens — can a stale
green survive; that quadruple-failure window is the honest, irreducible residual,
not a state the code claims to have closed.

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

The enforceable signals are the **two** check runs (`paperclip-checker/app` and
`paperclip-checker-runner`), each bound to a head SHA and unable to carry to a new
commit. Configure `main` protection to require **both** contexts, and also keep
the review-hygiene rules so the audit review can never accidentally carry a merge:

- **Require both status checks** — `paperclip-checker/app` (pin to `app_id`
  **4372695**) **and** `paperclip-checker-runner` (pin to `app_id` **15368**).
  Requiring only one re-opens the single-key residual described above.
- **Dismiss stale pull request approvals when new commits are pushed**
  (`dismiss_stale_reviews: true`).
- **Require approval from someone other than the last pusher**
  (`require_last_push_approval: true`) — pairs with the App's identity
  separation so the App can never approve its own push.

See `doc/SECURITY-BRANCH-PROTECTION.md` for the full baseline. Do **not** add
either context as a required check until after the witness PR below. When you do,
require the **API-published, head-bound, app-id-pinned** contexts
`paperclip-checker/app` (`app_id` 4372695) and `paperclip-checker-runner`
(`app_id` 15368) — **never** the runner Actions **job** `paperclip-checker
(runner)`. The job's native check reports on the **base SHA** (under
`pull_request_target`) and only means "the script ran", not "the gate approved";
its name (with a space and parenthesis) is intentionally distinct from the runner
**key** `paperclip-checker-runner`.

## Activation

External App creation requires GitHub **sudo (2FA) authentication** and cannot
be performed by automation. The ordering below is deliberate: **required contexts
are added only after the gate is proven to produce them on a live head**, so a
pre-migration merge is never blocked by a check that is not yet being published.

1. Create the GitHub App with the [expected permissions](#expected-app-permissions-least-privilege)
   and subscribe to Pull request events. Note the numeric App ID; generate and
   download a private key.
2. Install the App on this repository only.
3. Add `PAPERCLIP_CHECKER_APP_ID` and `PAPERCLIP_CHECKER_PRIVATE_KEY` as
   repository secrets.
4. **Enable the gate first, while neither context is required.** Set the
   repository variable `PAPERCLIP_CHECKER_ENABLED=true`. Because neither
   `paperclip-checker/app` nor `paperclip-checker-runner` is a required check yet,
   this cannot block any current merge — it only starts the job publishing both
   keys.
5. **Witness PR (bootstrap both keys on the exact migration head):** open a
   throwaway GREEN PR and confirm the workflow reaches a live decision and
   publishes **both** a `success` `paperclip-checker/app` (attributed to the App,
   app id 4372695) **and** a `success` `paperclip-checker-runner` (attributed to
   github-actions, app id 15368) on the exact head — plus the audit review.
   Confirm a RED/ORANGE PR, a fork PR, and an App-authored PR each get **both**
   keys as `failure` and are refused.
6. **Atomically add both required contexts and remove human-review authority.**
   Only after the witness PR behaves correctly, in a single branch-protection
   update: add `paperclip-checker/app` (pin `app_id` 4372695) **and**
   `paperclip-checker-runner` (pin `app_id` 15368) as required checks, and make
   the corresponding reduction to human-review authority. Adding both together
   avoids a window where one key is required but the other is not. Never require
   the runner **job** `paperclip-checker (runner)`.

## Key rotation

1. In the App settings, generate a **new** private key (keep the old one valid).
2. Update the `PAPERCLIP_CHECKER_PRIVATE_KEY` secret with the new PEM.
3. Trigger a witness PR run and confirm token minting succeeds.
4. Delete the old key from the App settings.

Tokens are installation tokens minted per run with a short (~9 min) JWT window
and expire automatically; there is no long-lived token to revoke beyond the
private key itself.

## Kill switch & rollback

**Rollback reverses the activation order: relax protection *before* disabling the
gate.** If the variable is unset while the two contexts are still required, the
job stops publishing them, the contexts go/stay pending on every open PR, and
**all merges block**. So always remove the required contexts first.

- **Kill switch (safe order):**
  1. In branch protection, remove `paperclip-checker/app` **and**
     `paperclip-checker-runner` from required checks (and restore any human-review
     authority you reduced during activation).
  2. Only then set `PAPERCLIP_CHECKER_ENABLED` to anything other than `true` (or
     unset it). The job is skipped on the next event; no code change.
- **Secret compromise:** delete/replace the private key in App settings and
  update the secret. Existing minted tokens expire within minutes. The runner key
  (default token) is unaffected.
- **Full rollback:** after removing both required contexts and unsetting the
  variable, — if desired — revert the PR that introduced these files. Reverting is
  safe because the gate is inert while the variable is off.
