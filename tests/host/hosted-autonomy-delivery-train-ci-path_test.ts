/**
 * A delivery train never carries a change to a CI-executable path (owner
 * directive 2026-11-17): its own modified workflow judges it, and the train
 * reads only the train commit's CI. Through the real delivery pass with the
 * real train composer, such a member is refused at admission and keeps the
 * per-record path (it is not stranded): the others land as one train, and it
 * waits behind the moved tip at `delivery` exactly like a conflicting member,
 * to be refreshed and merged on its own under the success rule.
 */
import assert from "node:assert/strict";
import { createMetricsCollectorV1 } from "../../src/contracts/throughput-metrics-collector.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";
import { makeTrainWorld, type MemberSpecV1 } from "./delivery-train-rig.ts";
import { T0 } from "../state/helpers.ts";

const SPECS: MemberSpecV1[] = [0, 1, 2, 3, 4].map((index) => ({
  file: `feature-${index}.txt`,
  content: `feature ${index}\n`,
}));

/** The pull request files GitHub lists: member 2 also changes a workflow. */
const WORKFLOW_MEMBER = 2;

Deno.test("train: a member that changes a workflow leaves the train for the per-record path; the other four land", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "sentinel-train-ci-world-" });
  const world = await makeTrainWorld(tmp, SPECS, { now: () => T0 });
  const { rig, github } = await makeRig("train-ci-path", {
    repair: repairSnapshot(
      world.members.map((m) => m.record),
      world.members.map((m) => m.receipt),
    ),
  });
  const files = new Map(
    world.members.map((m, index) => [
      m.pr,
      index === WORKFLOW_MEMBER
        ? [SPECS[index].file, ".github/workflows/member.yml"]
        : [SPECS[index].file],
    ]),
  );
  const base = world.surface(github);
  const surface: HostedAutonomyGitHubV1 = {
    ...base,
    listPullFiles: (number: number) =>
      Promise.resolve(files.get(number) ?? null),
    hasTargetCiSuccess: () => Promise.resolve(true),
  };
  try {
    const { actions } = await run(rig, surface, {
      deliveryTrain: world.trainDeps,
      metrics: createMetricsCollectorV1(),
    });
    const text = JSON.stringify(actions);
    const workflow = world.members[WORKFLOW_MEMBER];
    assert.deepEqual(world.merges, [500, 501, 503, 504], text);
    assert.ok(
      !actions.some((line) =>
        line.startsWith(`delivery:${workflow.id}:train_member:`)
      ),
      text,
    );
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const after = new Map(
      read.value.snapshot.work.map((record) => [record.id, record]),
    );
    for (const m of world.members) {
      assert.equal(
        after.get(m.id)?.nextStep,
        m.id === workflow.id ? "delivery" : "done",
        text,
      );
    }
    // Back on the per-record path it waits behind the moved tip, like a
    // conflicting member, for its refresh and its own merge gate.
    assert.ok(actions.includes(`delivery:${workflow.id}:base_moved`), text);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
    await Deno.remove(tmp, { recursive: true });
  }
});
