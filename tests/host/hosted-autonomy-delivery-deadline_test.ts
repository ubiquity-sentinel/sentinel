import assert from "node:assert/strict";
import {
  HOSTED_AUTONOMY_PASS_DEADLINE_MS,
  HOSTED_AUTONOMY_PHASE_RESERVE_MS,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy-runner.ts";
import { runHostedDeliveryPass } from "../../ops/hosted-autonomy-delivery-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import { report } from "../../ops/hosted-autonomy-main.ts";
import { darkQueueCoordinatorFixture } from "./hosted-autonomy-dark-queue-fixture.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";
import { foreignReceipt, foreignRecord } from "./hosted-autonomy-fixtures.ts";
import { foreignPullFacts } from "./hosted-autonomy-fixtures.ts";
import { runHostedCiRerunPass } from "../../ops/hosted-autonomy-ci-rerun.ts";
import {
  authorizingReceipt,
  deliveryRecord,
  pullFacts,
} from "./hosted-autonomy-fixtures.ts";
import { T0 } from "../state/helpers.ts";
import type { WorkItemId } from "../../src/contracts/brands.ts";

const CUTOFF = HOSTED_AUTONOMY_PASS_DEADLINE_MS -
  HOSTED_AUTONOMY_PHASE_RESERVE_MS;

async function fixture(protectedRows = false, rerun = false) {
  const records = [
    foreignRecord(),
    foreignRecord({ id: "deadline-second" as WorkItemId }),
  ].map((record) =>
    rerun
      ? {
        ...record,
        nextStep: "blocked" as const,
        blocker: {
          kind: "other" as const,
          message: "CI checks failed: ci(failure)",
          since: T0,
        },
        target: {
          ...record.target,
          candidateState: {
            preserved: {
              operationKey: `impl:${"a".repeat(64)}`,
              base: record.target.base!,
              head: record.target.head!,
              ref: `refs/heads/sentinel-candidates/${"b".repeat(64)}`,
            },
            publishedHead: record.target.head,
          },
        },
      }
      : record
  );
  const { rig, github } = await makeRig("delivery-deadline", {
    repair: repairSnapshot(records, [foreignReceipt()]),
  });
  let now = T0 + 5000;
  const startedAt = now;
  const calls = {
    lists: 0,
    pulls: 0,
    approved: [] as number[],
    settled: false,
  };
  github.listParkedRuns = () => {
    calls.lists++;
    return Promise.resolve([]);
  };
  github.readPull = () => {
    calls.pulls++;
    return Promise.resolve(null);
  };
  rig.githubFor = () => github;
  const clock = { now: () => now };
  const deps = {
    state: rig.state,
    githubFor: rig.githubFor,
    clock,
    queueCustody: {
      ready: true,
      proofActivated: true,
      protectedRecordIds: new Set(
        protectedRows ? records.map((r) => r.id) : [],
      ),
    },
  };
  async function context() {
    const read = await rig.state.readRepair(),
      release = await rig.state.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    assert.ok(release.ok && release.value.status === "found");
    const value: HostedAutonomyPassContextV1 = {
      deps,
      snapshot: read.value.snapshot,
      observedHead: read.value.head,
      initialHead: read.value.head,
      releaseSnapshot: release.value.snapshot,
      actions: [],
      revisions: [],
      closedIssues: new Set(),
      foreignMerged: new Map(),
      dedicatedReservations: new Set(),
      ...createHostedAutonomyScopes(deps),
    };
    return Object.assign(value, {
      deadlineAt: startedAt + CUTOFF,
      passStartedAt: startedAt,
    });
  }
  const expire = () => {
    now = startedAt + CUTOFF + 1;
  };
  return {
    rig,
    github,
    deps,
    records,
    calls,
    context,
    expire,
    clock,
    now: () => now,
  };
}

Deno.test("delivery deadline: no-write maintenance stops after the settled approval read and permits prepare", async () => {
  const f = await fixture();
  try {
    const before = await f.rig.state.readRepair();
    let expire = true;
    f.github.listParkedRuns = async () => {
      f.calls.lists++;
      await Promise.resolve();
      if (expire) {
        expire = false;
        f.expire();
      }
      return [];
    };
    const deps = { ...f.deps, queue: await darkQueueCoordinatorFixture(f.rig) };
    const result = await runHostedAutonomy(deps);
    assert.equal(
      f.calls.lists,
      1,
      "no new record may start after the existing cutoff",
    );
    assert.equal(result.status, "skipped");
    assert.ok(result.actions.some((a) => a.includes("deferred_deadline")));
    assert.equal(
      report(result),
      0,
      "bounded no-write deferral keeps maintenance successful for prepare",
    );
    assert.deepEqual(await f.rig.state.readRepair(), before);
    f.calls.lists = 0;
    await runHostedAutonomy(deps);
    assert.equal(
      f.calls.lists,
      2,
      "the fresh pass still considers every unvisited record",
    );
    assert.deepEqual(await f.rig.state.readRepair(), before);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("delivery deadline: the last admitted approval settles without a later effect", async () => {
  const f = await fixture();
  try {
    f.github.listParkedRuns = () => Promise.resolve([11, 12]);
    f.github.approveRun = async (id) => {
      f.calls.approved.push(id);
      f.expire();
      await Promise.resolve();
      f.calls.settled = true;
      return true;
    };
    const before = await f.rig.state.readRepair();
    const result = await runHostedDeliveryPass(await f.context());
    assert.equal(f.calls.settled, true);
    assert.deepEqual(f.calls.approved, [11]);
    assert.equal(result?.status, "skipped");
    assert.deepEqual(await f.rig.state.readRepair(), before);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("delivery deadline: an admitted booking read settles before remaining records defer", async () => {
  const f = await fixture(true);
  try {
    f.github.readPull = async () => {
      f.calls.pulls++;
      f.expire();
      await Promise.resolve();
      f.calls.settled = true;
      return null;
    };
    const before = await f.rig.state.readRepair();
    const result = await runHostedDeliveryPass(await f.context());
    assert.equal(f.calls.pulls, 1);
    assert.equal(f.calls.settled, true);
    assert.equal(result?.status, "skipped");
    assert.deepEqual(await f.rig.state.readRepair(), before);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("delivery deadline: rerun listing admission stops while admitted batch readback settles", async (t) => {
  for (const admitted of [false, true]) {
    await t.step(
      admitted ? "admitted head settles" : "expired listing sends nothing",
      async () => {
        const f = await fixture(false, true);
        try {
          const context = await f.context(), head = f.records[0].target.head!;
          const before = await f.rig.state.readRepair();
          let listings = 0;
          f.github.listHeadRuns = async () => {
            await Promise.resolve();
            listings++;
            if (!admitted) f.expire();
            return [11, 12].map((id) => ({
              id,
              headSha: head,
              status: "completed",
              conclusion: "failure",
              runAttempt: listings > 1 ? 2 : 1,
              createdAt: T0,
            }));
          };
          f.github.readIssueOpen = () => Promise.resolve(true);
          f.github.readPull = () =>
            Promise.resolve(
              foreignPullFacts({
                state: "open",
                merged: false,
                mergeCommitSha: null,
              }),
            );
          f.github.readBaseTip = () =>
            Promise.resolve(f.records[0].target.base);
          f.github.hasAllChecksGreen = () => Promise.resolve(true);
          f.github.rerunFailedJobs = async (id) => {
            f.calls.approved.push(id);
            f.expire();
            await Promise.resolve();
            f.calls.settled = true;
            return true;
          };
          await runHostedCiRerunPass(context);
          assert.deepEqual(f.calls.approved, admitted ? [11, 12] : []);
          assert.equal(listings, admitted ? 2 : 1);
          assert.equal(f.calls.settled, admitted);
          assert.deepEqual(await f.rig.state.readRepair(), before);
        } finally {
          await Deno.remove(f.rig.tmp, { recursive: true });
        }
      },
    );
  }
});

Deno.test("delivery deadline: an admitted merge completes verification and CAS readback across cutoff", async () => {
  const { rig, github } = await makeRig("delivery-deadline-merge", {
    repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()]),
    pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    afterMerge: pullFacts(),
  });
  try {
    const started = T0 + 5000;
    let now = started, settled = false;
    const merge = github.merge;
    github.merge = async (...args) => {
      const result = await merge(...args);
      now = started + CUTOFF + 1;
      await Promise.resolve();
      settled = true;
      return result;
    };
    const deps = {
      state: rig.state,
      githubFor: () => github,
      clock: { now: () => now },
    };
    const before = await rig.state.readRepair(),
      release = await rig.state.readRelease();
    assert.ok(before.ok && before.value.status === "found");
    assert.ok(release.ok && release.value.status === "found");
    const context: HostedAutonomyPassContextV1 = {
      deps,
      passStartedAt: started,
      deadlineAt: started + CUTOFF,
      snapshot: before.value.snapshot,
      observedHead: before.value.head,
      initialHead: before.value.head,
      releaseSnapshot: release.value.snapshot,
      actions: [],
      revisions: [],
      closedIssues: new Set(),
      foreignMerged: new Map(),
      dedicatedReservations: new Set(),
      ...createHostedAutonomyScopes(deps),
    };
    const result = await runHostedDeliveryPass(context);
    assert.equal(settled, true);
    assert.equal(result?.status, "applied", JSON.stringify(result));
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(after.value.head, result.appliedHead);
    assert.equal(after.value.snapshot.releaseRequests.length, 1);
    assert.deepEqual(
      after.value.snapshot.reservations,
      before.value.snapshot.reservations,
    );
    assert.equal(rig.merges, 1);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
