/**
 * The existing-published-head continuation start (owner throughput, 2026-10-30).
 *
 * A record whose published pull request is bound to its exact target head while
 * no candidate descriptor was preserved (`candidateState.preserved === null`,
 * the shape `existingHeadContinuationShape` names in `loop-eligibility.ts`) cannot
 * be regenerated, published or reviewed from an unverified head, so the
 * ordinary lane leaves it parked. The one authorized start corrects that EXACT
 * published head: nothing here starts a fresh candidate from the base, which
 * would overwrite the unverified head.
 *
 * Two live re-verifications run BEFORE anything is charged:
 *   1. `verifyExistingPublishedHead`: the pull request must still be open at the
 *      exact recorded head — a head that moved since custody, or an unreadable
 *      pull request, is refused (nothing written, never planned). A completed
 *      review does NOT refuse: this shape exists precisely for a custody_ready
 *      head a review already judged, whose red CI still needs its correction;
 *   2. `gateExistingHeadContinuation`: the head's live CI disposition is taken
 *      from the SAME CI-first gate the serial lane uses. A candidate-caused
 *      failure writes its unchanged fix marker (uncharged deterministic
 *      progress, which arms `headAwaitsPreReviewCiFix` for the next wave's
 *      authenticated CI-correction start), a pending head waits, a red base
 *      backs off and an exhausted record parks. A green head returns a plain
 *      deferral: its next action is the review request, not a model start.
 */
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { gateReviewOnCi } from "./loop-ci-first.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";

/** Refusal detail of a continuation whose live PR no longer binds its head. */
export const EXISTING_HEAD_MOVED_DETAIL =
  "existing published head moved since custody";

/** Refusal detail of an unreadable existing pull request. */
export const EXISTING_HEAD_UNREADABLE_DETAIL =
  "existing published head read unavailable";

/** Deferral of a continuation head whose CI is green. */
export const EXISTING_HEAD_GREEN_DETAIL =
  "existing published head is green; it awaits its review request";

/**
 * Re-prove the record's published head against the live pull request. Null
 * means the exact head is still published and binds the record; otherwise the
 * returned step refuses the start uncharged. The eligibility shape guarantees a
 * head and a PR; a missing one refuses rather than guessing.
 */
export async function verifyExistingPublishedHead(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  const pr = record.target.pr;
  const head = record.target.head;
  if (pr === null || head === null) {
    return { kind: "deferred", detail: EXISTING_HEAD_UNREADABLE_DETAIL };
  }
  let live;
  try {
    const read = await deps.github.readPullRequest(pr);
    live = read.ok ? read.value : null;
  } catch {
    live = null;
  }
  if (live === null) {
    return { kind: "deferred", detail: EXISTING_HEAD_UNREADABLE_DETAIL };
  }
  if (live.state !== "open" || live.head !== head) {
    return { kind: "deferred", detail: EXISTING_HEAD_MOVED_DETAIL };
  }
  return null;
}

/**
 * The verified continuation's live CI disposition (see the module comment).
 * Only a candidate-caused failure produces the fix marker this wave; nothing is
 * reserved here and no counter moves.
 */
export async function gateExistingHeadContinuation(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const gated = await gateReviewOnCi(deps, context, record);
  return gated ?? { kind: "deferred", detail: EXISTING_HEAD_GREEN_DETAIL };
}
