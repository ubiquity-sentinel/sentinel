/**
 * One store's hot repair/release reads reuse a validated parse (idle-cycle
 * attribution, 2026-11-15: a hosted state read lists, fetches and parses the
 * whole hot tree, several times per target). Every read still lists the
 * remote ref, fetches it and reads every blob; a parse is reused only when
 * all freshly read bytes match (`StateTreeMemo`), always as a fresh copy, and
 * a moved head reuses only its byte-identical records.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  HOT_STATE_TREE_MEMO_BYTES,
  StateTreeMemo,
} from "../../src/state/state-repair-history-cache.ts";
import {
  appliedHead,
  makeCtx,
  releaseSnapshot,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";
import { T0, workRecord } from "./helpers.ts";

/** Observe every memo consultation of every store during one test. */
function observeMemo() {
  const read = StateTreeMemo.prototype.read;
  const record = StateTreeMemo.prototype.record;
  const statuses: string[] = [];
  let recordHits = 0;
  StateTreeMemo.prototype.read = function (key, proof) {
    const result = read.call(this, key, proof);
    statuses.push(key.split(":")[0] + ":" + result.status);
    return result;
  };
  StateTreeMemo.prototype.record = function (path, text) {
    const result = record.call(this, path, text);
    if (result !== undefined) recordHits++;
    return result;
  };
  return {
    statuses,
    recordHits: () => recordHits,
    restore() {
      StateTreeMemo.prototype.read = read;
      StateTreeMemo.prototype.record = record;
    },
  };
}

Deno.test("hot state reads: an unchanged head reuses its validated parse as a fresh copy", async () => {
  const ctx = await makeCtx("hot-memo");
  const memo = observeMemo();
  try {
    const writer = storeAt(ctx, "writer", "repair");
    const first = appliedHead(
      await writer.writeRepair(
        repairSnapshot({ work: [workRecord("hot-a"), workRecord("hot-b")] }),
        null,
      ),
    );
    const reader = storeAt(ctx, "reader", "repair");
    const during = async <T>(read: () => Promise<T>) => {
      const from = memo.statuses.length;
      const value = await read();
      return { value, statuses: memo.statuses.slice(from) };
    };
    const a = await during(() => reader.readRepair());
    const b = await during(() => reader.readRepair());
    assert.deepEqual(a.statuses, ["repair:miss"]);
    assert.deepEqual(b.statuses, ["repair:hit"], "the same bytes reuse");
    assert.ok(a.value.ok && a.value.value.status === "found");
    assert.ok(b.value.ok && b.value.value.status === "found");
    assert.equal(b.value.value.head, first);
    assert.deepEqual(b.value.value.snapshot, a.value.value.snapshot);
    // No caller holds the memo's own copy: mutating one result changes no
    // later read.
    (a.value.value.snapshot.work as WorkRecordV1[]).length = 0;
    const c = await reader.readRepair();
    assert.ok(c.ok && c.value.status === "found");
    assert.deepEqual(c.value.snapshot.work.map((row) => row.id), [
      "hot-a",
      "hot-b",
    ]);

    // A release read in between keeps its own memo: the repair parse stays.
    const release = storeAt(ctx, "release-writer", "release");
    const seeded = await release.writeRelease(releaseSnapshot(), null);
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const r1 = await during(() => reader.readRelease());
    const r2 = await during(() => reader.readRepair());
    assert.deepEqual(r1.statuses, ["release:miss"]);
    assert.deepEqual(r2.statuses, ["repair:hit"]);

    // A moved head is parsed again; only its byte-identical records reuse.
    const second = appliedHead(
      await writer.writeRepair(
        repairSnapshot({
          stateHead: first,
          sequence: 2,
          updatedAt: T0 + 2000,
          work: [
            workRecord("hot-a"),
            workRecord("hot-b"),
            workRecord("hot-c"),
          ],
        }),
        first,
      ),
    );
    const hitsBefore = memo.recordHits();
    const d = await during(() => reader.readRepair());
    assert.deepEqual(d.statuses, ["repair:miss"]);
    assert.ok(d.value.ok && d.value.value.status === "found");
    assert.equal(d.value.value.head, second);
    assert.deepEqual(d.value.value.snapshot.work.map((row) => row.id), [
      "hot-a",
      "hot-b",
      "hot-c",
    ]);
    assert.ok(memo.recordHits() - hitsBefore >= 2, "unchanged records reuse");
  } finally {
    memo.restore();
    await ctx.cleanup();
  }
});

Deno.test("hot state reads: the hot bound keeps a production-size tree the history default refuses", () => {
  const snapshot = repairSnapshot();
  const proof = {
    parents: "parents",
    tree: "tree",
    // Above the history cache's 8 MiB bound; today's hot tree is ~7 MiB.
    bytes: new Uint8Array(9 * 1024 * 1024),
  };
  const history = new StateTreeMemo();
  history.put("repair:big", proof, snapshot);
  assert.equal(history.read("repair:big", proof).status, "miss");
  const hot = new StateTreeMemo(HOT_STATE_TREE_MEMO_BYTES);
  hot.put("repair:big", proof, snapshot);
  assert.equal(hot.read("repair:big", proof).status, "hit");
  // A byte that differs is never a hit, whatever the bound.
  const changed = { ...proof, bytes: proof.bytes.slice() };
  changed.bytes[0] = 1;
  assert.equal(hot.read("repair:big", changed).status, "mismatch");
});
