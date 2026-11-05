/**
 * Planner refusal classification (#335): why one planner pass left ready
 * implementation records unplanned, as one closed reason plus the count.
 *
 * Pure and advisory: computed once at the end of `planMatrixWave` from facts
 * the planner already holds, carried on the plan diagnostic line and folded
 * into the cycle's throughput metrics record by finalize. It grants nothing
 * and changes no admission.
 */
import {
  PLANNER_REFUSAL_REASONS_V1,
  type PlannerRefusalReasonV1,
} from "../contracts/throughput-metrics.ts";

export interface MatrixPlanRefusalV1 {
  /** null when the pass refused nothing or the cause was not observed. */
  reason: PlannerRefusalReasonV1 | null;
  /** Records observed ready during this pass but left unplanned; null when never read. */
  readyUnplanned: number | null;
}

export interface MatrixPlanRefusalFactsV1 {
  prepared: number;
  /** Distinct implementation-start ids observed ready during the pass, or null. */
  readyIds: readonly string[] | null;
  /** Task ids that received a cell. */
  plannedTaskIds: ReadonlySet<string>;
  /** The loop stopped because no start fits the operation margin. */
  stoppedByDeadline: boolean;
  /** No further grant fits the configured/native cell capacity this wave. */
  cellLimitReached?: boolean;
  /** Model starts are disabled for this run (unreachable model cutoff). */
  modelStartsDisabled: boolean;
  /** Closed `planDeferredKey` histogram of this pass's deferrals. */
  deferredByReason: Readonly<Record<string, number>>;
  memoryRefused: number;
}

const MAX_READY_UNPLANNED = 1_000_000;

const anyOf = (counts: Readonly<Record<string, number>>, keys: string[]) =>
  keys.some((key) => (counts[key] ?? 0) > 0);

function reasonOf(
  facts: MatrixPlanRefusalFactsV1,
  readyUnplanned: number | null,
): PlannerRefusalReasonV1 | null {
  if (readyUnplanned === 0) {
    return facts.prepared === 0 ? "no_ready_records" : null;
  }
  if (facts.modelStartsDisabled) return "provider_unavailable";
  if (facts.stoppedByDeadline || anyOf(facts.deferredByReason, ["bounds"])) {
    return "deadline_margin";
  }
  if (
    facts.cellLimitReached === true || facts.memoryRefused > 0 ||
    anyOf(facts.deferredByReason, ["admission_capacity", "memory_refused"])
  ) return "reservation_denied";
  if (
    anyOf(facts.deferredByReason, [
      "cooldown",
      "admission",
      "progress",
      "blocked",
      "state_error",
      "artifact",
      "deferred",
      "other",
    ])
  ) {
    return "target_unavailable";
  }
  return null;
}

/** One closed reason for the pass (first match wins) and the unplanned count. */
export function classifyMatrixPlanRefusalV1(
  facts: MatrixPlanRefusalFactsV1,
): MatrixPlanRefusalV1 {
  const readyUnplanned = facts.readyIds === null
    ? null
    : facts.readyIds.filter((id) => !facts.plannedTaskIds.has(id)).length;
  return { reason: reasonOf(facts, readyUnplanned), readyUnplanned };
}

/** Strict re-parse of a carried refusal: closed reason, bounded count. */
export function parseMatrixPlanRefusalV1(
  reason: unknown,
  readyUnplanned: unknown,
): MatrixPlanRefusalV1 | null {
  if (
    reason !== null &&
    !PLANNER_REFUSAL_REASONS_V1.includes(reason as PlannerRefusalReasonV1)
  ) return null;
  if (
    readyUnplanned !== null &&
    !(typeof readyUnplanned === "number" &&
      Number.isSafeInteger(readyUnplanned) && readyUnplanned >= 0 &&
      readyUnplanned <= MAX_READY_UNPLANNED)
  ) return null;
  return {
    reason: reason as PlannerRefusalReasonV1 | null,
    readyUnplanned: readyUnplanned as number | null,
  };
}
