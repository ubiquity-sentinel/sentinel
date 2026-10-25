/**
 * Delivery line and a red base (live Passport, 2026-10-24): records 13 (PR
 * 161) and 14 (PR 162) sat at `work` on the tip with their refreshed heads
 * held by the CI-first gate's `base_red` backoff, and stood `re_review`, so
 * each of the 22 reviewed Passport records with a round left deferred behind
 * them for 18 hours. A red base moves only by a merge, and the line held
 * every record whose merge could move it, so only the stall and idle rules
 * (12 non-advancing executions of a 30-minute backoff) ever released it.
 *
 * A contender on the tip with a round left, held by its red base, now holds
 * nobody while the hold runs (`src/repair/delivery-queue.ts`). A spent or
 * delivering head keeps standing `landing` and holds the line: releasing the
 * records behind it would refresh each onto the red tip, where the carried
 * gate's six-hour bound parks it for good (stage-1 review, 2026-10-25). A
 * running CI wait, the CI fix marker, the carried-merge marker and every
 * record on a moved base stand as before.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  WorkRecordV1,
  WorkWaitV1,
} from "../../src/contracts/work-record.ts";
import {
  type DeliveryLineStandingV1,
  deliveryQueueAhead,
  lineStanding,
} from "../../src/repair/delivery-queue.ts";
import { deliveryQueueDeferral } from "../../src/repair/loop-delivery-queue.ts";
import { RED_BASE_RECHECK_MS } from "../../src/repair/loop-ci-correction.ts";
import { ciFixMarker } from "../../src/repair/ci-first-policy.ts";
import { carriedMergeMarker } from "../../src/repair/carried-review.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";
import { MAX_REVIEW_ROUNDS } from "../../src/repair/review-round-cap.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { sha } from "./review-round-cap-rig.ts";

type Snapshot = Parameters<typeof deliveryQueueAhead>[0];

const MINUTE = 60_000;
const NOW = T0 + 10 * 60 * MINUTE;
const TIP = SHA2;
const MOVED = SHA1;
/** The head every refreshed contender's latest review judged. */
const REVIEWED = sha(0xeee);

/** The CI-first `base_red` hold as live 13 carried it at the snapshot. */
const RED_BASE: WorkWaitV1 = {
  reason: "backoff",
  since: NOW - 100 * MINUTE,
  until: NOW + 27 * MINUTE,
};

/** A reviewed issue task of REPO with `rounds` review charges. */
function contender(
  issue: number,
  rounds: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(`issue-${issue}`, {
    repository: REPO,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    target: {
      base: MOVED,
      branch: `sentinel/repair/issue-${issue}`,
      checkpoint: null,
      head: SHA3,
      pr: 100 + issue,
    },
    nextStep: "delivery",
    counters: { attempts: 1, retries: 0, reviewRounds: rounds },
    updatedAt: NOW - MINUTE,
    ...overrides,
  });
}

/** `record` with a refreshed head published on `base`, waiting `wait`. */
function refreshedAt(
  record: WorkRecordV1,
  base: GitSha,
  wait: WorkWaitV1 | null,
  nextStep: WorkRecordV1["nextStep"] = "work",
): WorkRecordV1 {
  return {
    ...record,
    nextStep,
    wait,
    target: { ...record.target, base, head: sha(0x1000 + record.target.pr!) },
  };
}

/** The line's snapshot: one charge per round and one clean review each. */
function line(work: WorkRecordV1[]): Snapshot {
  const reviewed = (record: WorkRecordV1) =>
    record.target.head === SHA3 ? SHA3 : REVIEWED;
  return {
    work,
    reservations: work.flatMap((record) =>
      Array.from(
        { length: record.counters.reviewRounds },
        (_, index) =>
          reservation(`${record.id}-review-${index + 1}`, {
            repository: REPO,
            taskId: record.id,
            head: reviewed(record),
            attempt: index + 1,
            purpose: "review_request",
            outcome: "submitted",
            settledAt: T0 + index,
          }),
      )
    ),
    reviews: work.map((record) =>
      completedReceipt(record.target.pr!, reviewed(record), MOVED, {
        id: `receipt-${record.id}`,
        repository: REPO,
      })
    ),
    releaseRequests: [],
  } as unknown as Snapshot;
}

function standing(
  record: WorkRecordV1,
  now = NOW,
  others: WorkRecordV1[] = [],
): DeliveryLineStandingV1 {
  return lineStanding(line([record, ...others]), record, TIP, now, null);
}

Deno.test("delivery line (live Passport 2026-10-24): heads on the tip held by the red base hold no reviewed record", () => {
  // 13 and 14: refreshed heads on the tip, rounds left, the CI-first gate's
  // red-base backoff running.
  const holders = [
    refreshedAt(contender(61, 2), TIP, RED_BASE),
    refreshedAt(contender(62, 1), TIP, {
      ...RED_BASE,
      since: NOW - 300 * MINUTE,
    }),
  ];
  // The reviewed records behind them, a round left each, on a moved base.
  const reviewed = [4, 7, 9, 10, 12].map((issue) => contender(issue, 1));
  const snapshot = line([...holders, ...reviewed]);
  for (const holder of holders) {
    assert.equal(
      lineStanding(snapshot, holder, TIP, NOW, null),
      "waiting",
      holder.id,
    );
  }
  // The first reviewed record refreshes; the rest wait behind it alone, as
  // the line orders reviewed records.
  const [first, ...rest] = reviewed;
  assert.equal(deliveryQueueAhead(snapshot, first!, TIP, NOW, null), null);
  for (const record of rest) {
    assert.equal(
      deliveryQueueAhead(snapshot, record, TIP, NOW, null)?.id,
      first!.id,
      record.id,
    );
  }
  // The delivery step's own line decision (the real consumer) agrees.
  const deps = { clock: { now: () => NOW } } as unknown as RepairCycleDepsV1;
  const context = {
    snapshot,
    legacyReviewCutoff: null,
  } as unknown as LoopContextV1;
  assert.equal(deliveryQueueDeferral(deps, context, first!, TIP), null);
  assert.deepEqual(deliveryQueueDeferral(deps, context, rest[0]!, TIP), {
    kind: "deferred",
    detail: `delivery queue: ${first!.id} goes first`,
  });
});

Deno.test("delivery line: a red-base hold on the tip releases the line only for a head with a round left", () => {
  const spent = MAX_REVIEW_ROUNDS;
  const cases: [string, DeliveryLineStandingV1, WorkRecordV1][] = [
    [
      "refreshed head at work, a round left",
      "re_review",
      refreshedAt(contender(1, 1), TIP, RED_BASE),
    ],
    [
      "carried refreshed head at work, spent",
      "landing",
      refreshedAt(contender(2, spent), TIP, RED_BASE),
    ],
    [
      "accepted head re-requesting its review",
      "re_review",
      {
        ...contender(3, 1, { nextStep: "review", wait: RED_BASE }),
        target: { ...contender(3, 1).target, base: TIP },
      },
    ],
    [
      "reviewed head on the tip at delivery (pre-merge red base)",
      "landing",
      {
        ...contender(4, 1, { wait: RED_BASE }),
        target: { ...contender(4, 1).target, base: TIP },
      },
    ],
  ];
  for (const [label, before, held] of cases) {
    const released = before === "re_review";
    assert.equal(standing(held), released ? "waiting" : before, label);
    // Once the hold ends the record is due for its re-poll and stands as it
    // did: its own step re-arms the hold or moves on.
    assert.equal(standing(held, RED_BASE.until!), before, `${label}, due`);
    assert.equal(
      standing({ ...held, wait: null }),
      before,
      `${label}, no wait`,
    );
    // A round-left record behind a head with a round left is not held
    // while the hold runs; a spent or delivering head holds it.
    const behind = contender(30, 1);
    const snapshot = line([held, behind]);
    assert.equal(
      deliveryQueueAhead(snapshot, behind, TIP, NOW, null)?.id ?? null,
      released ? null : held.id,
      label,
    );
    assert.equal(
      deliveryQueueAhead(snapshot, behind, TIP, RED_BASE.until!, null)?.id,
      held.id,
      `${label}, due`,
    );
  }
});

Deno.test("delivery line: running CI, the CI fix marker, the carried-merge marker and a moved base stand as before", () => {
  const ciPending: WorkWaitV1 = {
    reason: "ci_pending",
    since: NOW - 300 * MINUTE,
    until: NOW + CHECK_POLL_MS,
  };
  const cases: [string, DeliveryLineStandingV1, WorkRecordV1][] = [
    [
      "refreshed head on the tip awaiting its CI",
      "re_review",
      refreshedAt(contender(1, 1), TIP, ciPending),
    ],
    [
      "red refreshed head on the tip with the CI fix marker",
      "re_review",
      refreshedAt(contender(2, 1), TIP, ciFixMarker(NOW)),
    ],
    [
      "carried refreshed head on the tip with the carried-merge marker",
      "landing",
      refreshedAt(
        contender(3, MAX_REVIEW_ROUNDS),
        TIP,
        carriedMergeMarker(NOW),
      ),
    ],
    [
      "reviewed head on the tip behind a merge refusal backoff",
      "landing",
      {
        ...contender(4, 1, {
          wait: { reason: "backoff", since: NOW, until: NOW + CHECK_POLL_MS },
        }),
        target: { ...contender(4, 1).target, base: TIP },
      },
    ],
    [
      "carried refreshed head on a moved base, its old base red",
      "ready",
      refreshedAt(contender(5, MAX_REVIEW_ROUNDS), MOVED, {
        reason: "backoff",
        since: NOW,
        until: NOW + RED_BASE_RECHECK_MS,
      }),
    ],
  ];
  for (const [label, expected, record] of cases) {
    assert.equal(standing(record), expected, label);
  }
});

Deno.test("delivery line: spent deliverable records stay behind a spent carried head under the red-base hold", () => {
  // The review's scenario: S1 refreshed onto the red tip and holds its
  // red-base backoff; S2..S4 (spent, clean, reviewed heads on a moved base)
  // would each refresh onto the red tip and park there after six hours.
  const holder = refreshedAt(contender(40, MAX_REVIEW_ROUNDS), TIP, RED_BASE);
  const spentBehind = [41, 42, 43].map((issue) =>
    contender(issue, MAX_REVIEW_ROUNDS)
  );
  const snapshot = line([holder, ...spentBehind]);
  assert.equal(lineStanding(snapshot, holder, TIP, NOW, null), "landing");
  for (const record of spentBehind) {
    assert.equal(
      deliveryQueueAhead(snapshot, record, TIP, NOW, null)?.id,
      holder.id,
      record.id,
    );
  }
});
