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
  `pnpm-workspace.yaml`, `.npmrc`, `yarn.lock`, `pnpmfile.*`)
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
error fails closed to RED. Required check-run evidence at merge time is still
enforced by branch protection — the lane gate adds the deterministic
path/size/actor/label guardrails *before* auto-merge is enabled. If a PR later
loses GREEN status, the workflow reruns and disables native auto-merge.

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

## What this does not do

- It does not change repository settings or branch protection.
- It does not merge PRs; it only gates whether auto-merge may be enabled.
- It does not create secrets or credentials.
- It does not replace the existing quality, security, or governance gates — it
  runs alongside them.
