# PR Risk Lanes

This runbook describes the deterministic, fail-closed PR risk-lane classifier
used to gate development/test autonomy. It complements
[`doc/AGENT-PR-FACTORY.md`](AGENT-PR-FACTORY.md) (auto-merge lane) and
[`doc/SECURITY-BRANCH-PROTECTION.md`](SECURITY-BRANCH-PROTECTION.md) (branch
protection). Branch protection and GitHub check-runs remain the final merge
authority; the classifier only decides how much autonomy a PR may have.

## Lanes

The classifier (`.github/scripts/classify-pr-risk-lane.mjs`) assigns exactly one
lane from PR metadata plus the git diff. It never executes PR code.

- **GREEN** — bounded low-risk diff by a recognized actor, valid inputs, fresh
  head SHA, and all required evidence green. Only GREEN is auto-merge eligible.
- **ORANGE** — plausibly safe but needs extra human evidence (larger scope/size,
  or an explicit `risk:orange` label). **Never auto-merges by default.**
- **RED** — touches a sacred/high-blast-radius surface, exceeds reviewability
  limits, or trips any fail-closed condition. A human must review and merge.

GREEN size bound: at most 200 changed lines and 10 files. Above that (but still
non-sacred) is ORANGE. Above the governance reviewability limits (2000 lines /
50 files) is RED.

## RED surfaces (always require a human)

Any active changed file matching any of these makes the PR RED:

- `.github/**` (workflows, actions, governance config, templates)
- `CODEOWNERS` (anywhere GitHub honors it)
- governance/checker code (`scripts/check-*.mjs`, `run-quality-gates`, etc.)
- auth / authz / authn code
- secrets material (`.env*`, `.gitleaks.toml`, `*secret*`/`*credential*` code)
- migrations / schema (`**/migrations/**`, `**/schema/**`, `*.sql`, drizzle config)
- infrastructure / release / production (`Dockerfile*`, `docker/**`, `releases/**`,
  `scripts/release*`, `*.tf`, `k8s`/`helm`/`terraform`/`deploy`)
- dependency manifests / lockfiles (`package.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `package-lock.json`) — the *exemptable* declarative subset
- dependency install-hook / registry / workspace config (`.npmrc`,
  `pnpmfile.*`, `pnpm-workspace.yaml`) — **never exemptable**: `pnpmfile.*`
  runs arbitrary code at install time (RCE-class), `.npmrc` can repoint the
  registry (supply-chain), and `pnpm-workspace.yaml` changes package topology
- excessive diff size

## Fail-closed conditions (resolve to RED)

The classifier picks the most restrictive lane when anything is uncertain:

- missing or invalid inputs (non-array file list, empty diff, opaque/empty title)
- unknown actor (not one of the recognized autonomy identities)
- contradictory labels (e.g. two different `risk:*` hints, or `automerge`
  requested alongside a hard-block label)
- hard-block labels (`do-not-merge`, `human-gate-required`, `prod-gate-required`,
  sacred-path labels, …)
- stale PR head SHA (evaluated SHA no longer matches current head)
- neutral / skipped / missing required evidence (never treated as a pass)

## How autonomy consumes the lane

`.github/scripts/enable-agent-automerge.mjs` classifies the live PR and only
enables GitHub native auto-merge when the lane is GREEN. Any classification
error (including a failed file-list or check-run fetch) fails closed to RED. If
a PR later loses GREEN status, the workflow reruns and disables native
auto-merge.

The lane gate adds the deterministic path/size/actor/label guardrails *before*
auto-merge is enabled, and additionally consumes real check-run evidence:

- The head SHA's check-runs are fetched and matched against the required set
  (`REQUIRED_CHECKS`, default `verify,gitleaks`). A **completed** required check
  whose conclusion is `neutral`/`skipped`/`failure` fails closed to RED. A
  required check that is still **pending** is not treated as evidence here — it
  is left to branch protection, which will not merge until it is green. This
  keeps the neutral/skipped fail-closed guarantee live in production without
  preventing native auto-merge from being enabled early.
- Stale-SHA detection compares two independent SHA sources: the workflow passes
  the event payload's head SHA (`EVENT_HEAD_SHA`) while the script freshly
  re-reads `pull.head.sha` from the API. If they differ the head advanced
  mid-run and the classification is stale → RED.

### Bounded dependency-automation exemption

Requiring a human for every lockfile bump would silently disable the
`chore/refresh-lockfile` automation and Dependabot auto-merge, since those PRs
inherently touch dependency manifests (a RED surface). Instead there is one
narrow, verifiable carve-out: a PR authored by the lockfile-refresh automation
(`github-actions[bot]` on `chore/refresh-lockfile`) or `dependabot[bot]` whose
changed files are **exclusively** declarative dependency manifests/lockfiles
(`package.json`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`) may treat
that single surface as non-blocking. The exemption is keyed to
`isDependencyManifestOnly` (every changed path — including rename sources — must
be an exemptable manifest); if such a PR also touches a workflow, auth file,
migration, **an install-hook/registry config (`.npmrc`, `pnpmfile.*`,
`pnpm-workspace.yaml`)**, or any other sacred surface, the exemption evaporates
and the PR is RED. Those install-hook/registry files carry a distinct
non-exemptable label, so even a dependency-automation actor cannot green-light
them. All other guardrails (evidence, size, actor, labels, stale SHA) still apply.

The CLI exits `0` only for GREEN, non-zero for ORANGE/RED, so any caller that
treats the exit code as an auto-merge gate also fails closed.

## Copilot and the future external Checker App

- **GitHub Copilot / inline AI review is advisory only.** Copilot suggestions,
  chat, and PR summaries never satisfy the evidence requirement and never move a
  PR to GREEN. Treat them as hints; the deterministic classifier and required
  check-runs are the authority.
- A future **external Checker GitHub App is not yet built and does not exist
  today.** Do not configure required checks against it or claim it is present.
  When it is introduced it **must**:
  - be a **distinct identity**, separate from the author/automation identities
    that open PRs (no self-approval, no maker-checker collapse);
  - hold **no `Contents`, `Actions`, or `Checks` write permissions** — it may
    read PR metadata and post advisory signals only, so it cannot merge, mutate
    workflows, or forge its own passing check-runs;
  - **never** be used to lower required approving reviews to zero. Human review
    requirements set in branch protection stay in force.

## Merge queue (`merge_group`) is out of scope

This classifier is wired to `pull_request`/`pull_request_target` events only. It
is **not** consulted in a GitHub merge-queue (`merge_group`) context, and the
required checks in `commitperclip-review.yml`/`pr.yml` do not run on
`merge_group`, so enabling a merge queue on this repo would stall. This is a
pre-existing gap, not something this classifier introduces — and
`evaluateBranchProtection` intentionally requires `strict: true` (branches must
be up to date before merging), which is itself incompatible with a merge queue.
Merge-queue support is therefore treated as **external / not implemented** in
this lot. Adding it later would require: `merge_group` triggers on the review
and required-check workflows, dropping the `strict: true` requirement, and a
`merge_group`-aware classification entrypoint. Do not enable a merge queue until
that work is done.

## What this does not do

- It does not change repository settings or branch protection.
- It does not merge PRs; it only gates whether auto-merge may be enabled.
- It does not create secrets or credentials.
- It does not replace the existing quality, security, or governance gates — it
  runs alongside them.
