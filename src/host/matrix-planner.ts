import { reconcileExistingPrs } from "../repair/loop-existing-pr.ts";
/** Trusted serialized planning, decomposition and admission diagnostics. */
import { deriveReservationId } from "../budget/mod.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  MATRIX_DECOMPOSE_AFTER_TIMEOUTS,
  MATRIX_PLAN_VERSION,
  matrixCellIdV1,
  type MatrixCellPlanV1,
  matrixDigestV1,
  type MatrixPlanV1,
  type MatrixRunIdentityV1,
  MAX_MATRIX_ARTIFACT_BYTES,
  MAX_MATRIX_CELLS,
} from "../contracts/matrix.ts";
import type { GitHubPort } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { implementationIntentKey } from "../repair/keys.ts";
import {
  createRunBounds,
  isMatrixImplementationReadyV1,
  loadRepairContext,
  type LoopContextV1,
  OPERATION_MARGIN_MS,
  prepareImplementationStart,
  type RepairCycleDepsV1,
} from "../repair/loop.ts";
import { attemptEquivalenceRefusalForRecordV1 } from "../repair/attempt-policy.ts";
import { planDeferredKey } from "./matrix-plan-diagnostic.ts";
import {
  classifyMatrixPlanRefusalV1,
  type MatrixPlanRefusalV1,
} from "./matrix-plan-refusal.ts";
import { ciCorrectionRouteOpen } from "../repair/ci-rejection.ts";
import { preReviewCiFixRouteOpen } from "../repair/ci-first-policy.ts";
import {
  conflictResolutionCapReached,
  conflictResolutionRouteOpen,
  conflictResolutionsInFlightIds,
  HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE,
  pendingConflictResolution,
} from "../repair/conflict-resolution.ts";
import {
  existingHeadContinuationShape,
  isStaleImplementationIntent,
  ownsPublishedArtifact,
  roundLeftForStart,
  unpublishedLocalCandidateShape,
} from "../repair/loop-eligibility.ts";
import { recoverClosedExistingHead } from "../repair/loop-existing-head-continuation.ts";
import type { StepResultV1 } from "../repair/loop-types.ts";
import type { LegacyCutoff } from "../repair/review-round-cap.ts";
import { rankEligibleWork } from "../repair/selection.ts";
import {
  createDecompositionChildren,
  isDecompositionChildId,
  markBlocked,
} from "../repair/transitions.ts";
import {
  persistTransition,
  replaceWorkMutation,
} from "../repair/loop-state.ts";
import { configForRepository } from "./matrix-identity.ts";
import {
  isNoTestEvidenceTargetV1,
  NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER,
  NO_CI_AND_NO_LOCAL_VERIFY_DETAIL,
} from "./target-policy-generic.ts";

export interface MatrixPlanOptionsV1 {
  waveId: string;
  run: MatrixRunIdentityV1;
  /** Trusted runtime implementation revision the wave is running. */
  runtimeSha: GitSha;
  /** Trusted hosted runtime pointer generation the wave is running. */
  generation: number;
  /** Absolute planner deadline; clamped by the shared run ceiling. */
  deadline: number;
  plannedAt: number;
  runStartedAt?: number;
  modelStartsEnabled?: boolean;
  /** Exact target source port while ranking all repositories on one shared budget/state. */
  githubForRepository?: (repository: RepositoryIdentityV1) => GitHubPort;
  /**
   * Optional planning bound. Defaults to the platform matrix ceiling
   * (`MAX_MATRIX_CELLS`) and is never allowed above it.
   */
  maxCells?: number;
}

export interface MatrixPlanReportV1 {
  plan: MatrixPlanV1;
  /** Ranked records this planner considered. */
  attempted: number;
  /** Grants admitted into the plan. */
  prepared: number;
  /** Considered records that are not fresh implementation starts. */
  notReady: number;
  /** Records whose preparation persisted a wait/refusal step instead. */
  deferred: number;
  /**
   * Ready records whose admission was refused by durable attempt memory
   * because the attempt would replay failures already recorded at this base
   * and runtime revision. Nothing is charged and the record stays untouched;
   * changed evidence (a moved base, a new runtime revision, the transient
   * decay window) or the transient allowance re-opens admission on a later
   * plan.
   */
  memoryRefused: number;
  /** Closed refusal reason and ready-unplanned count of this pass (#335). */
  refusal?: MatrixPlanRefusalV1;

  /**
   * Diagnostic breakdown of why records were filtered. Present when the
   * planner found zero eligible work; used to identify intake/planner bugs.
   */
  diagnostic?: MatrixPlanDiagnosticV1;
}

/** Why the planner filtered records, for debugging zero-cell runs. */
export interface MatrixPlanDiagnosticV1 {
  /** Total work records in the snapshot. */
  totalRecords: number;
  /** Records skipped by rankEligibleWork, grouped by skip reason. */
  skippedByReason: Record<string, number>;
  /** Records in ranked order that failed isMatrixImplementationReadyV1, grouped by specific filter. */
  notReadyByReason: Record<string, number>;
  /** Sample record IDs for each not-ready reason (max 3 per reason). */
  notReadySamples: Record<string, string[]>;
  /** Records whose preparation was attempted on the last iteration. */
  attempted?: number;
  /** Attempted records whose preparation returned a step instead of a cell. */
  deferred?: number;
  /** Closed per-reason histogram of those preparation outcomes. */
  deferredByReason?: Record<string, number>;
  /**
   * Present when the conflict-resolution cap was full on the last read, so
   * every pending resolution was held back (`notReadyByReason` counts them as
   * `conflictResolutionCap`): the cap and the ids of the in-flight
   * resolutions holding it (`conflictResolutionsInFlightIds`).
   */
  conflictResolutionCap?: { cap: number; inFlight: string[] };
  /**
   * The same two breakdowns per repository (`owner/name`), for the hosted
   * `sentinel_matrix_plan_diagnostic` line (`matrix-plan-diagnostic.ts`).
   */
  byRepository?: Record<string, MatrixPlanRepositoryCountsV1>;
}

/** One repository's share of a zero-cell plan diagnostic. */
export interface MatrixPlanRepositoryCountsV1 {
  skippedByReason: Record<string, number>;
  notReadyByReason: Record<string, number>;
}

/** Not-ready reason of a pending conflict resolution held back by the cap. */
export const CONFLICT_RESOLUTION_CAP_REASON = "conflictResolutionCap";

/**
 * Decomposition helpers: split a repeatedly-timed-out issue into serial
 * sub-tasks so a host timeout discards at most one part's work.
 */

/** Work records already created for this parent's decomposition. */
function decompositionChildrenOf(
  snapshot: { work: readonly { id: string }[] },
  parentId: string,
): string[] {
  const prefix = parentId + ":part-";
  return snapshot.work
    .map((w) => w.id)
    .filter((id) => id.startsWith(prefix) && isDecompositionChildId(id));
}

/**
 * True when the planner should decompose this record instead of granting the
 * whole issue again: it is a whole issue (not itself a part), it has timed
 * out at least MATRIX_DECOMPOSE_AFTER_TIMEOUTS times, it has no candidate or
 * pull request of its own, and it has no children yet. Children never
 * decompose further (no infinite recursion).
 */
export function isDecompositionEligible(
  record: {
    id: string;
    source: { kind: string };
    counters: { timeouts?: number };
    target: { head: string | null; pr: number | null };
  },
  snapshot: { work: readonly { id: string }[] },
): boolean {
  if (record.source.kind !== "issue") return false;
  if (isDecompositionChildId(record.id)) return false;
  // A record in correction already owns a candidate and pull request; splitting
  // it would orphan that publication, so only a fresh implementation splits.
  if (record.target.head !== null || record.target.pr !== null) return false;
  if ((record.counters.timeouts ?? 0) < MATRIX_DECOMPOSE_AFTER_TIMEOUTS) {
    return false;
  }
  return decompositionChildrenOf(snapshot, record.id).length === 0;
}

/**
 * Persist decomposition children for a timed-out parent. Idempotent: if any
 * child already exists the write is skipped. Returns true when children are
 * present afterwards (either pre-existing or newly persisted).
 */
async function persistDecompositionChildren(
  deps: RepairCycleDepsV1,
  parent: WorkRecordV1,
  now: number,
): Promise<boolean> {
  const read = await deps.state.readRepair();
  if (!read.ok || read.value.status !== "found") return false;
  const snapshot = read.value.snapshot;
  if (decompositionChildrenOf(snapshot, parent.id).length > 0) return true;
  const freshParent = snapshot.work.find((w) => w.id === parent.id);
  if (freshParent === undefined) return false;
  const children = createDecompositionChildren(freshParent, now);
  // The write binds the head this read observed (as every other state writer
  // does); only an applied write persists the children.
  const next = {
    ...snapshot,
    stateHead: read.value.head,
    work: [...snapshot.work, ...children],
    sequence: snapshot.sequence + 1,
    updatedAt: Math.max(now, snapshot.updatedAt),
  };
  const written = await deps.state.writeRepair(next, read.value.head);
  return written.ok && written.value.status === "applied";
}

/**
 * Explains why a record fails isMatrixImplementationReadyV1. Returns null if
 * the record passes all checks (except the head review check, which needs
 * snapshot context and is reported as "head-not-null" for further inspection).
 * Mirrors the predicate logic exactly for diagnostic purposes.
 */
export function explainMatrixNotReady(
  record: WorkRecordV1,
  config: RepositoryConfigV1,
  /** The snapshot, CI route and legacy cutoff of the planning run (#159). */
  snapshot: Parameters<typeof roundLeftForStart>[0],
  ciRouteOpen: boolean,
  cutoff: LegacyCutoff,
): string | null {
  if (record.source.kind !== "issue") {
    return `source.kind=${record.source.kind}`;
  }
  // A record this planner already parked for missing test evidence keeps that
  // closed reason in every later diagnostic instead of reporting the parked
  // next step it now has.
  if (record.blocker?.message.startsWith(NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER)) {
    return NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER;
  }
  if (record.nextStep !== "work") {
    return `nextStep=${record.nextStep}`;
  }
  // The target's own evidence policy is the reason it is never planned, with
  // or without a retained intent; report it before the intent/round filters.
  if (isNoTestEvidenceConfig(config)) {
    return NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER;
  }
  if (!roundLeftForStart(snapshot, record, ciRouteOpen, cutoff)) {
    return "review_rounds_spent";
  }
  if (record.intent !== null) {
    return `intent=${record.intent.key}`;
  }
  const candidateState = record.target.candidateState;
  // A published head with no descriptor is admitted through the
  // existing-published-head continuation, and a preserved-null record that owns
  // no publishable artifact at all (no PR, no published head) is released to a
  // fresh base start, so neither is a refusal reason.
  if (
    candidateState !== undefined && candidateState.preserved === null &&
    ownsPublishedArtifact(record) && !existingHeadContinuationShape(record)
  ) {
    return "candidateState.preserved=null";
  }
  if (record.target.branch === null) {
    return "target.branch=null";
  }
  if (config.sessionBound === null) {
    return "config.sessionBound=null";
  }
  if (
    record.target.head !== null && !unpublishedLocalCandidateShape(record)
  ) {
    // A continuation record is eligible on its snapshot shape; its exact head
    // is re-proved against the live pull request and its CI at admission, so a
    // refused one is named by this start kind, never by a missing head.
    return existingHeadContinuationShape(record)
      ? "existing_head_continuation_live"
      : "target.head-not-null";
  }
  return null;
}

/** Defensive read: some callers pass a partial config to the explainer. */
function isNoTestEvidenceConfig(config: RepositoryConfigV1): boolean {
  return config.commands !== undefined && isNoTestEvidenceTargetV1(config);
}

/**
 * Trusted planner-side park for a target with no merge test evidence. Such a
 * record must never become a matrix cell: its admission would park it before
 * any carrier exists, failing the cell and the whole supervisor run. The park
 * is written here, before any reservation, in ONE state transition; it is
 * uncharged and carries the same blocker/detail the admission would have
 * written. Returns the number of records parked and whether the state write
 * failed closed.
 */
async function parkNoTestEvidenceRecords(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  ordered: readonly string[],
  now: number,
  attemptedIds: Set<string>,
  ciRouteOpen: boolean,
  conflictRouteOpen: boolean,
  preReviewRouteOpen: boolean,
): Promise<{ parked: number; stateError: boolean }> {
  const parked: WorkRecordV1[] = [];
  for (const id of ordered) {
    if (attemptedIds.has(id)) continue;
    const record = context.snapshot.work.find((work) => work.id === id);
    if (record === undefined) continue;
    // A live intent keeps its own owner. A stale implementation intent (a run
    // that died after reserving and never settled) is parkable exactly like
    // the admission park, and `markBlocked` keeps it for audit as it does for
    // every other park; otherwise this target would idle at `work` forever.
    if (
      record.intent !== null && !isStaleImplementationIntent(record.intent, now)
    ) continue;
    const config = configForRepository(deps, record.repository);
    if (config === null || !isNoTestEvidenceConfig(config)) continue;
    if (
      !isMatrixImplementationReadyV1(
        record,
        context.snapshot,
        config,
        now,
        ciRouteOpen,
        conflictRouteOpen,
        preReviewRouteOpen,
        context.legacyReviewCutoff ?? null,
      )
    ) continue;
    parked.push(
      markBlocked(
        record,
        "missing_evidence",
        NO_CI_AND_NO_LOCAL_VERIFY_DETAIL,
        now,
      ),
    );
  }
  if (parked.length === 0) return { parked: 0, stateError: false };
  const written = await persistTransition(deps, context, (draft) => {
    for (const record of parked) replaceWorkMutation(record)(draft);
  });
  for (const record of parked) attemptedIds.add(record.id);
  if (written.kind !== "progress") {
    return { parked: 0, stateError: true };
  }
  return { parked: parked.length, stateError: false };
}

/** The closed reason a parked no-test-evidence record is counted under. */
const NO_TEST_EVIDENCE_REASON = NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER;

/**
 * Builds a diagnostic breakdown of why the planner filtered records.
 * `explainNotReady` returns the specific filter reason for a record in
 * ranked order, or null if the record is ready.
 */
function buildPlanDiagnostic(
  snapshot: { work: readonly WorkRecordV1[] },
  ranked: { ordered: string[]; skipped: Record<string, string> },
  explainNotReady: (record: WorkRecordV1) => string | null,
): MatrixPlanDiagnosticV1 {
  const skippedByReason: Record<string, number> = {};
  const workById = new Map<string, WorkRecordV1>(
    snapshot.work.map((w) => [w.id as string, w]),
  );
  const byRepository: Record<string, MatrixPlanRepositoryCountsV1> = {};
  const countsOf = (record: WorkRecordV1 | undefined) => {
    if (record === undefined) return null;
    const key = `${record.repository.owner}/${record.repository.name}`;
    return byRepository[key] ??= { skippedByReason: {}, notReadyByReason: {} };
  };
  for (const [id, reason] of Object.entries(ranked.skipped)) {
    const record = workById.get(id);
    // These parked records are counted under their specific reason below.
    if (
      record?.blocker?.message.startsWith(NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER)
    ) {
      continue;
    }
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
    const counts = countsOf(record);
    if (counts !== null) {
      counts.skippedByReason[reason] = (counts.skippedByReason[reason] ?? 0) +
        1;
    }
  }
  const notReadyByReason: Record<string, number> = {};
  const notReadySamples: Record<string, string[]> = {};
  const counted = new Set<string>();
  const countNotReady = (record: WorkRecordV1, reason: string) => {
    counted.add(record.id);
    notReadyByReason[reason] = (notReadyByReason[reason] ?? 0) + 1;
    const counts = countsOf(record)!;
    counts.notReadyByReason[reason] = (counts.notReadyByReason[reason] ?? 0) +
      1;
    const samples = notReadySamples[reason] ?? [];
    if (samples.length < 3) samples.push(record.id);
    notReadySamples[reason] = samples;
  };
  for (const id of ranked.ordered) {
    const record = workById.get(id);
    if (record === undefined) continue;
    const reason = explainNotReady(record);
    if (reason === null) continue;
    countNotReady(record, reason);
  }
  // A no-test-evidence record this planner parked is ranked as `blocked` on
  // the next iteration. Keep it counted under its own closed reason so an
  // all-parked plan still says why it planned no cell.
  for (const record of snapshot.work) {
    if (counted.has(record.id)) continue;
    if (
      !record.blocker?.message.startsWith(NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER)
    ) {
      continue;
    }
    countNotReady(record, NO_TEST_EVIDENCE_REASON);
  }
  return {
    totalRecords: snapshot.work.length,
    skippedByReason,
    notReadyByReason,
    notReadySamples,
    byRepository,
  };
}

/**
 * Trusted planner. Only records whose NEXT step is a fresh implementation
 * start receive a grant (`isMatrixImplementationReadyV1`); review, delivery,
 * correction, preservation and already-intended records are left to the
 * ordinary serial lifecycle. Every admitted grant has a durable reservation, a
 * persisted implementation intent and the exact request the cell will run; the
 * planner re-reads authoritative state before each candidate.
 *
 * Decomposition: a whole issue that has timed out MATRIX_DECOMPOSE_AFTER_TIMEOUTS
 * times is split into serial sub-tasks instead of being granted whole again.
 * The parent is skipped while its children exist; children chain via
 * dependencies so each part's cell starts from the previous part's merged
 * base. A timeout then discards at most one part's work.
 */
export async function planMatrixWave(
  deps: RepairCycleDepsV1,
  options: MatrixPlanOptionsV1,
): Promise<MatrixPlanReportV1> {
  const bounds = createRunBounds(deps, {
    deadline: options.deadline,
    runStartedAt: options.runStartedAt,
    modelStartsEnabled: options.modelStartsEnabled,
  });
  // Grant publication precedes native scheduling and target preparation. Keep
  // one existing operation margin for that handoff; cells retain full bounds.
  bounds.runDeadline -= OPERATION_MARGIN_MS;
  const limit = Math.min(
    options.maxCells ?? MAX_MATRIX_CELLS,
    MAX_MATRIX_CELLS,
  );
  const attemptedIds = new Set<string>();
  const takeoverAttempted = new Set<string>();
  const publicationAttempted = new Set<string>();
  const takeoverRefused = new Set<string>();
  const cells: MatrixCellPlanV1[] = [];
  const manifest = (entries: MatrixCellPlanV1[]): MatrixPlanV1 => ({
    version: MATRIX_PLAN_VERSION,
    kind: "matrix_plan",
    waveId: options.waveId,
    run: options.run,
    plannedAt: options.plannedAt,
    cells: entries,
  });
  let attempted = 0;
  let deferred = 0;
  let notReady = 0;
  const deferredByReason: Record<string, number> = {};
  // Diagnostic: captured from the last planner iteration for zero-cell runs.
  let lastDiagnostic: MatrixPlanDiagnosticV1 | null = null;
  let memoryRefused = 0;
  let noTestEvidenceParked = 0;
  // #335: why ready records stayed unplanned (see matrix-plan-refusal.ts).
  let stoppedByDeadline = false;
  let lastReadyIds: string[] | null = null;
  // A CI correction is granted only where its cell survives a rollback
  // (`ciCorrectionRouteOpen`): in process, and in hosted runs from generation
  // 78, whose rollback target isolates the cell.
  const ciRouteOpen = ciCorrectionRouteOpen(deps);
  // A pending refresh-conflict resolution is granted only where its cell
  // survives a rollback (`conflictResolutionRouteOpen`): in process, and in
  // hosted runs from generation 79, whose rollback target isolates the cell.
  const conflictRouteOpen = conflictResolutionRouteOpen(deps);
  // A pre-review CI fix is granted only where its cell survives a rollback
  // (`preReviewCiFixRouteOpen`): closed in hosted generation-80 runs, whose
  // rollback target refused the cell, and open from generation 81, whose
  // rollback target R80 isolates it.
  const preReviewRouteOpen = preReviewCiFixRouteOpen(deps);

  while (cells.length < limit) {
    const readAt = deps.clock.now();
    if (
      readAt >= bounds.modelCutoff ||
      !deps.configs.some((config) =>
        config.sessionBound !== null &&
        readAt + config.sessionBound.maxDurationMs + OPERATION_MARGIN_MS <
          bounds.runDeadline
      )
    ) {
      stoppedByDeadline = true;
      break;
    }
    const context = await loadRepairContext(deps, bounds);
    if (context === null) break;
    const now = deps.clock.now();
    if (now >= bounds.modelCutoff || now >= bounds.runDeadline) {
      stoppedByDeadline = true;
      break;
    }
    const takeover = await reconcileExistingPrs(
      deps,
      context,
      takeoverAttempted,
      takeoverRefused,
      options.githubForRepository === undefined
        ? undefined
        : (record) => options.githubForRepository!(record.repository),
    );
    if (takeover !== null) {
      if (takeover.kind === "state_error" || takeover.kind === "margin") break;
      if (takeover.kind === "deferred") deferred++;
      continue;
    }
    const ranked = rankEligibleWork(context.snapshot, deps.configs, now);
    // Closed own publications need deterministic recovery, not an implementation
    // grant. Run it before readiness filtering, including preserved-null rows
    // that have no recorded published head and cannot be continuations yet.
    let publication: StepResultV1 | null = null;
    for (const id of ranked.ordered) {
      if (publicationAttempted.has(id)) continue;
      const row = context.snapshot.work.find((work) => work.id === id);
      if (
        row?.nextStep !== "work" ||
        row.target.candidateState?.preserved !== null
      ) continue;
      publicationAttempted.add(id);
      publication = await recoverClosedExistingHead(
        options.githubForRepository === undefined
          ? deps
          : { ...deps, github: options.githubForRepository(row.repository) },
        context,
        row,
      );
      if (publication !== null) break;
    }
    if (publication !== null) {
      if (publication.kind === "state_error" || publication.kind === "margin") {
        break;
      }
      if (publication.kind === "deferred") deferred++;
      continue;
    }
    // At most HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE resolutions in flight, on
    // this fresh read (this wave's grants, earlier cells, kept receipts): a
    // rollback isolates every one still unconsumed at `work`; one it already
    // isolated, or admitted past its cell artifact's retention, holds no
    // slot. A pending one past the cap is not considered (nothing charged or
    // written) and stays pending.
    const conflictCapReached = conflictResolutionCapReached(
      context.snapshot,
      now,
    );
    // Capture diagnostic on every iteration; the last one explains a zero-cell result.
    lastDiagnostic = buildPlanDiagnostic(
      context.snapshot,
      ranked,
      (record) => {
        if (
          conflictCapReached &&
          pendingConflictResolution(record.intent) !== null
        ) return CONFLICT_RESOLUTION_CAP_REASON;
        const config = configForRepository(deps, record.repository);
        return config === null ? "config=null" : explainMatrixNotReady(
          record,
          config,
          context.snapshot,
          ciRouteOpen,
          context.legacyReviewCutoff ?? null,
        );
      },
    );
    if (conflictCapReached) {
      lastDiagnostic.conflictResolutionCap = {
        cap: HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE,
        inFlight: conflictResolutionsInFlightIds(context.snapshot, now),
      };
    }
    // A no-test-evidence target can never produce merge evidence. Park it in
    // the trusted planner before any reservation/cell exists instead of
    // admitting a cell whose own admission would only park it (issue #282).
    const parkOutcome = await parkNoTestEvidenceRecords(
      deps,
      context,
      ranked.ordered,
      now,
      attemptedIds,
      ciRouteOpen,
      conflictRouteOpen,
      preReviewRouteOpen,
    );
    attempted += parkOutcome.parked;
    noTestEvidenceParked += parkOutcome.parked;
    if (parkOutcome.stateError) break;
    const isReady = (id: string) => {
      const record = context.snapshot.work.find((work) => work.id === id);
      if (record === undefined) return false;
      if (
        conflictCapReached && pendingConflictResolution(record.intent) !== null
      ) return false;
      // A decomposed parent is superseded by its children; grant the parts,
      // never the whole issue again.
      if (decompositionChildrenOf(context.snapshot, record.id).length > 0) {
        return false;
      }
      const config = configForRepository(deps, record.repository);
      return config !== null && !isNoTestEvidenceConfig(config) &&
        isMatrixImplementationReadyV1(
          record,
          context.snapshot,
          config,
          now,
          ciRouteOpen,
          conflictRouteOpen,
          preReviewRouteOpen,
          context.legacyReviewCutoff ?? null,
        );
    };
    lastReadyIds = ranked.ordered.filter(isReady);
    const nextId = ranked.ordered.find((id) =>
      !attemptedIds.has(id) && !takeoverRefused.has(id) && isReady(id)
    );
    if (nextId === undefined) break;
    attemptedIds.add(nextId);
    const record = context.snapshot.work.find((work) => work.id === nextId);
    if (record === undefined) continue;
    const config = configForRepository(deps, record.repository);
    if (config === null) continue;
    attempted++;
    if (
      isNoTestEvidenceConfig(config) ||
      !isMatrixImplementationReadyV1(
        record,
        context.snapshot,
        config,
        now,
        ciRouteOpen,
        conflictRouteOpen,
        preReviewRouteOpen,
        context.legacyReviewCutoff ?? null,
      )
    ) {
      notReady++;
      continue;
    }
    // Decomposition: a repeatedly-timed-out issue is split into serial
    // sub-tasks instead of being granted whole again. Skip the parent this
    // wave; the children enter normal selection on the next wave. This is a
    // structured strategy change, so it takes precedence over the memory gate.
    // A pending conflict resolution continues one published candidate and is
    // never decomposed.
    if (
      pendingConflictResolution(record.intent) === null &&
      isDecompositionEligible(record, context.snapshot)
    ) {
      const decomposed = await persistDecompositionChildren(deps, record, now);
      if (decomposed) continue;
      // Persist failed: fall through to a normal grant rather than stalling.
    }
    // Durable attempt memory gate: a ready record whose next attempt would be
    // equivalent to failures already recorded at this base and runtime
    // revision is skipped for this wave. Nothing is charged or written; the
    // refusal is counted in the report so the loop breaker is observable.
    if (
      attemptEquivalenceRefusalForRecordV1({
        record,
        snapshot: context.snapshot,
        now,
        runtimeSha: deps.controllerSha,
      }).refuse
    ) {
      memoryRefused++;
      continue;
    }
    const outcome = await prepareImplementationStart(
      options.githubForRepository === undefined
        ? deps
        : { ...deps, github: options.githubForRepository(record.repository) },
      context,
      record,
      config,
      async (request) => {
        const reservationId = await deriveReservationId({
          repository: record.repository,
          taskId: record.id,
          head: request.base,
          attempt: record.counters.attempts + 1,
          purpose: record.counters.attempts === 0 ? "implementation" : "retry",
        });
        const candidate: MatrixCellPlanV1 = {
          cellId: await matrixCellIdV1(
            options.waveId,
            record.id,
            reservationId,
          ),
          taskId: record.id,
          repository: record.repository,
          reservationId,
          intentKey: implementationIntentKey(reservationId),
          expectedBase: request.base,
          runtimeSha: options.runtimeSha,
          generation: options.generation,
          requestDigest: await matrixDigestV1(request),
          request,
        };
        // Use exactly the publisher's formatting and UTF-8 byte count BEFORE
        // any reservation/attempt/intent is saved. Smaller later tasks may fit.
        return new TextEncoder().encode(
          JSON.stringify(manifest([...cells, candidate]), null, 2) + "\n",
        ).length <= MAX_MATRIX_ARTIFACT_BYTES;
      },
      // The planner authorizes the existing-published-head continuation: a
      // custody_ready record with no preserved candidate is corrected on its
      // exact published head (the admission re-proves that head and its live
      // CI failure before anything is charged) instead of a fresh start from
      // the base, which would overwrite the unverified head.
      { existingHeadContinuation: true },
    );
    if (outcome.kind !== "prepared") {
      deferred++;
      const waitReason = context.snapshot.work.find((entry) =>
        entry.id === record.id
      )?.wait?.reason;
      const reason = planDeferredKey(outcome, waitReason);
      deferredByReason[reason] = (deferredByReason[reason] ?? 0) + 1;
      // An ordinary fresh-base refresh is progress, not a failed admission.
      // Reconsider that same task against its persisted current base.
      if (outcome.kind === "progress") {
        const refreshed = await deps.state.readRepair();
        if (
          refreshed.ok && refreshed.value.status === "found" &&
          refreshed.value.snapshot.work.some((entry) =>
            entry.id === record.id && entry.target.base !== record.target.base
          )
        ) {
          attemptedIds.delete(record.id);
        }
      }
      continue;
    }
    const request = outcome.request;
    const cellId = await matrixCellIdV1(
      options.waveId,
      record.id,
      outcome.reservationId,
    );
    cells.push({
      cellId,
      taskId: record.id,
      repository: outcome.record.repository,
      reservationId: outcome.reservationId,
      intentKey: outcome.record.intent?.key ??
        implementationIntentKey(outcome.reservationId),
      expectedBase: request.base,
      runtimeSha: options.runtimeSha,
      generation: options.generation,
      requestDigest: await matrixDigestV1(request),
      request,
    });
  }

  return {
    plan: { ...manifest(cells), plannedAt: deps.clock.now() },
    attempted,
    prepared: cells.length,
    notReady,
    deferred,
    // Include the diagnostic when no cells were prepared; it explains why.
    ...((cells.length === 0 || noTestEvidenceParked > 0) &&
        lastDiagnostic !== null
      ? {
        diagnostic: memoryRefused === 0
          ? { ...lastDiagnostic, attempted, deferred, deferredByReason }
          : {
            ...lastDiagnostic,
            attempted,
            deferred,
            deferredByReason: {
              ...deferredByReason,
              memory_refused: (deferredByReason.memory_refused ?? 0) +
                memoryRefused,
            },
          },
      }
      : {}),
    memoryRefused,
    refusal: classifyMatrixPlanRefusalV1({
      prepared: cells.length,
      readyIds: lastReadyIds,
      plannedTaskIds: new Set(cells.map((cell) => cell.taskId as string)),
      stoppedByDeadline,
      modelStartsDisabled: bounds.modelCutoff === Number.NEGATIVE_INFINITY,
      deferredByReason,
      memoryRefused,
    }),
  };
}

// ---------------------------------------------------------------------------
// Cell
// ---------------------------------------------------------------------------
