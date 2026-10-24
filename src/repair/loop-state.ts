/** Repair loop internals: state. */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { configFor } from "./loop-records.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  RunBoundsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  buildMemoryLessonsV1,
  memoryLessonsSourceDigestV1,
} from "./memory-lessons.ts";
import { noteExecution } from "./transitions.ts";

/**
 * True when one execution advanced the record's durable shape. The lifecycle
 * step, the published target, the intent identity, the blocker, the terminal
 * step and the charged counters all count; a re-armed wait, a fresh wait
 * timestamp and free-text notes alone do not, because they leave the record
 * exactly where a later run will find it.
 */
export function executionAdvanced(
  before: WorkRecordV1,
  after: WorkRecordV1,
): boolean {
  if (after.nextStep !== before.nextStep) return true;
  if (after.blocker?.message !== before.blocker?.message) return true;
  if (after.target.base !== before.target.base) return true;
  if (after.target.head !== before.target.head) return true;
  if (after.target.pr !== before.target.pr) return true;
  if (
    after.target.candidateState?.publishedHead !==
      before.target.candidateState?.publishedHead
  ) {
    return true;
  }
  if (after.intent?.key !== before.intent?.key) return true;
  if (after.intent?.resultId !== before.intent?.resultId) return true;
  if (after.counters.attempts !== before.counters.attempts) return true;
  if (after.counters.retries !== before.counters.retries) return true;
  if (after.counters.reviewRounds !== before.counters.reviewRounds) return true;
  return false;
}

// ---------------------------------------------------------------------------
// State load/commit (expected-head compare-and-swap, never force overwrite).
// Context mutates in place after every applied write so a later commit in the
// same step never races its own earlier checkpoint.
// ---------------------------------------------------------------------------

/**
 * Rearm only authentic historical emissions of the retired implementation
 * ceiling. The historical review-round ceiling block ("review rounds exhausted
 * without an accepted verdict (...)") is no longer re-armed into review: the
 * hard three-round ceiling (owner decision 2026-10-16) keeps it blocked.
 */
export function retiredCapNextStep(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
): "work" | null {
  if (
    record.nextStep !== "blocked" || record.blocker?.kind !== "review_quota" ||
    record.intent !== null || record.wait !== null ||
    configFor(deps, record.repository) === null
  ) return null;
  if (
    record.counters.attempts >= 4 &&
    record.blocker.message === "implementation attempt budget exhausted"
  ) return "work";
  return null;
}

export async function loadSnapshot(
  deps: RepairCycleDepsV1,
  bounds: RunBoundsV1,
): Promise<LoopContextV1 | null> {
  const read = await deps.state.readRepair();
  if (!read.ok || read.value.status === "absent") return null;
  const context: LoopContextV1 = {
    snapshot: read.value.snapshot,
    head: read.value.head,
    bounds,
    executionBaseline: null,
    legacyReviewCutoff: deps.legacyReviewCutoff ?? null,
  };
  if (
    deps.clock.now() < bounds.runDeadline &&
    context.snapshot.work.some((record) =>
      retiredCapNextStep(deps, record) !== null
    )
  ) {
    const now = deps.clock.now();
    const restored = await persistTransition(deps, context, (draft) => {
      draft.work = draft.work.map((record) => {
        const nextStep = retiredCapNextStep(deps, record);
        return nextStep === null
          ? record
          : { ...record, nextStep, blocker: null, updatedAt: now };
      });
    });
    if (restored.kind !== "progress") return null;
  }
  return context;
}

/**
 * Trusted fresh-state load for the matrix planner and ingester: the exact same
 * authoritative read and context shape the repair cycle uses. An absent or
 * unavailable state returns null, and the caller fails closed instead of
 * planning or ingesting against a fabricated empty state.
 */
export async function loadRepairContext(
  deps: RepairCycleDepsV1,
  bounds: RunBoundsV1,
): Promise<LoopContextV1 | null> {
  return await loadSnapshot(deps, bounds);
}

/** Seed the repair branch once with sequence 1 when no snapshot exists. */
export async function seedSnapshot(
  deps: RepairCycleDepsV1,
  bounds: RunBoundsV1,
): Promise<LoopContextV1 | null> {
  const now = deps.clock.now();
  const seed = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: now,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  const written = await deps.state.writeRepair(seed, null);
  if (!written.ok || written.value.status !== "applied") return null;
  return {
    snapshot: seed,
    head: written.value.head,
    bounds,
    executionBaseline: null,
    legacyReviewCutoff: deps.legacyReviewCutoff ?? null,
  };
}

/**
 * Bounded recomputation of one checkpoint after a lost compare-and-swap. The
 * shared cooldown gate writes `githubCooldowns` through the same store from
 * concurrent GitHub requests (a reviewer's HTTP calls run beside the loop), so
 * the loop's own write can lose its CAS to a cooldown-only movement between
 * its synchronized read and its push. Each retry re-synchronizes first, which
 * admits only cooldown-only movement, and recomputes the whole draft on the
 * fresh base; any other movement, ambiguity or rejection still fails closed.
 */
const CHECKPOINT_CAS_ATTEMPTS = 3;

export async function persistTransition(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  mutate: (draft: RepairStateSnapshotV1) => void,
  proofHead?: GitSha,
): Promise<StepResultV1> {
  for (let attempt = 1; attempt <= CHECKPOINT_CAS_ATTEMPTS; attempt++) {
    const written = await persistTransitionOnce(
      deps,
      context,
      mutate,
      proofHead,
    );
    // A proof bound to one exact head can never be satisfied once the head
    // provably moved (the CAS store never rewinds), so a recomputation would
    // only spend another read before the same stale-proof deferral (#206).
    if (written.kind === "lost_cas" && proofHead !== undefined) {
      return { kind: "deferred", detail: STALE_PROOF_DETAIL };
    }
    if (written.kind !== "lost_cas" || attempt === CHECKPOINT_CAS_ATTEMPTS) {
      return written.kind === "lost_cas"
        ? { kind: "state_error", detail: CHECKPOINT_CAS_DETAIL }
        : written;
    }
  }
  return { kind: "state_error", detail: CHECKPOINT_CAS_DETAIL };
}

const CHECKPOINT_CAS_DETAIL = "checkpoint CAS conflict or ambiguity";
const STALE_PROOF_DETAIL =
  "state head moved after the trusted proof was established";

async function persistTransitionOnce(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  mutate: (draft: RepairStateSnapshotV1) => void,
  proofHead?: GitSha,
): Promise<StepResultV1 | { kind: "lost_cas" }> {
  // Safe snapshot synchronization: the durable cooldown gate writes
  // githubCooldowns through the SAME repair state store, so the authoritative
  // head may have moved since this context was loaded (also covering the
  // reread after intake). A moved head is accepted ONLY when the canonical
  // non-cooldown contents are unchanged — admitting own cooldown-only writes
  // but never blindly applying a stale work mutation atop another writer.
  const synchronized = await synchronizeSnapshot(deps, context);
  if (synchronized.status === "unavailable") {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  if (synchronized.status === "conflict") {
    return {
      kind: "state_error",
      detail: "repair state moved with conflicting contents",
    };
  }
  // A caller that carries a proof bound to one exact authoritative state head
  // requires the reread to still BE that head. Even an admitted cooldown-only
  // movement makes the proof stale, so the mutation is refused before the
  // draft is built: no state is written and the caller defers the record.
  if (proofHead !== undefined && synchronized.head !== proofHead) {
    return { kind: "deferred", detail: STALE_PROOF_DETAIL };
  }
  const base = synchronized.snapshot;
  const draft: RepairStateSnapshotV1 = {
    ...base,
    stateHead: synchronized.head,
    sequence: base.sequence + 1,
    updatedAt: deps.clock.now(),
    incidents: [...base.incidents],
    evidence: [...base.evidence],
    work: [...base.work],
    reservations: [...base.reservations],
    reviews: [...base.reviews],
    replays: [...base.replays],
    releaseRequests: [...base.releaseRequests],
    // The draft always clones the cooldown records: a synthesized snapshot
    // never shares (or mutates) the gate's persisted array.
    githubCooldowns: [...base.githubCooldowns],
    attemptMemory: [...base.attemptMemory],
    lessons: [...base.lessons],
  };
  mutate(draft);
  // Canonical array order: the state store's read path orders every collection
  // by record id, so the in-memory snapshot keeps the same order to stay
  // byte-equal with read-back state for every custody/equality consumer.
  draft.attemptMemory = [...draft.attemptMemory].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  // The lesson digest is a deterministic view of authoritative attempt memory.
  // It is rebuilt ONLY when the source memory actually changed: a transition
  // that leaves memory untouched keeps the existing view byte-for-byte, so
  // "no change means no change" holds for every custody/equality consumer.
  const memoryDigest = await memoryLessonsSourceDigestV1(draft);
  const lessonsCurrent = base.lessons.length > 0 &&
    base.lessons.every((record) => record.sourceDigest === memoryDigest);
  if (!lessonsCurrent) {
    draft.lessons = await buildMemoryLessonsV1(draft, deps.clock.now());
  }
  let parsed: RepairStateSnapshotV1;
  try {
    parsed = parseRepairStateSnapshotV1(draft);
  } catch {
    return { kind: "state_error", detail: "invalid persisted transition" };
  }
  const written = await deps.state.writeRepair(parsed, synchronized.head);
  if (written.ok && written.value.status === "applied") {
    context.snapshot = parsed;
    context.head = written.value.head;
    return { kind: "progress" };
  }
  // A lost compare-and-swap whose authoritative head provably moved is
  // recomputed by the caller: the next synchronization admits the movement
  // only when it is cooldown-only and rebuilds the draft on that fresh base.
  if (
    written.ok && written.value.status === "conflict" &&
    written.value.currentHead !== null &&
    written.value.currentHead !== synchronized.head
  ) {
    return { kind: "lost_cas" };
  }
  // Ambiguous or rejected without a proven movement: the mutation was
  // computed against a possibly stale base, so it is never blindly replayed
  // over newer authoritative state (that could overwrite a newer conflicting
  // record with a captured stale mutation). Stop safely and explicitly; the
  // next run rereads the exact authoritative state and reconciles, and every
  // mutation here is keyed by deterministic identity so an already-applied
  // effect is absorbed instead of duplicated.
  return { kind: "state_error", detail: CHECKPOINT_CAS_DETAIL };
}

/**
 * Reread the actual strict repair state and reconcile it with the loaded
 * context. An unchanged head proceeds (the authoritative state equals the
 * loaded contents). A moved head is accepted ONLY when the canonical
 * non-cooldown contents equal the original context (excluding stateHead,
 * sequence, updatedAt and githubCooldowns): that admits the shared gate's
 * cooldown-only write while never applying a stale work mutation atop another
 * writer; any other movement is "conflict" (state_error at the caller). The
 * reread is strictly re-validated before it is compared or adopted: a read,
 * strict-parse or canonical-compare fault is "unavailable" (fail closed, never
 * trusted or written back). The context is refreshed when the gate's write is
 * accepted so the transition is computed against the authoritative head.
 */
export async function synchronizeSnapshot(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
): Promise<
  | { status: "ok"; snapshot: RepairStateSnapshotV1; head: GitSha }
  | { status: "unavailable" }
  | { status: "conflict" }
> {
  try {
    const read = await deps.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      return { status: "unavailable" };
    }
    // The read view is transport-only: every reread is strictly re-parsed
    // (a corrupt row must never reach a comparison or a write-back).
    const snapshot = parseRepairStateSnapshotV1(read.value.snapshot);
    const fresh = { snapshot, head: read.value.head };
    if (fresh.head === context.head) return { status: "ok", ...fresh };
    if (!sameNonCooldownContents(context.snapshot, fresh.snapshot)) {
      return { status: "conflict" };
    }
    context.snapshot = fresh.snapshot;
    context.head = fresh.head;
    return { status: "ok", ...fresh };
  } catch {
    return { status: "unavailable" };
  }
}

/** Canonical equality of the non-cooldown snapshot contents. */
export function sameNonCooldownContents(
  original: RepairStateSnapshotV1,
  other: RepairStateSnapshotV1,
): boolean {
  return canonicalStringify({
    version: original.version,
    kind: original.kind,
    incidents: original.incidents,
    evidence: original.evidence,
    work: original.work,
    reservations: original.reservations,
    reviews: original.reviews,
    replays: original.replays,
    releaseRequests: original.releaseRequests,
    attemptMemory: original.attemptMemory,
  }) === canonicalStringify({
    version: other.version,
    kind: other.kind,
    incidents: other.incidents,
    evidence: other.evidence,
    work: other.work,
    reservations: other.reservations,
    reviews: other.reviews,
    replays: other.replays,
    releaseRequests: other.releaseRequests,
    attemptMemory: other.attemptMemory,
  });
}

export function replaceWorkMutation(
  next: WorkRecordV1,
): (draft: RepairStateSnapshotV1) => void {
  return (draft) => {
    const index = draft.work.findIndex((record) => record.id === next.id);
    if (index === -1) {
      throw new Error("replaceWork: work record not found");
    }
    draft.work[index] = next;
  };
}

/** Persist one work record transition. */
export function persistWork(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  next: WorkRecordV1,
  proofHead?: GitSha,
): Promise<StepResultV1> {
  // Per-record no-progress budget (run fairness): ONE execution of the
  // selected record either advanced its durable shape or only re-armed state.
  // The comparison is always against the execution baseline — never against an
  // intermediate write of the same execution — so the count is idempotent
  // across a step's bookkeeping writes and no extra state movement is created.
  const baseline = context.executionBaseline;
  const counted = baseline !== null && baseline.id === next.id
    ? noteExecution(
      next,
      baseline.counters.stalled ?? 0,
      executionAdvanced(baseline, next),
      deps.clock.now(),
    )
    : next;
  return persistTransition(
    deps,
    context,
    replaceWorkMutation(counted),
    proofHead,
  );
}
