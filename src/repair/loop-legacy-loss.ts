/** Repair loop internals: legacy loss. */
import type {
  LegacyBaseRefreshLossProofV1,
  PortResultV1,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { candidateBranch } from "./keys.ts";
import { baseRefreshIntentKey } from "./loop-base-refresh.ts";
import { checkGithubCooldown } from "./loop-bounds.ts";
import {
  configFor,
  legacyDependenciesDone,
  sameRepositoryIdentity,
} from "./loop-records.ts";
import {
  hasBlockingFindings,
  headRejectedByReview,
} from "./loop-review-records.ts";
import { persistTransition, replaceWorkMutation } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { isWaiting } from "./selection.ts";
import { markBlocked } from "./transitions.ts";

// ---------------------------------------------------------------------------
// Legacy loss bridge: two guarded CAS commits turn ONE proven lost legacy
// base-refresh candidate into an ordinary charged retry. The bounded pass is
// strictly pre-ranking; the generic selector, blocked handling and every other
// transition stay unchanged.
// ---------------------------------------------------------------------------

/** Truthful static detail for a proven lost legacy candidate. */
export const LEGACY_LOSS_DETAIL =
  "legacy base-refresh candidate is missing; predecessor head pending";

export type LegacyLossPhaseV1 = "discover" | "restore";

export type LegacyLossBridgeResultV1 =
  | { kind: "progress" }
  | { kind: "none" }
  | { kind: "state_error"; detail: string };

/** Exact self scope-0 identity: `ubiquity-sentinel/sentinel` under the no-App scope. */
export function isSelfScopeZero(repository: RepositoryIdentityV1): boolean {
  return repository.installationId === 0 &&
    repository.owner === "ubiquity-sentinel" &&
    repository.name === "sentinel";
}

/**
 * Structural eligibility for the legacy-loss bridge. It matches ONLY a self
 * scope-0 issue with an absent candidateState and the original unprepared
 * base_refresh intent whose branch/PR/head/key/observedBase bind exactly to
 * the loaded record: implementation intents, new-format candidate records and
 * every other lifecycle are never touched. Discovery covers ordinary `work`;
 * restoration covers only the truthful missing_evidence blocker this bridge
 * writes, while an implementation attempt remains.
 */
export function legacyLossPhase(
  deps: RepairCycleDepsV1,
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  now: number,
): LegacyLossPhaseV1 | null {
  if (!isSelfScopeZero(record.repository)) return null;
  if (record.source.kind !== "issue" || record.related.incidentId !== null) {
    return null;
  }
  const issueNumber = record.related.issueNumber;
  if (issueNumber === null || record.source.id !== String(issueNumber)) {
    return null;
  }
  if (record.target.candidateState !== undefined) return null;
  const intent = record.intent;
  if (
    intent === null || intent.kind !== "base_refresh" ||
    intent.requestId !== null || intent.resultId !== null
  ) {
    return null;
  }
  const branch = record.target.branch;
  const head = record.target.head;
  const pr = record.target.pr;
  const observedBase = intent.observedBase;
  if (
    branch === null || head === null || pr === null || observedBase === null
  ) {
    return null;
  }
  if (
    branch !== candidateBranch(record.id) ||
    intent.branch !== branch || intent.expectedHead !== head ||
    intent.pr !== pr ||
    intent.key !== baseRefreshIntentKey(pr, head, observedBase)
  ) {
    return null;
  }
  if (isWaiting(record, now) || !legacyDependenciesDone(snapshot, record)) {
    return null;
  }
  if (configFor(deps, record.repository) === null) return null;
  if (record.nextStep === "work") return "discover";
  if (
    record.nextStep === "blocked" &&
    record.blocker?.kind === "missing_evidence"
  ) {
    return "restore";
  }
  return null;
}

/**
 * The proof's historical review must be the authentic completed H0/B0
 * correction review: exact scope, PR, predecessor head and lost base, the
 * configured trusted reviewer as both expected and observed identity, and at
 * least one unresolved P0/P1 finding.
 */
export function legacyLossReviewMatches(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  proof: LegacyBaseRefreshLossProofV1,
  reviewer: string,
): boolean {
  const review = snapshot.reviews.find((entry) => entry.id === proof.reviewId);
  if (review === undefined) return false;
  return review.outcome === "completed" && review.resultId !== null &&
    review.completedAt !== null && hasBlockingFindings(review) &&
    review.expectedReviewer === reviewer &&
    review.observedReviewer === reviewer &&
    review.pullRequest.number === proof.pr &&
    review.pullRequest.head === proof.predecessorHead &&
    review.pullRequest.base === proof.lostBase &&
    sameRepositoryIdentity(review.repository, record.repository);
}

/**
 * Independent re-validation of one runtime proof against the exact loaded
 * record and this run's authoritative state head. The proof's `stateHead` must
 * equal the head of the state read that produced the record — the snapshot's
 * own `stateHead` field is never current-head evidence.
 */
export function legacyLossProofMatches(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  proof: LegacyBaseRefreshLossProofV1,
): boolean {
  if (proof.shape !== "legacy_base_refresh") return false;
  if (proof.taskId !== record.id) return false;
  if (!sameRepositoryIdentity(proof.repository, record.repository)) {
    return false;
  }
  if (proof.stateHead !== context.head) return false;
  if (proof.lostBase !== record.target.base) return false;
  if (proof.lostHead !== record.target.head) return false;
  if (proof.branch !== record.target.branch) return false;
  if (proof.pr !== record.target.pr) return false;
  if (record.intent === null || proof.intentKey !== record.intent.key) {
    return false;
  }
  if (proof.predecessorHead === proof.lostHead) return false;
  return legacyLossReviewMatches(
    context.snapshot,
    record,
    proof,
    deps.github.reviewerIdentity,
  );
}

/** Ordinary restored tuple: H0 at B0, same branch/PR, no intent or blocker. */
export function legacyLossRestoredRecord(
  record: WorkRecordV1,
  proof: LegacyBaseRefreshLossProofV1,
  now: number,
): WorkRecordV1 {
  return {
    ...record,
    target: {
      ...record.target,
      base: proof.lostBase,
      branch: proof.branch,
      checkpoint: null,
      head: proof.predecessorHead,
      pr: proof.pr,
    },
    nextStep: "work",
    wait: null,
    blocker: null,
    intent: null,
    updatedAt: now,
  };
}

/**
 * Restoration is admitted only when the EXISTING head-rejection helper agrees
 * for the proposed H0 record: it reads the FIRST completed receipt for the
 * PR/head, so an earlier clean H0 receipt keeps the tuple blocked instead of
 * delivering a head the ordinary gate would treat as publish-ready.
 */
export function restoreLegacyLoss(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  proof: LegacyBaseRefreshLossProofV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const proposed = legacyLossRestoredRecord(record, proof, now);
  if (!headRejectedByReview(context.snapshot, proposed)) {
    return Promise.resolve({
      kind: "deferred",
      detail: "legacy predecessor head is not rejected by review",
    });
  }
  return persistTransition(
    deps,
    context,
    replaceWorkMutation(proposed),
    proof.stateHead,
  );
}

/**
 * Bounded pre-ranking pass over structurally eligible legacy records in stable
 * id order. Each phase is attempted at most once per run, marked BEFORE its
 * proof call. A shared state trust error stops the run; an ordinary cooldown
 * deferral, a thrown/unavailable proof or any proof mismatch defers the active
 * record and continues, so the first null/unavailable candidate can never
 * starve a later recoverable one. Null means no loss state change. The pass
 * stops at the first successful CAS (the caller reloads, counts the ordinary
 * step and returns to normal ranking) or at exhaustion/deadline.
 */
export async function bridgeLegacyLoss(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  attempted: Set<string>,
  deferred: Set<string>,
): Promise<LegacyLossBridgeResultV1> {
  const prove = deps.github.proveLegacyBaseRefreshLoss;
  if (prove === undefined) return { kind: "none" };
  const now = deps.clock.now();
  const ids = context.snapshot.work
    .filter((record) =>
      legacyLossPhase(deps, context.snapshot, record, now) !== null
    )
    .map((record) => record.id)
    .sort();
  for (const id of ids) {
    // No probe begins at/after the total run deadline: the proof is awaited
    // wall-clock work and every CAS must stay inside the same bound.
    if (deps.clock.now() >= context.bounds.runDeadline) return { kind: "none" };
    const record = context.snapshot.work.find((work) => work.id === id);
    if (record === undefined) continue;
    const phase = legacyLossPhase(deps, context.snapshot, record, now);
    if (phase === null) continue;
    const key = `${id}:${phase}`;
    if (attempted.has(key)) continue;
    attempted.add(key);
    const cooling = await checkGithubCooldown(
      deps,
      record.repository,
      context.bounds,
    );
    if (cooling.kind === "state_error") {
      return { kind: "state_error", detail: cooling.detail };
    }
    if (cooling.kind === "deferred") {
      deferred.add(id);
      continue;
    }
    let proof: PortResultV1<LegacyBaseRefreshLossProofV1 | null>;
    try {
      proof = await prove.call(deps.github, record.id);
    } catch {
      deferred.add(id);
      continue;
    }
    if (!proof.ok) {
      deferred.add(id);
      continue;
    }
    // Explicit "this record is not a legacy-loss case": an ordinary work
    // record needs no bridge mutation. A record that this bridge previously
    // parked as missing_evidence must be resumed, however; otherwise the
    // generic selector skips it forever and its saved base-refresh intent can
    // never reach executeBaseRefreshIntent, which owns candidate restoration.
    if (proof.value === null) {
      if (phase !== "restore") continue;
      const resumed = await persistTransition(
        deps,
        context,
        replaceWorkMutation({
          ...record,
          nextStep: "work",
          wait: null,
          blocker: null,
          updatedAt: deps.clock.now(),
        }),
      );
      if (resumed.kind === "progress") {
        // The same non-loss proof also covers the newly resumed discover
        // phase; do not spend a second remote proof before normal refresh
        // processing observes the exact task ref again.
        attempted.add(`${id}:discover`);
        return { kind: "progress" };
      }
      if (resumed.kind === "state_error") {
        return { kind: "state_error", detail: resumed.detail };
      }
      deferred.add(id);
      continue;
    }
    if (!legacyLossProofMatches(deps, context, record, proof.value)) {
      deferred.add(id);
      continue;
    }
    const persisted = phase === "discover"
      ? await persistTransition(
        deps,
        context,
        replaceWorkMutation(
          markBlocked(
            record,
            "missing_evidence",
            LEGACY_LOSS_DETAIL,
            deps.clock.now(),
          ),
        ),
        proof.value.stateHead,
      )
      : await restoreLegacyLoss(deps, context, record, proof.value);
    if (persisted.kind === "progress") return { kind: "progress" };
    if (persisted.kind === "state_error") {
      return { kind: "state_error", detail: persisted.detail };
    }
    deferred.add(id);
  }
  return { kind: "none" };
}
