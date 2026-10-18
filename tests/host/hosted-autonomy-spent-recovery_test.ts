/** Lost-write recovery observes the branch after the merge advanced it. */
import assert from "node:assert/strict";
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
  readSnapshot,
} from "./hosted-autonomy-spent-fixtures.ts";

Deno.test("spent recovery: an already-merged App PR is adopted at the post-merge tip and a later descendant", async (t) => {
  const record = liveRecord(698);
  const receipts = liveReceipts(record);
  const pr = record.target.pr!;
  for (const tip of [mergeSha(pr), "f".repeat(40)]) {
    await t.step(tip === mergeSha(pr) ? "merge tip" : "later tip", async () => {
      const before = liveSnapshot([record], receipts);
      const { surface, calls } = liveSurface({
        tip,
        green: { [record.target.head!]: true },
        pulls: { [pr]: mergedPull(record, record.target.base!) },
        issueOpen: { 698: false },
        tasks: { 698: liveTask(698, receipts) },
      });
      const rig = await liveRig(`post-merge-${tip}`, before, surface);
      try {
        const { result, actions } = await deliveryOnly(rig);
        assert.equal(result?.status, "applied", actions.join(" "));
        const after = await readSnapshot(rig);
        assert.equal(after.work[0].nextStep, "delivery");
        assert.equal(after.releaseRequests.length, 1);
        assert.equal(after.releaseRequests[0].revision, mergeSha(pr));
        assert.deepEqual(after.reservations, before.reservations);
        assert.deepEqual(after.work[0].counters, record.counters);
        assert.deepEqual(calls.merges, [], "adoption performs no merge");

        await deliveryOnly(rig);
        assert.deepEqual(
          (await readSnapshot(rig)).releaseRequests,
          after.releaseRequests,
          "reconciliation never duplicates the request",
        );
        assert.deepEqual(calls.merges, []);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("spent recovery: a moved tip never bypasses trusted-merger, green-head or ancestry evidence", async (t) => {
  const record = liveRecord(698);
  const receipts = liveReceipts(record);
  const pr = record.target.pr!;
  for (const cause of ["foreign merger", "red head", "unproven base"]) {
    await t.step(cause, async () => {
      const { surface, calls } = liveSurface({
        tip: mergeSha(pr),
        green: { [record.target.head!]: cause !== "red head" },
        pulls: {
          [pr]: mergedPull(record, record.target.base!, {
            ...(cause === "foreign merger" ? { mergedBy: "0x4007" } : {}),
            ...(cause === "unproven base"
              ? {
                parents: ["e".repeat(40), record.target.head!],
                baseAncestorOfRevision: false,
              }
              : {}),
          }),
        },
        issueOpen: { 698: false },
        tasks: { 698: liveTask(698, receipts) },
      });
      const rig = await liveRig(
        `post-merge-refusal-${cause.replaceAll(" ", "-")}`,
        liveSnapshot([record], receipts),
        surface,
      );
      try {
        const { result, actions } = await deliveryOnly(rig);
        assert.equal(result, null);
        assert.ok(
          actions.includes(`delivery:${record.id}:merged_outside_trusted_path`),
          actions.join(" "),
        );
        const after = await readSnapshot(rig);
        assert.deepEqual(after.work, [record]);
        assert.deepEqual(after.releaseRequests, []);
        assert.deepEqual(calls.merges, []);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});
