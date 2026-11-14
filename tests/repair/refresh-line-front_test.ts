/**
 * The refresh line's front is the oldest record that can act now (live
 * ubiquity-sentinel/sentinel, 2026-11-13/14).
 *
 * A record on a moved base asks the line before its CI gate is read, and the
 * deferral writes nothing, so the wait it carries is whatever an earlier step
 * left: record 268 (PR 390), refreshed at 19:40Z and green since 19:47Z, kept
 * `ci_pending` from 19:40:12Z after the tip moved under it; 397 (PR 399), green
 * since 17:16Z, kept `ci_pending` from 17:10:08Z; 398 (PR 400) kept the expired
 * `unavailable` wait its pull request creation left at 18:16:17Z. Ordered by
 * that leftover wait (`ci_pending` last), the line put 271 ahead of 268 at
 * 20:39Z and, from 00:18Z, 398 ahead of both older green heads; past the
 * six-hour pre-review CI bound 397 held nobody at all. Record 312 (PR 313),
 * stalled at 180 executions without progress, was stepped after the younger
 * front 386 and refreshed onto the same tip at 23:00:17Z (two refreshes, then
 * two reviews at 00:12Z and 00:13Z in one repository).
 *
 * The REAL serial repair cycle over in-memory state and a fake repository; no
 * network, no model call.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { STEP_LINE_KIND } from "../../src/repair/step-line.ts";
import { T0 } from "../state/helpers.ts";
import { queueRig } from "./delivery-queue-rig.ts";
import { captured } from "./repository-pass-rig.ts";
import { MINUTE, sha } from "./review-round-cap-rig.ts";

const HOUR = 60 * MINUTE;
const TIP = sha(0x777);

/** A wait whose two-minute poll window ended long ago. */
function leftover(
  reason: "ci_pending" | "unavailable",
  since: number,
): WorkRecordV1["wait"] {
  return { reason, since, until: since + 2 * MINUTE };
}

/**
 * One serial pass over three published heads on a moved base, created a month
 * ago in issue order: the refreshed pull requests and every deferral. A
 * refreshed head's CI is still running, as live 386's was at 23:00:17Z.
 */
async function pass(shape: (records: WorkRecordV1[]) => WorkRecordV1[]) {
  const rig = await queueRig(3, {
    tip: TIP,
    shape: (records) =>
      shape(records.map((record, index) => ({
        ...record,
        firstSeenAt: T0 - 31 * 24 * HOUR,
        createdAt: T0 - 30 * 24 * HOUR + index,
      }))),
  });
  for (const refreshed of [sha(0x5001), sha(0x5002), sha(0x5003)]) {
    rig.github.checksByHead.set(refreshed, [{
      name: "validate",
      status: "in_progress",
      conclusion: null,
      head: refreshed,
      startedAt: T0,
      completedAt: null,
    }]);
  }
  const { lines } = await captured(() =>
    runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
    })
  );
  const steps = lines.filter((entry) => entry.kind === STEP_LINE_KIND);
  return {
    refreshed: rig.github.preparedKeys.map((key) => Number(key.split(":")[0])),
    deferred: steps.filter((entry) => entry.outcome === "deferred")
      .map((entry) => [entry.recordId, entry.reason ?? null]),
  };
}

Deno.test("refresh line: the oldest head goes first whatever wait an earlier step left", async () => {
  // issue-1 is 268, issue-2 397 (its leftover CI wait past the six-hour
  // pre-review bound) and issue-3 398, oldest first.
  const out = await pass(([first, second, third]) => [
    { ...first!, wait: leftover("ci_pending", T0 - 4 * HOUR) },
    { ...second!, wait: leftover("ci_pending", T0 - 7 * HOUR) },
    {
      ...third!,
      wait: leftover("unavailable", T0 - 6 * HOUR),
      updatedAt: T0 - 5 * HOUR,
    },
  ]);
  assert.deepEqual(out.refreshed, [101], "one refresh: the oldest head's");
  assert.deepEqual(out.deferred, [
    ["issue-2", "ci_line"],
    ["issue-3", "ci_line"],
  ]);
});

Deno.test("refresh line: a stalled record waits at the back instead of refreshing beside the front", async () => {
  // issue-1 is 312: the oldest, stalled, its red backoff long expired;
  // issue-2 (386) and issue-3 can act.
  const out = await pass(([first, second, third]) => [
    {
      ...first!,
      counters: { ...first!.counters, stalled: 180 },
      wait: {
        reason: "backoff",
        since: T0 - 7 * 24 * HOUR,
        until: T0 - 20 * HOUR,
      },
      updatedAt: T0 - 20 * HOUR,
    },
    { ...second!, wait: leftover("unavailable", T0 - 22 * HOUR) },
    { ...third!, wait: leftover("ci_pending", T0 - 3 * HOUR) },
  ]);
  assert.deepEqual(out.refreshed, [102], "exactly one refresh per pass");
  assert.deepEqual(
    out.deferred.map(([id]) => id).sort(),
    ["issue-1", "issue-3"],
  );
});
