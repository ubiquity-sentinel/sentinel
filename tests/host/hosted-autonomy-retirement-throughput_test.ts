import assert from "node:assert/strict";
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import { runHostedClosurePass } from "../../ops/hosted-autonomy-closure-pass.ts";
import { HOSTED_AUTONOMY_RETIRED } from "../../ops/hosted-autonomy-policy.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import { foreignRecord } from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";
import { hostedIssueKey } from "../../ops/hosted-autonomy-policy.ts";
import { reservation, T0 } from "../state/helpers.ts";

async function fixture(count: number) {
  const records = Array.from({ length: count }, (_, index) => {
    const original = foreignRecord();
    const issue = index + 1;
    const id = `issue-ubiquity-other-target-${issue}`;
    return foreignRecord({
      id,
      source: { ...original.source, id: String(issue) },
      related: { ...original.related, issueNumber: issue },
      target: {
        ...original.target,
        branch: `sentinel/repair/${id}`,
        pr: issue,
      },
    });
  });
  const charges = records.map((record, index) =>
    reservation(`retirement-charge-${index}`, {
      repository: record.repository,
      taskId: record.id,
      head: record.target.head,
      outcome: "submitted",
      settledAt: T0 + 2000,
    })
  );
  const { rig, github } = await makeRig("retirement-throughput", {
    repair: repairSnapshot(records, [], [], charges),
  });
  let now = T0 + 5000;
  const deps = {
    ciMinutes: INACTIVE_CI_MINUTES,
    state: rig.state,
    githubFor: () => github,
    clock: { now: () => now },
  };
  const repair = await rig.state.readRepair();
  const release = await rig.state.readRelease();
  assert.ok(repair.ok && repair.value.status === "found");
  assert.ok(release.ok && release.value.status === "found");
  const context: HostedAutonomyPassContextV1 = {
    deps,
    snapshot: repair.value.snapshot,
    observedHead: repair.value.head,
    initialHead: repair.value.head,
    releaseSnapshot: release.value.snapshot,
    actions: [],
    revisions: [],
    closedIssues: new Set(
      records.map((record) =>
        hostedIssueKey(record.repository, record.related.issueNumber!)
      ),
    ),
    foreignMerged: new Map(),
    dedicatedReservations: new Set(),
    ...createHostedAutonomyScopes(deps),
  };
  return {
    rig,
    github,
    records: repair.value.snapshot.work,
    charges: repair.value.snapshot.reservations,
    context,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

Deno.test("retirement throughput: hot-tier status reads overlap before the single trusted write", async () => {
  const f = await fixture(25);
  try {
    const start = f.now();
    let active = 0, peak = 0, waves = 0;
    const reads: number[] = [];
    f.github.readPullStatus = async (number) => {
      if (active === 0) {
        waves++;
        f.advance(1000);
      }
      peak = Math.max(peak, ++active);
      reads.push(number);
      await Promise.resolve();
      active--;
      return { number, state: "closed", merged: false };
    };
    let deliveryReads = 0;
    f.github.readPull = () => {
      deliveryReads++;
      return Promise.resolve(null);
    };
    const write = f.context.deps.state.writeRepair.bind(f.context.deps.state);
    f.context.deps.state.writeRepair = (snapshot, expectedHead) => {
      assert.equal(active, 0, "all admitted reads settle before a write");
      assert.equal(reads.length, 25);
      return write(snapshot, expectedHead);
    };
    const result = await runHostedClosurePass(f.context);
    assert.equal(peak, 4, "status reads overlap with a four-read bound");
    assert.equal(waves, 7, "25 statuses take seven waves, not 25 round trips");
    assert.equal(f.now() - start, 7000);
    assert.deepEqual(reads, f.records.map((record) => record.target.pr));
    assert.equal(result?.reason, "retired_records");
    assert.equal(f.rig.writes, 1);
    assert.equal(deliveryReads, 0, "retirement needs no delivery ancestry");
    assert.equal(f.rig.merges, 0);
    assert.deepEqual(f.rig.closed, []);
    assert.deepEqual(
      result?.actions,
      f.records.map((record) =>
        `retire:${record.id}:issue=${record.related.issueNumber}`
      ),
      "retirements retain snapshot order",
    );
    const after = await f.rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.deepEqual(after.value.snapshot.reservations, f.charges);
    for (const record of after.value.snapshot.work) {
      assert.equal(record.nextStep, "blocked");
      assert.equal(record.blocker?.message, HOSTED_AUTONOMY_RETIRED);
      assert.deepEqual(
        record.counters,
        f.records.find((row) => row.id === record.id)!.counters,
      );
    }
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("retirement throughput: slow and failed reads drain without manufacturing retirement evidence", async () => {
  const f = await fixture(8);
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let scanning: ReturnType<typeof runHostedClosurePass> | undefined;
  try {
    const reads: number[] = [];
    f.context.closedIssues.delete(hostedIssueKey(f.records[0].repository, 8));
    f.github.readPullStatus = async (number) => {
      reads.push(number);
      if (number === 1) await first;
      if (number === 4) return null;
      if (number === 6) throw new Error("unavailable");
      return {
        number: number === 5 ? 500 : number,
        state: number === 2 ? "open" : "closed",
        merged: number === 3,
      };
    };
    scanning = runHostedClosurePass(f.context);
    // The slow first read must not hold the other three read slots. No wall
    // clock sleeps or real API calls are involved in this simulated outage.
    for (let turns = 0; turns < 50 && reads.length < 7; turns++) {
      await Promise.resolve();
    }
    assert.deepEqual(reads, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(
      f.rig.writes,
      0,
      "a pending read cannot leak into a state write",
    );
    releaseFirst();
    const result = await scanning;
    assert.ok(result);
    assert.equal(result.reason, "retired_records");
    assert.equal(f.rig.writes, 1);
    assert.equal(f.rig.merges, 0);
    assert.deepEqual(f.rig.closed, []);
    assert.deepEqual(
      result.actions,
      [1, 2, 7].map((issue) =>
        `retire:issue-ubiquity-other-target-${issue}:issue=${issue}`
      ),
    );
    const after = await f.rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.deepEqual(after.value.snapshot.reservations, f.charges);
    for (const issue of [3, 4, 5, 6, 8]) {
      const before = f.records.find((record) =>
        record.related.issueNumber === issue
      )!;
      assert.deepEqual(
        after.value.snapshot.work.find((record) => record.id === before.id),
        before,
        "merged, unreadable, mismatched and still-open issues keep their records",
      );
    }
  } finally {
    releaseFirst();
    await scanning;
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});
