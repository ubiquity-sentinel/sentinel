/**
 * The one gate for persisting a wait's concrete cause (#335). A writer that
 * knows why it waits passes the cause here; it lands on the record only when
 * the trusted host enabled `recordWaitCauses`.
 */
import type { WorkWaitV1 } from "../contracts/work-record.ts";
import type { WorkWaitCauseV1 } from "../contracts/work-wait-cause.ts";

/**
 * The production hosted hosts enable wait causes. Installed rollback-target
 * rule: a new revision installs with a model-disabled bootstrap health pass
 * that writes no record (#336), and automatic rollback happens only when that
 * bootstrap fails. A runtime that cannot parse `cause` therefore never reads a
 * state this revision wrote. The same rule covers the `deployment` wait,
 * attempt `inputs`, `targetCapabilities` and `repair-archive/` additions.
 */
export const HOSTED_RECORD_WAIT_CAUSES = true;

export function causedWait(
  deps: { recordWaitCauses?: boolean },
  wait: WorkWaitV1,
  cause: WorkWaitCauseV1 | undefined,
): WorkWaitV1 {
  return deps.recordWaitCauses === true && cause !== undefined
    ? { ...wait, cause }
    : wait;
}
