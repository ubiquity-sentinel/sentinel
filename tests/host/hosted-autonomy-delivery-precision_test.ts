/**
 * Launcher delivery precision (sentinel issue #156) on the live ai.ubq.fi
 * shapes:
 *
 * - (1) a merge THIS pass made is booked only when its commit's parents are
 *   exactly [the tip re-read before the call, the head]; GitHub has no
 *   compare-and-swap on the base, so one that landed on a later commit is
 *   reported `merged_off_tip` and nothing is written;
 * - (2) a carried App merge already landed off its tip is reported (and the
 *   Gateway record parked) on its parents alone, before the patch proof;
 * - (3) a carried head the runtime waits on with `unavailable` (a wait the
 *   runtime also writes before any merge) reads only its pull request until
 *   that pull request is merged;
 * - (6) a spent record whose base is not the tip (D3 off) is left out of the
 *   read window: only its pull request is read (the lost write of a merge
 *   that moved the tip itself is still adopted) and it ends `base_moved`.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  spentOnTip,
  spentReadWindow,
} from "../../ops/hosted-autonomy-spent-delivery.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  carriedPass,
  LIVE_618,
  MOVED_TIP,
  REFRESHED,
  refreshed618,
} from "./hosted-autonomy-carried-fixtures.ts";
import {
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
  NOW,
  openPull,
  readSnapshot,
  runAt,
  TIP,
} from "./hosted-autonomy-spent-fixtures.ts";

/** An owner merge that landed on the base between the re-read and the PUT. */
const OWNER_MERGE = "0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e" as GitSha;

/** Count the trusted task reads and pull reads a surface serves. */
function countReads(surface: HostedAutonomyGitHubV1) {
  const reads = { tasks: 0, pulls: 0 };
  const task = surface.readIssueTask!.bind(surface);
  surface.readIssueTask = (number: number) => {
    reads.tasks++;
    return task(number);
  };
  const pull = surface.readPull.bind(surface);
  surface.readPull = (number: number, branch: string | null) => {
    reads.pulls++;
    return pull(number, branch);
  };
  return reads;
}

/** One delivery pass over `record` alone on the given surface options. */
async function pass(
  name: string,
  record: WorkRecordV1,
  options: LiveSurfaceOptionsV1,
) {
  const { surface, calls } = liveSurface(options);
  const reads = countReads(surface);
  const rig = await liveRig(
    `precision-${name}`,
    liveSnapshot([record], liveReceipts(record)),
    surface,
  );
  try {
    const { result, actions } = await deliveryOnly(rig);
    return {
      result,
      actions,
      calls,
      reads,
      writes: rig.writes,
      after: await readSnapshot(rig),
    };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

/** The surface of live 618 (green, task accepted) with the tip at `tip`. */
function options618(
  record: WorkRecordV1,
  tip: string,
  overrides: Partial<LiveSurfaceOptionsV1> = {},
): LiveSurfaceOptionsV1 {
  return {
    tip,
    green: { [record.target.head!]: true },
    pulls: { 1071: openPull(record) },
    afterMerge: { 1071: mergedPull(record, tip) },
    tasks: { 618: liveTask(618, liveReceipts(record)) },
    ...overrides,
  };
}

Deno.test("delivery precision (#156) 1: a merge this pass made that landed off its re-read tip is reported and never booked", async () => {
  const record = liveRecord(618);
  const base = record.target.base!;
  const { result, actions, calls, writes, after } = await pass(
    "merged-off-tip",
    record,
    // The tip read (and re-read) is the exact base, but the merge commit's
    // first parent is an owner merge that landed before the PUT. GitHub
    // still names the reviewed base an ancestor, so the adoption rule
    // (`baseAndHeadAreMerged`) alone would accept it.
    options618(record, base, {
      afterMerge: { 1071: mergedPull(record, OWNER_MERGE) },
    }),
  );
  assert.equal(result, null, JSON.stringify(actions));
  assert.deepEqual(calls.merges, [1071]);
  const sha = mergeSha(1071);
  assert.deepEqual(actions, [
    `merge:${record.id}:pr=1071:sha=${sha}`,
    `delivery:${record.id}:merged_off_tip:sha=${sha}`,
  ]);
  assert.equal(writes, 0, "nothing is written");
  assert.deepEqual(after.work, [record]);
  assert.deepEqual(after.releaseRequests, []);
});

Deno.test("delivery precision (#156) 1: a merge this pass made exactly on its re-read tip is still booked", async () => {
  const record = liveRecord(618);
  const base = record.target.base!;
  const { result, actions, calls, after } = await pass(
    "merged-on-tip",
    record,
    options618(record, base),
  );
  assert.equal(result?.status, "applied", JSON.stringify(actions));
  assert.deepEqual(calls.merges, [1071]);
  assert.equal(after.releaseRequests.length, 1);
  assert.equal(after.releaseRequests[0].revision, mergeSha(1071));
  assert.equal(after.work[0].nextStep, "delivery");
});

Deno.test("delivery precision (#156) 2: a carried App merge off its tip is reported on its parents alone, before the patch proof", async () => {
  const record = refreshed618();
  const offTip = "9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e" as GitSha;
  const { result, actions, calls, after } = await carriedPass(
    "precision-off-tip-adoption",
    record,
    { pulls: { 1071: mergedPull(record, offTip) } },
  );
  assert.deepEqual(calls.merges, []);
  assert.equal(result?.status, "applied", JSON.stringify(actions));
  assert.deepEqual(actions, [
    `delivery:${record.id}:carried_merged_off_tip:sha=${mergeSha(1071)}`,
    `park:${record.id}:carried_merged_off_tip`,
  ]);
  assert.equal(after.work[0].nextStep, "blocked");
  assert.deepEqual(after.releaseRequests, []);
  // An App merge exactly on T still pays for (and needs) the full proof:
  // both change sets from Git trees and both rendered diffs. Off the tip
  // neither proof read is made (the Gateway's queue custody still reads its
  // own two change sets to resolve the merge).
  const onTip = await carriedPass(
    "precision-on-tip-adoption",
    record,
    { pulls: { 1071: mergedPull(record, MOVED_TIP) } },
  );
  assert.equal(onTip.result?.status, "applied", JSON.stringify(onTip.actions));
  assert.equal(onTip.after.work[0].nextStep, "delivery");
  assert.equal(onTip.calls.compares.length, 2);
  assert.deepEqual(calls.compares, [], "no rendered diff read");
  assert.equal(
    calls.trees.length,
    onTip.calls.trees.length - 2,
    "no Git tree read for the patch proof",
  );
});

Deno.test("delivery precision (#156) 3: a carried head waiting with `unavailable` reads only its pull request until it is merged", async () => {
  const record = refreshed618({
    wait: { reason: "unavailable", since: NOW - 60_000, until: NOW + 60_000 },
  });
  let reads: { tasks: number; pulls: number } = { tasks: 0, pulls: 0 };
  const open = await carriedPass(
    "precision-unavailable-open",
    record,
    {},
    {},
    liveReceipts(LIVE_618),
    {},
    (surface) => {
      reads = countReads(surface);
    },
  );
  assert.equal(open.result, null);
  assert.deepEqual(open.actions, [
    `delivery:${record.id}:carried_awaiting_runtime`,
  ]);
  assert.deepEqual(reads, { tasks: 0, pulls: 1 }, "no task read");
  assert.deepEqual(open.calls.merges, []);
  assert.deepEqual(open.calls.trees, []);
  assert.deepEqual(open.after.work, [record]);
  // Once the pull request is merged (the launcher's own lost write), the
  // same record is adopted through every gate, the task read included.
  const merged = await carriedPass(
    "precision-unavailable-merged",
    record,
    { pulls: { 1071: mergedPull(record, MOVED_TIP) } },
    {},
    liveReceipts(LIVE_618),
    {},
    (surface) => {
      reads = countReads(surface);
    },
  );
  assert.equal(
    merged.result?.status,
    "applied",
    JSON.stringify(merged.actions),
  );
  assert.ok(reads.tasks > 0, "the merged pull request is authorized");
  assert.equal(merged.after.work[0].nextStep, "delivery");
  assert.equal(merged.after.releaseRequests[0].source.head, REFRESHED);
});

Deno.test("delivery precision (#156) 6: the window leaves out a spent record behind the tip while D3 is off", () => {
  const record = liveRecord(618);
  const snapshot = liveSnapshot([record], liveReceipts(record));
  const carried = refreshed618();
  const carriedSnapshot = liveSnapshot([carried], liveReceipts(LIVE_618));
  const onTip = (tip: string, d3: boolean) => (row: WorkRecordV1) =>
    spentOnTip(row, tip, d3);
  assert.deepEqual([...spentReadWindow(snapshot, NOW)], [record.id]);
  assert.deepEqual(
    [...spentReadWindow(snapshot, NOW, undefined, onTip(TIP, false))],
    [],
  );
  assert.deepEqual(
    [
      ...spentReadWindow(
        snapshot,
        NOW,
        undefined,
        onTip(record.target.base!, false),
      ),
    ],
    [record.id],
  );
  // D3 (the Gateway's moved-base merge, test-only) keeps it readable.
  assert.deepEqual(
    [...spentReadWindow(snapshot, NOW, undefined, onTip(TIP, true))],
    [record.id],
  );
  // A carried head on a moved base keeps its own exemption.
  assert.deepEqual(
    [...spentReadWindow(carriedSnapshot, NOW, undefined, onTip(TIP, false))],
    [carried.id],
  );
});

Deno.test("delivery precision (#156) 6: a spent record behind the tip reads only its pull request and ends base_moved", async () => {
  const record = liveRecord(618);
  const { result, actions, calls, reads, writes } = await pass(
    "behind-tip",
    record,
    options618(record, TIP, { green: { [record.target.head!]: true } }),
  );
  assert.equal(result, null);
  assert.deepEqual(actions, [`delivery:${record.id}:base_moved`]);
  assert.deepEqual(reads, { tasks: 0, pulls: 1 }, "no task read");
  assert.deepEqual(calls.merges, []);
  assert.deepEqual(calls.greenReads, [], "no CI read");
  assert.equal(writes, 0);
});

Deno.test("delivery precision (#156) 6: the lost write of an App merge that moved the tip is still adopted", async () => {
  const record = liveRecord(618);
  const base = record.target.base!;
  // The pass merged 618 at its exact base, which moved the tip to the merge
  // commit, and its state write was lost.
  const { result, actions, calls, reads, after } = await pass(
    "behind-tip-adoption",
    record,
    options618(record, mergeSha(1071), {
      pulls: { 1071: mergedPull(record, base) },
    }),
  );
  assert.equal(result?.status, "applied", JSON.stringify(actions));
  assert.deepEqual(calls.merges, [], "no merge call");
  assert.ok(reads.tasks > 0, "the merged pull request is authorized");
  assert.equal(after.work[0].nextStep, "delivery");
  assert.equal(after.releaseRequests[0].revision, mergeSha(1071));
});

Deno.test("#156 (1): an App merge that landed off its tip is never booked by a later pass either", async () => {
  // Review finding (upheld 3 of 3): the pass that made the merge refused it,
  // but the next pass adopted the same App merge as an outside merge and
  // wrote a release request for a tree no CI ran on.
  const record = liveRecord(618);
  const { surface, calls } = liveSurface({
    tip: record.target.base!,
    tipFollowsMerges: true,
    green: { [record.target.head!]: true },
    pulls: { 1071: openPull(record) },
    afterMerge: { 1071: mergedPull(record, OWNER_MERGE) },
    tasks: { 618: liveTask(618, liveReceipts(record)) },
  });
  const rig = await liveRig(
    "off-tip-durable",
    liveSnapshot([record], liveReceipts(record)),
    surface,
  );
  try {
    for (let run = 0; run < 3; run++) await runAt(rig);
    const after = await readSnapshot(rig);
    assert.deepEqual(calls.merges, [1071], "exactly one merge call");
    assert.deepEqual(after.releaseRequests, [], "no release request");
    assert.notEqual(after.work[0].nextStep, "delivery");
    assert.notEqual(after.work[0].nextStep, "done");
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
