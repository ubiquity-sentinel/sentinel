/** Repair loop internals: implementation result. */
import type {
  AttemptFailureClassV1,
  AttemptStageV1,
} from "../contracts/attempt-memory.ts";
import type { ModelRunReceiptV1 } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import { generatedArtifactOnly } from "../github/review-snapshot.ts";
import {
  ATTEMPT_DETAIL_INCOMPLETE,
  ATTEMPT_DETAIL_LOOP_STOP,
  ATTEMPT_DETAIL_PROVIDER_THROTTLED,
  ATTEMPT_DETAIL_UNCERTAIN,
  attemptMemorySettlementMutationV1,
  attemptMemorySuccessMutationV1,
} from "./attempt-policy.ts";
import { conflictResolutionInFlight } from "./conflict-resolution.ts";
import { isProviderThrottledReceiptV1 } from "./model-port-retry.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "./keys.ts";
import { persistAfterSettlement, settleAndBlock } from "./loop-accounting.ts";
import { MATRIX_PREDECESSOR_DEFERRED } from "./loop-bounds.ts";
import { handleConflictResolutionReceipt } from "./loop-conflict-resolution.ts";
import { verifiedPublishedHead } from "./loop-preservation.ts";
import { touchesProtected } from "./loop-records.ts";
import {
  loadSnapshot,
  persistTransition,
  replaceWorkMutation,
} from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  clearIntent,
  markBlocked,
  noteCandidate,
  setCandidateState,
  setIntent,
} from "./transitions.ts";

/**
 * Trusted terminal handling for a start that produced no usable receipt: the
 * reservation settles ambiguous (charged, never refunded from absence) and the
 * record is blocked with the exact static detail. Shared by the serial step
 * and the matrix ingester so both consumers are byte-identical.
 */
export async function settleFailedImplementation(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  reservationId: string,
  detail: string,
  classification?: {
    stage: AttemptStageV1;
    failureClass: AttemptFailureClassV1;
  },
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const blocked = await settleAndBlock(
    deps,
    reservationId,
    "ambiguous",
    record,
    detail,
    now,
  );
  if (blocked.kind === "state_error") return blocked;
  // The attempt-memory entry is persisted in the SAME state commit as the
  // blocker it describes (atomic memory + outcome, never a torn pair).
  const memory = await attemptMemorySettlementMutationV1({
    record,
    detail,
    now,
    runtimeSha: deps.controllerSha,
    ...(classification === undefined ? {} : { classification }),
  });
  return persistAfterSettlement(deps, context.bounds, (draft) => {
    replaceWorkMutation(blocked)(draft);
    memory(draft);
  });
}

/**
 * The configured session duration bound ended the run (an interrupted runtime
 * terminal or the host's own timeout at the bound), as opposed to an output
 * bound, a loop stop or an early failure.
 */
export function sessionBoundExhausted(
  receipt: ModelRunReceiptV1,
  config: RepositoryConfigV1,
): boolean {
  const bound = config.sessionBound;
  if (bound === null || receipt.error === ATTEMPT_DETAIL_LOOP_STOP) {
    return false;
  }
  if (
    receipt.outcome !== "interrupted" &&
    receipt.actual.terminalOrigin !== "host-timeout"
  ) return false;
  return receipt.actual.outputChars <= bound.maxOutputChars &&
    receipt.actual.durationMs >= bound.maxDurationMs;
}

/** One more consecutive time-bound exhaustion (see recordMatrixTimeout). */
function countSessionTimeout(record: WorkRecordV1, now: number): WorkRecordV1 {
  return {
    ...record,
    counters: {
      ...record.counters,
      timeouts: (record.counters.timeouts ?? 0) + 1,
    },
    updatedAt: now,
  };
}

export async function handleModelReceipt(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  reservationId: string,
  receipt: ModelRunReceiptV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const candidate = receipt.candidate;
  // A conflict resolution's change set is read against the merged base, and
  // its merge must be a new commit over the published candidate.
  const conflictBase = conflictResolutionInFlight(record.intent);
  const completed = receipt.outcome === "completed" && candidate !== null &&
    candidate.head !== null && candidate.head !== record.target.base &&
    (conflictBase === null || candidate.head !== record.target.head) &&
    candidate.changedPaths.length > 0 &&
    // A nonempty diff is not a repair: a candidate whose ENTIRE change set is
    // obvious generated/cache output (build products, logs, caches, OS junk)
    // can never establish task completion — however clean a downstream
    // code-quality review is — so it is refused here, before publication.
    !generatedArtifactOnly(candidate.changedPaths);
  if (!completed) {
    // A raw (serial) receipt the gateway throttled settles exactly like the
    // matrix cell's throttled refusal: transient, never no-progress. An
    // exported matrix receipt is sanitized and can never match here.
    if (isProviderThrottledReceiptV1(receipt)) {
      return settleFailedImplementation(
        deps,
        context,
        record,
        reservationId,
        ATTEMPT_DETAIL_PROVIDER_THROTTLED,
      );
    }
    // Only OUR sanitized loop-stop marker gets the exact failed_command_loop
    // blocker message; every other incomplete receipt keeps the generic
    // message. The settlement write moved the authoritative head, so the
    // block is persisted against the reloaded state (never a stale CAS).
    const loopStopped = receipt.error === ATTEMPT_DETAIL_LOOP_STOP;
    const artifactOnly = receipt.outcome === "completed" &&
      candidate !== null &&
      candidate.changedPaths.length > 0 &&
      generatedArtifactOnly(candidate.changedPaths);
    let incompleteMessage: string = ATTEMPT_DETAIL_INCOMPLETE;
    if (loopStopped) incompleteMessage = ATTEMPT_DETAIL_LOOP_STOP;
    if (artifactOnly) {
      incompleteMessage =
        "model candidate changed only generated/cache artifacts";
    }
    const settled = await settleAndBlock(
      deps,
      reservationId,
      "ambiguous",
      record,
      incompleteMessage,
      now,
    );
    if (settled.kind === "state_error") return settled;
    // A session the configured duration bound cut off proves the whole task
    // does not fit one session: it counts toward decomposition exactly like a
    // matrix host timeout, so the planner splits it instead of replaying it.
    const blocked = sessionBoundExhausted(receipt, config)
      ? countSessionTimeout(settled, now)
      : settled;
    const memory = await attemptMemorySettlementMutationV1({
      record,
      detail: incompleteMessage,
      now,
      runtimeSha: deps.controllerSha,
    });
    return persistAfterSettlement(deps, context.bounds, (draft) => {
      replaceWorkMutation(blocked)(draft);
      memory(draft);
    });
  }
  const head = candidate!.head!;
  if (conflictBase !== null) {
    return handleConflictResolutionReceipt(
      deps,
      context,
      record,
      reservationId,
      { head, changedPaths: candidate!.changedPaths },
      config,
    );
  }
  const protectedHit = candidate!.changedPaths.some((path) =>
    touchesProtected(config.protectedPaths, path)
  );
  // The verified prior published head: retained from existing V1 candidate
  // state, or proved by an ACTUAL owned-branch observation of the exact prior
  // target head for a legacy record. Model output never establishes it. It is
  // observed before anything is consumed.
  const priorPublished = await verifiedPublishedHead(deps, context, record);
  // A hosted (matrix) ingest never consumes a legacy record's receipt on an
  // unavailable observation. Hosted admission DOES start legacy records that
  // carry a head (a review or CI correction), and noting the candidate in the
  // legacy shape clears the implementation intent with no preservation intent:
  // no later consumer scan would select the artifact again, and a fresh
  // runner's mirror can never restore the candidate (legacy restoration
  // accepts only the task-branch head). The reservation stays reserved and the
  // intent bound, so the consumer re-ingests the same artifact later.
  if (
    priorPublished.kind === "unavailable" &&
    deps.externalImplementations === true
  ) return MATRIX_PREDECESSOR_DEFERRED;
  // A verified bad candidate stays charged (submitted) but never publishes.
  const settled = await deps.budget.settleModelStart({
    id: reservationId,
    outcome: "submitted",
    proofRef: null,
  });
  if (settled.status !== "settled" && settled.status !== "idempotent") {
    return { kind: "state_error", detail: "budget settlement failed" };
  }
  // The settlement write advanced the state; the exact new head must be
  // observed before the candidate transition is persisted (never a stale CAS).
  const afterSettlement = await loadSnapshot(deps, context.bounds);
  if (afterSettlement === null) {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  const operationKey = implementationIntentKey(reservationId);
  const preservationRef = await candidatePreservationRef(
    record.repository,
    record.id,
    operationKey,
  );
  const preservationIntent: IncompleteOperationV1 = {
    kind: "candidate_preservation",
    key: operationKey,
    startedAt: now,
    branch: preservationRef,
    expectedHead: head,
    observedBase: record.target.base,
    pr: null,
    requestId: reservationId,
    resultId: null,
  };
  // A completed run closes the implementation operation and opens the durable
  // candidate lifecycle: head/checkpoint plus candidateState with no
  // descriptor yet and the verified published head unchanged. The intent is
  // cleared only after the candidate is durably noted (never on uncertain
  // outcomes, where it remains as the manual-disposition record).
  const noted = noteCandidate(clearIntent(record, now), {
    head,
    checkpoint: candidate!.checkpointSha === null
      ? null
      : { branch: candidateBranch(record.id), sha: candidate!.checkpointSha },
  }, now);
  // An in-process (serial) legacy record whose predecessor observation was
  // unavailable keeps its legacy shape: an unverified observation is never
  // stored as a verified absent head, which would terminally refuse the
  // legitimate predecessor ref once reads recover. Its publication re-observes
  // the branch through the legacy path from the same local checkout, and its
  // next candidate retries the observation.
  const withCandidate = priorPublished.kind === "unavailable"
    ? noted
    : setCandidateState(noted, {
      preserved: null,
      publishedHead: priorPublished.head,
    }, now);
  if (protectedHit) {
    const blocked = markBlocked(
      withCandidate,
      "other",
      "candidate touches a protected path",
      now,
    );
    const r1 = await persistTransition(
      deps,
      afterSettlement,
      replaceWorkMutation(blocked),
    );
    return r1;
  }
  // An accepted candidate resolves the implementation attempt: record the
  // family success in the SAME state commit as the candidate transition, so
  // durable memory grows the full picture (failures and resolutions), not
  // only the refusal side.
  const successMemory = await attemptMemorySuccessMutationV1({
    record,
    now,
    runtimeSha: deps.controllerSha,
  });
  return persistTransition(deps, afterSettlement, (draft) => {
    replaceWorkMutation(
      withCandidate.target.candidateState === undefined
        ? withCandidate
        : setIntent(withCandidate, preservationIntent, now),
    )(draft);
    successMemory(draft);
  });
}

/** Saved implementation uncertainty: charged ambiguous, blocked, never rerun. */
export async function handleImplementationUncertainty(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const reservationId = record.intent?.requestId;
  if (
    reservationId !== null && reservationId !== undefined &&
    reservationId !== ""
  ) {
    const settled = await deps.budget.settleModelStart({
      id: reservationId,
      outcome: "ambiguous",
      proofRef: null,
    });
    if (settled.status !== "settled" && settled.status !== "idempotent") {
      return { kind: "state_error", detail: "budget settlement failed" };
    }
  }
  // The ambiguous settlement above writes the SAME authoritative repair state,
  // so the block is applied against the reread head exactly like the adjacent
  // settled-budget paths (a pre-settlement CAS is refused as state_error).
  const now = deps.clock.now();
  const blocked = markBlocked(record, "other", ATTEMPT_DETAIL_UNCERTAIN, now);
  // The saved intent has no authenticated producing runtime. Preserve its
  // charge and blocked custody without fabricating a new memory outcome.
  return persistAfterSettlement(deps, context.bounds, (draft) => {
    replaceWorkMutation(blocked)(draft);
  });
}
