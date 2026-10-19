import assert from "node:assert/strict";
import { readOwnerFutureRecoveryAuthority } from "../../src/host/owner-install-future-recovery.ts";
import { runOwnerDevelopmentInstallMain } from "../../src/host/owner-install-run.ts";
import { futureRecoveryFixture } from "./owner-install-future-recovery-fixtures.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../../src/contracts/canonical.ts";
import { validateHostedStateTransition } from "../../src/contracts/hosted-supervisor.ts";
import { parseHostedRuntimeRollout } from "../../src/host/hosted-runtime-rollout.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-install-plan.ts";
import {
  readOwnerSupersededRecoveryAuthority,
  readOwnerSupersessionAuthority,
} from "../../src/host/owner-install-supersession.ts";
import type { OwnerSupersessionAuthority } from "../../src/host/owner-install-supersession.ts";
import {
  ownerInstall,
  runHostedSupervisorPrepare,
  settle,
  supervisor,
} from "./owner-install-supersession-fixtures.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { driveOwnerTaskAcceptance } from "./owner-install-supersession-acceptance-fixtures.ts";
import { driveCapableNormalRollback } from "./owner-install-supersession-normal-fixtures.ts";
import { originalPriorNativeFingerprint } from "../../src/host/owner-install-supersession-original.ts";
import { driveSupersessionRefusals } from "./owner-install-supersession-refusal-fixtures.ts";

Deno.test("owner supersession atomically installs capable F and preserves failed PRIOR custody", async () => {
  const rig = await futureRecoveryFixture({
    legacyFirst: true,
    ownerSupersession: true,
  });
  try {
    const before = await rig.current();
    assert.equal(rig.failed.execution.id, "39170939335:1:repair");
    assert.equal(rig.originalHistorical.execution.id, "39167387867:1:repair");
    assert.equal(rig.failed.execution.purpose, "prior");
    assert.equal(
      rig.failed.execution.releaseId,
      before.snapshot.hostedReleases[0].id,
    );
    assert.equal(before.snapshot.hostedReleases[0].phase, "requested");
    assert.equal(
      await readOwnerFutureRecoveryAuthority(await rig.readerInput()),
      undefined,
    );
    const initialAuthority = await readOwnerSupersessionAuthority(
      await rig.readerInput(),
    );
    assert.ok(initialAuthority);
    for (
      const forged of [{}, {
        ...initialAuthority,
      }] as OwnerSupersessionAuthority[]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          before.snapshot,
          Date.now(),
          undefined,
          undefined,
          rig.queue,
          rig.custody,
          rig.rollout,
          undefined,
          forged,
        ).status,
        "waiting",
      );
    }
    const repairBefore = await rig.repair.readRepair();
    const maintenance = await rig.maintenance();
    assert.equal(maintenance.effects, 0);
    const code = await runOwnerDevelopmentInstallMain({
      queueRuntimeCapability: rig.queue,
      existingPrRuntimeCapability: rig.custody,
      rollout: rig.rollout,
    });
    assert.equal(code, 0);
    assert.deepEqual({
      migration: maintenance.outputs.runtimeMigrationOnly,
      writer: rig.reports.at(-1)?.status,
      patches: rig.patches(),
    }, { migration: "true", writer: "installed", patches: 1 });
    const after = await rig.current();
    const receipt = after.snapshot.hostedReleases[0];
    assert.equal(receipt.phase, "owner_superseded");
    assert.deepEqual(
      receipt.request,
      before.snapshot.hostedReleases[0].request,
    );
    assert.deepEqual([
      receipt.priorProof,
      receipt.candidateProof,
      receipt.rollbackProof,
      receipt.pointerIntent,
    ], [null, null, null, null]);
    assert.deepEqual(receipt.ownerDisposition?.failedPriorProof, rig.failed);
    assert.ok(receipt.ownerDisposition);
    assert.equal(
      await originalPriorNativeFingerprint(
        receipt.ownerDisposition.originalFailedPriorProof,
      ),
      await originalPriorNativeFingerprint(rig.originalHistorical),
    );
    assert.equal(
      receipt.ownerDisposition.originalFailedPriorProof.observedAt,
      Date.now(),
    );
    assert.notEqual(
      receipt.ownerDisposition.originalFailedPriorProof.observedAt,
      rig.originalHistorical.observedAt,
    );
    assert.equal(
      Object.hasOwn(
        receipt.ownerDisposition.intent,
        "originalFailedPriorWitnessHead",
      ),
      false,
    );
    assert.deepEqual(
      after.snapshot.hostedRuntimes[0].lastExecutionProof,
      rig.failed,
    );
    assert.deepEqual(
      after.snapshot.hostedRuntimes[0].lastHealthyProof,
      rig.healthy,
    );
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
    assert.equal(
      validateHostedStateTransition(
        before.snapshot.hostedRuntimes,
        before.snapshot.hostedReleases,
        after.snapshot.hostedRuntimes,
        after.snapshot.hostedReleases,
      ),
      null,
    );
    const bootstrap = await runHostedSupervisorPrepare(supervisor(rig));
    assert.ok(bootstrap.status === "run");
    assert.equal(bootstrap.execution.purpose, "bootstrap");
    assert.equal(bootstrap.execution.releaseId, null);
    assert.equal(bootstrap.execution.id, `${rig.run.runId}:1:repair`);
    assert.equal(await ownerInstall(rig), 0);
    assert.equal(rig.patches(), 1);
    assert.deepEqual(await rig.current(), after);
    assert.equal(
      await readOwnerSupersessionAuthority(await rig.readerInput()),
      undefined,
    );
    assert.equal(receipt.ownerAcceptance, undefined);
    const disposition = canonicalStringify(receipt.ownerDisposition);
    await settle(rig, "failed");
    rig.nextRun();
    const failedF = await rig.current();
    assert.equal(
      (await rig.maintenance()).outputs.runtimeMigrationOnly,
      "false",
    );
    assert.equal(
      await readOwnerFutureRecoveryAuthority(await rig.readerInput()),
      undefined,
    );
    assert.equal(
      await readOwnerSupersededRecoveryAuthority(await rig.readerInput()),
      undefined,
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        failedF.snapshot,
        Date.now(),
        undefined,
        undefined,
        rig.queue,
        rig.custody,
        rig.rollout,
      ).status,
      "waiting",
    );
    await rig.source.write(
      rig.source.runtime,
      "runtime.ts",
      "// Exact capable recovery F2\n",
    );
    await rig.source.git(rig.source.runtime, ["add", "."]);
    await rig.source.git(rig.source.runtime, [
      "commit",
      "-qm",
      "freeze capable F2",
    ]);
    const f2 = await rig.source.git(rig.source.runtime, [
      "rev-parse",
      "HEAD",
    ]) as GitSha;
    const recovery = {
      fromRevision: rig.successor,
      fromGeneration: 82,
      toRevision: f2,
      toGeneration: 83,
      failedProofSha256: await canonicalStringifySha256(
        failedF.snapshot.hostedRuntimes[0].lastExecutionProof,
      ),
      retainedHealthyProofSha256: await canonicalStringifySha256(rig.healthy),
      healthyWitnessHead: rig.rollout.ownerSupersessions[0].healthyWitnessHead,
    };
    const queue = { ...rig.queue, revisions: [...rig.queue.revisions, f2] },
      custody = { ...rig.custody, revisions: [...rig.custody.revisions, f2] };
    await rig.publishRollout(
      parseHostedRuntimeRollout({ ...rig.rollout, recoveries: [recovery] }),
      queue,
      custody,
    );
    assert.equal(
      (await rig.maintenance()).outputs.runtimeMigrationOnly,
      "false",
      "missing explicit F2 task binding must hold",
    );
    assert.equal(await ownerInstall(rig), 0);
    assert.equal(rig.patches(), 1);
    const i = receipt.ownerDisposition!.intent;
    const taskBinding = {
      releaseId: receipt.id,
      requestSha256: i.requestSha256,
      intentSha256: receipt.ownerDisposition!.intentSha256,
      successorRevision: f2,
      successorGeneration: 83,
      taskSha256: i.taskSha256,
      issueNumber: i.issueNumber,
      workId: i.workId,
      acceptanceBaseRevision: rig.successor,
      controllerSourceRevision: i.controllerSourceRevision,
      controllerCodeSha256: i.controllerCodeSha256,
      ciRevision: f2,
    };
    await rig.publishRollout(
      parseHostedRuntimeRollout({
        ...rig.rollout,
        ownerSuccessorTaskBindings: [taskBinding],
      }),
    );
    assert.equal(
      (await rig.maintenance()).outputs.runtimeMigrationOnly,
      "true",
    );
    const recoveryInput = await rig.readerInput();
    const authority = await readOwnerSupersededRecoveryAuthority(recoveryInput);
    assert.ok(authority);
    assert.equal(
      planOwnerDevelopmentInstall(
        recoveryInput.current.snapshot,
        Date.now(),
        undefined,
        undefined,
        rig.queue,
        rig.custody,
        rig.rollout,
        undefined,
        authority,
      ).status,
      "install",
    );
    assert.equal(await ownerInstall(rig), 0);
    assert.equal(rig.reports.at(-1)?.status, "installed");
    assert.equal(rig.patches(), 2);
    const recovered = await rig.current();
    assert.equal(recovered.snapshot.hostedRuntimes[0].activeRevision, f2);
    assert.equal(
      recovered.snapshot.hostedRuntimes[0].execution?.purpose,
      "bootstrap",
    );
    assert.equal(
      canonicalStringify(recovered.snapshot.hostedReleases[0].ownerDisposition),
      disposition,
    );
    assert.deepEqual(
      recovered.snapshot.hostedReleases[0].ownerSuccessorBindings?.[0].binding,
      taskBinding,
    );
    assert.equal(
      recovered.snapshot.hostedReleases[0].ownerAcceptance,
      undefined,
    );
    assert.equal(
      (await runHostedSupervisorPrepare(supervisor(rig))).status,
      "run",
    );
    await driveOwnerTaskAcceptance(rig, { deferredAcceptance: true });
    await driveCapableNormalRollback(rig);
  } finally {
    await rig.close();
  }
});

Deno.test(
  "owner supersession exact authority refuses changed identity state source proof floor and native custody",
  driveSupersessionRefusals,
);
