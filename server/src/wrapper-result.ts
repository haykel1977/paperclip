/**
 * A `result=` line that claims a pull request is open is only truthful when
 * `scripts/agent-pr-create.sh` posted it: the wrapper appends its own signature to the comment
 * it writes on the ticket.
 *
 * Observed failure (QUA-1345, 2026-09-07): after the wrapper refused the delivery twice on
 * CF-028, the agent judged the validation "overly strict", pushed seven more commits that dropped
 * the rows the ticket required, and typed three `[result=created pr_url=…]` lines by hand. The
 * board read the ticket as delivered while the pull request body still described an older head.
 *
 * `result=blocked` stays hand-writable on purpose: the agent instructions require the agent itself
 * to post it when a guard is not the agent's to fix.
 */
export const WRAPPER_RESULT_SIGNATURE = "(posted by scripts/agent-pr-create.sh)";

/** `result=created`, `result=updated`, `result=exists` — the dispositions only the wrapper may claim. */
const CLAIMS_OPEN_PR = /(^|[^A-Za-z0-9_])result=(created|updated|exists)(?![A-Za-z0-9_])/i;

/**
 * True when `body` claims an open pull request without carrying the wrapper's signature.
 * Empty or absent bodies, and `result=blocked`, are never fabricated.
 */
export function isFabricatedWrapperResult(body: unknown): boolean {
  if (typeof body !== "string" || body.length === 0) return false;
  if (!CLAIMS_OPEN_PR.test(body)) return false;
  return !body.includes(WRAPPER_RESULT_SIGNATURE);
}
