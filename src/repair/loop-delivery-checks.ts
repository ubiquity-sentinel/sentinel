/** Post-merge closure gate; ordinary current-head CI keeps its existing gates. */
import type { DeliveryCheckV1 } from "../contracts/delivery-checks.ts";
import {
  deliveryCheckTransition,
  requiredDeliveryChecks,
} from "./delivery-checks.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

export async function gateRequiredDeliveryChecks(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  const names = requiredDeliveryChecks(record.repository);
  if (names.length === 0) return null;
  let checks: DeliveryCheckV1[] | null = null;
  if (record.target.head !== null) {
    const read = await deps.github.readChecks(
      record.target.head,
      new Set(names),
    );
    if (read.ok && read.value.head === record.target.head) {
      checks = read.value.checks.filter((check) =>
        check.runId !== undefined && check.backup === undefined
      ).map((check) => ({ ...check, runId: check.runId! }));
    }
  }
  const { record: next } = deliveryCheckTransition(
    record,
    checks,
    deps.clock.now(),
  );
  // Save the receipt BEFORE the external close. The next turn re-reads checks;
  // only an unchanged successful receipt can proceed without another write.
  return next === record ? null : persistWork(deps, context, next);
}
