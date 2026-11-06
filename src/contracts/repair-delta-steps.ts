/**
 * The step summary a repository cell's delta carries (#328 widening, owner
 * decision 2026-11-05): one entry per step the cell's loop selected, in step
 * order, naming the record, the step kind it was selected as, whether the
 * cell kept the step's transition or handed the record back to the trusted
 * serial path, and the step's elapsed time on the cell's clock.
 *
 * Advisory measurement only: finalize aggregates it into bounded counts by
 * step kind on the `sentinel_repair_fanout` line, so the next widening can
 * see which kinds cells keep, which they hand back and what they cost. It
 * grants nothing and no transition is accepted or refused because of it.
 */
import type { WorkRecordV1 } from "./work-record.ts";
import {
  expectArray,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectPattern,
  expectRecord,
  fail,
} from "./validation.ts";

/** Steps one delta summarizes at most (later steps are not listed). */
export const MAX_REPAIR_DELTA_STEPS = 1_024;
/** A day bounds every step duration. */
export const MAX_REPAIR_DELTA_STEP_MS = 86_400_000;

export const REPAIR_STEP_NEXT_STEPS = [
  "work",
  "review",
  "delivery",
  "blocked",
  "done",
] as const;
export const REPAIR_STEP_WAITS = [
  "none",
  "budget_cap",
  "review_pending",
  "review_quota",
  "ci_pending",
  "ledger_capacity",
  "deployment",
  "backoff",
  "unavailable",
  "manual",
] as const;
export const REPAIR_STEP_DISPOSITIONS = ["kept", "deferred"] as const;
export type RepairStepDispositionV1 = typeof REPAIR_STEP_DISPOSITIONS[number];

/** Every step kind: `<nextStep>:<wait reason or none>` (50 in all). */
export const REPAIR_STEP_KINDS: readonly string[] = REPAIR_STEP_NEXT_STEPS
  .flatMap((step) => REPAIR_STEP_WAITS.map((wait) => `${step}:${wait}`));

export interface RepairDeltaStepV1 {
  record: string;
  /** `repairStepKindV1` of the record as the step selected it. */
  kind: string;
  disposition: RepairStepDispositionV1;
  elapsedMs: number;
}

/** The step kind of a record as its step selects it. */
export function repairStepKindV1(
  record: Pick<WorkRecordV1, "nextStep" | "wait">,
): string {
  return `${record.nextStep}:${record.wait?.reason ?? "none"}`;
}

const STEP_KEYS = ["record", "kind", "disposition", "elapsedMs"] as const;
const RECORD_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export function parseRepairDeltaStepsV1(
  input: unknown,
  path: string,
): RepairDeltaStepV1[] {
  return expectArray(input, path, MAX_REPAIR_DELTA_STEPS, (item, at) => {
    const row = expectRecord(item, at);
    expectExactKeys(row, STEP_KEYS, at);
    const elapsedMs = expectCount(row.elapsedMs, `${at}.elapsedMs`);
    if (elapsedMs > MAX_REPAIR_DELTA_STEP_MS) {
      fail(`${at}.elapsedMs`, "bound_exceeded", "step duration too long");
    }
    return {
      record: expectPattern(
        row.record,
        `${at}.record`,
        RECORD_ID,
        "invalid_pattern",
        "expected work item id",
        256,
      ),
      kind: expectEnum(row.kind, REPAIR_STEP_KINDS, `${at}.kind`),
      disposition: expectEnum(
        row.disposition,
        REPAIR_STEP_DISPOSITIONS,
        `${at}.disposition`,
      ),
      elapsedMs,
    };
  });
}
