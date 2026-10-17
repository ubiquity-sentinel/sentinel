/**
 * The one-time legacy table is pinned at its cut, while generation 79 keeps
 * parking records into the owner's class until generation 80 installs (the
 * integration review found 27 class members against a 21-entry table). Every
 * maintenance pass therefore reports, state-free, each class member the table
 * does not pin at its live count, so a drifted table is never silent and the
 * regeneration at the cut cannot be forgotten.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { LEGACY_DRIFT_REPORTS_PER_PASS } from "../../ops/hosted-autonomy-retry-pass.ts";
import {
  liveReceipts,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  readSnapshot,
  runAt,
} from "./hosted-autonomy-spent-fixtures.ts";

/** A live 879-shaped CI-red park under another ai.ubq.fi issue identity. */
function unpinned(issue: number): WorkRecordV1 {
  const shape = liveRecord(879);
  return liveRecord(879, {
    id: `issue-ubiquity-ai.ubq.fi-${issue}`,
    source: { ...shape.source, id: String(issue) },
    related: { ...shape.related, issueNumber: issue },
    target: { ...shape.target, pr: 2000 + issue - 1500 },
  });
}

async function pass(work: WorkRecordV1[]) {
  const record = liveRecord(618);
  const { surface } = liveSurface({ tip: record.target.base });
  const rig = await liveRig(
    `legacy-drift-${work.length}`,
    liveSnapshot(work, liveReceipts(record)),
    surface,
  );
  try {
    const before = await readSnapshot(rig);
    const result = await runAt(rig);
    return {
      actions: result.actions ?? [],
      writes: rig.writes,
      unchanged: JSON.stringify(await readSnapshot(rig)) ===
        JSON.stringify(before),
    };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("legacy class drift: every pass names the class members the table does not pin, state-free", async () => {
  // 618 spent one round past its pin before the install; 1500 was parked
  // into the class after the cut; 879 is pinned exactly and stays quiet.
  const past = liveRecord(618, {
    counters: { attempts: 3, retries: 0, reviewRounds: 8 },
  });
  const { actions, writes, unchanged } = await pass([
    past,
    liveRecord(879),
    unpinned(1500),
  ]);
  const drift = actions.filter((action) => action.includes(":legacy_class"));
  assert.deepEqual(drift, [
    "retry:issue-ubiquity-ai.ubq.fi-618:denied:legacy_class_pin_mismatch:pin=7:spent=8",
    "retry:issue-ubiquity-ai.ubq.fi-1500:denied:legacy_class_unpinned:pin=none:spent=3",
  ]);
  assert.equal(writes, 0, actions.join(" "));
  assert.ok(unchanged, "nothing is written for a drift report");
});

Deno.test("legacy class drift: the report is bounded per pass and counts the rest", async () => {
  const many = Array.from(
    { length: LEGACY_DRIFT_REPORTS_PER_PASS + 2 },
    (_, index) => unpinned(1500 + index),
  );
  const { actions } = await pass(many);
  const drift = actions.filter((action) => action.includes("legacy_class"));
  assert.equal(drift.length, LEGACY_DRIFT_REPORTS_PER_PASS + 1);
  assert.equal(
    drift.at(-1),
    "retry:legacy_class:denied:drift_more=2",
  );
});
