import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseHostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { OWNER_DEVELOPMENT_INSTALL_MATRIX_RECOVERY_REVISION } from "../../src/host/owner-development-install.ts";
import { LAUNCHER, NOW, T0 } from "./owner-install-fixture-constants.ts";
import {
  cooldown,
  hostedProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { matrixRecoveryState } from "./owner-install-fixture-matrix.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";

for (const useSourcePin of [false, true]) {
  Deno.test(
    useSourcePin
      ? "owner install matrix recovery: default source pin installs reviewed runtime, bootstrap, rollback and never reinstall"
      : "owner install matrix recovery: exact metadata and charges install, bootstrap, rollback and never reinstall",
    async () => {
      const candidate = useSourcePin
        ? "ac98dc80ff9c3eca5f36aca91493168e9ff74596" as GitSha
        : "a".repeat(40) as GitSha;
      if (useSourcePin) {
        assert.equal(
          OWNER_DEVELOPMENT_INSTALL_MATRIX_RECOVERY_REVISION,
          candidate,
        );
      }
      const own = parseHostedRunProofV1({
        ...hostedProof({
          runId: 37170000000,
          purpose: "bootstrap",
          releaseId: null,
          revision: CLOSED_C_WAVE.runtimeSha,
          generation: 60,
          outcome: "healthy",
        }),
        execution: {
          ...hostedProof({
            runId: 37170000000,
            purpose: "bootstrap",
            releaseId: null,
            revision: CLOSED_C_WAVE.runtimeSha,
            generation: 60,
            outcome: "healthy",
          }).execution,
          createdAt: T0 - 5000,
        },
        startedAt: T0 - 4000,
        finishedAt: T0 - 3000,
        observedAt: T0 - 2000,
        terminalAt: T0 - 3500,
      });
      const failure = parseHostedRunProofV1({
        ...hostedProof({
          runId: CLOSED_C_WAVE.run.runId,
          purpose: "ordinary",
          releaseId: null,
          revision: CLOSED_C_WAVE.runtimeSha,
          generation: 60,
          outcome: "failed",
        }),
        execution: {
          ...hostedProof({
            runId: CLOSED_C_WAVE.run.runId,
            purpose: "ordinary",
            releaseId: null,
            revision: CLOSED_C_WAVE.runtimeSha,
            generation: 60,
            outcome: "failed",
          }).execution,
          launcherSha: CLOSED_C_WAVE.run.launcherSha,
        },
      });
      const state = releaseSnapshot({
        runtime: runtimeRecord({
          revision: CLOSED_C_WAVE.runtimeSha,
          generation: 60,
          healthyProof: own,
          executionProof: failure,
        }),
      });
      const cells = await matrixRecoveryState();
      for (const failedBootstrap of [false, true]) {
        const fixture = await concurrencyInstallerFixture(
          state,
          undefined,
          candidate,
          { ...cells, binding: CLOSED_C_WAVE, useSourcePin },
        );
        try {
          const repair = await fixture.readRepair();
          assert.equal(await fixture.run(), 0);
          assert.equal(fixture.reports.at(-1)?.status, "installed");
          assert.equal(fixture.reports.at(-1)?.candidateGeneration, 61);
          assert.equal(fixture.patches(), 1);
          assert.deepEqual(await fixture.readRepair(), repair);
          assert.equal(await fixture.run(), 0);
          assert.equal(fixture.reports.at(-1)?.status, "waiting");
          const run = {
            runId: 37190000000,
            runAttempt: 1,
            launcherSha: LAUNCHER,
          };
          const prepared = await runHostedSupervisorPrepare({
            queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
            existingPrRuntimeCapability:
              DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
            runtimeRollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
            state: fixture.releaseStore,
            clock: { now: () => NOW + 100 },
            run,
            evidence: {
              readExecution: () => Promise.resolve(portOk(null)),
              verifyRevision: () => Promise.resolve(portOk(true)),
              verifyRequest: () => Promise.resolve(portOk(false)),
            },
          });
          assert.equal(prepared.status, "run");
          if (prepared.status !== "run") throw new Error("missing bootstrap");
          assert.equal(prepared.execution.purpose, "bootstrap");
          assert.equal(prepared.execution.revision, candidate);
          assert.equal(prepared.execution.generation, 61);
          const proof = parseHostedRunProofV1({
            ...failure,
            execution: prepared.execution,
            startedAt: NOW + 200,
            finishedAt: NOW + 300,
            observedAt: NOW + 400,
            outcome: failedBootstrap ? "failed" : "healthy",
            startupReady: !failedBootstrap,
            baseSha: failedBootstrap ? null : candidate,
            terminalAt: failedBootstrap ? null : NOW + 250,
          });
          const finalized = await runHostedSupervisorFinalize({
            queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
            existingPrRuntimeCapability:
              DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
            runtimeRollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
            state: fixture.releaseStore,
            clock: { now: () => NOW + 400 },
            run,
            evidence: {
              readExecution: () => Promise.resolve(portOk(proof)),
              verifyRevision: () => Promise.resolve(portOk(true)),
              verifyRequest: () => Promise.resolve(portOk(false)),
            },
          });
          assert.equal(finalized.status, "idle");
          fixture.setNow(NOW + 500);
          assert.equal(await fixture.run(), 0);
          assert.equal(
            fixture.reports.at(-1)?.status,
            failedBootstrap ? "rolled_back" : "no_change",
          );
          assert.equal(fixture.patches(), failedBootstrap ? 2 : 1);
          const after = await fixture.read();
          assert.ok(after.ok && after.value.status === "found");
          assert.equal(
            after.value.snapshot.hostedRuntimes[0].generation,
            failedBootstrap ? 62 : 61,
          );
          assert.deepEqual(await fixture.readRepair(), repair);
          if (failedBootstrap) {
            fixture.expireArchives();
            assert.deepEqual(
              after.value.snapshot.hostedRuntimes[0].lastHealthyProof,
              own,
            );
            assert.equal(await fixture.run(), 0);
            assert.equal(fixture.reports.at(-1)?.status, "waiting");
            assert.equal(fixture.patches(), 2);
            const restoredRun = { ...run, runId: run.runId + 1 };
            const restored = await runHostedSupervisorPrepare({
              queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
              existingPrRuntimeCapability:
                DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
              runtimeRollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
              state: fixture.releaseStore,
              clock: { now: () => NOW + 600 },
              run: restoredRun,
              evidence: {
                readExecution: () => Promise.resolve(portOk(null)),
                verifyRevision: () => Promise.resolve(portOk(true)),
                verifyRequest: () => Promise.resolve(portOk(false)),
              },
            });
            assert.equal(restored.status, "run");
            if (restored.status !== "run") {
              throw new Error("missing restored verification");
            }
            assert.equal(restored.execution.purpose, "bootstrap");
            assert.equal(restored.execution.generation, 62);
            assert.equal(restored.execution.revision, CLOSED_C_WAVE.runtimeSha);
            const restoredFailure = parseHostedRunProofV1({
              ...failure,
              execution: restored.execution,
              startedAt: NOW + 700,
              finishedAt: NOW + 800,
              observedAt: NOW + 900,
            });
            const settledRollback = await runHostedSupervisorFinalize({
              queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
              existingPrRuntimeCapability:
                DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
              runtimeRollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
              state: fixture.releaseStore,
              clock: { now: () => NOW + 900 },
              run: restoredRun,
              evidence: {
                readExecution: () => Promise.resolve(portOk(restoredFailure)),
                verifyRevision: () => Promise.resolve(portOk(true)),
                verifyRequest: () => Promise.resolve(portOk(false)),
              },
            });
            assert.equal(settledRollback.status, "idle");
            fixture.setNow(NOW + 1000);
            assert.equal(await fixture.run(), 0);
            assert.equal(fixture.reports.at(-1)?.status, "waiting");
            assert.equal(
              fixture.patches(),
              2,
              "failed restored verification cannot reinstall or advance to generation 63",
            );
            assert.deepEqual(await fixture.readRepair(), repair);
          } else {
            fixture.expireArchives();
            const ordinaryRun = { ...run, runId: run.runId + 2 };
            const ordinary = await runHostedSupervisorPrepare({
              queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
              existingPrRuntimeCapability:
                DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
              runtimeRollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
              state: fixture.releaseStore,
              clock: { now: () => NOW + 600 },
              run: ordinaryRun,
              evidence: {
                readExecution: () => Promise.resolve(portOk(null)),
                verifyRevision: () => Promise.resolve(portOk(true)),
                verifyMatrixOrdinaryRevision: () =>
                  Promise.resolve(portOk(true)),
                verifyRequest: () => Promise.resolve(portOk(false)),
              },
            });
            assert.equal(ordinary.status, "run");
            if (ordinary.status !== "run") {
              throw new Error("missing ordinary61");
            }
            assert.equal(ordinary.execution.purpose, "ordinary");
            const ordinaryFailure = parseHostedRunProofV1({
              ...failure,
              execution: ordinary.execution,
              startedAt: NOW + 700,
              finishedAt: NOW + 800,
              observedAt: NOW + 900,
            });
            const failed = await runHostedSupervisorFinalize({
              queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
              existingPrRuntimeCapability:
                DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
              runtimeRollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
              state: fixture.releaseStore,
              clock: { now: () => NOW + 900 },
              run: ordinaryRun,
              evidence: {
                readExecution: () => Promise.resolve(portOk(ordinaryFailure)),
                verifyRevision: () => Promise.resolve(portOk(true)),
                verifyRequest: () => Promise.resolve(portOk(false)),
              },
            });
            assert.equal(failed.status, "idle");
            fixture.setNow(NOW + 1000);
            assert.equal(await fixture.run(), 0);
            assert.equal(
              fixture.reports.at(-1)?.status,
              "rolled_back",
              "healthy61 then failed ordinary61 restores C62 after original archives disappear",
            );
            const restored = await fixture.read();
            assert.ok(restored.ok && restored.value.status === "found");
            assert.equal(
              restored.value.snapshot.hostedRuntimes[0].generation,
              62,
            );
            assert.deepEqual(
              restored.value.snapshot.hostedRuntimes[0].lastHealthyProof,
              proof,
              "healthy61 history must remain verbatim",
            );
            assert.deepEqual(
              restored.value.snapshot.hostedRuntimes[0].lastExecutionProof,
              ordinaryFailure,
            );
            assert.equal(await fixture.run(), 0);
            assert.equal(fixture.reports.at(-1)?.status, "waiting");
            assert.equal(fixture.patches(), 2);
            assert.deepEqual(await fixture.readRepair(), repair);
          }
          assert.ok(
            fixture.requests.filter((row) => row.method === "GET").every((
              row,
            ) => !row.path.includes("/logs") && !row.path.includes("/zip")),
          );
        } finally {
          await fixture.close();
        }
      }
      for (
        const refusal of [
          "ci",
          "parent",
          "readback",
          "native",
          "repair-active",
          "repair-unknown",
          "repair-expired",
        ] as const
      ) {
        const repairHold = refusal.startsWith("repair-");
        const fixture = await concurrencyInstallerFixture(
          state,
          refusal === "native" || repairHold
            ? undefined
            : refusal as "ci" | "parent" | "readback",
          candidate,
          {
            ...cells,
            ingested: repairHold
              ? parseRepairStateSnapshotV1({
                ...cells.ingested,
                githubCooldowns: [cooldown(
                  refusal === "repair-unknown"
                    ? null
                    : refusal === "repair-active"
                    ? NOW + 1000
                    : NOW - 1,
                )],
              })
              : cells.ingested,
            binding: CLOSED_C_WAVE,
            nativeRefusal: refusal === "native",
            useSourcePin,
          },
        );
        try {
          assert.equal(await fixture.run(), 0);
          if (refusal === "repair-expired") {
            assert.equal(fixture.reports.at(-1)?.status, "installed");
          } else assert.notEqual(fixture.reports.at(-1)?.status, "installed");
          assert.equal(
            fixture.patches(),
            refusal === "readback" || refusal === "repair-expired" ? 1 : 0,
          );
        } finally {
          await fixture.close();
        }
      }
    },
  );
}
