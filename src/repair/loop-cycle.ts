import { reconcileExistingPrs } from "./loop-existing-pr.ts";
import { guardQueueOperation } from "./loop-queue-guard.ts";
/** Repair loop internals: cycle. */
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { createRunBounds, DEFAULT_STEP_LIMIT } from "./loop-bounds.ts";
import { resumeBaseSatisfaction } from "./loop-base-satisfaction.ts";
import { declaredOperationFits } from "./loop-eligibility.ts";
import { pollIntake } from "./loop-intake.ts";
import { bridgeLegacyLoss } from "./loop-legacy-loss.ts";
import { createPostDrainContinuation } from "./loop-post-drain.ts";
import { reconcileOrphanPublication } from "./loop-publication.ts";
import {
  type ReleaseResumeRunV1,
  resumeDeferredRelease,
} from "./loop-release.ts";
import {
  recoverBlockedAlreadySatisfied,
  recoverBlockedMissingTaskReview,
} from "./loop-review-recovery.ts";
import {
  loadSnapshot,
  persistWork,
  seedSnapshot,
  synchronizeSnapshot,
} from "./loop-state.ts";
import type {
  LoopContextV1,
  PostDrainReviewContinuationV1,
  RepairCycleDepsV1,
  RepairCycleOptionsV1,
  RepairCycleOutcomeV1,
  RepairCycleTrackingV1,
  StepResultV1,
} from "./loop-types.ts";
import { executeStep } from "./loop-work.ts";
import { rankEligibleWork, rankReviewDrain } from "./selection.ts";
import { createStepLog } from "./step-line.ts";
import { setWait } from "./transitions.ts";

/** One run of the bounded repair loop. */
export async function runRepairCycle(
  deps: RepairCycleDepsV1,
  options: RepairCycleOptionsV1,
  registerPostDrain?: (continuation: PostDrainReviewContinuationV1) => void,
): Promise<RepairCycleOutcomeV1> {
  const bounds = createRunBounds(deps, options);
  const { runDeadline } = bounds;
  const stepLimit = options.stepLimit ?? DEFAULT_STEP_LIMIT;
  const tracking: RepairCycleTrackingV1 = {
    steps: 0,
    lastSnapshot: null,
    postDrainAllowed: false,
    continued: false,
  };
  let sourceError: string | null = null;
  let didWork = false;
  // Records whose declared next operation cannot start under the current run
  // bounds are deferred so that lower-ranked deterministic work still runs;
  // the run ends in the existing typed "margin" outcome when nothing remains.
  const deferred = new Set<string>();
  const baseReviewAttempted = new Set<string>();

  // One run-local attempt per task and legacy-loss phase: a phase is never
  // proved twice in the same run, even after a state reload.
  const legacyLossAttempted = new Set<string>();
  // One run-local release per transient review-quota record: each iteration
  // releases the next-highest-priority drain candidate and the ordinary
  // lifecycle retries it, so the pass is bounded and never re-attempts the same
  // record within one run.
  const reviewDrainAttempted = new Set<string>();
  // One run-local discovery per orphan publication record: an existing live PR
  // is attached to its record BEFORE cap enforcement, so a real PR is never
  // skipped as over-cap.
  const orphanAttempted = new Set<string>();
  const takeoverAttempted = new Set<string>();
  const takeoverRefused = new Set<string>();
  const missingTaskReviewAttempted = new Set<string>();
  // One run-local re-observation per historical already-satisfied block.
  const alreadySatisfiedAttempted = new Set<string>();
  // One release read per run, and one look per deferred release record.
  const releaseResume: ReleaseResumeRunV1 = { attempted: new Set() };
  // Intake is polled exactly once per run. A deferred (cooldown or bound)
  // iteration must never re-poll the sources: subsequent loop iterations reuse
  // the run-local deferral tracking instead of repeating intake reads.
  let intakePolled = false;
  // One bounded advisory `sentinel_step` line per selected step (C5.2).
  const logStep = createStepLog();

  registerPostDrain?.(
    createPostDrainContinuation(deps, bounds, stepLimit, tracking),
  );

  for (;;) {
    if (deps.clock.now() >= runDeadline) {
      return { status: "margin", detail: "repair run deadline reached" };
    }
    let loaded = await loadSnapshot(deps, bounds);
    if (loaded === null) {
      // The state read is awaited wall-clock time: if it crossed the total
      // deadline, even the one-time seed write must not start then (a later
      // run inside its own window seeds).
      if (deps.clock.now() >= runDeadline) {
        return {
          status: "margin",
          detail: "repair run deadline reached during state read",
        };
      }
      // Branch creation: exactly one seeded snapshot (sequence 1), written
      // with expectedHead null; never a force overwrite of existing state.
      loaded = await seedSnapshot(deps, bounds);
      if (loaded === null) {
        return { status: "state_error", detail: "repair state unavailable" };
      }
    }
    const context: LoopContextV1 = { ...loaded, bounds };
    tracking.lastSnapshot = context.snapshot;

    // The initial state read is awaited wall-clock time and may have crossed
    // the total deadline (fakes advance the clock inside port calls): no
    // intake read may start at/after it.
    if (deps.clock.now() >= runDeadline) {
      return {
        status: "margin",
        detail: "repair run deadline reached during state read",
      };
    }

    if (!intakePolled) {
      intakePolled = true;
      const intake = await pollIntake(deps, context);
      sourceError = intake.error;
      // A cooldown gate fault is a state trust failure, never a source error:
      // it stops the run before any external effect.
      if (intake.result.kind === "state_error") {
        return { status: "state_error", detail: intake.result.detail };
      }
      if (intake.changed) {
        if (intake.result.kind !== "progress") {
          return {
            status: "state_error",
            detail: "intake checkpoint conflict",
          };
        }
        didWork = true;
        tracking.steps++;
      }

      // Intake (and the shared cooldown gate behind it) is awaited wall-clock
      // work: the authoritative head may have moved even when no source row
      // changed. Synchronize once before any ranking/decision so unrelated
      // state movement can never admit a model against a stale context; an
      // unavailable or conflicting reread is a state trust failure.
      const synchronized = await synchronizeSnapshot(deps, context);
      if (synchronized.status === "unavailable") {
        return { status: "state_error", detail: "repair state unavailable" };
      }
      if (synchronized.status === "conflict") {
        return {
          status: "state_error",
          detail: "repair state moved with conflicting contents",
        };
      }
    }

    if (tracking.steps >= stepLimit) {
      return { status: "step_limit", steps: tracking.steps };
    }

    const takeover = await reconcileExistingPrs(
      deps,
      context,
      takeoverAttempted,
      takeoverRefused,
    );
    if (takeover?.kind === "state_error") {
      return { status: "state_error", detail: takeover.detail };
    }
    if (takeover?.kind === "progress") {
      didWork = true;
      tracking.steps++;
      continue;
    }
    if (takeover?.kind === "deferred") continue;

    const baseReview = await resumeBaseSatisfaction(
      deps,
      context,
      baseReviewAttempted,
    );
    if (baseReview?.kind === "state_error") {
      return { status: "state_error", detail: baseReview.detail };
    }
    if (baseReview?.kind === "progress") {
      didWork = true;
      tracking.steps++;
      continue;
    }
    if (baseReview?.kind === "deferred") continue;

    // Bounded pre-ranking legacy-loss bridge (optional capability): a proven
    // lost legacy candidate is committed as truthful missing_evidence BEFORE
    // the generic ranking sees it; a successful CAS counts as the ordinary
    // step and the outer loop reloads the authoritative state. Generic
    // selection and blocked behavior stay unchanged.
    const bridged = await bridgeLegacyLoss(
      deps,
      context,
      legacyLossAttempted,
      deferred,
    );
    if (bridged.kind === "state_error") {
      return { status: "state_error", detail: bridged.detail };
    }
    if (bridged.kind === "progress") {
      didWork = true;
      tracking.steps++;
      continue;
    }

    // Orphan-publication reconciliation (issue-141 / PR 433): a durable
    // publication intent that names the deterministic branch but has not yet
    // persisted its PR number must have the existing live PR discovered and
    // attached BEFORE ranking so cap enforcement sees the real identity.
    const orphan = await reconcileOrphanPublication(
      deps,
      context,
      orphanAttempted,
    );
    if (orphan !== null) {
      if (orphan.kind === "state_error") {
        return { status: "state_error", detail: orphan.detail };
      }
      if (orphan.kind === "margin") {
        return { status: "margin", detail: orphan.detail };
      }
      if (orphan.kind === "progress") {
        didWork = true;
        tracking.steps++;
        continue;
      }
    }

    // Review-drain pass (owner rule, 2026-09-29): a transient `review_quota`
    // record keeps producing/updating its publication and must be retroactively
    // reviewed when quota returns, oldest/highest-priority first. Releasing its
    // wait makes the ordinary lifecycle attempt it on this iteration; if quota
    // is still exhausted the step re-arms the same transient wait, so the pass
    // is self-scheduling and never terminally blocks.
    const drained = await releaseReviewQuotaWait(
      deps,
      context,
      reviewDrainAttempted,
    );
    if (drained !== null) {
      if (drained.kind === "state_error") {
        return { status: "state_error", detail: drained.detail };
      }
      if (drained.kind === "margin") {
        return { status: "margin", detail: drained.detail };
      }
      if (drained.kind === "progress") {
        didWork = true;
        tracking.steps++;
        continue;
      }
    }

    const missingTaskReview = await recoverBlockedMissingTaskReview(
      deps,
      context,
      missingTaskReviewAttempted,
      deferred,
    );
    if (missingTaskReview?.kind === "state_error") {
      return { status: "state_error", detail: missingTaskReview.detail };
    }
    if (missingTaskReview?.kind === "progress") {
      didWork = true;
      tracking.steps++;
      continue;
    }

    const alreadySatisfied = await recoverBlockedAlreadySatisfied(
      deps,
      context,
      alreadySatisfiedAttempted,
      deferred,
    );
    if (alreadySatisfied?.kind === "state_error") {
      return { status: "state_error", detail: alreadySatisfied.detail };
    }
    if (alreadySatisfied?.kind === "progress") {
      didWork = true;
      tracking.steps++;
      continue;
    }

    // A release deferred while the release path is disabled resumes once the
    // release ref records its request; otherwise it costs nothing (JAM B12).
    const resumed = await resumeDeferredRelease(deps, context, releaseResume);
    if (resumed?.kind === "state_error") {
      return { status: "state_error", detail: resumed.detail };
    }
    if (resumed?.kind === "progress") {
      didWork = true;
      tracking.steps++;
      continue;
    }

    const rank = rankEligibleWork(
      context.snapshot,
      deps.configs,
      deps.clock.now(),
    );
    if (rank.ordered.length === 0) {
      if (!didWork && sourceError !== null) {
        return { status: "source_error", detail: sourceError };
      }
      tracking.postDrainAllowed = true;
      return {
        status: "idle",
        detail: idleDetail(context.snapshot, rank.skipped),
      };
    }

    let selected: WorkRecordV1 | null = null;
    let cannotFit: string | null = null;
    for (const id of rank.ordered) {
      if (deferred.has(id) || takeoverRefused.has(id)) continue;
      const record = context.snapshot.work.find(
        (work) => work.id === id,
      );
      if (record === undefined) {
        return { status: "state_error", detail: "selected record missing" };
      }
      if (
        declaredOperationFits(deps, context, record)
      ) {
        selected = record;
        break;
      }
      // This record cannot start under the current bounds; keep looking for
      // eligible deterministic work before giving up (never block it).
      deferred.add(id);
      cannotFit = `next operation for ${id} cannot fit`;
    }
    if (selected === null) {
      // Every remaining record was deferred: matrix ownership, a model start
      // past the horizon, a cooldown or a transient read. None of these stops
      // deterministic work, which this loop keeps running for lower-ranked
      // records up to the run deadline. The post-drain continuation is only
      // that deterministic work for the reviews drained in this run (no model
      // start or charge, the original deadline and step budget, a cooldown
      // re-check and exact identity), so it stays open here; every other
      // margin exit keeps it closed.
      tracking.postDrainAllowed = true;
      return {
        status: "margin",
        detail: deferred.size > 0
          ? "all eligible work is deferred (cooldown or run bounds)"
          : cannotFit ?? "no operation fits the remaining run margin",
      };
    }

    context.executionBaseline = selected;
    // Monotonic wall time: the injected run clock is never read for the log.
    const stepStartedAt = performance.now();
    const result = await executeStep(deps, context, selected);
    context.executionBaseline = null;
    logStep(
      selected,
      result.kind,
      Math.round(performance.now() - stepStartedAt),
    );
    if (result.kind === "deferred") {
      deferred.add(selected.id);
      continue;
    }
    if (result.kind === "state_error") {
      return { status: "state_error", detail: result.detail };
    }
    if (result.kind === "margin") {
      return { status: "margin", detail: result.detail };
    }
    if (result.kind === "idle") {
      if (!didWork && sourceError !== null) {
        return { status: "source_error", detail: sourceError };
      }
      tracking.postDrainAllowed = true;
      return {
        status: "idle",
        detail: `no eligible work after ${tracking.steps} steps`,
      };
    }
    didWork = true;
    tracking.steps++;
  }
}

/**
 * Release the next transient review-quota record's wait so the ordinary
 * ranking selects it on a following iteration. The drain order is highest
 * priority first, then oldest first (pure `rankReviewDrain`), and each record is
 * released at most once per run. There is no fixed per-run truncation: the
 * pass walks the ACTUAL pending collection and every candidate must still fit
 * the remaining run bounds (`declaredOperationFits`), while the outer loop's
 * step budget and deadline bound the run. Returns null when there is nothing
 * left to drain or the next candidate cannot fit the remaining run bounds.
 */
export async function releaseReviewQuotaWait(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  attempted: Set<string>,
): Promise<StepResultV1 | null> {
  for (const id of rankReviewDrain(context.snapshot)) {
    if (attempted.has(id)) continue;
    attempted.add(id);
    const record = context.snapshot.work.find((work) => work.id === id);
    if (record === undefined) continue;
    const queueGuard = await guardQueueOperation(
      deps,
      context,
      record,
      "resume",
    );
    if (queueGuard !== null) return queueGuard;
    // Release eligibility without erasing the submitted attempt's deadline.
    // A confirmed submission no longer has an intent, so this wait is its
    // only durable start anchor until observation settles or replaces it.
    const now = deps.clock.now();
    const released = setWait(record, { ...record.wait!, until: now }, now);
    if (!declaredOperationFits(deps, context, released)) continue;
    const persisted = await persistWork(deps, context, released);
    return persisted;
  }
  return null;
}

export function idleDetail(
  snapshot: RepairStateSnapshotV1,
  skipped: Record<string, string>,
): string {
  const terminal = snapshot.work.filter((record) => record.nextStep === "done")
    .length;
  const blocked =
    snapshot.work.filter((record) => record.nextStep === "blocked")
      .length;
  const waiting =
    Object.values(skipped).filter((reason) => reason === "waiting")
      .length;
  return (
    `${snapshot.work.length} records: ${terminal} terminal, ` +
    `${blocked} blocked, ${waiting} waiting`
  );
}
