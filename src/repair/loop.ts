/**
 * m04-repair: the bounded repair polling loop.
 *
 * Deterministic trusted code owns every id, digest, branch identity, attempt,
 * state intent, schedule and state write. The loop never sleeps and never
 * busy-waits: each run loads the authoritative repair snapshot, reconciles
 * saved operation intents against exact remote objects, polls unresolved
 * incidents, selects the next eligible action by the frozen priority order,
 * executes exactly one bounded step, persists a checkpoint (sequence + 1) and
 * repeats until no eligible work remains or the next declared operation cannot
 * fit the remaining run margin. All ports are injected; the loop has no
 * transport, no storage alternative and no inference policy of its own.
 */

export {
  createRunBounds,
  OPERATION_MARGIN_MS,
  REPAIR_MODEL_CUTOFF_MS,
  REPAIR_RUN_CEILING_MS,
} from "./loop-bounds.ts";
export type {
  LoopContextV1,
  PostDrainReviewContinuationV1,
  PreparedImplementationV1,
  RepairCycleDepsV1,
  RepairCycleOptionsV1,
  RepairCycleOutcomeV1,
  ReplayFixtureIdentitySourceV1,
  RunBoundsV1,
  StepResultV1,
} from "./loop-types.ts";
export {
  isMatrixImplementationReadyV1,
  isStaleImplementationIntent,
  STALE_IMPLEMENTATION_INTENT_TTL_MS,
} from "./loop-eligibility.ts";
export { prepareMatrixIntakeV1 } from "./loop-intake.ts";
export { runRepairCycle } from "./loop-cycle.ts";
export { loadRepairContext } from "./loop-state.ts";
export {
  MAX_CORRECTION_FINDING_CHARS,
  MAX_CORRECTION_FINDINGS,
  MAX_CORRECTION_HISTORY_RECEIPTS,
} from "./loop-review-records.ts";
export { prepareImplementationStart } from "./loop-implementation.ts";
export {
  handleModelReceipt,
  settleFailedImplementation,
} from "./loop-implementation-result.ts";
export { decideCiGate, gateDeliveryOnChecks } from "./loop-checks.ts";
