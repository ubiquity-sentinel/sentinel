/** Runtime admission uses exact native evidence, independent of retired floors. */
import assert from "node:assert/strict";
import { runHostedSupervisorPrepare } from "../../src/host/actions-supervisor.ts";
import { commitHosted } from "../../src/host/actions-supervisor-state.ts";
import {
  CANDIDATE,
  DORMANT_HOSTED_POLICIES,
  LAUNCHER,
  makeRig,
  releaseRequest,
  requireRun,
  type RigV1,
  run,
} from "./actions-supervisor-fixture.ts";
import { bootstrapHealthy } from "./actions-supervisor-lifecycle-fixture.ts";

function input(rig: RigV1, id: number) {
  return {
    ...DORMANT_HOSTED_POLICIES,
    clock: rig.clock,
    state: rig.release,
    run: run(id),
    evidence: rig.evidence,
    queueRuntimeCapability: { proofActivated: true, revisions: [CANDIDATE] },
    existingPrRuntimeCapability: {
      custodyActivated: true,
      revisions: [CANDIDATE],
    },
  };
}

Deno.test("existing PR runtime admission: missing exact source proof refuses bootstrap before a pointer write", async () => {
  const rig = await makeRig();
  try {
    const before = await rig.release.readRelease();
    assert.equal(
      (await runHostedSupervisorPrepare(input(rig, 1))).status,
      "pending",
    );
    assert.deepEqual(await rig.release.readRelease(), before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime admission: proven bootstrap ignores retired custody floors and stays model-disabled", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    const repairBefore = await rig.repair.readRepair();
    const boot = requireRun(await runHostedSupervisorPrepare(input(rig, 1)));
    assert.equal(boot.purpose, "bootstrap");
    assert.equal(boot.revision, LAUNCHER);
    assert.equal(boot.launcherSha, LAUNCHER);
    assert.equal(boot.generation, 1);
    assert.equal(boot.releaseId, null);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime admission: same-run ordinary replay preserves exact execution and accounting", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const saved = requireRun(await rig.prepare(run(2)));
    assert.equal(saved.purpose, "ordinary");
    const before = await rig.snapshot();
    const repairBefore = await rig.repair.readRepair();
    const replay = requireRun(await runHostedSupervisorPrepare(input(rig, 2)));
    assert.deepEqual(replay, saved);
    assert.deepEqual(await rig.snapshot(), before);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime admission: unresolved native settlement cannot be displaced by a new run", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    requireRun(await rig.prepare(run(1)));
    const before = await rig.snapshot();
    const repairBefore = await rig.repair.readRepair();
    assert.equal(
      (await runHostedSupervisorPrepare(input(rig, 2))).status,
      "pending",
    );
    assert.deepEqual(await rig.snapshot(), before);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime admission: an unreviewed candidate cannot open a generic release or move the pointer", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    await rig.seedRepair([request], []);
    rig.evidence.requests.add(request.id);
    const repairBefore = await rig.repair.readRepair();
    const outcome = await runHostedSupervisorPrepare(input(rig, 2));
    if (outcome.status === "run") {
      assert.equal(outcome.execution.purpose, "ordinary");
    }
    const after = await rig.snapshot();
    assert.equal(after.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(after.hostedRuntimes[0].generation, 1);
    assert.deepEqual(after.hostedReleases, []);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime admission: final CAS rejects a synthesized pointer movement without an installation journal", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const read = await rig.release.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    const before = read.value.snapshot;
    assert.equal(
      await commitHosted(
        input(rig, 2),
        { snapshot: before, head: read.value.head },
        {
          ...before.hostedRuntimes[0],
          activeRevision: CANDIDATE,
          generation: 2,
        },
        before.hostedReleases,
      ),
      "pending",
    );
    assert.deepEqual(await rig.snapshot(), before);
  } finally {
    await rig.cleanup();
  }
});
