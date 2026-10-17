/**
 * Per-repository delivery queue (generation 80 integration review, P1): with
 * the hard three-round ceiling, several clean records reviewed on one tip
 * must not all refresh and re-review after every merge, or the third merge
 * leaves the rest parked BASE_MOVED for good. Only the record at the front of
 * the line refreshes; the others wait with nothing written or charged.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  DELIVERY_QUEUE_IDLE_MS,
  DELIVERY_QUEUE_STALL_LIMIT,
  deliveryQueueAhead,
} from "../../src/repair/delivery-queue.ts";
import {
  MAX_REVIEW_ROUNDS,
  REVIEW_ROUND_CEILING_PREFIX,
  reviewRoundsSpent,
} from "../../src/repair/review-round-cap.ts";
import {
  releaseRequest,
  REPO,
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { queueRig } from "./delivery-queue-rig.ts";

const RECORDS = 5;

Deno.test("delivery queue: five clean records on one moving base all merge within three rounds", async () => {
  const rig = await queueRig(RECORDS);
  await rig.drive(40);
  const snapshot = await rig.snapshot();
  const parks = snapshot.work.filter((record) =>
    (record.blocker?.message ?? "").startsWith(REVIEW_ROUND_CEILING_PREFIX)
  ).map((record) => `${record.id}: ${record.blocker!.message}`);
  assert.deepEqual(parks, [], "no record parks at the ceiling");
  assert.deepEqual(
    [...rig.github.merged].sort(),
    rig.records.map((record) => record.target.pr).sort(),
    "every pull request merged",
  );
  for (const record of snapshot.work) {
    const spent = reviewRoundsSpent(snapshot, record);
    assert.ok(spent <= MAX_REVIEW_ROUNDS, `${record.id} spent ${spent}`);
  }
  // Each merge moved the base once; a waiting record refreshed only at the
  // front of the line, so every record after the first needed exactly one
  // refreshed head: one review on the original base, one on its turn.
  assert.equal(rig.github.reviewed.length, 2 * RECORDS - 1);
  assert.equal(rig.github.refreshes, RECORDS - 1);
  // Every review after the first wave judged a refreshed head on a merge
  // commit (the tip of its turn), never the original base.
  const waves = rig.github.reviewed.slice(RECORDS);
  assert.ok(waves.every((review) => review.base !== SHA1));
  assert.equal(new Set(waves.map((review) => review.base)).size, waves.length);
});

Deno.test("delivery queue: a record waiting its turn writes, charges and refreshes nothing", async () => {
  // 1 is reviewed on the tip (SHA2) and waits for its CI in `delivery`; 2 was
  // reviewed on the old base and would refresh. 2 defers behind 1.
  const rig = await queueRig(2, {
    tip: SHA2,
    shape: ([first, second]) => [
      workRecord(first.id, {
        ...first,
        nextStep: "delivery",
        target: { ...first.target, base: SHA2 },
        wait: { reason: "ci_pending", since: T0, until: T0 + 60 * 60_000 },
        counters: { attempts: 1, retries: 0, reviewRounds: 1 },
      }),
      workRecord(second.id, {
        ...second,
        nextStep: "delivery",
        counters: { attempts: 1, retries: 0, reviewRounds: 1 },
      }),
    ],
  });
  const before = await rig.snapshot();
  await runRepairCycle(rig.deps, {
    deadline: rig.clock.now() + 60 * 60_000,
    stepLimit: 16,
  });
  const after = await rig.snapshot();
  assert.deepEqual(after.work, before.work, "no record rewritten");
  assert.deepEqual(after.reservations, before.reservations);
  assert.equal(rig.github.refreshes, 0);
  assert.equal(rig.github.pushes.length, 0);
  assert.equal(rig.github.reviewed.length, 0);
  assert.equal(rig.github.merged.length, 0);
});

// ---- pure policy ----------------------------------------------------------

const TIP = SHA2;
const OLD = SHA1;
/** The policy clock: one second after every seeded record's last write. */
const NOW = T0 + 2000;

/** A reviewed record of REPO with `rounds` review charges in the ledger. */
function reviewed(
  index: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(`issue-${index}`, {
    repository: REPO,
    source: { kind: "issue", id: String(index), revision: SHA1 },
    related: { incidentId: null, issueNumber: index },
    target: {
      base: OLD,
      branch: `sentinel/repair/issue-${index}`,
      checkpoint: null,
      head: SHA3,
      pr: 100 + index,
    },
    nextStep: "delivery",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

function snapshotOf(work: WorkRecordV1[], releaseRequests: unknown[] = []) {
  return {
    work,
    reservations: work.flatMap((record) =>
      Array.from(
        { length: record.counters.reviewRounds },
        (_, index) =>
          reservation(`${record.id}-review-${index + 1}`, {
            repository: record.repository,
            taskId: record.id,
            head: SHA3,
            attempt: index + 1,
            purpose: "review_request",
            outcome: "submitted",
            settledAt: T0 + index,
          }),
      )
    ),
    releaseRequests,
  } as Parameters<typeof deliveryQueueAhead>[0];
}

const onTip = (index: number, overrides: Record<string, unknown> = {}) =>
  reviewed(index, {
    target: { ...reviewed(index).target, base: TIP },
    ...overrides,
  });

Deno.test("delivery queue: a reviewed record in flight on the tip goes first", () => {
  const me = reviewed(5);
  for (const step of ["work", "review", "delivery"] as const) {
    const other = onTip(9, { nextStep: step });
    assert.equal(
      deliveryQueueAhead(snapshotOf([me, other]), me, TIP, NOW)?.id,
      other.id,
      step,
    );
  }
  // Alone, or behind nobody, it refreshes.
  assert.equal(deliveryQueueAhead(snapshotOf([me]), me, TIP, NOW), null);
});

Deno.test("delivery queue: the lowest pull request on a moved base refreshes first", () => {
  const first = reviewed(1);
  const second = reviewed(2);
  const snapshot = snapshotOf([second, first]);
  assert.equal(deliveryQueueAhead(snapshot, first, TIP, NOW), null);
  assert.equal(deliveryQueueAhead(snapshot, second, TIP, NOW)?.id, first.id);
  // A refresh already in flight holds the line whatever its number.
  const refreshing = reviewed(9, {
    intent: {
      kind: "base_refresh",
      key: `base_refresh:109:${SHA3}:${TIP}`,
      startedAt: T0,
      branch: "sentinel/repair/issue-9",
      expectedHead: SHA3,
      observedBase: TIP,
      pr: 109,
      requestId: null,
      resultId: null,
    },
  });
  assert.equal(
    deliveryQueueAhead(snapshotOf([first, refreshing]), first, TIP, NOW)?.id,
    refreshing.id,
  );
});

Deno.test("delivery queue: records that cannot take the tip hold nobody", () => {
  const me = reviewed(5);
  const holders: [string, WorkRecordV1, unknown[]][] = [
    [
      "never reviewed",
      onTip(1, { counters: { attempts: 1, retries: 0, reviewRounds: 0 } }),
      [],
    ],
    [
      "blocked",
      onTip(1, {
        nextStep: "blocked",
        blocker: { kind: "other", message: "x", since: T0 },
      }),
      [],
    ],
    ["done", onTip(1, { nextStep: "done" }), []],
    ["no PR", onTip(1, { target: { ...onTip(1).target, pr: null } }), []],
    [
      "not an issue task",
      onTip(1, {
        source: { kind: "incident", id: "i-1", revision: SHA1 },
        related: { incidentId: "i-1", issueNumber: null },
        fingerprint: "f".repeat(64),
      }),
      [],
    ],
    [
      "idle: nothing written for two hours",
      onTip(1, {
        createdAt: NOW - DELIVERY_QUEUE_IDLE_MS - 1,
        updatedAt: NOW - DELIVERY_QUEUE_IDLE_MS,
      }),
      [],
    ],
    [
      "stalled",
      onTip(1, {
        counters: {
          attempts: 1,
          retries: 0,
          reviewRounds: 1,
          stalled: DELIVERY_QUEUE_STALL_LIMIT,
        },
      }),
      [],
    ],
    [
      "at work on the tip with no round left",
      onTip(1, {
        nextStep: "work",
        counters: { attempts: 1, retries: 0, reviewRounds: MAX_REVIEW_ROUNDS },
      }),
      [],
    ],
    [
      "spent on a moved base",
      reviewed(1, {
        counters: { attempts: 1, retries: 0, reviewRounds: MAX_REVIEW_ROUNDS },
      }),
      [],
    ],
    ["already merged", onTip(1), [
      releaseRequest("merged-1", {
        target: { repository: REPO, environment: "production" },
        revision: SHA2,
        source: {
          pullRequest: 101,
          reviewRequestId: "r",
          reviewReceiptId: null,
          head: SHA3,
          base: TIP,
        },
      }),
    ]],
    [
      "another repository",
      onTip(1, {
        repository: { ...REPO, installationId: 8 },
      }),
      [],
    ],
  ];
  for (const [label, other, releases] of holders) {
    assert.equal(
      deliveryQueueAhead(snapshotOf([me, other], releases), me, TIP, NOW),
      null,
      label,
    );
  }
  // A spent record reviewed on the tip and waiting to merge still goes first.
  const spentOnTip = onTip(1, {
    counters: { attempts: 1, retries: 0, reviewRounds: MAX_REVIEW_ROUNDS },
  });
  assert.equal(
    deliveryQueueAhead(snapshotOf([me, spentOnTip]), me, TIP, NOW)?.id,
    spentOnTip.id,
  );
  // A higher pull request on a moved base waits behind this one.
  assert.equal(
    deliveryQueueAhead(snapshotOf([me, reviewed(8)]), me, TIP as GitSha, NOW),
    null,
  );
});
