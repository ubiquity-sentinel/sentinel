import assert from "node:assert/strict";
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import { runHostedDeliveryPass } from "../../ops/hosted-autonomy-delivery-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import { foreignRecord } from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";
import { T0 } from "../state/helpers.ts";

async function fixture(count: number) {
  const records = Array.from({ length: count }, (_, index) => {
    const original = foreignRecord();
    return foreignRecord({
      id: `approval-${String(index).padStart(2, "0")}`,
      target: {
        ...original.target,
        head: (index + 1).toString(16).padStart(40, "0"),
        pr: index + 1,
      },
    });
  });
  const { rig, github } = await makeRig("approval-throughput", {
    repair: repairSnapshot(records, []),
  });
  let now = T0 + 5_000;
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
    closedIssues: new Set(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set(),
    ...createHostedAutonomyScopes(deps),
  };
  return {
    rig,
    github,
    records,
    context,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

Deno.test("approval throughput: hot-tier listings overlap while approvals and state stay serial", async () => {
  const f = await fixture(25);
  try {
    const before = await f.rig.state.readRepair();
    const start = f.now();
    let active = 0, peak = 0, waves = 0;
    let approving = 0, peakApprovals = 0;
    const reads: number[] = [], approved: number[] = [];
    f.github.listParkedRuns = async (head) => {
      if (active === 0) {
        waves++;
        f.advance(1_000);
      }
      peak = Math.max(peak, ++active);
      const number = parseInt(head, 16);
      reads.push(number);
      await Promise.resolve();
      active--;
      return [number];
    };
    f.github.approveRun = async (id) => {
      peakApprovals = Math.max(peakApprovals, ++approving);
      await Promise.resolve();
      approved.push(id);
      approving--;
      return true;
    };
    await runHostedDeliveryPass(f.context);
    assert.equal(
      peak,
      4,
      "independent read-only listings must overlap, bounded at four",
    );
    assert.equal(
      waves,
      7,
      "one initial listing, then six four-record read batches",
    );
    assert.equal(
      f.now() - start,
      7_000,
      "25 serial round trips must not consume 25 seconds",
    );
    assert.deepEqual(reads, f.records.map((record) => record.target.pr));
    assert.deepEqual(
      approved,
      reads,
      "approvals keep deterministic record order",
    );
    assert.equal(peakApprovals, 1, "GitHub writes must never overlap");
    assert.equal(active, 0, "all admitted reads settle before returning");
    assert.equal(
      f.rig.merges,
      0,
      "approval cannot bypass the review or merge gate",
    );
    assert.deepEqual(await f.rig.state.readRepair(), before);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("approval throughput: failed listings stay unavailable and the three-run write bound is unchanged", async () => {
  const f = await fixture(6);
  try {
    const approved: number[] = [], listed: number[] = [];
    f.github.listParkedRuns = async (head) => {
      const number = parseInt(head, 16);
      listed.push(number);
      await Promise.resolve();
      if (number === 2) throw new Error("listing unavailable");
      return number === 4 ? [40, 41, 42, 43] : [];
    };
    f.github.approveRun = (id) => {
      approved.push(id);
      if (id === 41) return Promise.reject(new Error("approval unavailable"));
      return Promise.resolve(true);
    };
    await runHostedDeliveryPass(f.context);
    assert.deepEqual(listed, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(approved, [40, 41, 42]);
    assert.deepEqual(f.context.actions, [
      "approve:approval-03:run=40:approved",
      "approve:approval-03:run=41:refused",
      "approve:approval-03:run=42:approved",
    ]);
    assert.equal(f.rig.merges, 0);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("approval throughput: deadline drains the admitted read batch without another read or approval", async () => {
  const f = await fixture(10);
  const releases: (() => void)[] = [];
  let active = 0, settled = false;
  let pending: ReturnType<typeof runHostedDeliveryPass> | undefined;
  try {
    const before = await f.rig.state.readRepair();
    f.context.passStartedAt = f.now();
    f.context.deadlineAt = f.now() + 1_000;
    const reads: number[] = [], approved: number[] = [];
    f.github.listParkedRuns = async (head) => {
      const number = parseInt(head, 16);
      reads.push(number);
      if (number === 1) return [];
      active++;
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return [number];
    };
    f.github.approveRun = (id) => {
      approved.push(id);
      return Promise.resolve(true);
    };
    pending = runHostedDeliveryPass(f.context).then((result) => {
      settled = true;
      return result;
    });
    for (let tick = 0; tick < 100 && releases.length < 4; tick++) {
      await Promise.resolve();
    }
    assert.equal(releases.length, 4, "only four tail reads may be admitted");
    f.advance(2_000);
    for (const release of releases.slice(0, -1)) release();
    for (let tick = 0; tick < 30; tick++) await Promise.resolve();
    assert.equal(active, 1);
    assert.equal(
      settled,
      false,
      "the final admitted read must settle before return",
    );
    releases.at(-1)!();
    const result = await pending;
    assert.equal(active, 0);
    assert.deepEqual(reads, [1, 2, 3, 4, 5]);
    assert.deepEqual(approved, [], "expired listings never start a write");
    assert.equal(result?.status, "skipped");
    assert.ok(
      result?.actions.includes("continuation:delivery:deferred_deadline"),
    );
    assert.deepEqual(await f.rig.state.readRepair(), before);
  } finally {
    f.advance(2_000);
    for (const release of releases) release();
    await pending;
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});
