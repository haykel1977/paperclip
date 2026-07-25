#!/usr/bin/env bash
#
# Autonomy Witness (RED) — bounded, docs-only PR opener for the RED lane.
#
# Invoked only by .github/workflows/autonomy-witness-red.yml (manual dispatch).
# It is the deterministic-RED counterpart to autonomy-witness.sh: it opens a
# docs-only pull request authored by the SAME allowlisted autonomous App identity
# and then requests the exact `risk:red` label, so the deterministic risk-lane
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
# settings. New RED witness PRs are created as DRAFT first so they remain inert
# while identity/label/diff validations run. Only after all invariants pass will
# a valid draft be marked ready.
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
# -E (errtrace): the ERR trap must also fire for failures raised INSIDE shell
# functions — without it, a nested assertion failure after `gh pr create`
# would abort the run without ever invoking the cleanup trap.
# inherit_errexit: command substitutions must keep errexit — without it, a
# failed `gh pr list` inside `$(resolve_pr_number)` degrades to an empty
# result and the fail-closed lookup is silently defeated.
set -Eeuo pipefail
shopt -s inherit_errexit

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
created=0
pr_id_resolved=""
pr_is_draft_resolved=""
author=""

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

# Re-run safe AND SIGPIPE-safe: query ALL states for this branch, scope to PRs
# owned by THIS repo (never a same-named fork branch), fail closed if any
# matching PR is already terminal, and reuse only a single matching OPEN PR.
# There is no `head`/early-terminating consumer, so `gh pr list` cannot take
# SIGPIPE under `set -o pipefail`.
resolve_pr_number() {
  local matches_json terminal_count open_count

  # --limit 100 makes the lookup bound explicit (gh defaults to 30). Overflow
  # interleavings all resolve fail-closed anyway (terminal rows refuse, >1 open
  # refuses), but the bound should be intentional, not implicit.
  matches_json="$(gh pr list --repo "$REPO" --state all --head "$BRANCH" --limit 100 \
    --json number,state,headRepositoryOwner \
    --jq "[.[] | select(.headRepositoryOwner.login == \"${OWNER}\") | {number, state}]")"

  # Fail closed on a malformed lookup result: inherit_errexit already aborts on
  # a failed gh invocation, and this rejects a non-array/garbage payload so the
  # counts below can never be computed from junk.
  if ! jq -e 'type == "array"' <<<"$matches_json" >/dev/null 2>&1; then
    echo "ERROR: witness PR lookup returned a malformed payload; refusing to create or reuse." >&2
    return 1
  fi

  terminal_count="$(jq '[.[] | select(.state != "OPEN")] | length' <<<"$matches_json")"
  if ! [[ "$terminal_count" =~ ^[0-9]+$ ]]; then
    echo "ERROR: witness PR lookup produced a non-numeric terminal count ('${terminal_count}'); refusing to create or reuse." >&2
    return 1
  fi
  if [ "$terminal_count" -ne 0 ]; then
    echo "ERROR: found matching closed/terminal witness PR(s) for branch '${BRANCH}'; refusing to create or reuse." >&2
    jq -r '.[] | select(.state != "OPEN") | " - #\(.number) [\(.state)]"' <<<"$matches_json" >&2
    return 1
  fi

  open_count="$(jq '[.[] | select(.state == "OPEN")] | length' <<<"$matches_json")"
  if ! [[ "$open_count" =~ ^[0-9]+$ ]]; then
    echo "ERROR: witness PR lookup produced a non-numeric open count ('${open_count}'); refusing to create or reuse." >&2
    return 1
  fi
  if [ "$open_count" -gt 1 ]; then
    echo "ERROR: found ${open_count} matching open witness PRs for branch '${BRANCH}'; refusing to guess." >&2
    jq -r '.[] | select(.state == "OPEN") | " - #\(.number) [\(.state)]"' <<<"$matches_json" >&2
    return 1
  fi

  jq -r '[.[] | select(.state == "OPEN") | .number] | first // empty' <<<"$matches_json"
}

extract_created_pr_number() {
  local create_output="$1"
  local pr_number
  pr_number="$(printf '%s\n' "$create_output" | sed -n 's#^.*/pull/\([0-9][0-9]*\)$#\1#p' | tail -n 1)"
  if [[ "$pr_number" =~ ^[0-9]+$ ]]; then
    printf '%s' "$pr_number"
  fi
}

# After a failed `gh pr create`, look for the PR it may still have created
# server-side. Identification is by exact identity — this run's run-scoped
# branch, owned by this repo — and demands EXACTLY ONE open match; the caller
# then routes it through close_created_pr_if_revalidated, which independently
# revalidates base/head/owner/headRefOid before any close. Ambiguity → return 1.
recover_created_pr_after_failed_create() {
  local nums count candidate
  nums="$(gh pr list --repo "$REPO" --state open --head "$BRANCH" --limit 10 \
    --json number,headRepositoryOwner \
    --jq "[.[] | select(.headRepositoryOwner.login == \"${OWNER}\") | .number]" 2>/dev/null || printf '[]')"
  jq -e 'type == "array"' <<<"$nums" >/dev/null 2>&1 || return 1
  count="$(jq 'length' <<<"$nums" 2>/dev/null || printf 'x')"
  if [ "$count" = "0" ]; then
    return 1
  fi
  if [ "$count" != "1" ]; then
    # Truthful audit line: candidates WERE found; they are refused as
    # ambiguous, not reported as absent.
    echo "WARNING: found ${count} open PR(s) on ${BRANCH} after the failed create: $(jq -r 'map("#\(.)") | join(", ")' <<<"$nums" 2>/dev/null || true) — ambiguous — refusing recovery and leaving all of them untouched." >&2
    return 1
  fi
  candidate="$(jq -r '.[0]' <<<"$nums" 2>/dev/null || true)"
  [[ "$candidate" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$candidate"
}

load_pr_json() {
  local pr_core_json pr_files_json

  pr_core_json="$(gh pr view "$1" --repo "$REPO" \
    --json id,number,isDraft,baseRefName,headRefName,headRepositoryOwner,headRefOid,author,labels,url)"
  pr_files_json="$(gh api --paginate "/repos/${REPO}/pulls/$1/files?per_page=100" | jq -s 'add // []')"

  jq -cn --argjson pr "$pr_core_json" --argjson files "$pr_files_json" '$pr + { files: $files }'
}

close_created_pr_if_revalidated() {
  local expected_id="$1"
  local expected_head_oid="$2"
  local pr_json pr_id pr_base pr_head pr_head_owner pr_head_oid

  # Idempotence: with `set -E` the ERR trap is inherited by command-substitution
  # subshells, so one failure can fire this handler once per nesting level. An
  # atomic mkdir (a shell variable would not escape the subshell) makes every
  # fire after the first a no-op — one close attempt, one audit line.
  if [ -n "${cleanup_fired_sentinel:-}" ] && ! mkdir "$cleanup_fired_sentinel" 2>/dev/null; then
    return 0
  fi

  if [ "${created:-0}" != "1" ] || [ -z "${pr_number:-}" ]; then
    return 0
  fi

  pr_json="$(load_pr_json "$pr_number" 2>/dev/null || true)"
  # Runs inside the ERR-trap handler: a failed revalidation read must degrade
  # to "leave untouched", never abort the handler mid-way (which would skip
  # both the close AND the explanatory message).
  if [ -z "$pr_json" ] || ! jq -e 'type == "object"' <<<"$pr_json" >/dev/null 2>&1; then
    echo "ERROR: freshly created witness PR #${pr_number} failed verification, and revalidation was unavailable; leaving it untouched." >&2
    return 0
  fi
  pr_id="$(jq -r '.id // empty' <<<"$pr_json" 2>/dev/null || true)"
  pr_base="$(jq -r '.baseRefName // empty' <<<"$pr_json" 2>/dev/null || true)"
  pr_head="$(jq -r '.headRefName // empty' <<<"$pr_json" 2>/dev/null || true)"
  pr_head_owner="$(jq -r '.headRepositoryOwner.login // empty' <<<"$pr_json" 2>/dev/null || true)"
  pr_head_oid="$(jq -r '.headRefOid // empty' <<<"$pr_json" 2>/dev/null || true)"

  if [ -n "$expected_id" ] && [ "$pr_id" != "$expected_id" ]; then
    echo "ERROR: freshly created witness PR #${pr_number} revalidated to id '${pr_id}', expected '${expected_id}'; leaving it untouched." >&2
    return 0
  fi

  if [ "$pr_base" = "$DEFAULT_BRANCH" ] && [ "$pr_head" = "$BRANCH" ] && [ "$pr_head_owner" = "$OWNER" ] && [ "$pr_head_oid" = "$expected_head_oid" ]; then
    echo "Closing freshly created witness PR #${pr_number} after fail-closed verification." >&2
    gh pr close "$pr_number" --repo "$REPO" || true
    return 0
  fi

  echo "ERROR: freshly created witness PR #${pr_number} failed verification, but revalidation was insufficient for automatic close; leaving it untouched." >&2
}

assert_pr_core() {
  local pr_json="$1"
  local expected_id="${2:-}"
  local require_draft="${3:-either}"
  local expected_head_oid="${4:-}"
  local pr_id pr_base pr_head pr_head_owner pr_is_draft pr_head_oid

  pr_id="$(jq -r '.id // empty' <<<"$pr_json")"
  pr_base="$(jq -r '.baseRefName // empty' <<<"$pr_json")"
  pr_head="$(jq -r '.headRefName // empty' <<<"$pr_json")"
  pr_head_owner="$(jq -r '.headRepositoryOwner.login // empty' <<<"$pr_json")"
  pr_head_oid="$(jq -r '.headRefOid // empty' <<<"$pr_json")"
  pr_is_draft="$(jq -r '.isDraft // false' <<<"$pr_json")"

  if [ -n "$expected_id" ] && [ "$pr_id" != "$expected_id" ]; then
    echo "ERROR: witness PR #${pr_number} has id '${pr_id}', expected '${expected_id}'." >&2
    return 1
  fi
  if [ -z "$pr_id" ]; then
    echo "ERROR: witness PR #${pr_number} did not expose a stable id." >&2
    return 1
  fi
  pr_id_resolved="$pr_id"
  if [ "$pr_base" != "$DEFAULT_BRANCH" ]; then
    echo "ERROR: witness PR #${pr_number} targets base '${pr_base}', expected '${DEFAULT_BRANCH}'." >&2
    return 1
  fi
  if [ "$pr_head" != "$BRANCH" ]; then
    echo "ERROR: witness PR #${pr_number} targets head '${pr_head}', expected '${BRANCH}'." >&2
    return 1
  fi
  if [ "$pr_head_owner" != "$OWNER" ]; then
    echo "ERROR: witness PR #${pr_number} is owned by '${pr_head_owner}', expected '${OWNER}'." >&2
    return 1
  fi
  if [ -n "$expected_head_oid" ] && [ "$pr_head_oid" != "$expected_head_oid" ]; then
    echo "ERROR: witness PR #${pr_number} points at head '${pr_head_oid}', expected '${expected_head_oid}'." >&2
    return 1
  fi
  if [ "$require_draft" = "yes" ] && [ "$pr_is_draft" != "true" ]; then
    echo "ERROR: witness PR #${pr_number} must still be draft while validations run." >&2
    return 1
  fi
  if [ "$require_draft" = "no" ] && [ "$pr_is_draft" != "false" ]; then
    echo "ERROR: witness PR #${pr_number} should already be ready." >&2
    return 1
  fi

  pr_is_draft_resolved="$pr_is_draft"
  return 0
}

assert_pr_shape() {
  local pr_json="$1"
  local expected_id="${2:-}"
  local require_draft="${3:-either}"
  local expected_head_oid="${4:-}"
  local pr_author files_count file_path file_previous_filename file_status

  # `|| return 1` is belt-and-braces with `set -E`: a nested failure must
  # surface as this function's failure so the caller's ERR trap can fire.
  assert_pr_core "$pr_json" "$expected_id" "$require_draft" "$expected_head_oid" || return 1

  pr_author="$(jq -r '.author.login // empty' <<<"$pr_json")"
  files_count="$(jq -r '(.files // []) | length' <<<"$pr_json")"
  file_path="$(jq -r '.files[0].filename // empty' <<<"$pr_json")"
  file_previous_filename="$(jq -r '.files[0].previous_filename // empty' <<<"$pr_json")"
  file_status="$(jq -r '.files[0].status // empty' <<<"$pr_json")"

  if [ "$pr_author" != "$EXPECTED_AUTHOR_GRAPHQL" ] && [ "$pr_author" != "$EXPECTED_AUTHOR_REST" ]; then
    echo "ERROR: witness PR #${pr_number} is authored by '${pr_author}', not the allowlisted App identity ('${EXPECTED_AUTHOR_GRAPHQL}' or '${EXPECTED_AUTHOR_REST}'). In particular github-actions[bot] is produced only by the built-in GITHUB_TOKEN, whose pull_request workflows are suppressed so the required checks never run. Open the witness with a minted solidus-paperclip-delivery App installation token instead." >&2
    return 1
  fi
  if [ "$files_count" -ne 1 ]; then
    echo "ERROR: witness PR #${pr_number} changes ${files_count} files; expected exactly 1 (${DOC_PATH})." >&2
    return 1
  fi
  if [ "$file_path" != "$DOC_PATH" ]; then
    echo "ERROR: witness PR #${pr_number} changes '${file_path}', expected '${DOC_PATH}'." >&2
    return 1
  fi
  if [ -n "$file_previous_filename" ]; then
    echo "ERROR: witness PR #${pr_number} includes rename source '${file_previous_filename}', so it is not a pure witness doc change." >&2
    return 1
  fi
  # Belt-and-braces with the previous_filename check: REST reports renames and
  # copies via `status` too, and a rename of a sacred file INTO the doc path
  # would surface as one file whose filename matches DOC_PATH exactly.
  if [ "$file_status" = "renamed" ] || [ "$file_status" = "copied" ]; then
    echo "ERROR: witness PR #${pr_number} file has status '${file_status}', so it is not a pure witness doc change." >&2
    return 1
  fi
  # Structural label equality (jq), not line matching: a crafted label name
  # embedding a newline around 'risk:red' must NOT satisfy this check.
  if ! jq -e --arg l "$RISK_RED_LABEL" 'any(.labels[]?; .name == $l)' <<<"$pr_json" >/dev/null; then
    echo "ERROR: witness PR #${pr_number} does not carry the required ${RISK_RED_LABEL} label; refusing to report success." >&2
    return 1
  fi

  author="$pr_author"
  return 0
}

mark_ready_if_still_draft() {
  if [ "$pr_is_draft_resolved" = "true" ]; then
    gh pr ready "$pr_number" --repo "$REPO"
    pr_json="$(load_pr_json "$pr_number")"
    assert_pr_shape "$pr_json" "$pr_id_resolved" "no" "$expected_head_oid"
  fi
}

pr_number="$(resolve_pr_number)"

if [ -n "$pr_number" ]; then
  # Reuse path: validate the complete witness shape BEFORE writing docs,
  # committing, or pushing. Invalid reuse leaves the branch and PR untouched.
  echo "Reusing existing witness PR #${pr_number}"
  pr_json="$(load_pr_json "$pr_number")"
  assert_pr_shape "$pr_json" "" "either" ""
  expected_head_oid="$(jq -r '.headRefOid // empty' <<<"$pr_json")"
  reused_head_sha="$expected_head_oid"
else
  reused_head_sha=""
fi

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

if [ -n "$reused_head_sha" ]; then
  current_head_sha="$(git rev-parse HEAD)"
  if [ "$current_head_sha" != "$reused_head_sha" ]; then
    echo "ERROR: reused witness PR #${pr_number} points at '${reused_head_sha}', but branch '${BRANCH}' currently resolves to '${current_head_sha}' before any mutation." >&2
    exit 1
  fi
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

expected_head_oid="$(git rev-parse HEAD)"

# Fast-forward push: the branch is either brand new or advanced from its own tip,
# so no force is needed — a divergent remote is surfaced rather than clobbered.
git push origin "$BRANCH"

if [ -n "$pr_number" ]; then
  pr_json="$(load_pr_json "$pr_number")"
  assert_pr_shape "$pr_json" "" "either" "$expected_head_oid"
  mark_ready_if_still_draft
else
  # Create path: always create as a DRAFT first. On a non-zero create result we
  # close nothing and infer nothing — any partial draft remains inert.
  create_output=""
  create_status=0
  created_pr_number=""
  set +e
  create_output="$(gh pr create --repo "$REPO" --draft --base "$DEFAULT_BRANCH" --head "$BRANCH" \
    --title "docs(autonomy-witness-red): witness run ${RUN_ID}" \
    --body "Permanent operational witness infrastructure — RED lane. This docs-only PR was opened by an allowlisted autonomous App identity, using an App installation token (NOT the built-in GITHUB_TOKEN) so the required PR workflows actually run on the exact head. It is created as a draft first, then validated for exact author/base/head/doc-path/rename/label invariants before ever being marked ready. It changes only doc/autonomy-witness-red/${RUN_ID}.md. Do NOT auto-merge, auto-approve, or change repository settings. Cleanup: close this PR and delete branch ${BRANCH} after witnessing." 2>&1)"
  create_status=$?
  set -e
  if [ "$create_status" -ne 0 ]; then
    if [ -n "$create_output" ]; then
      printf '%s\n' "$create_output" >&2
    fi
    # A client-side create failure (e.g. network timeout) may still have
    # created the PR server-side, which would otherwise orphan a draft.
    # Recovery identifies by TUPLE, not creator provenance: a SINGLE open PR
    # on this run-scoped branch whose base/head/owner/headRefOid revalidate
    # against what THIS run just pushed is treated as this run's artifact.
    # (A racing third-party PR at the exact same tuple would be closed too —
    # accepted: seconds-wide window, disposable run-scoped branch,
    # content-identical diff, reversible and audit-logged close.)
    # Zero or multiple candidates → never guess, leave everything untouched.
    recovered_pr="$(recover_created_pr_after_failed_create || true)"
    if [[ "$recovered_pr" =~ ^[0-9]+$ ]]; then
      echo "ERROR: gh pr create exited ${create_status}, but PR #${recovered_pr} exists server-side on ${BRANCH}; running fail-closed cleanup against this run's exact head." >&2
      pr_number="$recovered_pr"
      created=1
      # Guarded: an mktemp failure must degrade to no-sentinel (the handler
      # then merely lacks idempotence) rather than abort before the cleanup.
      if sentinel_dir="$(mktemp -d -t awr-cleanup-XXXXXX 2>/dev/null)"; then
        cleanup_fired_sentinel="${sentinel_dir}/fired"
      else
        cleanup_fired_sentinel=""
      fi
      close_created_pr_if_revalidated "" "$expected_head_oid"
      exit "$create_status"
    fi
    echo "ERROR: gh pr create exited ${create_status}; no unambiguous server-side PR for this run's branch was identified — leaving any partial draft untouched and refusing further mutation." >&2
    exit "$create_status"
  fi

  created_pr_number="$(extract_created_pr_number "$create_output")"
  if [ -z "$created_pr_number" ]; then
    echo "ERROR: successful gh pr create did not return a trustworthy PR identifier; leaving the draft untouched." >&2
    exit 1
  fi

  pr_number="$created_pr_number"
  created=1
  pr_id_resolved=""
  # A fresh private directory guarantees the sentinel path does not exist yet;
  # the handler's first fire claims it with an atomic mkdir. Guarded: an mktemp
  # failure degrades to no-sentinel (the handler merely loses idempotence)
  # instead of aborting between create and trap arming — which would orphan.
  if sentinel_dir="$(mktemp -d -t awr-cleanup-XXXXXX 2>/dev/null)"; then
    cleanup_fired_sentinel="${sentinel_dir}/fired"
  else
    cleanup_fired_sentinel=""
  fi
  trap 'close_created_pr_if_revalidated "${pr_id_resolved:-}" "$expected_head_oid"' ERR
  pr_json="$(load_pr_json "$pr_number")"
  assert_pr_core "$pr_json" "" "yes" "$expected_head_oid"
  gh pr edit "$pr_number" --repo "$REPO" --add-label "$RISK_RED_LABEL"
  pr_json="$(load_pr_json "$pr_number")"
  assert_pr_shape "$pr_json" "$pr_id_resolved" "yes" "$expected_head_oid"
  # Intentional asymmetry from here on: the trap is disarmed BEFORE the ready
  # transition. The PR passed the full invariant set as a draft immediately
  # above; a post-ready revalidation failure therefore leaves the (labelled,
  # RED-laned, never auto-merged) PR open for operator inspection rather than
  # destroying a possibly-valid witness on a transient re-read.
  trap - ERR
  rm -f "${cleanup_fired_sentinel:-}" || true
  mark_ready_if_still_draft
fi

echo "Witness PR #${pr_number} authored by ${author} (App/bot identity); labelled ${RISK_RED_LABEL} → RED lane, both checker contexts fail by policy, auto-merge never enabled."
gh pr view "$pr_number" --repo "$REPO" --json url --jq .url
