import { runSelfObservationPass } from "./hosted-autonomy-observation.ts";
import {
  beginMaintenanceProgress,
  HistoricalQuarantineIncomplete,
  maintenanceFailureCategory,
  readReleaseSafely,
  readRepairSafely,
  skipped,
} from "./hosted-autonomy-state.ts";
import {
  readHostedClosedIssues,
  runHostedRetryPass,
} from "./hosted-autonomy-retry-pass.ts";
import { runHostedClosurePass } from "./hosted-autonomy-closure-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "./hosted-autonomy-scopes.ts";
import { HOSTED_AUTONOMY_SELF_SCOPE } from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyReasonV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";
import { runHostedDeliveryPass } from "./hosted-autonomy-delivery-pass.ts";
import { runHostedMatrixMaintenance } from "./hosted-autonomy-maintenance.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "./hosted-autonomy-producer-recovery.ts";
import { ClosedCWaveRecoveryIntegrityFailure } from "../src/host/modern-matrix-recovery.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { isHostedReleaseTerminal } from "../src/contracts/hosted-supervisor.ts";
import {
  continuationLate,
  createPassWrites,
  HOSTED_AUTONOMY_PASS_DEADLINE_MS,
  HOSTED_AUTONOMY_PHASE_RESERVE_MS,
  type HostedAutonomyContinuationStopV1,
  type HostedAutonomyPhaseV1,
  settledSince,
} from "./hosted-autonomy-continuation.ts";
import { runHostedFollowUpPass } from "./hosted-autonomy-follow-up-pass.ts";
import { runHostedQueueCustody } from "./hosted-autonomy-queue-pass.ts";
import { protectQueueState } from "./hosted-autonomy-queue-state.ts";
import type {
  HostedQueueCustodyContext,
  QueueCustodyResult,
} from "./hosted-autonomy-queue-context.ts";

export {
  HOSTED_AUTONOMY_PASS_DEADLINE_MS,
  HOSTED_AUTONOMY_PHASE_RESERVE_MS,
} from "./hosted-autonomy-continuation.ts";

interface PhaseV1 {
  readonly name: HostedAutonomyPhaseV1;
  run(
    context: HostedAutonomyPassContextV1,
    releaseHead: string,
  ): Promise<HostedAutonomyResultV1 | null>;
  /** True for an applied write the remaining phases may follow. */
  continues(result: HostedAutonomyResultV1): boolean;
}

const PHASES: readonly PhaseV1[] = [
  {
    // Ready delivery bookkeeping precedes unrelated retry grants. Restrict
    // this early pass to delivery records so blocked candidate-ref and
    // recovery transitions retain their own reconciliation boundary. Its
    // Gateway release block or closure intent (`applied`) ends the pass.
    name: "closure-delivery",
    run: (context) => runHostedClosurePass(context, true),
    continues: (result) =>
      result.reason === "retired_records" || result.reason === "closed_issues",
  },
  {
    // Only the ordinary grant and re-admission write continues. A
    // candidate-ref revalidation still ends the pass, so no delivery or review
    // decision is made from a state the runtime has not yet reconciled, and so
    // do the mismatch and preservation dispositions and the refresh re-arm.
    name: "retry",
    run: (context, releaseHead) => runHostedRetryPass(context, releaseHead),
    continues: (result) => result.reason === "retried",
  },
  {
    name: "delivery",
    run: (context) => runHostedDeliveryPass(context),
    continues: () => true,
  },
  {
    name: "closure",
    run: (context) => runHostedClosurePass(context),
    continues: () => true,
  },
];

/** Integrity faults fail closed, even from a continued phase. */
function integrityFault(error: unknown): boolean {
  return error instanceof CurrentMatrixRecoveryIntegrityFailure ||
    error instanceof ClosedCWaveRecoveryIntegrityFailure ||
    error instanceof HistoricalQuarantineIncomplete;
}

/**
 * The maintenance chain, then the state-free review follow-up pass. The
 * follow-ups run once per pass, after the whole chain (every continued phase
 * included, so a merge written anywhere in this pass is already seen), and
 * are skipped after a failed chain. They only append actions: status, reason
 * and heads stay the chain's own. They share the chain's deadline: no
 * follow-up read or create starts later than HOSTED_AUTONOMY_PASS_DEADLINE_MS
 * after the pass started, so a long continued pass leaves them to the next
 * pass instead of running past the job's own limit.
 */
export async function runHostedAutonomy(
  deps: HostedAutonomyDepsV1,
): Promise<HostedAutonomyResultV1> {
  await deps.onQueueCustodyReady?.(false);
  const startedAt = deps.clock.now();
  try {
    let custody: QueueCustodyResult;
    const finishCustody = beginMaintenanceProgress("queue_custody");
    try {
      custody = await runHostedQueueCustody(
        deps,
        startedAt + HOSTED_AUTONOMY_PASS_DEADLINE_MS,
      );
    } finally {
      finishCustody();
    }
    if (!custody.ready) {
      return custody.write ??
        skipped("no_change", custody.observed?.head ?? null, custody.actions);
    }
    const context: HostedQueueCustodyContext = {
      ready: true,
      proofActivated: deps.queue?.config.proofActivated ?? false,
      protectedRecordIds: custody.protectedRecordIds,
      resolveDelivery: deps.queue?.resolveDelivery,
      verifyProtectedWrite: deps.queue?.verifyProtectedWrite,
    };
    const guarded = protectQueueState(deps.state, context);
    const scoped: HostedAutonomyDepsV1 = {
      ...deps,
      state: guarded,
      queueCustody: context,
      ...(deps.historicalMatrix
        ? {
          historicalMatrix: {
            ...deps.historicalMatrix,
            state: protectQueueState(deps.historicalMatrix.state, context),
            protectedRecordIds: context.protectedRecordIds,
          },
        }
        : {}),
      ...(deps.closedMatrix
        ? {
          closedMatrix: async (state = guarded) => {
            // Producer-specific writers also enforce release custody and deadline.
            const ports = await deps.closedMatrix!(
              protectQueueState(state, context),
            );
            return { ...ports, state: protectQueueState(ports.state, context) };
          },
        }
        : {}),
      ...(deps.uncertainMatrix
        ? {
          uncertainMatrix: () =>
            deps.uncertainMatrix!(guarded, context.protectedRecordIds),
        }
        : {}),
    };
    const result = await runHostedAutonomyChain(scoped, startedAt, custody);
    if (result.status === "failed") return result;
    let followUps: string[];
    let followUpComplete = true;
    const finishFollowup = beginMaintenanceProgress("followup");
    try {
      followUps = await runHostedFollowUpPass(
        scoped,
        startedAt + HOSTED_AUTONOMY_PASS_DEADLINE_MS,
      );
    } catch {
      followUps = ["followup:unexpected_error"];
      followUpComplete = false;
    } finally {
      finishFollowup();
    }
    await deps.onQueueCustodyReady?.(followUpComplete);
    return followUps.length === 0
      ? result
      : { ...result, actions: [...result.actions, ...followUps] };
  } catch (error) {
    await deps.onQueueCustodyReady?.(false);
    throw error;
  }
}

/**
 * Maintenance first, then the ordinary phases in their fixed order, each at
 * most once and each returning its own result from its own expected-head CAS
 * and readback. After a write a later phase may follow, the pass re-reads
 * state, requires exactly the head that write left and runs the remaining
 * phases there (see hosted-autonomy-continuation.ts); everything else still
 * ends the pass on that phase's result, and a pass that writes nothing is
 * unchanged.
 */
async function runHostedAutonomyChain(
  deps: HostedAutonomyDepsV1,
  startedAt: number,
  custody: QueueCustodyResult,
): Promise<HostedAutonomyResultV1> {
  const actions: string[] = [...custody.actions];
  const revisions: string[] = [];
  const dedicatedReservations = new Set<string>();
  const writes = createPassWrites(actions, revisions);
  if (custody.write !== null) writes.absorb(custody.write);
  // Offsets from the pass start at which maintenance and each phase ended,
  // read only once the pass has written (calibration of the start limit).
  const ended: (number | null)[] = [null, null, null, null, null];
  const mark = (index: number) => {
    try {
      const now = deps.clock.now();
      ended[index] =
        Number.isSafeInteger(now) && Number.isSafeInteger(startedAt)
          ? now - startedAt
          : null;
    } catch {
      ended[index] = null;
    }
  };
  const finish = (
    stopped: string | null = null,
    failure: HostedAutonomyResultV1 | null = null,
  ) => {
    console.log(JSON.stringify({
      kind: "sentinel_autonomy_continuation",
      version: "v1",
      endedMs: ended,
      stopped,
    }));
    return writes.result(failure);
  };
  /** Ends a pass that already wrote, before `phase` or on its own outcome. */
  const stop = (
    phase: HostedAutonomyPhaseV1,
    outcome: HostedAutonomyReasonV1 | HostedAutonomyContinuationStopV1,
    failure: HostedAutonomyResultV1 | null = null,
  ) => {
    actions.push(`continuation:${phase}:${outcome}`);
    return outcome === "deferred_deadline" && !writes.applied
      ? skipped("no_change", custody.observed?.head ?? null, actions)
      : finish(`${phase}:${outcome}`, failure);
  };
  // Only the matrix pre-passes can write before the ordinary phases: the
  // state they started from marks the records they settled.
  let before: Awaited<ReturnType<typeof readRepairSafely>> = null;
  if (deps.closedMatrix) {
    const finishBaseline = beginMaintenanceProgress("matrix_baseline");
    try {
      before = await readRepairSafely(deps.state);
    } finally {
      finishBaseline();
    }
  }
  let baseline: RepairStateSnapshotV1 | null = custody.write !== null
    ? custody.observed?.snapshot ?? null
    : null;
  const maintenance = await runHostedMatrixMaintenance(
    deps,
    actions,
    dedicatedReservations,
  );
  if (maintenance !== null) {
    if (maintenance.status !== "applied") return maintenance;
    writes.absorb(maintenance);
    mark(0);
    if (before !== null && before.ok && before.value.status === "found") {
      baseline = before.value.snapshot;
    }
  }

  const scopes = createHostedAutonomyScopes(deps);
  // Records whose source issue this pass has read: once per record per pass.
  const issuesRead = new Set<string>();
  const build = async (
    phase: HostedAutonomyPhaseV1,
    previous: HostedAutonomyPassContextV1 | null,
  ): Promise<
    HostedAutonomyResultV1 | {
      context: HostedAutonomyPassContextV1;
      releaseHead: string;
    }
  > => {
    const repair = await readRepairSafely(deps.state);
    const found = repair !== null && repair.ok &&
        repair.value.status === "found"
      ? repair.value
      : null;
    if (writes.applied) {
      if (found === null || baseline === null || writes.appliedHead === null) {
        return stop(phase, "state_unavailable");
      }
      // No phase ever runs on a head this pass's own writes did not leave.
      if (found.head !== writes.appliedHead) return stop(phase, "head_changed");
    } else if (found === null) {
      return skipped("no_change", null, actions);
    }
    const releaseRead = await readReleaseSafely(deps.state);
    if (
      releaseRead === null || !releaseRead.ok ||
      releaseRead.value.status !== "found" ||
      // The contract's terminal set, `abandoned` included (an
      // included_in_successor abandonment is settled custody, not in flight).
      releaseRead.value.snapshot.hostedReleases.some((release) =>
        !isHostedReleaseTerminal(release.phase)
      )
    ) {
      return writes.applied
        ? stop(phase, "release_not_terminal")
        : skipped("release_not_terminal", found.head, actions);
    }
    if (!writes.applied) baseline = found.snapshot;
    const context: HostedAutonomyPassContextV1 = {
      deps,
      passStartedAt: startedAt,
      deadlineAt: startedAt + HOSTED_AUTONOMY_PASS_DEADLINE_MS -
        HOSTED_AUTONOMY_PHASE_RESERVE_MS,
      actions,
      revisions,
      snapshot: found.snapshot,
      observedHead: found.head,
      initialHead: found.head,
      releaseSnapshot: releaseRead.value.snapshot,
      closedIssues: previous?.closedIssues ?? new Set(),
      // This pass's verified merge evidence still flows to its closure.
      foreignMerged: previous?.foreignMerged ?? new Map(),
      dedicatedReservations,
      settled: writes.applied && baseline !== null
        ? settledSince(baseline, found.snapshot)
        : new Set(),
      ...scopes,
    };
    await readHostedClosedIssues(context, issuesRead);
    return { context, releaseHead: releaseRead.value.head };
  };

  let context: HostedAutonomyPassContextV1 | null = null;
  let releaseHead = "";
  let stale = true;
  for (const [index, phase] of PHASES.entries()) {
    const continued = writes.applied;
    let result: HostedAutonomyResultV1 | null;
    try {
      if (continuationLate(startedAt, deps.clock.now())) {
        return stop(phase.name, "deferred_deadline");
      }
      if (stale) {
        const finishContext = beginMaintenanceProgress(
          phase.name === "closure-delivery"
            ? "context_closure_delivery"
            : phase.name === "retry"
            ? "context_retry"
            : phase.name === "delivery"
            ? "context_delivery"
            : "context_closure",
        );
        let built: Awaited<ReturnType<typeof build>>;
        try {
          built = await build(phase.name, context);
        } finally {
          finishContext();
        }
        if ("kind" in built) return built;
        context = built.context;
        releaseHead = built.releaseHead;
        stale = false;
      }
      if (continuationLate(startedAt, deps.clock.now())) {
        return stop(phase.name, "deferred_deadline");
      }
      const finishPhase = beginMaintenanceProgress(
        phase.name === "closure-delivery" ? "closure_delivery" : phase.name,
      );
      try {
        result = await phase.run(context!, releaseHead);
      } finally {
        finishPhase();
      }
    } catch (error) {
      if (!continued || integrityFault(error)) throw error;
      // The same bounded deferral line the protected main prints; only the
      // fixed category reaches the log, never error text.
      console.log(JSON.stringify({
        kind: "sentinel_autonomy_deferred",
        reason: "unexpected_error_deferred",
        category: maintenanceFailureCategory(error),
      }));
      return stop(phase.name, "deferred_unexpected_error");
    }
    if (result === null) {
      if (continued) mark(index + 1);
      continue;
    }
    if (result.status !== "applied") {
      if (!continued) return result;
      mark(index + 1);
      return stop(phase.name, result.reason, result);
    }
    writes.absorb(result);
    mark(index + 1);
    if (!phase.continues(result)) return finish();
    stale = true;
  }
  if (writes.applied) return finish();
  const observedHead = context!.observedHead;
  const { scopeFor } = scopes;
  // ---- self-observation pass ---------------------------------------------
  // Runs LAST and is fully optional: every read is bounded and state-free, its
  // only write is one deduplicated issue in this deployment's own tracker, and
  // any refusal inside it is reported as an action rather than a failure. The
  // normal repair loop then works those issues like any other. A pass that
  // wrote state never runs it.
  let selfSurface: HostedAutonomyGitHubV1 | null = null;
  const finishObservation = beginMaintenanceProgress("self_observation");
  try {
    try {
      selfSurface = (await scopeFor(HOSTED_AUTONOMY_SELF_SCOPE)).surface;
    } catch {
      selfSurface = null;
    }
    actions.push(
      ...await runSelfObservationPass({
        github: selfSurface,
        now: deps.clock.now(),
      }),
    );
  } finally {
    finishObservation();
  }

  const suffix = (value: string) =>
    actions.some((action) => action.endsWith(value));
  const reason: HostedAutonomyReasonV1 =
    actions.some((action) => action.startsWith("retry:"))
      ? "retried"
      : suffix(":already_recorded")
      ? "already_recorded"
      : suffix(":base_moved")
      ? "base_moved"
      : suffix(":checks_pending")
      ? "checks_pending"
      : suffix(":merge_refused")
      ? "merge_refused"
      : suffix(":merge_not_observed")
      ? "merge_not_observed"
      : suffix(":foreign_author")
      ? "foreign_author"
      : actions.length > 0
      ? "no_authorizing_review"
      : "no_change";
  return skipped(reason, observedHead, actions);
}
