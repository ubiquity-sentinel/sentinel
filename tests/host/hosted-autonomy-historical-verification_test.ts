import assert from "node:assert/strict";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import {
  HISTORICAL_MATRIX_QUARANTINE,
  type HistoricalMatrixQuarantineDepsV1,
  runHistoricalMatrixQuarantine,
} from "../../src/host/matrix-actions.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { parseHostedExecutionSettlementV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { T0 } from "../state/helpers.ts";
import { BASE } from "./hosted-autonomy-fixtures.ts";
import { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";
import { historicalMultiWaveRig } from "./hosted-autonomy-multiwave-fixtures.ts";

Deno.test("historical closed list: three distinct witnesses then current, retirement and selected missing custody", async () => {
  for (const mode of ["selected", "retired", "missing"]) {
    const f = await historicalMultiWaveRig(3, 1);
    const previousCwd = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      const before = await f.rig.state.readRepair();
      assert(before.ok && before.value.status === "found");
      const old = f.witness.snapshot.hostedRuntimes[0].lastExecutionProof!;
      assert(old.outcome !== "not_started");
      const witnesses = f.plan.cells.map((cell, i) => ({
        commit: `${i + 6}`.repeat(40) as GitSha,
        proof: {
          ...old,
          execution: {
            ...old.execution,
            id: `${101 + i}:1:repair`,
            runId: 101 + i,
            runAttempt: 1,
          },
        },
        cell,
      }));
      const order: number[] = [];
      f.rig.state.readReleaseAt = (input) => {
        if (mode === "retired") {
          throw new Error("completed witness reader must not run");
        }
        if (mode === "missing") {
          return Promise.resolve(
            portError("unavailable", "selected witness missing"),
          );
        }
        const witness = witnesses.find((row) => row.commit === input.commit)!;
        return Promise.resolve(portOk({
          status: "found",
          head: witness.commit,
          ref: null,
          snapshot: {
            ...f.witness.snapshot,
            hostedRuntimes: [{
              ...f.witness.snapshot.hostedRuntimes[0],
              lastExecutionProof: witness.proof,
            }],
          },
        }));
      };
      const readExecution = f.evidence.readExecution;
      const rejectCurrent = f.historicalMatrix.transport.rejectHistorical!;
      const deps: HistoricalMatrixQuarantineDepsV1 = {
        ...f.historicalMatrix,
        readExecution: (execution) => {
          const witness = witnesses.find((row) =>
            row.proof.execution.id === execution.id
          );
          if (!witness) return readExecution(execution);
          if (mode === "retired") {
            throw new Error("completed witness native read must not run");
          }
          return Promise.resolve(portOk(witness.proof));
        },
        transport: {
          ...f.historicalMatrix.transport,
          rejectHistorical: (input) => {
            order.push(input.proof.execution.runId);
            return rejectCurrent(input);
          },
        },
        historicalReleaseWitnesses: witnesses.map((witness) => ({
          commit: witness.commit,
          executionId: witness.proof.execution.id,
          logDigest: witness.proof.logDigest,
          reservationIds: [witness.cell.reservationId],
          reject: async (proof) => {
            if (mode === "retired") {
              throw new Error("completed witness archive must not run");
            }
            order.push(proof.execution.runId);
            const read = await f.rig.state.readRepair();
            assert(read.ok && read.value.status === "found");
            const work = read.value.snapshot.work.find((row) =>
              row.id === witness.cell.taskId
            )!;
            const charge = read.value.snapshot.reservations.find((row) =>
              row.id === witness.cell.reservationId
            )!;
            return [{
              reason: "reservation_after_manifest",
              proof,
              planDigest: "d".repeat(64),
              plannerJobId: 1000 + proof.execution.runId,
              plannerStartedAt: new Date(T0).toISOString(),
              plannerCompletedAt: new Date(T0 + 3_600_000).toISOString(),
              affected: [{
                request: witness.cell.request,
                requestDigest: witness.cell.requestDigest,
                work,
                workDigest: await matrixDigestV1(work),
                reservation: charge,
                reservationDigest: await matrixDigestV1(charge),
              }],
              cells: [],
            }];
          },
        })),
      };
      if (mode === "retired") {
        const ids = witnesses.map((row) => row.cell.reservationId);
        const blocked = await f.rig.state.writeRepair({
          ...before.value.snapshot,
          stateHead: before.value.head,
          sequence: before.value.snapshot.sequence + 1,
          updatedAt: f.clock.now(),
          work: before.value.snapshot.work.map((row) =>
            ids.includes(row.intent?.requestId ?? "")
              ? {
                ...row,
                nextStep: "blocked",
                blocker: {
                  kind: "other",
                  message: HISTORICAL_MATRIX_QUARANTINE,
                  since: f.clock.now(),
                },
                wait: null,
                updatedAt: f.clock.now(),
              }
              : row
          ),
        }, before.value.head);
        assert(blocked.ok && blocked.value.status === "applied");
      }
      if (mode === "missing") {
        await assert.rejects(
          () => runHistoricalMatrixQuarantine(deps),
          /release witness unavailable/,
        );
        assert.deepEqual(await f.rig.state.readRepair(), before);
        assert.deepEqual(order, []);
      } else {
        assert.equal(
          await runHistoricalMatrixQuarantine(deps),
          mode === "selected" ? 4 : 1,
        );
        assert.deepEqual(
          order,
          mode === "selected" ? [101, 102, 103, 73] : [73],
        );
      }
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical verification: healthy bootstrap preserves thirteen unrelated intents", async () => {
  for (
    const purpose of [
      "bootstrap",
      "prior",
      "candidate",
      "rollback",
      "failed-candidate",
    ] as const
  ) {
    const f = await historicalMalformedRig(false, 13);
    const previousCwd = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      const failed = purpose === "failed-candidate";
      const verificationPurpose = failed ? "candidate" : purpose;
      const execution: HostedExecutionIntentV1 = {
        ...f.execution,
        purpose: verificationPurpose,
        releaseId: verificationPurpose === "bootstrap"
          ? null
          : "verification-release",
      };
      const job = f.jobs.find((row) => row.id === 499)!;
      job.conclusion = failed ? "failure" : "success";
      job.steps[0].conclusion = job.conclusion;
      f.logs.set(
        499,
        `${new Date(T0 + 30_000).toISOString()} ${
          JSON.stringify({
            version: "v1",
            kind: "hosted_runtime_terminal",
            execution,
            controllerSha: execution.revision,
            startedAt: T0,
            finishedAt: T0 + 30_000,
            outcome: failed ? "failed" : "healthy",
            startupReady: !failed,
            settled: true,
            baseSha: BASE,
          })
        }\n`,
      );
      const native = await f.client.readHostedExecution(execution);
      assert(
        native.ok && native.value !== null &&
          native.value.outcome === (failed ? "failed" : "healthy"),
      );
      const release = await f.rig.state.readRelease();
      assert(release.ok && release.value.status === "found");
      const snapshot = parseReleaseStateSnapshotV1({
        ...release.value.snapshot,
        hostedRuntimes: [{
          ...release.value.snapshot.hostedRuntimes[0],
          execution: null,
          lastExecutionProof: native.value,
          lastHealthyProof: failed ? null : native.value,
        }],
      });
      f.rig.state.readRelease = () =>
        Promise.resolve(portOk({ ...release.value, snapshot }));
      f.rig.state.writeRepair = () => {
        throw new Error("unexpected task write");
      };
      f.historicalMatrix.budget.settleModelStart = () => {
        throw new Error("unexpected charge settlement");
      };
      const before = await f.rig.state.readRepair();
      assert.equal(
        await runHistoricalMatrixQuarantine({
          ...f.historicalMatrix,
          historicalReleaseWitnesses: [],
        }),
        0,
      );
      assert.deepEqual(await f.rig.state.readRepair(), before);
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical verification: missing proof ordinary pending mismatch and drift remain incomplete", async () => {
  for (
    const fault of [
      "missing",
      "ordinary-artifact",
      "active-ordinary",
      "notstarted-ordinary",
      "pending",
      "mismatch",
      "release-drift",
      "repair-drift",
    ]
  ) {
    const f = await historicalMalformedRig(false, 1);
    const previousCwd = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      const purpose = fault === "ordinary-artifact" ? "ordinary" : "bootstrap";
      const execution = {
        ...f.execution,
        purpose: purpose as "ordinary" | "bootstrap",
      };
      const job = f.jobs.find((row) => row.id === 499)!;
      job.conclusion = "success";
      job.steps[0].conclusion = "success";
      f.logs.set(
        499,
        `${new Date(T0 + 30_000).toISOString()} ${
          JSON.stringify({
            version: "v1",
            kind: "hosted_runtime_terminal",
            execution,
            controllerSha: execution.revision,
            startedAt: T0,
            finishedAt: T0 + 30_000,
            outcome: "healthy",
            startupReady: true,
            settled: true,
            baseSha: BASE,
          })
        }\n`,
      );
      const native = await f.client.readHostedExecution(execution);
      assert(
        native.ok && native.value !== null &&
          native.value.outcome === "healthy",
      );
      const release = await f.rig.state.readRelease();
      assert(release.ok && release.value.status === "found");
      const active = {
        ...f.execution,
        id: "72:1:repair",
        runId: 72,
        runAttempt: 1,
        createdAt: T0 + 31_000,
      };
      const snapshot = parseReleaseStateSnapshotV1({
        ...release.value.snapshot,
        hostedRuntimes: [{
          ...release.value.snapshot.hostedRuntimes[0],
          execution:
            fault === "active-ordinary" || fault === "notstarted-ordinary"
              ? active
              : null,
          lastExecutionProof: fault === "missing" ? null : native.value,
          lastHealthyProof: native.value,
        }],
      });
      f.rig.state.readRelease = () =>
        Promise.resolve(portOk({ ...release.value, snapshot }));
      f.rig.state.writeRepair = () => {
        throw new Error("unexpected task write");
      };
      f.historicalMatrix.budget.settleModelStart = () => {
        throw new Error("unexpected charge settlement");
      };
      const before = await f.rig.state.readRepair();
      assert(before.ok && before.value.status === "found");
      const repairBefore = before.value;
      if (fault === "ordinary-artifact") f.setFault("missing");
      if (fault === "pending") f.setFault("pending");
      if (fault === "notstarted-ordinary") {
        f.historicalMatrix.transport.confirmCompletedExecution = () =>
          Promise.resolve(true);
        f.historicalMatrix.readExecution = () =>
          Promise.resolve(portOk(parseHostedExecutionSettlementV1({
            execution: active,
            workflowId: 357012162,
            workflowPath: ".github/workflows/supervisor.yml",
            repository: "Ubiquity-Sentinel/sentinel",
            ref: "refs/heads/sentinel-supervisor",
            jobId: null,
            outcome: "not_started",
            finishedAt: T0 + 40_000,
            observedAt: f.clock.now(),
            evidenceDigest: "b".repeat(64),
          })));
      }
      if (
        fault === "mismatch" || fault === "release-drift" ||
        fault === "repair-drift"
      ) {
        const read = f.historicalMatrix.readExecution;
        f.historicalMatrix.readExecution = async (input) => {
          const observed = await read(input);
          if (fault === "release-drift") {
            f.rig.state.readRelease = () =>
              Promise.resolve(
                portOk({
                  ...release.value,
                  snapshot,
                  head: "f".repeat(40) as GitSha,
                }),
              );
          }
          if (fault === "repair-drift") {
            f.rig.state.readRepair = () =>
              Promise.resolve(
                portOk({
                  ...repairBefore,
                  snapshot: {
                    ...repairBefore.snapshot,
                    work: repairBefore.snapshot.work.map((row) => ({
                      ...row,
                      updatedAt: row.updatedAt + 1,
                    })),
                  },
                }),
              );
          }
          return fault === "mismatch" && observed.ok &&
              observed.value !== null &&
              observed.value.outcome !== "not_started"
            ? portOk({ ...observed.value, logDigest: "a".repeat(64) })
            : observed;
        };
      }
      await assert.rejects(
        () =>
          runHistoricalMatrixQuarantine({
            ...f.historicalMatrix,
            historicalReleaseWitnesses: [],
          }),
        /historical matrix|matrix artifact/,
      );
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});
