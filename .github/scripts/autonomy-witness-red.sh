#!/usr/bin/env bash
#
# Autonomy Witness (RED) — bounded, docs-only PR opener for the RED lane.
#
# Invoked only by .github/workflows/autonomy-witness-red.yml (manual dispatch).
# It is the deterministic-RED counterpart to autonomy-witness.sh: it opens a
# docs-only pull request authored by the SAME allowlisted autonomous App identity
# and then applies the exact `risk:red` label, so the deterministic risk-lane
# classifier assigns RED and BOTH paperclip-checker contexts fail BY POLICY. Its
# purpose is to prove the RED lane blocks correctly and NEVER auto-merges — it is
# a genuine negative witness, not a green one. Every bound here is asserted by:
#   - .github/scripts/tests/autonomy-witness-red-workflow.test.mjs   (static policy)
#   - .github/scripts/tests/autonomy-witness-red-behavior.test.mjs   (runtime behavior)
#
# Event-trigger note: GH_TOKEN MUST be a GitHub App installation token, NOT the
# built-in GITHUB_TOKEN. GitHub suppresses pull_request/pull_request_target/push
# workflow triggers for events created with GITHUB_TOKEN, so a witness opened
# with it would author a github-actions[bot] PR on which NO required checks ever
# run. Both the branch push (via `gh auth setup-git`, which wires GH_TOKEN into
# git's credential helper) and `gh pr create` therefore use the SAME App token,
# so the branch is pushed and the PR opened by one coherent App identity and the
# normal PR workflows fire on the exact head.
#
# It NEVER merges, NEVER approves, NEVER enables auto-merge, and NEVER changes
# settings. The RED lane is expected to leave the required checker contexts red;
# that is the witnessed outcome, not a failure of this script.
#
# Required env (all trusted GitHub-provided values; there are NO workflow inputs,
# so nothing user-supplied can reach a ref, path, or command):
#   GH_TOKEN        solidus-paperclip-delivery App installation token (see note
#                   above); used by `gh` and by `git` push. NEVER the built-in
#                   GITHUB_TOKEN.
#   RUN_ID          github.run_id (integer)
#   HEAD_SHA        github.sha
#   REPO            owner/repo
#   DEFAULT_BRANCH  repository default branch
set -euo pipefail

# The witness must be authored by the allowlisted solidus-paperclip-delivery App
# identity. A positive allowlist (rather than merely excluding github-actions[bot])
# also catches a misconfigured App or a wrong installation. In particular a
# github-actions[bot] author means the PR was created with the built-in
# GITHUB_TOKEN, whose pull_request workflows are suppressed → the required checks
# never ran, so a check-less witness could otherwise masquerade as valid.
# GitHub surfaces this ONE App under two exact login forms: the GraphQL/`gh pr
# view` path (used just below) returns `app/solidus-paperclip-delivery`, while REST
# webhook payloads use `solidus-paperclip-delivery[bot]`. Accept exactly these two
# canonical representations of the same App — no prefixes, no other `app/*`.
EXPECTED_AUTHOR_GRAPHQL="app/solidus-paperclip-delivery"
EXPECTED_AUTHOR_REST="solidus-paperclip-delivery[bot]"

# The exact label that deterministically forces the RED lane. It is a lane hint,
# not a hard-block label, so PR governance still passes while both paperclip-checker
# contexts fail by policy — exactly the RED outcome this witness proves.
RISK_RED_LABEL="risk:red"

: "${GH_TOKEN:?GH_TOKEN required}"
: "${RUN_ID:?RUN_ID required}"
: "${HEAD_SHA:?HEAD_SHA required}"
: "${REPO:?REPO required}"
: "${DEFAULT_BRANCH:?DEFAULT_BRANCH required}"

# RUN_ID is a GitHub-assigned integer. Enforcing that keeps the fixed branch
# prefix and docs path from ever being steered to an arbitrary ref or path.
if [[ ! "$RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "ERROR: RUN_ID must be a positive integer." >&2
  exit 1
fi

BRANCH="autonomy-witness-red/${RUN_ID}"
DOC_DIR="doc/autonomy-witness-red"
DOC_PATH="${DOC_DIR}/${RUN_ID}.md"
OWNER="${REPO%%/*}"

# Commit identity for the docs commit. The PR *author* — the identity the
# autonomy allowlist and paperclip-checker actually evaluate — is instead set by
# GH_TOKEN (the App installation token) when `gh pr create` runs below.
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# Wire the App installation token (GH_TOKEN) into git's credential helper so the
# branch push authenticates as the App — NOT the ambient checkout credential
# (checkout ran with persist-credentials:false). This makes the SAME App identity
# push the branch and open the PR, so authorship/event provenance is coherent.
gh auth setup-git

# Re-run safe: if the run-id branch already exists on origin, continue FROM it so
# an unchanged re-run is a genuine no-op. Only ever the fixed run-id branch is
# fetched (a literal refspec, never an arbitrary ref). Otherwise start from the
# already-checked-out default branch.
if git ls-remote --exit-code --heads origin "refs/heads/${BRANCH}" >/dev/null 2>&1; then
  git fetch --no-tags --depth=1 origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
  git checkout -B "$BRANCH" "refs/remotes/origin/${BRANCH}"
else
  git checkout -B "$BRANCH"
fi

mkdir -p "$DOC_DIR"

# Deterministic content derived only from trusted run metadata, so an unchanged
# re-run reproduces byte-identical output.
{
  printf '# Autonomy witness (RED) — run %s\n\n' "$RUN_ID"
  printf 'Generated by the Autonomy Witness (RED) workflow to prove that a\n'
  printf 'RED-classified pull request opened by the allowlisted autonomous App\n'
  printf 'identity is correctly BLOCKED: the risk:red label forces the RED lane,\n'
  printf 'so both paperclip-checker contexts fail by policy and auto-merge is\n'
  printf 'never enabled. This is the genuine negative counterpart to the green\n'
  printf 'docs-only witness.\n\n'
  printf -- '- Run ID: %s\n' "$RUN_ID"
  printf -- '- Source commit: %s\n' "$HEAD_SHA"
  printf -- '- Branch: %s\n' "$BRANCH"
  printf -- '- Lane: RED (label %s)\n\n' "$RISK_RED_LABEL"
  printf 'Disposable witness output. Cleanup: close the associated PR and\n'
  printf 'delete branch %s; this file may then be removed.\n' "$BRANCH"
} > "$DOC_PATH"

git add "$DOC_PATH"

# Because we resumed from the existing branch tip (when present), an unchanged
# run leaves the index identical to HEAD → no new commit.
if git diff --cached --quiet; then
  echo "No changes to commit (idempotent re-run)."
else
  git commit -m "docs(autonomy-witness-red): witness run ${RUN_ID}"
fi

# Fast-forward push: the branch is either brand new or advanced from its own tip,
# so no force is needed — a divergent remote is surfaced rather than clobbered.
git push origin "$BRANCH"

# Re-run safe AND SIGPIPE-safe: select the first open PR for this branch that is
# owned by THIS repo (never a same-named fork branch) entirely inside jq. There
# is no `head`/early-terminating consumer, so `gh pr list` cannot take SIGPIPE
# under `set -o pipefail`.
resolve_pr_number() {
  gh pr list --repo "$REPO" --state open --head "$BRANCH" \
    --json number,headRepositoryOwner \
    --jq "[.[] | select(.headRepositoryOwner.login == \"${OWNER}\") | .number] | first // empty"
}

pr_number="$(resolve_pr_number)"

if [ -n "$pr_number" ]; then
  echo "Reusing existing witness PR #${pr_number}"
else
  gh pr create --repo "$REPO" --base "$DEFAULT_BRANCH" --head "$BRANCH" \
    --title "docs(autonomy-witness-red): witness run ${RUN_ID}" \
    --body "Permanent operational witness infrastructure — RED lane. This docs-only PR was opened by an allowlisted autonomous App identity, using an App installation token (NOT the built-in GITHUB_TOKEN) so the required PR workflows actually run on the exact head. It is then labelled ${RISK_RED_LABEL}, so the deterministic risk-lane classifier assigns RED and BOTH paperclip-checker contexts fail BY POLICY. It exists to prove the RED lane blocks correctly and NEVER auto-merges. It changes only doc/autonomy-witness-red/${RUN_ID}.md. Do NOT auto-merge, auto-approve, or remove the ${RISK_RED_LABEL} label. Cleanup: close this PR and delete branch ${BRANCH} after witnessing."
  pr_number="$(resolve_pr_number)"
  if [ -z "$pr_number" ]; then
    echo "ERROR: could not resolve the witness PR number after creation." >&2
    exit 1
  fi
fi

# Fail closed unless the PR is authored by the expected allowlisted App identity.
# A positive allowlist rejects not only the github-actions[bot] event-suppression
# signature (built-in GITHUB_TOKEN → suppressed pull_request workflows → no
# required checks) but also any misconfigured App or wrong installation. Applies
# whether the PR was freshly created or reused. This runs BEFORE the label is
# applied so a wrong-identity PR is never touched further.
author="$(gh pr view "$pr_number" --repo "$REPO" --json author --jq .author.login)"
if [ "$author" != "$EXPECTED_AUTHOR_GRAPHQL" ] && [ "$author" != "$EXPECTED_AUTHOR_REST" ]; then
  echo "ERROR: witness PR #${pr_number} is authored by '${author}', not the allowlisted App identity ('${EXPECTED_AUTHOR_GRAPHQL}' or '${EXPECTED_AUTHOR_REST}'). In particular github-actions[bot] is produced only by the built-in GITHUB_TOKEN, whose pull_request workflows are suppressed so the required checks never run. Open the witness with a minted solidus-paperclip-delivery App installation token instead." >&2
  exit 1
fi

# Apply the exact risk:red label so the deterministic classifier forces the RED
# lane. `gh pr edit --add-label` is idempotent — re-adding an already-present
# label is a harmless no-op — so a re-run leaves the single label in place. This
# is the ONLY mutation beyond the docs commit; the script still never merges,
# approves, enables auto-merge, or changes any repository setting.
gh pr edit "$pr_number" --repo "$REPO" --add-label "$RISK_RED_LABEL"

echo "Witness PR #${pr_number} authored by ${author} (App/bot identity); labelled ${RISK_RED_LABEL} → RED lane, both checker contexts fail by policy, auto-merge never enabled."
gh pr view "$pr_number" --repo "$REPO" --json url --jq .url
