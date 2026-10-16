/**
 * Repair loop internals: the charged base-refresh conflict resolution.
 *
 * A pending resolution (`conflict-resolution.ts`) is admitted like any other
 * implementation start: under the ordinary charged, monotonic admission and
 * only after its conflict is re-confirmed live, so a moved base or a moved
 * branch never spends a charge. The request continues the published candidate
 * H (`checkoutBase`) with the conflicting base B to merge (`mergeBase`); the
 * durable reviewed base stays in `base`. A completed resolution settles
 * submitted and becomes the resolved refresh intent, which the ordinary
 * refresh tail preserves and publishes as a fast-forward of H. Every other
 * outcome stays charged and blocked with the conflict marker retained on the
 * intent, so neither the runtime nor the launcher's retry table spends a
 * second charge on the same base tip.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import { attemptMemorySuccessMutationV1 } from "./attempt-policy.ts";
import {
  CONFLICT_MERGE_PRESERVE_WINDOW_MS,
  CONFLICT_PROTECTED_DETAIL,
  conflictMarker,
  conflictMarkerBase,
  conflictResolutionAdmissible,
  conflictResolutionInFlight,
  conflictResolutionRouteOpen,
} from "./conflict-resolution.ts";
import { baseRefreshIntentKey, candidatePreservationRef } from "./keys.ts";
import { persistAfterSettlement } from "./loop-accounting.ts";
import {
  BASE_REFRESH_BASE_READ_DETAIL,
  BASE_REFRESH_FOREIGN_HEAD_DETAIL,
  BASE_REFRESH_REF_READ_DETAIL,
  failBaseRefresh,
} from "./loop-base-refresh-failure.ts";
import { reconcileRefreshPublication } from "./loop-base-refresh.ts";
import { MATRIX_IMPLEMENTATION_DEFERRED } from "./loop-bounds.ts";
import { configFor, touchesProtected } from "./loop-records.ts";
import { persistWork, replaceWorkMutation } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { clearIntent, markBlocked } from "./transitions.ts";

export { CONFLICT_PROTECTED_DETAIL } from "./conflict-resolution.ts";

/**
 * The work step of an admissible pending resolution: the record's own pull
 * request is reconciled first (a merged or closed publication is never
 * charged), then the in-process run admits and runs it (`implement`, the
 * ordinary implementation step); a hosted run leaves the admission to the
 * trusted matrix planner.
 */
export async function executeConflictResolutionStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  implement: () => Promise<StepResultV1>,
): Promise<StepResultV1> {
  const intent = record.intent;
  if (
    intent === null ||
    conflictResolutionAdmissible(
        conflictResolutionRouteOpen(deps),
        context.snapshot,
        record,
      ) === null
  ) {
    return {
      kind: "state_error",
      detail: "conflict resolution identity mismatch",
    };
  }
  const reconciled = await reconcileRefreshPublication(
    deps,
    context,
    record,
    intent,
  );
  if (reconciled !== null) return reconciled;
  if (deps.externalImplementations === true) {
    return MATRIX_IMPLEMENTATION_DEFERRED;
  }
  return implement();
}

/**
 * Admission-time confirmation, before anything is charged: the configured
 * base must still be the marked tip (a moved base clears ONLY the pending
 * intent, so the next step plans an uncharged refresh against the newest
 * base, which may merge cleanly) and the published branch must still carry H
 * (anything else is the refresh's own bounded foreign-head failure). The merge
 * itself is not re-run: merging a fixed (H, B) is deterministic.
 */
export async function confirmConflictResolution(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<
  { kind: "confirmed"; head: GitSha; mergeBase: GitSha } | StepResultV1
> {
  const mergeBase = conflictResolutionAdmissible(
    conflictResolutionRouteOpen(deps),
    context.snapshot,
    record,
  );
  const config = configFor(deps, record.repository);
  const { head, branch } = record.target;
  const intent = record.intent;
  if (
    mergeBase === null || config === null || head === null ||
    branch === null || intent === null
  ) {
    return {
      kind: "state_error",
      detail: "conflict resolution identity mismatch",
    };
  }
  const tip = await deps.github.readRef(`refs/heads/${config.baseBranch}`);
  if (!tip.ok || tip.value === null) {
    return failBaseRefresh(deps, context, record, intent, {
      kind: tip.ok ? "unavailable" : tip.error.kind,
      detail: BASE_REFRESH_BASE_READ_DETAIL,
      ...(tip.ok ? {} : { portDetail: tip.error.detail }),
    });
  }
  if (tip.value.sha !== mergeBase) {
    return persistWork(deps, context, clearIntent(record, deps.clock.now()));
  }
  const published = await deps.github.readRef(`refs/heads/${branch}`);
  if (!published.ok || published.value === null) {
    return failBaseRefresh(deps, context, record, intent, {
      kind: published.ok ? "unavailable" : published.error.kind,
      detail: BASE_REFRESH_REF_READ_DETAIL,
      ...(published.ok ? {} : { portDetail: published.error.detail }),
    });
  }
  if (published.value.sha !== head) {
    return failBaseRefresh(deps, context, record, intent, {
      kind: "conflict",
      detail: BASE_REFRESH_FOREIGN_HEAD_DETAIL,
    });
  }
  return { kind: "confirmed", head, mergeBase };
}

/**
 * A hosted conflict-resolution receipt kept unconsumed: its merge could not
 * yet be preserved on the remote (see `preserveConflictMerge`).
 */
export const CONFLICT_MERGE_PRESERVATION_DEFERRED: StepResultV1 = {
  kind: "deferred",
  detail: "resolved merge not yet preserved; receipt kept",
};

/**
 * Hosted only, BEFORE a completed resolution receipt is consumed: preserve
 * the trusted merge M under the deterministic refresh binding of (PR, H, B),
 * the exact operation ref the resolved intent later publishes through.
 *
 * A hosted job's mirror is its own: M reaches only the mirror of the
 * aggregate job that imported its bundle, and the resolved intent cannot be
 * regenerated. Once M is on the remote, any later job (a fresh mirror, or the
 * rollback target) reconciles that ref and imports M from it. A transient
 * failure (unavailable, rate limited, credential, a thrown port) keeps the
 * receipt unconsumed: nothing is written, the one charge stays `reserved`
 * and the marked implementation intent stays bound, so a later scan of the
 * retained artifact retries in its own mirror. That holds only while the
 * admission is younger than `CONFLICT_MERGE_PRESERVE_WINDOW_MS`; past it, and
 * on a definite refusal (invalid, conflict, not found), the receipt is
 * consumed exactly as before and the publication's bounded failure
 * accounting owns the outcome. A merge touching a protected path is never
 * preserved (it blocks charged without publishing). Returns null to consume.
 */
export async function preserveConflictMerge(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  merged: { head: GitSha; changedPaths: readonly string[] },
  config: RepositoryConfigV1,
): Promise<StepResultV1 | null> {
  if (deps.externalImplementations !== true) return null;
  const intent = record.intent;
  const mergeBase = conflictResolutionInFlight(intent);
  const { head, pr } = record.target;
  const publishedHead = record.target.candidateState?.publishedHead ?? null;
  if (
    intent === null || mergeBase === null || head === null || pr === null ||
    publishedHead !== head || merged.head === head ||
    merged.changedPaths.some((path) =>
      touchesProtected(config.protectedPaths, path)
    )
  ) return null;
  const operationKey = baseRefreshIntentKey(pr, head, mergeBase);
  let preserved;
  try {
    preserved = await deps.github.preserveCandidate({
      taskId: record.id,
      candidate: {
        operationKey,
        base: mergeBase,
        head: merged.head,
        ref: await candidatePreservationRef(
          record.repository,
          record.id,
          operationKey,
        ),
      },
      publishedHead,
    });
  } catch {
    preserved = null;
  }
  if (preserved !== null && preserved.ok) return null;
  const refused = preserved !== null &&
    (preserved.error.kind === "invalid" ||
      preserved.error.kind === "conflict" ||
      preserved.error.kind === "not_found");
  if (refused) return null;
  return deps.clock.now() - intent.startedAt < CONFLICT_MERGE_PRESERVE_WINDOW_MS
    ? CONFLICT_MERGE_PRESERVATION_DEFERRED
    : null;
}

/**
 * A completed resolution receipt (the caller already required a real,
 * non-generated change against the merged base and a head other than B0 and
 * H). It settles submitted: charged, never refunded. A merge touching a
 * protected path never publishes and blocks with the marker retained. Any
 * other merge becomes the resolved refresh intent (exact (P, H, B) key,
 * result M, marker) at `work` with the target still at H, so the ordinary
 * refresh tail preserves M under the refresh binding, lease-pushes it over H
 * and only then advances the target; the preservation proof re-checks that
 * both H and B are ancestors of M and the protected paths.
 */
export async function handleConflictResolutionReceipt(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  reservationId: string,
  merged: { head: GitSha; changedPaths: readonly string[] },
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  const mergeBase = conflictMarkerBase(record.intent);
  const { head, pr, branch } = record.target;
  if (mergeBase === null || head === null || pr === null || branch === null) {
    return {
      kind: "state_error",
      detail: "conflict resolution identity mismatch",
    };
  }
  const now = deps.clock.now();
  const settled = await deps.budget.settleModelStart({
    id: reservationId,
    outcome: "submitted",
    proofRef: null,
  });
  if (settled.status !== "settled" && settled.status !== "idempotent") {
    return { kind: "state_error", detail: "budget settlement failed" };
  }
  if (
    merged.changedPaths.some((path) =>
      touchesProtected(config.protectedPaths, path)
    )
  ) {
    return persistAfterSettlement(
      deps,
      context.bounds,
      replaceWorkMutation(
        markBlocked(record, "other", CONFLICT_PROTECTED_DETAIL, now),
      ),
    );
  }
  const resolved: IncompleteOperationV1 = {
    kind: "base_refresh",
    key: baseRefreshIntentKey(pr, head, mergeBase),
    startedAt: now,
    branch,
    expectedHead: head,
    observedBase: mergeBase,
    pr,
    requestId: null,
    resultId: merged.head,
    failure: conflictMarker(mergeBase, now),
  };
  // The accepted resolution is recorded in the SAME state commit as the
  // resolved intent (atomic memory + outcome).
  const successMemory = await attemptMemorySuccessMutationV1({
    record,
    now,
    runtimeSha: deps.controllerSha,
  });
  return persistAfterSettlement(deps, context.bounds, (draft) => {
    replaceWorkMutation({
      ...record,
      nextStep: "work",
      wait: null,
      blocker: null,
      intent: resolved,
      updatedAt: now,
    })(draft);
    successMemory(draft);
  });
}
