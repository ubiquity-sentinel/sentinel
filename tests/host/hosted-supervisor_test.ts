/** Hosted hosted-supervisor_test responsibility. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseHostedReleaseRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import type {
  ReleaseStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import type { HostedSupervisorEvidencePortV1 } from "../../src/host/actions-supervisor.ts";
import { T0 } from "../state/helpers.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import { recoveryRig } from "./actions-supervisor-recovery-fixture.ts";
import {
  CANDIDATE,
  DIGEST,
  DORMANT_HOSTED_POLICIES,
  execution,
  LAUNCHER,
  RECOVERY_HEALTH_LAUNCHER,
  RECOVERY_OLD_LAUNCHER,
  RECOVERY_REVISION,
  releaseRequest,
  requireRun,
  run,
  runProof,
  skippedProof,
} from "./actions-supervisor-fixture.ts";

Deno.test("same-pointer recovery: exact canceled71 admits one model-disabled bootstrap and healthy finalization restores installer eligibility", async () => {
  const rig = await recoveryRig();
  try {
    const planned = requireRun(
      await runHostedSupervisorPrepare({
        ...DORMANT_HOSTED_POLICIES,
        state: rig.state,
        evidence: rig.evidence,
        clock: rig.clock,
        run: run(72),
      }),
    );
    assert.equal(planned.purpose, "bootstrap");
    assert.equal(planned.revision, RECOVERY_REVISION);
    assert.equal(planned.generation, 59);
    const started = (await rig.read()).snapshot.hostedRuntimes[0];
    assert.deepEqual(started.lastHealthyProof, rig.prior);
    assert.deepEqual(started.lastExecutionProof, rig.skipped);
    assert.equal(
      requireRun(
        await runHostedSupervisorPrepare({
          ...DORMANT_HOSTED_POLICIES,
          state: rig.state,
          evidence: rig.evidence,
          clock: rig.clock,
          run: run(72),
        }),
      ).id,
      planned.id,
    );
    assert.equal(
      (await runHostedSupervisorPrepare({
        ...DORMANT_HOSTED_POLICIES,
        state: rig.state,
        evidence: rig.evidence,
        clock: rig.clock,
        run: run(73),
      })).status,
      "pending",
    );
    rig.evidence.settlements.set(planned.id, runProof(planned, "healthy"));
    rig.clock.advance(4000);
    const finalized = await runHostedSupervisorFinalize({
      ...DORMANT_HOSTED_POLICIES,
      state: rig.state,
      evidence: rig.evidence,
      clock: rig.clock,
      run: run(72),
    });
    assert.equal(finalized.status, "idle");
    const healthy = (await rig.read()).snapshot;
    assert.equal(healthy.hostedRuntimes[0].activeRevision, RECOVERY_REVISION);
    assert.equal(healthy.hostedRuntimes[0].generation, 59);
    assert.equal(healthy.hostedRuntimes[0].execution, null);
    assert.equal(
      healthy.hostedRuntimes[0].lastHealthyProof?.execution.id,
      planned.id,
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        healthy,
        rig.clock.now(),
        undefined,
        undefined,
        DORMANT_HOSTED_POLICIES.queueRuntimeCapability,
        DORMANT_HOSTED_POLICIES.existingPrRuntimeCapability,
        DORMANT_HOSTED_POLICIES.runtimeRollout,
      ).status,
      "install",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("same-pointer recovery: a freshly authenticated newer failed old-controller ordinary admits bootstrap without changing proofs", async () => {
  const failed = runProof(
    execution({
      id: "37156933037:1:repair",
      runId: 37156933037,
      launcherSha: RECOVERY_OLD_LAUNCHER,
      revision: RECOVERY_REVISION,
      generation: 59,
      purpose: "ordinary",
      createdAt: T0 + 4000,
    }),
    "failed",
  );
  const rig = await recoveryRig({ lastExecutionProof: failed });
  try {
    const planned = requireRun(
      await runHostedSupervisorPrepare({
        ...DORMANT_HOSTED_POLICIES,
        state: rig.state,
        evidence: rig.evidence,
        clock: rig.clock,
        run: run(72),
      }),
    );
    assert.equal(planned.purpose, "bootstrap");
    assert.equal(planned.revision, RECOVERY_REVISION);
    assert.equal(planned.generation, 59);
    const after = (await rig.read()).snapshot.hostedRuntimes[0];
    assert.deepEqual(after.lastHealthyProof, rig.prior);
    assert.deepEqual(after.lastExecutionProof, failed);
    assert.deepEqual(rig.evidence.completionCalls, [failed.execution]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("same-pointer recovery: missing incomplete unavailable or changed native proof refuses without a state write", async () => {
  for (
    const control of [
      "missing",
      "incomplete",
      "unavailable",
      "absent",
      "digest",
      "binding",
      "backward",
      "cursor",
    ]
  ) {
    const rig = await recoveryRig();
    try {
      const evidence: HostedSupervisorEvidencePortV1 = rig.evidence;
      if (control === "missing") evidence.confirmCompletedExecution = undefined;
      if (control === "incomplete") rig.evidence.completed = false;
      if (control === "unavailable") {
        evidence.confirmCompletedExecution = () =>
          Promise.reject(new Error("offline incomplete native response"));
      }
      const fresh = { ...rig.skipped, observedAt: rig.skipped.observedAt + 1 };
      if (control === "absent") {
        rig.evidence.settlements.set(fresh.execution.id, null);
      }
      if (control === "digest") {
        rig.evidence.settlements.set(fresh.execution.id, {
          ...fresh,
          evidenceDigest: "b".repeat(64),
        });
      }
      if (control === "binding") {
        rig.evidence.settlements.set(fresh.execution.id, {
          ...fresh,
          execution: { ...fresh.execution, launcherSha: LAUNCHER },
        });
      }
      if (control === "backward") {
        rig.evidence.settlements.set(fresh.execution.id, {
          ...fresh,
          observedAt: rig.skipped.observedAt - 1,
        });
      }
      let completed = false;
      if (control === "cursor") {
        evidence.confirmCompletedExecution = () => {
          completed = true;
          return Promise.resolve(true);
        };
      }
      const before = await rig.read();
      const state: StateReadView & ReleaseStateWriter = {
        readRepair: rig.state.readRepair.bind(rig.state),
        readRelease: async () => {
          const read = await rig.state.readRelease();
          return completed && read.ok && read.value.status === "found"
            ? portOk({ ...read.value, head: CANDIDATE })
            : read;
        },
        writeRelease: rig.state.writeRelease.bind(rig.state),
      };
      const outcome = await runHostedSupervisorPrepare({
        ...DORMANT_HOSTED_POLICIES,
        state,
        evidence,
        clock: rig.clock,
        run: run(72),
      });
      assert.equal(outcome.status, "pending", control);
      assert.deepEqual(await rig.read(), before, control);
    } finally {
      await rig.cleanup();
    }
  }
});

Deno.test("same-pointer recovery: wrong proof identity and failed verification refuse repeated broken ordinary", async () => {
  for (
    const mutation of [
      { lastExecutionProof: null },
      { lastHealthyProof: null },
      { generation: 60 },
      { activeRevision: CANDIDATE, generation: 60 },
      {
        lastExecutionProof: skippedProof(
          execution({
            id: "37148984942:1:repair",
            runId: 37148984942,
            launcherSha: RECOVERY_OLD_LAUNCHER,
            revision: RECOVERY_REVISION,
            generation: 59,
            purpose: "ordinary",
          }),
        ),
      },
      {
        lastHealthyProof: runProof(
          execution({
            id: "37134515396:1:repair",
            runId: 37134515396,
            launcherSha: RECOVERY_HEALTH_LAUNCHER,
            revision: RECOVERY_REVISION,
            generation: 59,
          }),
          "healthy",
        ),
      },
      {
        lastExecutionProof: skippedProof(
          execution({
            id: "37148984941:2:repair",
            runId: 37148984941,
            runAttempt: 2,
            launcherSha: RECOVERY_OLD_LAUNCHER,
            revision: RECOVERY_REVISION,
            generation: 59,
            purpose: "ordinary",
          }),
        ),
      },
      {
        lastExecutionProof: skippedProof(
          execution({
            id: "37148984941:1:repair",
            runId: 37148984941,
            launcherSha: LAUNCHER,
            revision: RECOVERY_REVISION,
            generation: 59,
            purpose: "ordinary",
          }),
        ),
      },
      {
        lastExecutionProof: runProof(
          execution({
            id: "72:1:repair",
            runId: 72,
            revision: RECOVERY_REVISION,
            generation: 59,
          }),
          "failed",
        ),
      },
    ]
  ) {
    const rig = await recoveryRig(mutation);
    try {
      assert.equal(
        (await runHostedSupervisorPrepare({
          ...DORMANT_HOSTED_POLICIES,
          state: rig.state,
          evidence: rig.evidence,
          clock: rig.clock,
          run: run(73),
        })).status,
        "pending",
      );
      assert.equal(
        (await rig.read()).snapshot.hostedRuntimes[0].execution,
        null,
      );
    } finally {
      await rig.cleanup();
    }
  }
});

Deno.test("same-pointer recovery: owner release cooldown capability cursor CAS and no-loop controls refuse unsafe admission", async () => {
  for (
    const control of [
      "owner",
      "release",
      "cooldown",
      "capability",
      "cursor",
      "cas",
      "failed",
      "not_started",
      "healthy",
    ]
  ) {
    const owner = execution({
      id: "74:1:repair",
      runId: 74,
      revision: RECOVERY_REVISION,
      generation: 59,
      purpose: "ordinary",
    });
    const rig = await recoveryRig(
      control === "owner" ? { execution: owner } : {},
    );
    try {
      if (
        control === "failed" || control === "not_started" ||
        control === "healthy"
      ) {
        const admitted = requireRun(
          await runHostedSupervisorPrepare({
            ...DORMANT_HOSTED_POLICIES,
            state: rig.state,
            evidence: rig.evidence,
            clock: rig.clock,
            run: run(72),
          }),
        );
        const settlement = control === "not_started"
          ? skippedProof(admitted)
          : runProof(admitted, control === "healthy" ? "healthy" : "failed");
        rig.evidence.settlements.set(admitted.id, settlement);
        rig.clock.advance(4000);
        await runHostedSupervisorFinalize({
          ...DORMANT_HOSTED_POLICIES,
          state: rig.state,
          evidence: rig.evidence,
          clock: rig.clock,
          run: run(72),
        });
        const next = await runHostedSupervisorPrepare({
          ...DORMANT_HOSTED_POLICIES,
          state: rig.state,
          evidence: rig.evidence,
          clock: rig.clock,
          run: run(73),
        });
        if (control === "healthy") {
          assert.equal(requireRun(next).purpose, "ordinary");
        } else {
          assert.equal(next.status, "pending");
          assert.equal(
            (await rig.read()).snapshot.hostedRuntimes[0].execution,
            null,
          );
        }
        assert.deepEqual(
          (await rig.read()).snapshot.hostedRuntimes[0].lastExecutionProof,
          settlement,
        );
        continue;
      }
      let sourceRead = false;
      if (control === "capability" || control === "cursor") {
        rig.evidence.verifyMatrixOrdinaryRevision = () => {
          sourceRead = true;
          return Promise.resolve(portOk(control !== "capability"));
        };
      }
      const state: StateReadView & ReleaseStateWriter = {
        readRepair: rig.state.readRepair.bind(rig.state),
        readRelease: async () => {
          const read = await rig.state.readRelease();
          if (!read.ok || read.value.status !== "found") return read;
          let snapshot = read.value.snapshot;
          if (control === "cooldown") {
            snapshot = parseReleaseStateSnapshotV1({
              ...snapshot,
              githubCooldowns: [{
                installationId: 0,
                retryNotBefore: rig.clock.now() + 60000,
                observedAt: T0,
                observationId: DIGEST,
                secondaryBackoff: 0,
              }],
            });
          }
          if (control === "release") {
            const request = releaseRequest();
            snapshot = parseReleaseStateSnapshotV1({
              ...snapshot,
              hostedReleases: [parseHostedReleaseRecordV1({
                version: "v1",
                kind: "hosted_release",
                id: request.id,
                request,
                priorRevision: RECOVERY_REVISION,
                phase: "requested",
                priorProof: null,
                candidateProof: null,
                rollbackProof: null,
                pointerIntent: null,
                createdAt: T0,
                updatedAt: T0,
              })],
            });
          }
          return portOk({
            ...read.value,
            snapshot,
            head: control === "cursor" && sourceRead
              ? "f".repeat(40) as GitSha
              : read.value.head,
          });
        },
        writeRelease: control === "cas"
          ? () =>
            Promise.resolve(
              portOk<StateWriteResultV1>({
                status: "conflict",
                currentHead: null,
              }),
            )
          : rig.state.writeRelease.bind(rig.state),
      };
      const result = await runHostedSupervisorPrepare({
        ...DORMANT_HOSTED_POLICIES,
        state,
        evidence: rig.evidence,
        clock: rig.clock,
        run: run(72),
      });
      assert.notEqual(result.status, "run", control);
      assert.deepEqual(
        (await rig.read()).snapshot.hostedRuntimes[0].execution,
        control === "owner" ? owner : null,
      );
      assert.deepEqual(
        (await rig.read()).snapshot.hostedRuntimes[0].lastHealthyProof,
        rig.prior,
      );
    } finally {
      await rig.cleanup();
    }
  }
});
