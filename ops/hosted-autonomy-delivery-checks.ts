/** Native post-merge deployment checks, deliberately separate from merge CI. */
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import {
  deliveryCheckTransition,
  requiredDeliveryChecks,
} from "../src/repair/delivery-checks.ts";
import { progressStage } from "../src/host/progress-comments.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";
import type { DeliveryCheckV1 } from "../src/contracts/delivery-checks.ts";

type GateResult = {
  record: WorkRecordV1;
  stop: boolean;
  result: HostedAutonomyResultV1 | null;
};

export async function gateHostedDeliveryChecks(
  context: HostedAutonomyPassContextV1,
  record: WorkRecordV1,
  surface: HostedAutonomyGitHubV1 | null,
  persist: (next: WorkRecordV1) => Promise<HostedAutonomyResultV1>,
): Promise<GateResult> {
  const names = requiredDeliveryChecks(record.repository);
  if (names.length === 0) return { record, stop: false, result: null };
  const expired = () =>
    context.deadlineAt !== undefined &&
    context.deps.clock.now() >= context.deadlineAt;
  if (expired()) return { record, stop: true, result: null };
  let checks: readonly DeliveryCheckV1[] | null = null;
  try {
    if (record.target.head !== null) {
      checks = await surface?.readDeliveryChecks?.(record.target.head, names) ??
        null;
    }
  } catch { /* Unavailable is a bounded deployment wait, never delivery. */ }
  if (expired()) return { record, stop: true, result: null };
  const { record: next, outcome } = deliveryCheckTransition(
    record,
    checks,
    context.deps.clock.now(),
  );
  if (next === record) return { record, stop: false, result: null };
  context.actions.push(`delivery:${record.id}:checks_${outcome}`);
  const result = await persist(next);
  if (result.status !== "applied" || result.appliedHead === null) {
    return { record, stop: true, result };
  }
  // The persistence callback advances the context only after exact readback.
  if (
    outcome === "failed" && next.related.issueNumber !== null &&
    !expired()
  ) {
    const words = progressStage(next)?.words;
    try {
      if (words !== undefined) {
        await surface?.commentDeliveryProgress?.(
          next.related.issueNumber,
          words,
        );
      }
    } catch { /* Progress reporting never authorizes issue closure. */ }
  }
  return {
    record: next,
    stop: outcome !== "passed" || expired(),
    result,
  };
}
