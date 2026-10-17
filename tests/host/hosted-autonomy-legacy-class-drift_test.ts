/**
 * The one-time legacy class is a rule over the installed CI-first runtime's
 * pinned cutoff (owner decision 2026-10-16; `review-round-cap.ts`): records
 * whose rounds were admitted before that runtime's activation. A record of
 * the owner's class shape (CI-red parked, three or more rounds spent) the
 * rule leaves without its final round is reported on every pass, state-free,
 * so it is never silent: a round the old runtime admitted after the cutoff
 * (`pin_mismatch`) or rounds all admitted after it (`unpinned`). Without a
 * cutoff nothing is reported, unless a proven CI-first runtime runs without
 * one: then only their count is.
 */
import assert from "node:assert/strict";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  LEGACY_DRIFT_REPORTS_PER_PASS,
  legacyClassDriftActions,
} from "../../ops/hosted-autonomy-retry-pass.ts";
import { reservation } from "../state/helpers.ts";
import {
  liveReceipts,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  NOW,
  readSnapshot,
  runAt,
} from "./hosted-autonomy-spent-fixtures.ts";

/** The pinned cutoff of these passes: before NOW, after the old rounds. */
const CUT = NOW - 60 * 60_000;

/** A live 879-shaped CI-red park under another ai.ubq.fi issue identity. */
function shaped(issue: number, rounds = 3): WorkRecordV1 {
  const shape = liveRecord(879);
  return liveRecord(879, {
    id: `issue-ubiquity-ai.ubq.fi-${issue}`,
    source: { ...shape.source, id: String(issue) },
    related: { ...shape.related, issueNumber: issue },
    target: { ...shape.target, pr: 2000 + issue - 1500 },
    counters: { ...shape.counters, reviewRounds: rounds },
  });
}

/** `count` counted review admissions of `record`, created from `at`. */
function rounds(
  record: WorkRecordV1,
  count: number,
  at: number,
  first = 1,
): BudgetReservationV1[] {
  return Array.from(
    { length: count },
    (_, index) =>
      reservation(`${record.id}-review-${first + index}`, {
        repository: record.repository,
        taskId: record.id,
        attempt: first + index,
        head: record.target.head,
        purpose: "review_request",
        createdAt: at + index,
        outcome: "submitted",
        settledAt: at + index + 1,
      }),
  );
}

async function pass(
  work: WorkRecordV1[],
  reservations: BudgetReservationV1[],
  cutoff: number | null,
) {
  const record = liveRecord(618);
  const { surface } = liveSurface({ tip: record.target.base });
  const rig = await liveRig(
    `legacy-drift-${work.length}-${cutoff === null ? "none" : "cut"}`,
    liveSnapshot(work, liveReceipts(record), [], reservations),
    surface,
  );
  try {
    const before = await readSnapshot(rig);
    const result = await runAt(rig, NOW, { legacyReviewCutoff: cutoff });
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

Deno.test("legacy class drift: every pass names the class-shaped records the rule leaves without a final round, state-free", async () => {
  // 879: three rounds before the cutoff, covered and quiet. 618: seven old
  // rounds and one the old runtime admitted after the cutoff. 1500: three
  // rounds all after the cutoff (new under the CI-first runtime).
  const covered = liveRecord(879);
  const past = liveRecord(618, {
    counters: { attempts: 3, retries: 0, reviewRounds: 8 },
  });
  const fresh = shaped(1500);
  const { actions, writes, unchanged } = await pass(
    [past, covered, fresh],
    [
      ...rounds(covered, 3, CUT - 10_000),
      ...rounds(past, 7, CUT - 10_000),
      ...rounds(past, 1, CUT + 1, 8),
      ...rounds(fresh, 3, CUT + 1),
    ],
    CUT,
  );
  const drift = actions.filter((action) => action.includes(":legacy_class"));
  assert.deepEqual(drift, [
    "retry:issue-ubiquity-ai.ubq.fi-618:denied:legacy_class_pin_mismatch:pin=7:spent=8",
    "retry:issue-ubiquity-ai.ubq.fi-1500:denied:legacy_class_unpinned:pin=none:spent=3",
  ]);
  assert.equal(writes, 0, actions.join(" "));
  assert.ok(unchanged, "nothing is written for a drift report");
});

Deno.test("legacy class drift: without a cutoff the pass reports nothing unless a CI-first runtime runs without one", async () => {
  const covered = liveRecord(879);
  const work = [covered, shaped(1500), shaped(1501, 2)];
  const reservations = rounds(covered, 3, CUT - 10_000);
  // No CI-first runtime installed: no final round is granted to anyone, so
  // the pass stays silent (its reason stays the chain's own).
  const { actions, writes } = await pass(work, reservations, null);
  assert.deepEqual(
    actions.filter((action) => action.includes("legacy_class")),
    [],
  );
  assert.equal(writes, 0, actions.join(" "));
  // A proven CI-first runtime with no pinned cutoff: the rule is off while
  // the runtime that would grant the round runs, so the class is counted.
  const snapshot = liveSnapshot(work, [], [], reservations);
  assert.deepEqual(legacyClassDriftActions(snapshot, null, true), [
    "retry:legacy_class:denied:cutoff_unpinned=2",
  ]);
  assert.deepEqual(legacyClassDriftActions(snapshot, null, false), []);
  assert.deepEqual(legacyClassDriftActions(snapshot, CUT, false), [
    "retry:issue-ubiquity-ai.ubq.fi-1500:denied:legacy_class_unpinned:pin=none:spent=3",
  ]);
});

Deno.test("legacy class drift: the report is bounded per pass and counts the rest", async () => {
  const many = Array.from(
    { length: LEGACY_DRIFT_REPORTS_PER_PASS + 2 },
    (_, index) => shaped(1500 + index),
  );
  const { actions } = await pass(many, [], CUT);
  const drift = actions.filter((action) => action.includes("legacy_class"));
  assert.equal(drift.length, LEGACY_DRIFT_REPORTS_PER_PASS + 1);
  assert.equal(
    drift.at(-1),
    "retry:legacy_class:denied:drift_more=2",
  );
});
