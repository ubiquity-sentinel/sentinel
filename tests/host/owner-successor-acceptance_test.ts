import { installedSupersession } from "./owner-install-supersession-fixtures.ts";
import { driveOwnerTaskAcceptance } from "./owner-install-supersession-acceptance-fixtures.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedRuntimeRollout } from "../../src/host/hosted-runtime-rollout.ts";
import { ownerInstall } from "./owner-install-supersession-fixtures.ts";

Deno.test("owner successor genuine structured review produces charged durable acceptance and delivers original task once", async () => {
  const rig = await installedSupersession();
  try {
    await driveOwnerTaskAcceptance(rig);
  } finally {
    await rig.close();
  }
});

Deno.test("owner successor deferred acceptance preserves native proof through prepare finalize and delivers on retry", async () => {
  const rig = await installedSupersession();
  try {
    await driveOwnerTaskAcceptance(rig, { deferredAcceptance: true });
  } finally {
    await rig.close();
  }
});

Deno.test("owner healthy correction retains failed task review and completes through its exact new capable binding", async () => {
  const rig = await installedSupersession();
  try {
    const failed = await driveOwnerTaskAcceptance(rig, { reviewFailure: true });
    assert.equal(failed.journal.phase, "failed");
    const oldJournal = canonicalStringify(failed.journal),
      before = await rig.current();
    const i = failed.receipt.ownerDisposition!.intent;
    await rig.source.write(
      rig.source.runtime,
      "runtime.ts",
      "// Corrected healthy successor after genuine task review refusal\n",
    );
    await rig.source.git(rig.source.runtime, ["add", "."]);
    await rig.source.git(rig.source.runtime, [
      "commit",
      "-qm",
      "freeze corrected task successor",
    ]);
    const f2 = await rig.source.git(rig.source.runtime, [
      "rev-parse",
      "HEAD",
    ]) as GitSha;
    const rung = {
      fromRevision: i.toRevision,
      fromGeneration: i.toGeneration,
      toRevision: f2,
      toGeneration: i.toGeneration + 1,
      rollbackToPrior: true,
    };
    const floors = {
      queue: { ...rig.queue, revisions: [...rig.queue.revisions, f2] },
      custody: { ...rig.custody, revisions: [...rig.custody.revisions, f2] },
    };
    await rig.publishRollout(
      parseHostedRuntimeRollout({
        ...rig.rollout,
        installs: [...rig.rollout.installs, rung],
      }),
      floors.queue,
      floors.custody,
    );
    rig.nextRun();
    const patches = rig.patches();
    await ownerInstall(rig);
    assert.equal(
      rig.patches(),
      patches,
      "healthy pointer movement cannot lose its pending task binding",
    );
    const binding = {
      releaseId: failed.receipt.id,
      requestSha256: i.requestSha256,
      intentSha256: failed.receipt.ownerDisposition!.intentSha256,
      successorRevision: f2,
      successorGeneration: i.toGeneration + 1,
      taskSha256: i.taskSha256,
      issueNumber: i.issueNumber,
      workId: i.workId,
      acceptanceBaseRevision: i.toRevision,
      controllerSourceRevision: i.controllerSourceRevision,
      controllerCodeSha256: i.controllerCodeSha256,
      ciRevision: f2,
    };
    await rig.publishRollout(
      parseHostedRuntimeRollout({
        ...rig.rollout,
        ownerSuccessorTaskBindings: [binding],
      }),
    );
    rig.nextRun();
    await ownerInstall(rig);
    assert.equal(rig.patches(), patches + 1);
    const moved = await rig.current();
    assert.equal(moved.snapshot.hostedRuntimes[0].activeRevision, f2);
    assert.equal(
      moved.snapshot.hostedReleases[0].ownerSuccessorBindings?.[0].movement,
      "install",
    );
    assert.equal(
      moved.snapshot.hostedReleases[0].ownerSuccessorBindings?.[0].movementProof
        .outcome,
      "healthy",
    );
    assert.deepEqual(
      moved.snapshot.hostedReleases[0].ownerDisposition,
      before.snapshot.hostedReleases[0].ownerDisposition,
    );
    await driveOwnerTaskAcceptance(rig);
    const repair = await rig.repair.readRepair();
    assert.ok(repair.ok && repair.value.status === "found");
    assert.equal(repair.value.snapshot.ownerSuccessorReviews?.length, 2);
    assert.equal(
      canonicalStringify(
        repair.value.snapshot.ownerSuccessorReviews!.find((r) =>
          r.id === failed.journal.id
        ),
      ),
      oldJournal,
    );
    assert.equal(repair.value.snapshot.work[0].nextStep, "done");
    assert.equal(
      repair.value.snapshot.reservations.filter((r) =>
        r.purpose === "review_request" && r.outcome === "submitted"
      ).length,
      2,
    );
  } finally {
    await rig.close();
  }
});
