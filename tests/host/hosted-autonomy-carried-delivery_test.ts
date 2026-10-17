/**
 * Launcher side of carried delivery (owner decision 2026-10-16 (2), the
 * coordinator's option (b); generation 80 round-2 recheck P1). The runtime's
 * merge port refuses every merge on live ai.ubq.fi, whose `development` has
 * no branch rules, so only the launcher's delivery pass merges there; it
 * therefore makes the carried merge too:
 *
 * - a spent record's refreshed head H1 (at `work`, which the runtime proved
 *   and now waits on) merges at exactly its tip T under the LATEST completed
 *   review of the earlier head H0 on B0, only after the pass re-derives the
 *   proof from GitHub's own merge-base diffs (B0...H0 and T...H1 equal), sees
 *   H1's own required CI green and T a strict ancestor of H1, and every
 *   ordinary spent gate holds; the proof is the merge commit's message and the
 *   pass's `carried_merge` action line; the record then moves to `delivery`
 *   beside a production request naming H0's receipt;
 * - anything short of that merges nothing;
 * - a record merged that way is reported with the reviewed identity, its
 *   receipt and the merged refreshed identity on later passes.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import {
  carriedDeliveryAction,
  carriedMergeReceipt,
  carriedRequestBindsDelivery,
  carriedRequestReceipt,
} from "../../ops/hosted-autonomy-spent-delivery.ts";
import type { HostedAutonomyHeadRunV1 } from "../../ops/hosted-autonomy-types.ts";
import { releaseRequest, SHA2, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  deliveryRecord,
  HEAD,
  MERGE,
  SELF_REPO,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";
import {
  APP,
  deliveryOnly,
  liveReceipts,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  type LiveSurfaceOptionsV1,
  liveTask,
  mergedPull,
  mergeSha,
  openPull,
  readSnapshot,
} from "./hosted-autonomy-spent-fixtures.ts";

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

/** The live 618 record's reviewed head H0 and base B0 (PR 1071). */
const LIVE_618 = liveRecord(618);
const H0 = LIVE_618.target.head!;
const B0 = LIVE_618.target.base;
/** The mechanical refresh of H0 onto the moved tip T. */
const REFRESHED = "6181618161816181618161816181618161816181" as GitSha;
const MOVED_TIP = "7181718171817181718171817181718171817181" as GitSha;
const DIGEST = "d".repeat(64);

/**
 * 618 after the runtime's carried refresh: its refreshed head H1 published
 * on T at `work`, the runtime waiting (`backoff`) for this merge, its seven
 * rounds spent and its latest completed review the clean one of H0 on B0.
 */
function refreshed618(overrides: Record<string, unknown> = {}): WorkRecordV1 {
  const preserved = LIVE_618.target.candidateState!.preserved!;
  return parseWorkRecordV1({
    ...structuredClone(LIVE_618),
    nextStep: "work",
    blocker: null,
    wait: {
      reason: "backoff",
      since: Date.parse("2026-10-16T23:20:00Z"),
      until: Date.parse("2026-10-16T23:25:00Z"),
    },
    target: {
      ...LIVE_618.target,
      head: REFRESHED,
      base: MOVED_TIP,
      candidateState: {
        preserved: {
          ...preserved,
          head: REFRESHED,
          base: MOVED_TIP,
          operationKey: `base_refresh:1071:${H0}:${MOVED_TIP}`,
        },
        publishedHead: REFRESHED,
      },
    },
    ...overrides,
  });
}

interface CarriedCallsV1 {
  merges: { number: number; head: string; message: string | undefined }[];
  compares: string[];
}

/** The surface options of a carried 618 the launcher may merge. */
function carriedOptions(
  record: WorkRecordV1,
  receipts: readonly ReviewReceiptV1[],
  calls: CarriedCallsV1,
  overrides: Partial<LiveSurfaceOptionsV1> = {},
  digests: { reviewed?: string | null; refreshed?: string | null } = {},
): LiveSurfaceOptionsV1 {
  const pr = record.target.pr!;
  const issue = record.related.issueNumber!;
  return {
    tip: MOVED_TIP,
    green: { [REFRESHED]: true },
    pulls: { [pr]: openPull(record) },
    afterMerge: { [pr]: mergedPull(record, MOVED_TIP) },
    tasks: { [issue]: liveTask(issue, receipts) },
    advanced: (base, tip) => base === MOVED_TIP && tip === REFRESHED,
    extra: {
      comparePatchDigest: (base: string, head: string) => {
        calls.compares.push(`${base}...${head}`);
        if (base === B0 && head === H0) {
          return Promise.resolve(
            digests.reviewed === undefined ? DIGEST : digests.reviewed,
          );
        }
        if (base === MOVED_TIP && head === REFRESHED) {
          return Promise.resolve(
            digests.refreshed === undefined ? DIGEST : digests.refreshed,
          );
        }
        return Promise.resolve(null);
      },
      listHeadRuns: (head: string) =>
        Promise.resolve([{
          id: 4242,
          headSha: head,
          status: "completed",
          conclusion: "success",
          runAttempt: 1,
          createdAt: T0,
        } as HostedAutonomyHeadRunV1]),
    },
    ...overrides,
  };
}

/** One delivery pass over a carried 618 and the surface built for it. */
async function carriedPass(
  name: string,
  record: WorkRecordV1 = refreshed618(),
  overrides: Partial<LiveSurfaceOptionsV1> = {},
  digests: { reviewed?: string | null; refreshed?: string | null } = {},
  receipts: readonly ReviewReceiptV1[] = liveReceipts(LIVE_618),
) {
  const calls: CarriedCallsV1 = { merges: [], compares: [] };
  const { surface } = liveSurface(
    carriedOptions(record, receipts, calls, overrides, digests),
  );
  const merge = surface.merge.bind(surface);
  surface.merge = (number: number, head: string, message?: string) => {
    calls.merges.push({ number, head, message });
    return merge(number, head, message);
  };
  const rig = await liveRig(
    `carried-${name}`,
    liveSnapshot([record], [...receipts]),
    surface,
  );
  try {
    const { result, actions } = await deliveryOnly(rig);
    return { result, actions, calls, after: await readSnapshot(rig) };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("carried merge (launcher): the refreshed head merges at exactly its tip under the carried receipt, the proof in the commit message and action line, the record booked", async () => {
  const record = refreshed618();
  const [receipt] = liveReceipts(LIVE_618);
  assert.deepEqual(
    carriedMergeReceipt(liveSnapshot([record], [receipt]), record),
    receipt,
  );
  const { result, actions, calls, after } = await carriedPass("merge", record);
  assert.equal(result?.status, "applied", JSON.stringify(actions));
  assert.deepEqual(calls.compares, [
    `${B0}...${H0}`,
    `${MOVED_TIP}...${REFRESHED}`,
  ]);
  assert.equal(calls.merges.length, 1);
  assert.equal(calls.merges[0].number, 1071);
  assert.equal(calls.merges[0].head, REFRESHED);
  const message = calls.merges[0].message ?? "";
  for (
    const line of [
      `reviewed head ${H0} on base ${B0}, review receipt ${receipt.id}`,
      `refreshed head ${REFRESHED} on base ${MOVED_TIP} (a strict ancestor of the head)`,
      `merge-base diff sha256 ${B0}...${H0} ${DIGEST}`,
      `merge-base diff sha256 ${MOVED_TIP}...${REFRESHED} ${DIGEST}`,
      `required CI on ${REFRESHED}: every check run completed successfully; workflow runs 4242`,
    ]
  ) assert.ok(message.includes(line), `${line}\n${message}`);
  assert.doesNotMatch(message, /@|#\d/);
  const merged = mergeSha(1071);
  assert.deepEqual(actions, [
    `delivery:${record.id}:carried_merge:pr=1071:reviewed=${H0}@${B0}:receipt=${receipt.id}:refreshed=${REFRESHED}@${MOVED_TIP}:patch=${DIGEST}/${DIGEST}:ci=4242`,
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
    { reviewed?: string | null; refreshed?: string | null },
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
      { refreshed: "e".repeat(64) },
      "carried_patch_changed",
    ],
    [
      "diff unavailable",
      refreshed618(),
      {},
      { refreshed: null },
      "carried_proof_unavailable",
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
  for (const [name, record, overrides, digests, refusal] of cases) {
    await t.step(name, async () => {
      const { result, actions, calls, after } = await carriedPass(
        name.replaceAll(" ", "-"),
        record,
        overrides,
        digests,
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
  // The latest review rejects (an unresolved P1): never carried.
  assert.equal(
    shape(record, [{ ...receipt, unresolvedSeverities: ["P1"] }]),
    null,
  );
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
