/**
 * The runtime's verdict on a review request whose admission settled
 * ambiguous and whose journal never bound (the submission did not land):
 * the REAL repair loop (`runRepairCycle` over the delivery-queue rig) on the
 * live shape of ai.ubq.fi 604, 630 and 647 (review step, the next round's
 * `review_request` intent naming an ambiguous review charge), long past the
 * review bound. The control binds the journal first (the submission did
 * land) and must move.
 *
 * `observeReview` checks the saved intent against the journal BEFORE the
 * expiry recovery (`reviewAttemptExpired`): an unbound journal returns
 * `deferred` without a write, so the bound never fires.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { reviewOperationKey } from "../../src/repair/keys.ts";
import { REVIEW_BOUND_MS } from "../../src/repair/loop-bounds.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { queueRig } from "../repair/delivery-queue-rig.ts";
import { MINUTE, sha } from "../repair/review-round-cap-rig.ts";
import { REPO, SHA1, T0 } from "../state/helpers.ts";
import { anchor } from "./anchors.ts";
import { charge, hexId } from "./world.ts";

export const REVIEW_INTENT_ANCHOR = anchor(
  "r.reviewIntentUnbound",
  "src/repair/loop-review-observation.ts",
  `      return {
        kind: "deferred",
        detail: "review intent has no exact bound journal",
      };`,
);

export interface ReviewIntentVerdictV1 {
  /** Some run changed the record's decision fields. */
  moved: boolean;
  /** Each run's outcome. */
  outcomes: string[];
  /** Journal reads of the intent's exact key (the step did run). */
  observed: number;
}

/** The runtime verdict the lifecycle uses (`primeReviewIntent`). */
export const REVIEW_INTENT: { unboundMoves: boolean | null } = {
  unboundMoves: null,
};

export async function primeReviewIntent(): Promise<void> {
  REVIEW_INTENT.unboundMoves ??= (await reviewIntentVerdict(false)).moved;
}

function decision(record: WorkRecordV1 | undefined): string {
  return JSON.stringify(
    record === undefined ? null : {
      nextStep: record.nextStep,
      wait: record.wait,
      blocker: record.blocker,
      intent: record.intent,
      rounds: record.counters.reviewRounds,
    },
  );
}

/** Six hosted runs, 16 minutes apart, over the live stuck shape. */
export async function reviewIntentVerdict(
  bound: boolean,
): Promise<ReviewIntentVerdictV1> {
  const requestId = hexId("issue-1:review-2");
  let key = "";
  let head = SHA1 as GitSha;
  const rig = await queueRig(1, {
    shape: (records) =>
      records.map((record) => {
        head = record.target.head!;
        key = reviewOperationKey(record.target.pr!, head, 2);
        return {
          ...record,
          nextStep: "review" as const,
          counters: { attempts: 1, retries: 0, reviewRounds: 1 },
          intent: {
            kind: "review_request" as const,
            key,
            startedAt: T0 - 2 * REVIEW_BOUND_MS,
            branch: record.target.branch,
            expectedHead: head,
            observedBase: record.target.base,
            pr: record.target.pr,
            requestId,
            resultId: null,
          },
        };
      }),
    reservations: [
      charge(hexId("issue-1:review-1"), REPO, "issue-1", {
        purpose: "review_request",
        head: sha(0x101),
        attempt: 1,
        createdAt: T0 - 3 * REVIEW_BOUND_MS,
        settledAt: T0 - 3 * REVIEW_BOUND_MS + 1000,
      }),
      charge(requestId, REPO, "issue-1", {
        purpose: "review_request",
        head: sha(0x101),
        attempt: 2,
        createdAt: T0 - 2 * REVIEW_BOUND_MS,
        outcome: "ambiguous",
        settledAt: T0 - 2 * REVIEW_BOUND_MS + 1000,
      }),
    ],
  });
  if (bound) {
    await rig.github.requestReview({
      operationKey: key,
      prNumber: 101,
      expectedHead: head,
      expectedBase: SHA1,
    });
  }
  let observed = 0;
  const observe = rig.github.observeReview.bind(rig.github);
  rig.github.observeReview = (request: unknown) => {
    if ((request as { operationKey: string }).operationKey === key) observed++;
    return observe(request);
  };
  const before = decision((await rig.snapshot()).work[0]);
  let moved = false;
  const outcomes: string[] = [];
  for (let run = 0; run < 6; run++) {
    const outcome = await runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 60 * MINUTE,
      // The hosted target cycles run without a step limit.
      stepLimit: Number.POSITIVE_INFINITY,
    });
    rig.clock.advance(16 * MINUTE);
    outcomes.push(
      `${outcome.status}${"detail" in outcome ? `:${outcome.detail}` : ""}`,
    );
    if (decision((await rig.snapshot()).work[0]) !== before) moved = true;
  }
  return { moved, outcomes, observed };
}
