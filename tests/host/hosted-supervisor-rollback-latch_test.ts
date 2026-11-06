import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { hostedOrdinaryAdmitted } from "../../src/contracts/hosted-supervisor-verification.ts";
import type { HostedSupervisorEvidencePortV1 } from "../../src/host/actions-supervisor.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  CANDIDATE,
  LAUNCHER,
  makeRig,
  requireRun,
  type RigV1,
  run,
  runProof,
  startedFailureProof,
} from "./actions-supervisor-fixture.ts";
import { ciRun, FollowFake } from "./hosted-runtime-follow-fixtures.ts";

/** A CI-green launcher revision that descends the failed candidate. */
const ROLLBACK_FIX = "3".repeat(40) as GitSha;

const ROLLBACK_FAILED_LATCH =
  "launcher installation rollback verification failed; model starts remain stopped";

async function settle(
  rig: RigV1,
  execution: HostedExecutionIntentV1,
  outcome: "healthy" | "started_failure",
) {
  rig.clock.advance(5_000);
  rig.evidence.settlements.set(
    execution.id,
    outcome === "started_failure"
      ? startedFailureProof(execution)
      : runProof(execution, outcome),
  );
  assert.equal(
    (await rig.finalize({
      runId: execution.runId,
      runAttempt: execution.runAttempt,
      launcherSha: execution.launcherSha,
    })).status,
    "idle",
  );
}

async function ready(rig: RigV1) {
  rig.evidence.revisions.add(LAUNCHER);
  await settle(rig, requireRun(await rig.prepare(run(1))), "healthy");
  const ordinary = requireRun(await rig.prepare(run(2)));
  assert.equal(ordinary.purpose, "ordinary");
  await settle(rig, ordinary, "healthy");
}

function installEvidence(rig: RigV1) {
  Object.assign(
    rig.evidence,
    {
      verifyAncestor: (_a: GitSha, _d: GitSha) => Promise.resolve(portOk(true)),
      verifyLauncherCi: (revision: GitSha) =>
        Promise.resolve(portOk({ revision, checkRunId: 91 })),
    } satisfies Pick<
      HostedSupervisorEvidencePortV1,
      "verifyAncestor" | "verifyLauncherCi"
    >,
  );
}

const launcherRun = (id: number, launcherSha: GitSha = CANDIDATE) => ({
  ...run(id),
  launcherSha,
});

/** Drive the shared fixture to a terminal `rollback_failed` history. */
async function rollbackFailed(rig: RigV1) {
  await ready(rig);
  installEvidence(rig);
  const boot = requireRun(await rig.prepare(launcherRun(3)));
  await settle(rig, boot, "started_failure");
  const rollback = requireRun(await rig.prepare(launcherRun(4)));
  assert.equal(rollback.purpose, "bootstrap");
  assert.equal(rollback.revision, LAUNCHER);
  await settle(rig, rollback, "started_failure");
  const state = await rig.snapshot();
  const record = state.hostedInstallations?.[0];
  assert.equal(record?.phase, "rollback_failed");
  assert.equal(record?.candidateRevision, CANDIDATE);
  assert.equal(record?.previousRevision, LAUNCHER);
  assert.equal(state.hostedRuntimes[0].activeRevision, LAUNCHER);
  assert.equal(state.hostedRuntimes[0].generation, 3);
  assert.equal(hostedOrdinaryAdmitted(state.hostedRuntimes[0]), false);
  return { record, state };
}

Deno.test("rollback latch: stops only its own failed candidate; a new CI-green launcher installs fresh", async (t) => {
  const rig = await makeRig();
  try {
    await t.step("run at the failed candidate stays barred", async () => {
      const { record, state } = await rollbackFailed(rig);
      const outcome = await rig.prepare(launcherRun(5));
      assert.equal(outcome.status, "pending");
      if (outcome.status === "pending") {
        assert.equal(outcome.detail, ROLLBACK_FAILED_LATCH);
      }
      const after = await rig.snapshot();
      assert.equal(after.hostedInstallations?.length, 1);
      assert.deepEqual(after.hostedInstallations?.[0], record);
      assert.deepEqual(after.hostedRuntimes, state.hostedRuntimes);
    });

    await t.step(
      "a new descendant launcher plans its own fresh install",
      async () => {
        const before = await rig.snapshot();
        const failed = before.hostedInstallations?.[0];
        assert.ok(failed);
        // #276: the dispatcher must deliver the repair despite rollback_failed;
        // selecting a fresh launcher is the only autonomous way out of the latch.
        const follow = new FollowFake();
        // Keep the state commit distinct from the failed candidate fixture SHA.
        follow.stateHead = "f".repeat(40);
        follow.installed = before.hostedRuntimes[0].activeRevision;
        follow.launcher = CANDIDATE;
        follow.development = ROLLBACK_FIX;
        follow.parents = new Map([
          [ROLLBACK_FIX, [CANDIDATE]],
          [CANDIDATE, [LAUNCHER]],
          [LAUNCHER, []],
        ]);
        follow.ci = new Map([
          [ROLLBACK_FIX, [ciRun(ROLLBACK_FIX, 30)]],
          [CANDIDATE, [ciRun(CANDIDATE, 20)]],
        ]);
        follow.installations = [{ ...failed }];
        const followed = await follow.follow();
        assert.equal(
          followed.journal.decision,
          "advanced",
          JSON.stringify(followed.journal),
        );
        assert.equal(followed.launcherSha, ROLLBACK_FIX);
        assert.equal(followed.safeToDispatch, true);
        assert.equal(followed.exitCode, 0);
        assert.equal(follow.mutations, 1);
        const writes: ReleaseStateSnapshotV1[] = [];
        const writeRelease = rig.release.writeRelease.bind(rig.release);
        rig.release.writeRelease = async (next, expectedHead) => {
          const result = await writeRelease(next, expectedHead);
          if (result.ok && result.value.status === "applied") writes.push(next);
          return result;
        };
        let bootId: string;
        try {
          const boot = requireRun(
            await rig.prepare(launcherRun(6, followed.launcherSha as GitSha)),
          );
          bootId = boot.id;
          assert.equal(boot.purpose, "bootstrap");
          assert.equal(boot.revision, ROLLBACK_FIX);
          assert.equal(boot.launcherSha, ROLLBACK_FIX);
        } finally {
          rig.release.writeRelease = writeRelease;
        }
        // The persisted plan: a new installation record off the restored prior.
        const planned = writes
          .flatMap((s) => s.hostedInstallations ?? [])
          .find((r) =>
            r.candidateRevision === ROLLBACK_FIX && r.phase === "requested"
          );
        assert.ok(planned);
        assert.equal(planned.phase, "requested");
        assert.equal(planned.previousRevision, LAUNCHER);
        // The rollback restored the prior at previousGeneration + 2; the fresh
        // install starts from that exact restored pointer (152 in the incident).
        assert.equal(planned.previousGeneration, 3);
        assert.equal(
          planned.previousGeneration,
          (failed?.previousGeneration ?? 0) + 2,
        );
        assert.equal(planned.ci.revision, ROLLBACK_FIX);
        assert.equal(planned.pointerIntent?.action, "promote");
        assert.equal(planned.pointerIntent?.expectedRevision, LAUNCHER);
        assert.equal(planned.pointerIntent?.nextRevision, ROLLBACK_FIX);
        assert.equal(planned.pointerIntent?.expectedGeneration, 3);
        const after = await rig.snapshot();
        assert.equal(after.hostedInstallations?.length, 2);
        // The terminal rollback_failed history is untouched.
        assert.deepEqual(after.hostedInstallations?.[0], failed);
        const fresh = after.hostedInstallations?.[1];
        assert.equal(fresh?.id, `installation:${ROLLBACK_FIX}`);
        assert.equal(fresh?.phase, "bootstrapping");
        assert.equal(fresh?.bootstrapExecutionId, bootId);
        assert.equal(after.hostedRuntimes[0].activeRevision, ROLLBACK_FIX);
        assert.equal(after.hostedRuntimes[0].generation, 4);
        assert.equal(after.hostedRuntimes[0].execution?.id, bootId);
      },
    );

    // Retain the bootstrap identity after the reinstall probe settles it.
    const bootstrap = (await rig.snapshot()).hostedRuntimes[0].execution;
    await t.step("the failed candidate still cannot reinstall", async () => {
      // Settle the fresh install so no in-flight record masks the candidate bar.
      assert.ok(bootstrap);
      await settle(rig, bootstrap, "healthy");
      const before = await rig.snapshot();
      assert.equal(before.hostedInstallations?.[1].phase, "accepted");
      assert.equal(before.hostedRuntimes[0].execution, null);
      // Refuse before CI checks, not via duplicate-record validation.
      let ciChecks = 0;
      const verifyMatrixOrdinaryRevision =
        rig.evidence.verifyMatrixOrdinaryRevision;
      Object.assign(rig.evidence, {
        // Keep ordinary work unavailable during this installation-only probe.
        verifyMatrixOrdinaryRevision: undefined,
        verifyLauncherCi: (revision: GitSha) => {
          ciChecks++;
          return Promise.resolve(portOk({ revision, checkRunId: 91 }));
        },
      });
      const outcome = await rig.prepare(launcherRun(7)).finally(() => {
        rig.evidence.verifyMatrixOrdinaryRevision =
          verifyMatrixOrdinaryRevision;
      });
      assert.equal(outcome.status, "pending");
      assert.equal(ciChecks, 0);
      const after = await rig.snapshot();
      assert.equal(after.hostedInstallations?.length, 2);
      assert.equal(
        after.hostedInstallations
          ?.filter((r) => r.candidateRevision === CANDIDATE)
          .length,
        1,
      );
      assert.deepEqual(
        after.hostedInstallations?.[0],
        before.hostedInstallations?.[0],
      );
      assert.deepEqual(
        after.hostedInstallations?.[1],
        before.hostedInstallations?.[1],
      );
      assert.deepEqual(after.hostedRuntimes, before.hostedRuntimes);
    });

    await t.step(
      "the followed repair resumes ordinary work",
      async () => {
        const before = await rig.snapshot();
        const boot = bootstrap;
        assert.ok(boot);
        rig.evidence.revisions.add(ROLLBACK_FIX);
        const accepted = await rig.snapshot();
        assert.equal(accepted.hostedInstallations?.[1].phase, "accepted");
        assert.equal(
          accepted.hostedRuntimes[0].lastHealthyProof?.execution.id,
          boot.id,
        );

        const ordinary = requireRun(
          await rig.prepare(launcherRun(8, ROLLBACK_FIX)),
        );
        assert.equal(ordinary.purpose, "ordinary");
        assert.equal(ordinary.revision, ROLLBACK_FIX);
        assert.equal(ordinary.launcherSha, ROLLBACK_FIX);
        assert.equal(ordinary.generation, 4);
        assert.equal(
          hostedOrdinaryAdmitted((await rig.snapshot()).hostedRuntimes[0]),
          true,
        );
        await settle(rig, ordinary, "healthy");
        const after = await rig.snapshot();
        assert.equal(after.hostedRuntimes[0].execution, null);
        assert.equal(after.hostedInstallations?.length, 2);
        assert.deepEqual(
          after.hostedInstallations?.[0],
          before.hostedInstallations?.[0],
        );
        assert.equal(
          after.hostedRuntimes[0].lastHealthyProof?.execution.id,
          ordinary.id,
        );
      },
    );
  } finally {
    await rig.cleanup();
  }
});
