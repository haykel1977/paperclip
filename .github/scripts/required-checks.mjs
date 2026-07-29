#!/usr/bin/env node
/**
 * required-checks.mjs
 * SINGLE SOURCE OF TRUTH for the required-check names used by the autonomy
 * stack. Before this module the same list was re-declared in five places
 * (branch-protection audit, automerge gate, risk-lane classifier, the
 * paperclip-checker policy default, and its committed config) and had already
 * drifted: three of them still named `gitleaks`, the *job id* of the scanning
 * job, while branch protection actually requires the `Secret Scan` context, and
 * none of them knew about the two paperclip-checker keys. A drifted name is
 * fail-OPEN in the worst way — a check nobody produces looks "missing" in one
 * place and "not required" in another.
 *
 * The live required set on `main` is exactly:
 *
 *   verify                     — aggregate of the PR workflow's lanes
 *   Secret Scan                — gitleaks gate context (workflow `Secret Scan`)
 *   paperclip-checker/app      — App key (App id 4372695, minted App token)
 *   paperclip-checker-runner   — runner key (github-actions app id 15368)
 *
 * `Build` and `Typecheck + Release Registry` are deliberately ADVISORY: the
 * `verify` job aggregates their results, so requiring them separately in branch
 * protection would double-count the same signal and add two more contexts that
 * can wedge a PR without adding information.
 */

/**
 * Every context branch protection on the default branch must require. Audited
 * (read-only) by check-branch-protection.mjs and asserted by the automerge gate
 * before it will enable native auto-merge.
 */
export const REQUIRED_STATUS_CHECKS = Object.freeze([
  'verify',
  'Secret Scan',
  'paperclip-checker/app',
  'paperclip-checker-runner',
]);

/**
 * The CI-produced subset used as risk-lane EVIDENCE.
 *
 * The two paperclip-checker keys are deliberately excluded: the checker
 * publishes them itself from its own risk-lane evaluation, so requiring them as
 * evidence *of* that evaluation is circular and deadlocks the gate. They are
 * enforced by branch protection (which GitHub evaluates independently of any
 * script), not by the classifier.
 */
export const CI_EVIDENCE_CHECKS = Object.freeze(['verify', 'Secret Scan']);

/**
 * The two-key paperclip-checker contexts. Enforced only via branch protection.
 */
export const CHECKER_KEY_CHECKS = Object.freeze(['paperclip-checker/app', 'paperclip-checker-runner']);

/**
 * Contexts that must NOT be required in branch protection because `verify`
 * already aggregates them. Named here so the audit can flag re-introduction.
 */
export const ADVISORY_CHECKS = Object.freeze(['Build', 'Typecheck + Release Registry']);

/** GitHub Actions' app id — producer of `verify` and `Secret Scan`. */
export const GITHUB_ACTIONS_APP_ID = 15368;
