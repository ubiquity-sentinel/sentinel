/**
 * A verified merged foreign delivery whose source issue is already closed has
 * nothing left to close. Live 2026-11-12: seven merged Passport, work and
 * keygen deliveries, each issue closed by its own `Resolves #N` merge, logged
 * `close:…:refused` on every maintenance pass because their head CI did not
 * read green, and stayed at `delivery` forever. Green head CI still gates
 * every closure Sentinel itself would make on an OPEN issue.
 */
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { buildHostedReleaseRequest } from "../../ops/hosted-autonomy.ts";
import { reservation, T0 } from "../state/helpers.ts";
import {
  BASE,
  FOREIGN_PR,
  FOREIGN_REPO,
  FOREIGN_TARGET,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
  MERGE,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";

const ISSUE = 120;
const REFUSED = `close:${FOREIGN_TARGET}:issue=${ISSUE}:refused`;
const RECONCILED = `reconcile:${FOREIGN_TARGET}:already_closed`;
const CLOSED = `close:${FOREIGN_TARGET}:issue=${ISSUE}`;

/** The live shape: merged by a person, waiting on its open release request. */
async function mergedDelivery(
  prefix: string,
  issueOpen: (read: number) => boolean | null,
  checks: boolean | null,
) {
  const receipt = foreignReceipt();
  const request = await buildHostedReleaseRequest(
    FOREIGN_REPO,
    MERGE,
    HEAD,
    BASE,
    FOREIGN_PR,
    receipt,
    T0 + 4500,
  );
  if (request === null) throw new Error("release request fixture invalid");
  const charge = reservation("foreign-review-charge", {
    repository: FOREIGN_REPO,
    taskId: FOREIGN_TARGET,
    head: HEAD,
    purpose: "review_request",
    outcome: "submitted",
    settledAt: T0 + 2000,
  });
  const record = foreignRecord({
    wait: { reason: "unavailable", since: T0 + 4600, until: T0 + 304_600 },
    counters: { attempts: 1, retries: 0, reviewRounds: 4, stalled: 365 },
  });
  const { rig, github } = await makeRig(prefix, {
    repair: repairSnapshot([record], [receipt], [request], [charge]),
    pull: foreignPullFacts({
      author: "ubiquity-sentinel[bot]",
      mergedBy: "a-maintainer",
    }),
  });
  let reads = 0;
  github.readIssueOpen = () => Promise.resolve(issueOpen(++reads));
  const checked: string[] = [];
  github.hasAllChecksGreen = (head) => {
    checked.push(head);
    return Promise.resolve(checks);
  };
  return { rig, record, checked, issueReads: () => reads };
}

async function snapshotOf(
  rig: Awaited<ReturnType<typeof makeRig>>["rig"],
): Promise<{ head: string; snapshot: RepairStateSnapshotV1 }> {
  const read = await rig.state.readRepair();
  if (!read.ok || read.value.status !== "found") throw new Error("unreadable");
  return { head: read.value.head, snapshot: read.value.snapshot };
}

function recordOf(snapshot: RepairStateSnapshotV1): WorkRecordV1 {
  const record = snapshot.work.find((row) => row.id === FOREIGN_TARGET);
  if (record === undefined) throw new Error("record missing");
  return record;
}

Deno.test("hosted closure: a merged foreign delivery whose issue is already closed settles done whatever its head CI reads", async (t) => {
  for (const checks of [false, null, true]) {
    await t.step(`head CI ${checks}`, async () => {
      const { rig, record, checked } = await mergedDelivery(
        `closure-already-closed-${checks}`,
        () => false,
        checks,
      );
      try {
        const before = await snapshotOf(rig);
        const result = await run(rig);
        assert.equal(result.status, "applied", JSON.stringify(result));
        assert.equal(result.reason, "closed_issues");
        assert.ok(
          result.actions.includes(`delivery:${FOREIGN_TARGET}:foreign_merged`),
        );
        assert.ok(result.actions.includes(RECONCILED), result.actions.join());
        assert.ok(result.actions.includes(CLOSED));
        assert.ok(!result.actions.includes(REFUSED));
        // Nothing is left to close: no issue write, no merge.
        assert.deepEqual(rig.closed, []);
        assert.equal(rig.merges, 0);
        assert.deepEqual(
          checked,
          [],
          "no closing write is left for CI to gate",
        );
        const after = await snapshotOf(rig);
        assert.equal(after.head, result.appliedHead, "exact CAS readback");
        const done = recordOf(after.snapshot);
        // The existing terminal transition: done, nothing in flight.
        assert.equal(done.nextStep, "done");
        assert.equal(done.wait, null);
        assert.equal(done.blocker, null);
        assert.equal(done.intent, null);
        assert.deepEqual(done.counters, record.counters);
        assert.deepEqual(done.target, record.target);
        assert.deepEqual(done.evidence, record.evidence);
        // Custody and accounting: no settlement, refund or new charge; the
        // open release request and the review stay exactly as recorded.
        assert.deepEqual(
          after.snapshot.reservations,
          before.snapshot.reservations,
        );
        assert.deepEqual(
          after.snapshot.releaseRequests,
          before.snapshot.releaseRequests,
        );
        assert.equal(after.snapshot.releaseRequests[0].status, "open");
        assert.deepEqual(after.snapshot.reviews, before.snapshot.reviews);

        // The loop is gone: the next pass neither reads nor refuses it.
        const writes = rig.writes;
        const again = await run(rig);
        assert.equal(rig.writes, writes, JSON.stringify(again));
        assert.ok(
          !again.actions.some((action) => action.includes(FOREIGN_TARGET)),
          again.actions.join(),
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("hosted closure: an open, reopened or unreadable issue on a red merged head still refuses", async (t) => {
  const cases: [string, (read: number) => boolean | null][] = [
    ["open", () => true],
    ["unreadable", () => null],
    // Closed for the pass's issue facts, then reopened before the closure's
    // own fresh read: the fresh read decides.
    ["reopened", (read) => read === 1 ? false : true],
    ["unreadable at the closure", (read) => read === 1 ? false : null],
  ];
  for (const [name, issueOpen] of cases) {
    await t.step(name, async () => {
      const { rig, record, checked } = await mergedDelivery(
        `closure-open-red-${name.replaceAll(" ", "-")}`,
        issueOpen,
        false,
      );
      try {
        const result = await run(rig);
        assert.ok(result.actions.includes(REFUSED), result.actions.join());
        assert.ok(!result.actions.includes(RECONCILED));
        assert.ok(!result.actions.includes(CLOSED));
        assert.deepEqual(rig.closed, []);
        assert.equal(rig.merges, 0);
        assert.ok(checked.includes(HEAD), "the open-issue path reads head CI");
        const after = await snapshotOf(rig);
        assert.deepEqual(recordOf(after.snapshot), record);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});
