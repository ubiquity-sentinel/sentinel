/**
 * The one gate for persisting a wait's concrete cause (#335). A writer that
 * knows why it waits passes the cause here; it lands on the record only when
 * the trusted host enabled `recordWaitCauses`, so a rollback target whose
 * strict parser predates the optional key never reads a state it refuses.
 */
import type { WorkWaitV1 } from "../contracts/work-record.ts";
import type { WorkWaitCauseV1 } from "../contracts/work-wait-cause.ts";

export function causedWait(
  deps: { recordWaitCauses?: boolean },
  wait: WorkWaitV1,
  cause: WorkWaitCauseV1 | undefined,
): WorkWaitV1 {
  return deps.recordWaitCauses === true && cause !== undefined
    ? { ...wait, cause }
    : wait;
}
