import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { HostedExecutionSettlementV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor-controller.ts";
import {
  futureRecoveryFixture,
  RECOVERY_NOW,
} from "./owner-install-future-recovery-fixtures.ts";
import { runOwnerDevelopmentInstallMain } from "../../src/host/owner-install-run.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-task-acceptance.ts";

export type SupersessionRig = Awaited<ReturnType<typeof futureRecoveryFixture>>;
export const task = {
  issueNumber: 170,
  title: "issue 170",
  body: "still wanted",
  digest: await reviewTaskStatementDigest({
    issueNumber: 170,
    title: "issue 170",
    body: "still wanted",
  }),
};
export const clock = { now: () => Date.now() };
export function ownerInstall(rig: SupersessionRig) {
  return runOwnerDevelopmentInstallMain({
    queueRuntimeCapability: rig.queue,
    existingPrRuntimeCapability: rig.custody,
    rollout: rig.rollout,
  });
}
export function supervisor(
  rig: SupersessionRig,
  settlement: HostedExecutionSettlementV1 | null = null,
) {
  return {
    state: rig.state,
    clock,
    run: { ...rig.run },
    queueRuntimeCapability: rig.queue,
    existingPrRuntimeCapability: rig.custody,
    runtimeRollout: rig.rollout,
    evidence: {
      readExecution: () => Promise.resolve(portOk(settlement)),
      verifyRevision: () => Promise.resolve(portOk(true)),
      verifyMatrixOrdinaryRevision: () => Promise.resolve(portOk(true)),
      verifyRequest: () => Promise.resolve(portOk(false)),
      readIssueTask: () => Promise.resolve(portOk(task)),
    },
  };
}
export async function settle(
  rig: SupersessionRig,
  outcome: "healthy" | "failed",
) {
  const saved = (await rig.current()).snapshot.hostedRuntimes[0].execution;
  assert.ok(saved);
  const proof = await rig.nativeSettlement(saved, outcome);
  rig.setNow(proof.observedAt + 10_000);
  const result = await runHostedSupervisorFinalize(supervisor(rig, proof));
  assert.equal(result.status, "idle");
  return proof;
}
export async function installedSupersession() {
  const rig = await futureRecoveryFixture({
    legacyFirst: true,
    ownerSupersession: true,
  });
  try {
    assert.equal(await ownerInstall(rig), 0);
    assert.equal(rig.reports.at(-1)?.status, "installed");
    assert.equal(
      (await runHostedSupervisorPrepare(supervisor(rig))).status,
      "run",
    );
    return rig;
  } catch (error) {
    await rig.close();
    throw error;
  }
}
export { RECOVERY_NOW, runHostedSupervisorPrepare };
