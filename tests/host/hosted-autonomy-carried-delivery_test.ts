/**
 * Launcher side of carried delivery (owner decision 2026-10-16 (2), the
 * coordinator's option (b); generation 80 round-2 recheck P1). The runtime's
 * merge port refuses every merge on live ai.ubq.fi, whose `development` has
 * no branch rules, so only the launcher's delivery pass merges there; it
 * therefore makes the carried merge too:
 *
 * - a spent record's refreshed head H1 (at `work`, where the runtime holds
 *   its exact carried-merge marker) merges at exactly its tip T under the
 *   LATEST completed review of the earlier head H0 on B0, only after the pass
 *   re-derives the exact proof from GitHub's Git trees (equal change sets of
 *   merge-base(B0, H0) -> H0 and T -> H1), sees H1's own required CI green
 *   and T a strict ancestor of H1, and every ordinary spent gate holds; the
 *   proof is the merge commit's message and the pass's `carried_merge` action
 *   line; the record then moves to `delivery` beside a production request
 *   naming H0's receipt;
 * - anything short of that merges nothing;
 * - a record merged that way is reported with the reviewed identity, its
 *   receipt and the merged refreshed identity on later passes.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type {
  ReviewFindingV1,
  ReviewReceiptV1,
} from "../../src/contracts/review-receipt.ts";
import {
  carriedDeliveryAction,
  carriedMergeReceipt,
  carriedRequestBindsDelivery,
  carriedRequestReceipt,
} from "../../ops/hosted-autonomy-spent-delivery.ts";
import { treeChangesDigest } from "../../ops/hosted-autonomy-github-trees.ts";
import { releaseRequest, SHA2, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  deliveryRecord,
  finding,
  HEAD,
  MERGE,
  SELF_REPO,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";
import {
  APP,
  liveReceipts,
  liveSnapshot,
  type LiveSurfaceOptionsV1,
  mergeSha,
} from "./hosted-autonomy-spent-fixtures.ts";
import {
  B0,
  type CarriedDigestsV1,
  carriedPass,
  type CarriedTreesV1,
  DIGEST,
  H0,
  LIVE_618,
  MOVED_TIP,
  REFRESHED,
  refreshed618,
  REVIEWED_CHANGES,
} from "./hosted-autonomy-carried-fixtures.ts";

/** The refreshed head H1 on the moved tip T that was merged. */
const H1 = "5001500150015001500150015001500150015001" as GitSha;
const TIP = SHA2;

function carriedSnapshot(receiptOverrides: Record<string, unknown> = {}) {
  const record = deliveryRecord({
    target: { ...deliveryRecord().target, head: H1, base: TIP },
    counters: { attempts: 1, retries: 0, reviewRounds: 3 },
  });
  // The receipt of the REVIEWED head H0 (HEAD) on its base B0 (BASE).
  const receipt = authorizingReceipt({
    requestId: "review-req-3",
    ...receiptOverrides,
  });
  const request = releaseRequest("release-carried", {
    target: { repository: SELF_REPO, environment: "production" },
    revision: MERGE,
    source: {
      pullRequest: 51,
      reviewRequestId: "review-req-3",
      reviewReceiptId: receipt.id,
      head: H1,
      base: TIP,
    },
  });
  return {
    record,
    receipt,
    request,
    snapshot: repairSnapshot([record], [receipt], [request], []),
  };
}

Deno.test("carried delivery (launcher): the action line names the reviewed identity, its receipt and the merged refreshed identity", () => {
  const { record, receipt, request, snapshot } = carriedSnapshot();
  assert.deepEqual(carriedRequestReceipt(snapshot.reviews, request), receipt);
  assert.equal(
    carriedDeliveryAction(snapshot, record),
    `delivery:${record.id}:carried:pr=51:reviewed=${HEAD}@${BASE}:receipt=${receipt.id}:merged=${H1}@${TIP}:sha=${MERGE}`,
  );
  // Not in delivery: nothing to report.
  assert.equal(
    carriedDeliveryAction(snapshot, { ...record, nextStep: "work" }),
    null,
  );
});

Deno.test("carried delivery (launcher): only a completed receipt of the App reviewer on an EARLIER head of the same pull request is carried", () => {
  // The ordinary request (receipt of the merged head itself) is not carried.
  const ordinary = carriedSnapshot({
    pullRequest: { number: 51, head: H1, base: TIP },
  });
  assert.equal(carriedDeliveryAction(ordinary.snapshot, ordinary.record), null);
  for (
    const [name, overrides] of [
      ["another pull request", {
        pullRequest: { number: 52, head: HEAD, base: BASE },
      }],
      ["another reviewer", { observedReviewer: "someone-else[bot]" }],
      ["not completed", {
        outcome: "unavailable",
        resultId: null,
        completedAt: null,
      }],
      ["another review request", { requestId: "review-req-9" }],
    ] as const
  ) {
    let built: ReturnType<typeof carriedSnapshot> | null = null;
    try {
      built = carriedSnapshot(overrides as Record<string, unknown>);
    } catch {
      continue; // the frozen parser already refuses this receipt shape
    }
    assert.equal(
      carriedRequestReceipt(built.snapshot.reviews, built.request),
      null,
      name,
    );
    assert.equal(carriedDeliveryAction(built.snapshot, built.record), null);
  }
});

// ---- the carried merge itself, on the live 618 shape ----------------------
// (`hosted-autonomy-carried-fixtures.ts`)

Deno.test("carried merge (launcher): the refreshed head merges at exactly its tip under the carried receipt, the proof in the commit message and action line, the record booked", async () => {
  const record = refreshed618();
  const [receipt] = liveReceipts(LIVE_618);
  assert.deepEqual(
    carriedMergeReceipt(liveSnapshot([record], [receipt]), record),
    receipt,
  );
  const { result, actions, calls, after } = await carriedPass("merge", record);
  assert.equal(result?.status, "applied", JSON.stringify(actions));
  // The exact proof reads the trees; the rendered diffs are evidence only.
  assert.deepEqual(calls.trees, [
    `${B0}...${H0}`,
    `${MOVED_TIP}...${REFRESHED}`,
    // The fresh dark-path resolver independently revalidates carried delivery.
    `${B0}...${H0}`,
    `${MOVED_TIP}...${REFRESHED}`,
  ]);
  assert.deepEqual(calls.compares, [
    `${B0}...${H0}`,
    `${MOVED_TIP}...${REFRESHED}`,
  ]);
  const changes = await treeChangesDigest(REVIEWED_CHANGES);
  assert.equal(calls.merges.length, 1);
  assert.equal(calls.merges[0].number, 1071);
  assert.equal(calls.merges[0].head, REFRESHED);
  const message = calls.merges[0].message ?? "";
  for (
    const line of [
      `reviewed head ${H0} on base ${B0}, review receipt ${receipt.id}`,
      `refreshed head ${REFRESHED} on base ${MOVED_TIP} (a strict ancestor of the head)`,
      `exact change set sha256 ${changes} (2 paths by path, mode and full blob id): ${B0}..${H0} equals ${MOVED_TIP}..${REFRESHED}`,
      `merge-base diff sha256 ${B0}...${H0} ${DIGEST} (evidence only)`,
      `merge-base diff sha256 ${MOVED_TIP}...${REFRESHED} ${DIGEST} (evidence only)`,
      `required CI on ${REFRESHED}: every check run completed successfully; workflow runs 4242`,
    ]
  ) assert.ok(message.includes(line), `${line}\n${message}`);
  assert.doesNotMatch(message, /@|#\d/);
  const merged = mergeSha(1071);
  assert.deepEqual(actions, [
    `delivery:${record.id}:carried_merge:pr=1071:reviewed=${H0}@${B0}:receipt=${receipt.id}:refreshed=${REFRESHED}@${MOVED_TIP}:changes=${changes}/2:patch=${DIGEST}/${DIGEST}:ci=4242`,
    `merge:${record.id}:pr=1071:sha=${merged}`,
    `request:${record.id}:${after.releaseRequests[0].id}`,
  ]);
  const [booked] = after.work;
  assert.equal(booked.nextStep, "delivery");
  assert.equal(booked.wait, null);
  assert.deepEqual(booked.counters, record.counters, "nothing charged");
  assert.deepEqual(booked.target, record.target);
  const [request] = after.releaseRequests;
  assert.equal(request.revision, merged);
  assert.deepEqual(request.source, {
    pullRequest: 1071,
    reviewRequestId: receipt.requestId,
    reviewReceiptId: receipt.id,
    head: REFRESHED,
    base: MOVED_TIP,
  });
  assert.equal(
    await carriedRequestBindsDelivery(request, booked, receipt, merged),
    true,
  );
  // A later pass reports the booked carried delivery and reads nothing.
  assert.equal(
    carriedDeliveryAction(after, booked),
    `delivery:${record.id}:carried:pr=1071:reviewed=${H0}@${B0}:receipt=${receipt.id}:merged=${REFRESHED}@${MOVED_TIP}:sha=${merged}`,
  );
});

Deno.test("carried merge (launcher): nothing short of the full proof merges", async (t) => {
  const cases: [
    string,
    WorkRecordV1,
    Partial<LiveSurfaceOptionsV1>,
    CarriedTreesV1,
    string,
  ][] = [
    ["tip moved", refreshed618(), { tip: SHA2 }, {}, "carried_base_moved"],
    [
      "red or pending head",
      refreshed618(),
      { green: {} },
      {},
      "checks_pending",
    ],
    [
      "tip not contained",
      refreshed618(),
      { advanced: () => false },
      {},
      "carried_not_on_tip",
    ],
    [
      "patch changed",
      refreshed618(),
      {},
      { refreshed: [REVIEWED_CHANGES[0]] },
      "carried_patch_changed",
    ],
    [
      "trees unavailable",
      refreshed618(),
      {},
      { refreshed: null },
      "carried_proof_unavailable",
    ],
    [
      // Issue #158 item 2: the exact patch touches a Gateway protected path.
      "protected path",
      refreshed618(),
      {},
      {
        reviewed: [{ ...REVIEWED_CHANGES[1], path: "deno.json" }],
        refreshed: [{ ...REVIEWED_CHANGES[1], path: "deno.json" }],
      },
      "protected_path",
    ],
    [
      "source issue closed",
      refreshed618(),
      { issueOpen: { 618: false } },
      {},
      "issue_not_open",
    ],
    [
      "task text changed",
      refreshed618(),
      { tasks: { 618: null } },
      {},
      "task_acceptance_refused",
    ],
    [
      "the runtime is still proving it",
      refreshed618({ wait: null }),
      {},
      {},
      "carried_awaiting_runtime",
    ],
    [
      "the runtime's CI wait",
      refreshed618({
        wait: {
          reason: "ci_pending",
          since: Date.parse("2026-10-16T23:20:00Z"),
          until: Date.parse("2026-10-16T23:25:00Z"),
        },
      }),
      {},
      {},
      "carried_awaiting_runtime",
    ],
  ];
  for (const [name, record, overrides, trees, refusal] of cases) {
    await t.step(name, async () => {
      const { result, actions, calls, after } = await carriedPass(
        name.replaceAll(" ", "-"),
        record,
        overrides,
        {} as CarriedDigestsV1,
        liveReceipts(LIVE_618),
        trees,
      );
      assert.equal(result, null, JSON.stringify(actions));
      assert.deepEqual(calls.merges, [], name);
      assert.ok(
        actions.includes(`delivery:${record.id}:${refusal}`),
        `${name}: ${JSON.stringify(actions)}`,
      );
      assert.deepEqual(after.work, [record]);
      assert.deepEqual(after.releaseRequests, []);
    });
  }
});

Deno.test("carried merge (launcher): only a spent record at work whose latest review is a clean one of an earlier head is a candidate", () => {
  const [receipt] = liveReceipts(LIVE_618);
  const record = refreshed618();
  // The pure shape reads only the receipts and the ledger.
  const shape = (row: WorkRecordV1, reviews: ReviewReceiptV1[] = [receipt]) =>
    carriedMergeReceipt({ reviews, reservations: [] }, row);
  assert.equal(shape(record), receipt);
  // Not spent (a round left): the runtime reviews it instead.
  assert.equal(
    shape({ ...record, counters: { ...record.counters, reviewRounds: 2 } }),
    null,
  );
  // Not at work, or an operation in flight.
  assert.equal(shape({ ...record, nextStep: "delivery" }), null);
  assert.equal(
    shape({
      ...record,
      nextStep: "blocked",
      wait: null,
      blocker: { kind: "other", message: "parked", since: T0 },
    }),
    null,
  );
  // The latest review rejects (an unresolved P0): never carried.
  assert.equal(
    shape(record, [{ ...receipt, unresolvedSeverities: ["P0"] }]),
    null,
  );
  assert.equal(
    shape(record, [{
      ...receipt,
      findings: [{ ...finding("P1"), severity: "P0" } as ReviewFindingV1],
    }]),
    null,
    "an unresolved P0 finding rejects on its own",
  );
  // Owner directive 2026-10-24: only P0 blocks; an unresolved P1 leaves the
  // review clean and the record carried.
  const p1 = { ...receipt, unresolvedSeverities: ["P1" as const] };
  assert.equal(shape(record, [p1]), p1);
  // A completed review of the refreshed head itself: the exact rule's.
  assert.equal(
    shape(record, [
      receipt,
      {
        ...receipt,
        id: `${receipt.id}-h1`,
        pullRequest: { number: 1071, head: REFRESHED, base: MOVED_TIP },
        completedAt: receipt.completedAt! + 1,
      },
    ]),
    null,
  );
  // Another reviewer's receipt is not the App's.
  assert.equal(
    shape(record, [{
      ...receipt,
      expectedReviewer: "someone-else[bot]",
      observedReviewer: "someone-else[bot]",
    }]),
    null,
  );
  assert.equal(APP, "ubiquity-sentinel[bot]");
});
