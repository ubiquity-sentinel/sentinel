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
import { hasTakeoverCustody } from "../github/existing-pr-takeover-provenance.ts";
import { candidateBranch } from "./keys.ts";
import { checkGithubCooldown } from "./loop-bounds.ts";
import { createPullRequestFor } from "./loop-publication-state.ts";
import { reconcilePublishIntent } from "./loop-publication.ts";
import { guardQueueOperation } from "./loop-queue-guard.ts";
import { configFor, withPublishedHead } from "./loop-records.ts";
import { persistWork } from "./loop-state.ts";
import { clearWait } from "./transitions.ts";
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

/**
 * Replace a closed own publication without pushing or inventing preservation
 * evidence. Its exact published branch is sufficient for a replacement PR;
 * ordinary live-head CI/review admission still follows. A deleted branch instead
 * releases a fresh base start, with all historical charges/counters retained.
 * The PR intent is durable before creation and reconciled after a lost reply.
 */
export async function recoverClosedExistingHead(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  const { branch, candidateState, head, pr } = record.target;
  if (
    record.source.kind !== "issue" || record.nextStep !== "work" ||
    hasTakeoverCustody(record) || head === null ||
    head === record.target.base ||
    branch !== candidateBranch(record.id) ||
    candidateState?.preserved !== null ||
    // A published head alone proves no closed-unmerged PR. Only a retained
    // PR or a durable replacement intent authorizes this recovery lane.
    (pr === null && record.intent === null) ||
    (pr === null && candidateState.publishedHead !== head)
  ) return null;
  const config = configFor(deps, record.repository);
  if (config === null) return null;
  if (record.intent !== null) {
    if (record.intent.kind !== "pull_request" || pr !== null) return null;
    return reconcilePublishIntent(deps, context, record, config);
  }
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind !== "ok") {
    return { kind: cooling.kind, detail: cooling.detail };
  }
  const guard = await guardQueueOperation(deps, context, record, "publication");
  if (guard !== null) return guard;
  if (pr !== null) {
    const read = await deps.github.readPullRequest(pr);
    if (!read.ok || read.value === null) {
      return { kind: "deferred", detail: EXISTING_HEAD_UNREADABLE_DETAIL };
    }
    const live = read.value;
    if (live.state !== "closed" || live.mergeSha !== null) return null;
    if (
      live.number !== pr || live.headRef !== branch ||
      live.baseRef !== config.baseBranch
    ) {
      return {
        kind: "deferred",
        detail: "closed publication identity mismatch",
      };
    }
  }
  const ref = await deps.github.readRef(`refs/heads/${branch}`);
  if (!ref.ok) {
    return {
      kind: "deferred",
      detail: "closed publication branch unavailable",
    };
  }
  if (ref.value !== null && ref.value.sha !== head) {
    return { kind: "deferred", detail: EXISTING_HEAD_MOVED_DETAIL };
  }
  const now = deps.clock.now();
  if (ref.value === null) {
    // Only the observed closed-unmerged PR authorizes a restart. A missing
    // branch with no retained PR identity is not proof of its disposition.
    if (pr === null) {
      return {
        kind: "deferred",
        detail: "closed publication branch unavailable",
      };
    }
    return persistWork(deps, context, {
      ...clearWait(record, now),
      target: {
        ...record.target,
        checkpoint: null,
        head: null,
        pr: null,
        candidateState: { preserved: null, publishedHead: null },
      },
    });
  }
  const proved = clearWait(withPublishedHead(record, head, now), now);
  return createPullRequestFor(deps, context, {
    ...proved,
    target: { ...proved.target, pr: null },
  }, config);
}
