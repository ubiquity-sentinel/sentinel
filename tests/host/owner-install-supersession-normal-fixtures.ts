import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedRuntimeRollout } from "../../src/host/hosted-runtime-rollout.ts";
import { readOwnerSupersededNormalAuthority } from "../../src/host/owner-install-supersession.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-install-plan.ts";
import {
  ownerInstall,
  runHostedSupervisorPrepare,
  settle,
  type SupersessionRig,
  supervisor,
} from "./owner-install-supersession-fixtures.ts";

export async function driveCapableNormalRollback(rig: SupersessionRig) {
  const original = await rig.current(),
    prior = original.snapshot.hostedRuntimes[0];
  const receipt = canonicalStringify(original.snapshot.hostedReleases[0]);
  const accounting = await rig.repair.readRepair();
  await rig.source.write(
    rig.source.runtime,
    "runtime.ts",
    "// Exact later capable A\n",
  );
  await rig.source.git(rig.source.runtime, ["add", "."]);
  await rig.source.git(rig.source.runtime, [
    "commit",
    "-qm",
    "freeze later capable A",
  ]);
  const next = await rig.source.git(rig.source.runtime, [
    "rev-parse",
    "HEAD",
  ]) as GitSha;
  const pin = {
    fromRevision: prior.activeRevision,
    fromGeneration: prior.generation,
    toRevision: next,
    toGeneration: prior.generation + 1,
    rollbackToPrior: true,
  };
  await rig.publishRollout(
    parseHostedRuntimeRollout({
      ...rig.rollout,
      installs: [...rig.rollout.installs, pin],
    }),
    { ...rig.queue, revisions: [...rig.queue.revisions, next] },
    { ...rig.custody, revisions: [...rig.custody.revisions, next] },
  );
  rig.nextRun();
  assert.equal(
    planOwnerDevelopmentInstall(
      original.snapshot,
      Date.now(),
      undefined,
      undefined,
      rig.queue,
      rig.custody,
      rig.rollout,
    ).status,
    "waiting",
    "generic nonterminal refusal remains strict",
  );
  const input = await rig.readerInput(),
    authority = await readOwnerSupersededNormalAuthority(input);
  assert.ok(authority);
  assert.equal(
    planOwnerDevelopmentInstall(
      input.current.snapshot,
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
  const patches = rig.patches();
  await ownerInstall(rig);
  assert.equal(rig.reports.at(-1)?.status, "installed");
  assert.equal(rig.patches(), patches + 1);
  let current = await rig.current();
  assert.equal(current.snapshot.hostedRuntimes[0].activeRevision, next);
  assert.equal(
    current.snapshot.hostedRuntimes[0].execution?.purpose,
    "bootstrap",
  );
  assert.equal(canonicalStringify(current.snapshot.hostedReleases[0]), receipt);
  assert.equal(
    (await runHostedSupervisorPrepare(supervisor(rig))).status,
    "run",
  );
  await settle(rig, "failed");
  rig.nextRun();
  const rollbackInput = await rig.readerInput(),
    rollback = await readOwnerSupersededNormalAuthority(rollbackInput);
  assert.ok(rollback);
  const plan = planOwnerDevelopmentInstall(
    rollbackInput.current.snapshot,
    Date.now(),
    undefined,
    undefined,
    rig.queue,
    rig.custody,
    rig.rollout,
    undefined,
    rollback,
  );
  assert.ok(plan.status === "rollback");
  assert.equal(plan.move.nextRevision, prior.activeRevision);
  assert.deepEqual(plan.move.priorHealthyProof, prior.lastHealthyProof);
  await ownerInstall(rig);
  assert.equal(rig.reports.at(-1)?.status, "rolled_back");
  assert.equal(rig.patches(), patches + 2);
  current = await rig.current();
  assert.equal(
    current.snapshot.hostedRuntimes[0].activeRevision,
    prior.activeRevision,
  );
  assert.equal(
    current.snapshot.hostedRuntimes[0].generation,
    prior.generation + 2,
  );
  assert.equal(
    current.snapshot.hostedRuntimes[0].execution?.purpose,
    "bootstrap",
  );
  assert.equal(canonicalStringify(current.snapshot.hostedReleases[0]), receipt);
  assert.equal(
    (await runHostedSupervisorPrepare(supervisor(rig))).status,
    "run",
  );
  const restored = await settle(rig, "healthy");
  assert.equal(restored.execution.revision, prior.activeRevision);
  assert.equal(restored.execution.generation, prior.generation + 2);
  rig.nextRun();
  await ownerInstall(rig);
  assert.equal(rig.patches(), patches + 2);
  assert.deepEqual(await rig.repair.readRepair(), accounting);
}
