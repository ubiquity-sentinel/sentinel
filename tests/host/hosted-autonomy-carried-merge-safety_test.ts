/**
 * Generation 80 round-3 merge safety and liveness of the launcher's carried
 * merge (round-2 rechecks 2:0 and 2:1):
 *
 * - every carried head the runtime proved and awaits is read on EVERY pass
 *   while it holds its repository's delivery line, not only in its slot of
 *   the rotating spent window (at most the line's front one per repository);
 * - only the runtime's exact carried-merge marker counts as "proved and
 *   awaiting", never another `backoff` at `work` (the CI-first red-base hold
 *   of a model-written CI fix);
 * - the patch proof is exact and binary-safe: the full change sets by path,
 *   mode and full blob id from GitHub's Git trees, the rendered diff digests
 *   evidence only;
 * - the tip is re-read uncached immediately before the merge, and a carried
 *   merge that landed off its tip is never booked: it is reported and the
 *   Gateway record parks precisely.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { carriedMergeMarker } from "../../src/repair/carried-review.ts";
import { REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX } from "../../src/repair/review-round-cap.ts";
import {
  carriedMergeAwaited,
  spentReadWindow,
} from "../../ops/hosted-autonomy-spent-delivery.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import { SHA2 } from "../state/helpers.ts";
import { assertGen79Parses, gen79Available } from "../state/gen77-contracts.ts";
import {
  B0,
  carriedCalls,
  carriedOptions,
  carriedPass,
  H0,
  LIVE_618,
  MOVED_TIP,
  recordCalls,
  REFRESHED,
  refreshed618,
  REVIEWED_CHANGES,
} from "./hosted-autonomy-carried-fixtures.ts";
import {
  deliveryOnly,
  liveReceipts,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  liveTask,
  mergedPull,
  mergeSha,
  NOW,
  openPull,
  readSnapshot,
} from "./hosted-autonomy-spent-fixtures.ts";

const SLOT = 300_000;
const GEN79 = await gen79Available();

/** A parked spent CI-red record (the live 618 shape) for another issue. */
function parkedPeer(issue: number): {
  record: WorkRecordV1;
  receipt: ReviewReceiptV1;
} {
  const pr = 2000 + issue;
  const record = parseWorkRecordV1({
    ...structuredClone(LIVE_618),
    id: `issue-ubiquity-ai.ubq.fi-${issue}`,
    source: { ...LIVE_618.source, id: String(issue) },
    related: { ...LIVE_618.related, issueNumber: issue },
    target: { ...LIVE_618.target, pr },
  });
  const [base] = liveReceipts(LIVE_618);
  const receipt = {
    ...structuredClone(base),
    id: `${base.id}-peer-${issue}`,
    pullRequest: { ...base.pullRequest, number: pr },
  } as ReviewReceiptV1;
  return { record, receipt };
}

/** Twelve parked peers (live: 36) beside the carried 618 the runtime awaits. */
function crowded(carried: WorkRecordV1 = refreshed618()) {
  const peers = Array.from(
    { length: 12 },
    (_, index) => parkedPeer(500 + index),
  );
  const [receipt618] = liveReceipts(LIVE_618);
  return {
    carried,
    snapshot: liveSnapshot(
      [...peers.map((peer) => peer.record), carried],
      [receipt618, ...peers.map((peer) => peer.receipt)],
    ),
  };
}

Deno.test("carried merge safety: an awaited carried head that holds the delivery line is readable on every pass, beside every eligible spent record", () => {
  const { carried, snapshot } = crowded();
  const slot0 = Math.floor(NOW / SLOT) * SLOT;
  for (let k = 0; k < 13; k++) {
    const at = slot0 + k * SLOT + 1_000;
    const window = spentReadWindow(snapshot, at);
    assert.ok(window.has(carried.id), `slot ${k}`);
    assert.equal(window.size, 13, "all eligible records are readable");
  }
});

Deno.test("carried merge safety: all carried heads and stalled peers remain readable without a rotating window", () => {
  const front = refreshed618();
  // A second awaited carried record of the same repository, later in line.
  const second = parseWorkRecordV1({
    ...structuredClone(front),
    id: "issue-ubiquity-ai.ubq.fi-619",
    source: { ...front.source, id: "619" },
    related: { ...front.related, issueNumber: 619 },
    target: { ...front.target, pr: 1200 },
  });
  const [receipt618] = liveReceipts(LIVE_618);
  const receipt619 = {
    ...structuredClone(receipt618),
    id: `${receipt618.id}-619`,
    pullRequest: { ...receipt618.pullRequest, number: 1200 },
  } as ReviewReceiptV1;
  const peers = Array.from(
    { length: 12 },
    (_, index) => parkedPeer(500 + index),
  );
  const snapshot = liveSnapshot(
    [...peers.map((peer) => peer.record), second, front],
    [receipt618, receipt619, ...peers.map((peer) => peer.receipt)],
  );
  const slot0 = Math.floor(NOW / SLOT) * SLOT;
  let secondSeen = 0;
  for (let k = 0; k < 13; k++) {
    const window = spentReadWindow(snapshot, slot0 + k * SLOT + 1_000);
    assert.ok(window.has(front.id), `front, slot ${k}`);
    assert.equal(window.size, 14);
    if (window.has(second.id)) secondSeen++;
  }
  assert.equal(
    secondSeen,
    13,
    "the record behind the front is always readable",
  );
  // A stalled carried record remains readable without holding the line.
  const stalled = refreshed618({
    counters: { ...LIVE_618.counters, stalled: 12 },
  });
  const { snapshot: stalledSnapshot } = crowded(stalled);
  let seen = 0;
  for (let k = 0; k < 13; k++) {
    const window = spentReadWindow(stalledSnapshot, slot0 + k * SLOT + 1_000);
    assert.equal(window.size, 13);
    if (window.has(stalled.id)) seen++;
  }
  assert.equal(seen, 13);
});

Deno.test("carried merge safety: the launcher merges the awaited carried head in its first pass whatever the window's slot", async () => {
  const { carried, snapshot } = crowded();
  const receipts = liveReceipts(LIVE_618);
  const slot0 = Math.floor(NOW / SLOT) * SLOT;
  // Three slots, at least one of which the rotating window alone skips.
  for (const k of [0, 5, 9]) {
    const at = slot0 + k * SLOT + 1_000;
    const calls = carriedCalls();
    const { surface } = liveSurface(
      carriedOptions(carried, receipts, calls),
    );
    recordCalls(surface, calls);
    const rig = await liveRig(`crowded-${k}`, snapshot, surface);
    try {
      const { actions } = await deliveryOnly(rig, at);
      assert.deepEqual(
        calls.merges.map((merge) => merge.number),
        [1071],
        JSON.stringify(actions),
      );
      assert.ok(!actions.includes(`delivery:${carried.id}:spent_deferred`));
      const after = await readSnapshot(rig);
      assert.equal(
        after.work.find((row) => row.id === carried.id)?.nextStep,
        "delivery",
      );
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  }
});

Deno.test("carried merge safety: no backoff but the runtime's exact carried-merge marker is the runtime's proof", async (t) => {
  const since = NOW - 10 * 60_000;
  const waits = [
    // The CI-first red-base hold of a model-written CI fix (recheck 2:0).
    ["red-base hold", { reason: "backoff", since, until: since + 30 * 60_000 }],
    // The merge port's refusal backoff.
    ["merge refusal backoff", {
      reason: "backoff",
      since,
      until: since + 5 * 60_000,
    }],
    // The CI fix marker.
    ["CI fix marker", { reason: "backoff", since, until: since }],
  ] as const;
  for (const [name, wait] of waits) {
    await t.step(name, async () => {
      const record = refreshed618({ wait });
      assert.equal(carriedMergeAwaited(record), false);
      const { result, actions, calls, after } = await carriedPass(
        `marker-${name.replaceAll(" ", "-")}`,
        record,
      );
      assert.equal(result, null);
      assert.deepEqual(calls.merges, []);
      assert.deepEqual(calls.trees, [], "nothing read for the proof");
      assert.ok(
        actions.includes(`delivery:${record.id}:carried_awaiting_runtime`),
        JSON.stringify(actions),
      );
      assert.deepEqual(after.work, [record]);
    });
  }
  assert.equal(carriedMergeAwaited(refreshed618()), true);
  assert.equal(
    carriedMergeAwaited(refreshed618({ wait: carriedMergeMarker(since) })),
    true,
  );
});

Deno.test("carried merge safety: the patch proof is the exact change set, never the rendered diff", async (t) => {
  // A binary payload whose blob id shares its first nine hex digits with the
  // reviewed one renders as the same "Binary files ... differ" diff.
  const collided = [
    { ...REVIEWED_CHANGES[0], newSha: "f1c05210e" + "0".repeat(31) },
    REVIEWED_CHANGES[1],
  ];
  // The tip changed a reviewed path: the same new blob onto another old one.
  const rebased = [
    REVIEWED_CHANGES[0],
    { ...REVIEWED_CHANGES[1], oldSha: "c".repeat(40) },
  ];
  const cases = [
    [
      "binary payload, equal rendered diffs",
      { refreshed: collided },
      "carried_patch_changed",
    ],
    [
      "base change under a reviewed path",
      { refreshed: rebased },
      "carried_patch_changed",
    ],
    ["mode change only", {
      refreshed: [REVIEWED_CHANGES[0], {
        ...REVIEWED_CHANGES[1],
        newMode: "100755",
      }],
    }, "carried_patch_changed"],
    [
      "refreshed merge base is not the tip",
      { refreshedMergeBase: B0 },
      "carried_not_on_tip",
    ],
    [
      "a truncated or unreadable tree",
      { reviewed: null },
      "carried_proof_unavailable",
    ],
  ] as const;
  for (const [name, trees, refusal] of cases) {
    await t.step(name, async () => {
      const record = refreshed618();
      const { result, actions, calls, after } = await carriedPass(
        `proof-${name.replaceAll(/[^a-z]+/g, "-")}`,
        record,
        {},
        {},
        liveReceipts(LIVE_618),
        trees,
      );
      assert.equal(result, null, JSON.stringify(actions));
      assert.deepEqual(calls.merges, []);
      assert.ok(
        actions.includes(`delivery:${record.id}:${refusal}`),
        JSON.stringify(actions),
      );
      assert.deepEqual(after.work, [record]);
      assert.deepEqual(after.releaseRequests, []);
    });
  }
  await t.step(
    "an unrendered diff is evidence only: the exact proof merges",
    async () => {
      const record = refreshed618();
      const { result, actions, calls } = await carriedPass(
        "proof-unrendered",
        record,
        {},
        { reviewed: null, refreshed: null },
      );
      assert.equal(result?.status, "applied", JSON.stringify(actions));
      assert.equal(calls.merges.length, 1);
      assert.match(actions[0], /:patch=unrendered\/unrendered:ci=4242$/);
      assert.match(
        calls.merges[0].message ?? "",
        new RegExp(
          `merge-base diff sha256 ${B0}...${H0} unrendered \\(evidence only\\)`,
        ),
      );
    },
  );
});

Deno.test("carried merge safety: a tip that moves after the gates is re-read uncached and nothing merges", async (t) => {
  for (
    const [name, later, refusal] of [
      // The owner merges one of his own PRs before the PUT.
      ["moved", SHA2, "carried_base_moved"],
      // The re-read fails: no tip, no merge.
      ["unreadable", null, "base_unreadable"],
    ] as const
  ) {
    await t.step(name, async () => {
      const record = refreshed618();
      let reads = 0;
      const { result, actions, calls, after } = await carriedPass(
        `tip-race-${name}`,
        record,
        {},
        {},
        liveReceipts(LIVE_618),
        {},
        (surface: HostedAutonomyGitHubV1) => {
          const read = surface.readBaseTip.bind(surface);
          // The pass's first read sees T, which the gates use.
          surface.readBaseTip = (branch: string) =>
            ++reads === 1 ? read(branch) : Promise.resolve(later);
        },
      );
      assert.equal(result, null, JSON.stringify(actions));
      assert.equal(
        reads,
        2,
        "one cached read for the gates, one uncached re-read",
      );
      assert.deepEqual(calls.merges, []);
      // The proof and the CI were read before the final tip read.
      assert.deepEqual(calls.trees, [
        `${B0}...${H0}`,
        `${MOVED_TIP}...${REFRESHED}`,
      ]);
      assert.deepEqual(actions, [`delivery:${record.id}:${refusal}`]);
      assert.deepEqual(after.work, [record]);
    });
  }
});

Deno.test("carried merge safety: a carried merge that landed off its tip is never booked; the Gateway record parks precisely", async () => {
  const record = refreshed618();
  const offTip = "9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e" as GitSha;
  const merged = mergedPull(record, offTip);
  const { result, actions, calls, after } = await carriedPass(
    "off-tip",
    record,
    { afterMerge: { 1071: merged } },
  );
  assert.equal(calls.merges.length, 1);
  assert.equal(result?.status, "applied", JSON.stringify(actions));
  const sha = mergeSha(1071);
  assert.deepEqual(actions.slice(1), [
    `merge:${record.id}:pr=1071:sha=${sha}`,
    `delivery:${record.id}:carried_merged_off_tip:sha=${sha}`,
    `park:${record.id}:carried_merged_off_tip`,
  ]);
  assert.deepEqual(after.releaseRequests, [], "nothing booked");
  const [parked] = after.work;
  assert.equal(parked.nextStep, "blocked");
  assert.equal(
    parked.blocker?.message,
    `${REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX}merge ${sha} has parents ${offTip},${REFRESHED}, not ${MOVED_TIP},${REFRESHED}`,
  );
  assert.deepEqual(parked.counters, record.counters, "nothing charged");
  assert.deepEqual(parked.target, record.target);
  // The rollback runtime parses the park the launcher wrote.
  if (GEN79) await assertGen79Parses(after);

  // The next pass leaves the undeliverable park alone: nothing is read,
  // reported or merged for it.
  const next = carriedCalls();
  const { surface } = liveSurface(
    carriedOptions(parked, liveReceipts(LIVE_618), next, {
      pulls: { 1071: merged },
    }),
  );
  recordCalls(surface, next);
  const rig = await liveRig(
    "off-tip-next",
    liveSnapshot([parked], liveReceipts(LIVE_618)),
    surface,
  );
  try {
    const { result: again, actions: later } = await deliveryOnly(rig);
    assert.equal(again, null);
    assert.deepEqual(later, []);
    assert.deepEqual(next.merges, []);
    assert.equal(next.tipReads, 0);
    assert.deepEqual(next.trees, []);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("carried merge safety: an App merge already landed off its tip is not adopted either", async () => {
  const record = refreshed618();
  const offTip = "9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e" as GitSha;
  const { result, actions, calls, after } = await carriedPass(
    "off-tip-adoption",
    record,
    { pulls: { 1071: mergedPull(record, offTip) } },
  );
  assert.deepEqual(calls.merges, []);
  assert.equal(result?.status, "applied", JSON.stringify(actions));
  assert.deepEqual(actions, [
    `delivery:${record.id}:carried_merged_off_tip:sha=${mergeSha(1071)}`,
    `park:${record.id}:carried_merged_off_tip`,
  ]);
  assert.deepEqual(after.releaseRequests, []);
  assert.equal(after.work[0].nextStep, "blocked");
});

Deno.test("carried merge safety: every launcher merge re-reads the tip uncached before its merge call", async () => {
  // An ordinary spent merge at the exact reviewed base (live 618, green).
  const record = liveRecord(618);
  const receipts = liveReceipts(record);
  const base = record.target.base;
  let reads = 0;
  const { surface, calls } = liveSurface({
    tip: base,
    green: { [record.target.head!]: true },
    pulls: { 1071: openPull(record) },
    afterMerge: { 1071: mergedPull(record, base) },
    tasks: { 618: liveTask(618, receipts) },
  });
  const read = surface.readBaseTip.bind(surface);
  surface.readBaseTip = (branch: string) =>
    ++reads === 1 ? read(branch) : Promise.resolve(SHA2);
  const rig = await liveRig(
    "exact-tip-race",
    liveSnapshot([record], receipts),
    surface,
  );
  try {
    const { result, actions } = await deliveryOnly(rig);
    assert.equal(result, null, JSON.stringify(actions));
    assert.equal(reads, 2);
    assert.deepEqual(calls.merges, []);
    assert.deepEqual(actions, [`delivery:${record.id}:base_moved`]);
    assert.deepEqual((await readSnapshot(rig)).work, [record]);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
