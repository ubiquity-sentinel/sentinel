/** Repair coordinator owns every self-merge state write, not the Git/model worker. */
import type { SelfMergeExecutionV1 } from "../contracts/self-merge.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { persistWork } from "./loop-state.ts";

export function selfMergeExecution(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  initial: WorkRecordV1,
) {
  const holder: {
    record: WorkRecordV1;
    failure: StepResultV1 | null;
    execution: SelfMergeExecutionV1;
  } = {
    record: initial,
    failure: null,
    execution: {
      taskId: initial.id,
      issueNumber: initial.related.issueNumber,
      headRef: initial.intent?.branch ?? "",
      operationKey: initial.intent?.key ?? "",
      deadline: context.bounds.runDeadline,
      proof: initial.intent?.selfMerge ?? null,
      persist: async (proof) => {
        if (holder.record.intent?.kind !== "merge") {
          return portError("invalid", "self merge durable intent absent");
        }
        const next: WorkRecordV1 = {
          ...holder.record,
          intent: { ...holder.record.intent, selfMerge: proof },
          updatedAt: deps.clock.now(),
        };
        const result = await persistWork(deps, context, next);
        if (result.kind !== "progress") {
          holder.failure = result;
          return portError("unavailable", "self merge state CAS unavailable");
        }
        holder.record = context.snapshot.work.find((r) => r.id === next.id) ??
          next;
        return portOk(undefined);
      },
    },
  };
  return holder;
}
