import assert from "node:assert/strict";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import { darkQueueCoordinatorFixture } from "./hosted-autonomy-dark-queue-fixture.ts";
import {
  captureHostedAutonomyMain,
  makeRig,
  releaseSnapshot,
  repairSnapshot,
} from "./hosted-autonomy-rig.ts";
import { gitRun, reservation, SHA1, T0, workRecord } from "../state/helpers.ts";
import { ENV } from "./hosted-autonomy-fixtures.ts";
import {
  CLOSED_C_WAVE,
  recoverClosedCWave,
} from "../../src/host/modern-matrix-recovery.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { ClosedCWaveRecoveryDepsV1 } from "../../src/host/modern-matrix-recovery.ts";
import type { HostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";

const unused = (): never => {
  throw new Error("external recovery capability must remain unused");
};
const clock = { now: () => T0 + 10_000 };
const idle = {
  version: "v1" as const,
  kind: "hosted_runtime" as const,
  id: "ubiquity-sentinel/sentinel:0:production",
  activeRevision: SHA1,
  generation: 1,
  lastHealthyProof: null,
  lastExecutionProof: null,
  nextOrdinaryAt: T0,
  execution: null,
  createdAt: T0,
  updatedAt: T0,
};

// Keep the native checkout gate real while testing an uncommitted candidate.
// The injected controllers execute the imported production code; only their
// external history/API reads are fake. Checkout identity is a clean real Git
// fixture and is never substituted through a mocked checkout reader.
async function captureNativeMain(
  tmp: string,
  deps: Parameters<typeof captureHostedAutonomyMain>[0],
) {
  const checkout = await Deno.makeTempDir({
    dir: tmp,
    prefix: "native-checkout-",
  });
  const cloned = await gitRun(tmp, [
    "clone",
    "--branch",
    "sentinel-state/release",
    tmp + "/remote.git",
    checkout,
  ], ENV);
  assert.ok(cloned.ok);
  const head = await gitRun(checkout, ["rev-parse", "HEAD"], ENV);
  assert.ok(head.ok);
  const previous = Deno.cwd();
  try {
    Deno.chdir(checkout);
    return await withHostedProductionPolicy(
      DORMANT_HOSTED_SUPERVISOR_POLICY,
      async (graph) => {
        const { runHostedAutonomyMain } = await graph.maintenanceMain();
        return await captureHostedAutonomyMain(
          {
            ...deps,
            queue: await darkQueueCoordinatorFixture(deps),
          },
          head.stdout.trim(),
          runHostedAutonomyMain,
        );
      },
    );
  } finally {
    Deno.chdir(previous);
  }
}

Deno.test("current matrix integrity: wrong-sequence ancestry fails protected main without a write", async () => {
  const release = releaseSnapshot();
  release.hostedRuntimes = [idle];
  const record = workRecord("integrity-custody-probe", {
    intent: {
      kind: "implementation",
      key: "impl:integrity-probe",
      requestId: "integrity-probe",
      observedBase: SHA1,
      expectedHead: null,
      resultId: null,
      pr: null,
      branch: null,
      startedAt: T0,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
  });
  const { rig } = await makeRig("current-integrity", {
    fixtureDir: Deno.cwd(),
    repair: repairSnapshot([record], [], [], []),
    release,
  });
  try {
    const before = await rig.state.readRepair();
    const observed = await rig.state.readRelease();
    assert(observed.ok && observed.value.status === "found");
    const current = {
      ...observed.value,
      snapshot: { ...observed.value.snapshot, stateHead: SHA1, sequence: 2 },
    };
    const state = {
      ...rig.state,
      readRelease: () => Promise.resolve(portOk(current)),
      readReleaseAt: () =>
        Promise.resolve(
          portOk({
            status: "found" as const,
            head: SHA1,
            ref: null,
            snapshot: { ...release, sequence: 99 },
          }),
        ),
    };
    const closed: ClosedCWaveRecoveryDepsV1 = {
      state,
      clock,
      configs: [],
      cycleFor: unused,
      prepareTarget: unused,
      importerFor: unused,
      transportFor: unused,
      readExecution: unused,
      binding: CLOSED_C_WAVE,
    };
    const reported = await captureNativeMain(rig.tmp, {
      state,
      clock,
      githubFor: () => null,
      closedMatrix: () => Promise.resolve(closed),
    });
    console.log(
      JSON.stringify({
        scenario: "wrong_sequence",
        exit: reported.exit,
        reason: reported.result.reason,
        status: reported.result.status,
        writes: rig.writes,
      }),
    );
    assert.deepEqual(await rig.state.readRepair(), before);
    assert.equal(rig.writes, 0);
    assert.equal(
      reported.exit,
      1,
      "tampered ancestry must fail protected maintenance",
    );
    assert.equal(reported.result.reason, "unexpected_failure");
    assert.equal(
      reported.result.beforeHead,
      before.ok && before.value.status === "found" ? before.value.head : null,
    );
    assert.equal(reported.result.appliedHead, null);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("modern closed C integrity: changed native proof fails protected main before any write", async () => {
  const repository = {
    owner: "ubiquity-sentinel",
    name: "sentinel",
    installationId: 0,
  };
  const id = "modern-integrity-probe";
  const chargeId = "modern-integrity-charge";
  const record = workRecord(id, {
    repository,
    target: {
      base: SHA1,
      head: null,
      pr: null,
      branch: null,
      checkpoint: null,
    },
    intent: {
      kind: "implementation",
      key: `implementation:${chargeId}`,
      requestId: chargeId,
      observedBase: SHA1,
      expectedHead: null,
      resultId: null,
      pr: null,
      branch: null,
      startedAt: T0,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
  });
  const charge = reservation(chargeId, {
    repository,
    taskId: id,
    head: SHA1,
    purpose: "implementation",
    attempt: 1,
  });
  const held: HostedRunProofV1 = {
    execution: {
      id: "901:1:repair",
      runId: 901,
      runAttempt: 1,
      launcherSha: SHA1,
      purpose: "ordinary",
      revision: SHA1,
      generation: 1,
      releaseId: null,
      createdAt: T0 + 1000,
    },
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity-sentinel/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 1,
    startedAt: T0 + 1100,
    finishedAt: T0 + 1200,
    observedAt: T0 + 1300,
    outcome: "failed",
    startupReady: true,
    settled: true,
    baseSha: SHA1,
    terminalAt: null,
    logDigest: "d".repeat(64),
  };
  const healthy: HostedRunProofV1 = {
    ...held,
    execution: {
      ...held.execution,
      id: "900:1:repair",
      runId: 900,
      createdAt: T0,
    },
    startedAt: T0,
    finishedAt: T0 + 100,
    observedAt: T0 + 200,
    outcome: "healthy",
    terminalAt: T0 + 100,
  };
  const release = releaseSnapshot();
  release.hostedRuntimes = [idle];
  const { rig } = await makeRig("modern-integrity", {
    fixtureDir: Deno.cwd(),
    repair: repairSnapshot([record], [], [], [charge]),
    release,
  });
  try {
    const repair = await rig.state.readRepair();
    const released = await rig.state.readRelease();
    assert(repair.ok && repair.value.status === "found");
    assert(released.ok && released.value.status === "found");
    // Producer history is the injected read-only API seam; the real live Git
    // store starts legally idle and never receives a fabricated healthy write.
    const producerRelease = {
      ...released.value,
      snapshot: {
        ...released.value.snapshot,
        hostedRuntimes: [{
          ...idle,
          lastHealthyProof: healthy,
          lastExecutionProof: held,
        }],
      },
    };
    const state = {
      ...rig.state,
      readRepairAt: () => Promise.resolve(repair),
      readReleaseAt: () => Promise.resolve(portOk(producerRelease)),
    };
    const closed: ClosedCWaveRecoveryDepsV1 = {
      state,
      clock,
      configs: [],
      cycleFor: unused,
      prepareTarget: unused,
      importerFor: unused,
      transportFor: () => ({
        confirmCompletedExecution: () => Promise.resolve(true),
        recover: unused,
      }),
      readExecution: () =>
        Promise.resolve(portOk({ ...held, logDigest: "e".repeat(64) })),
      binding: {
        runtimeSha: SHA1,
        generation: 1,
        run: { runId: 901, runAttempt: 1, launcherSha: SHA1 },
        repairCommit: repair.value.head,
        releaseCommit: released.value.head,
        planDigest: "f".repeat(64),
        expectedProvider: "synthetic-provider",
        cells: [{
          reservationId: chargeId,
          taskId: id,
          repository,
          base: SHA1,
        }],
      },
    };
    await assert.rejects(
      () => recoverClosedCWave(closed),
      /C recovery native failure proof changed/,
    );
    const reported = await captureNativeMain(rig.tmp, {
      state,
      clock,
      githubFor: () => null,
      closedMatrix: () => Promise.resolve(closed),
    });
    console.log(
      JSON.stringify({
        scenario: "changed_modern_native_proof",
        exit: reported.exit,
        reason: reported.result.reason,
        status: reported.result.status,
        writes: rig.writes,
      }),
    );
    assert.deepEqual(await rig.state.readRepair(), repair);
    assert.equal(rig.writes, 0);
    assert.equal(
      reported.exit,
      1,
      "conflicting modern-C proof must fail protected maintenance",
    );
    assert.equal(reported.result.reason, "unexpected_failure");
    assert.equal(reported.result.beforeHead, repair.value.head);
    assert.equal(reported.result.appliedHead, null);
    const unavailable = {
      ...closed,
      readExecution: () => Promise.resolve(portOk(null)),
    };
    const deferred = await captureNativeMain(rig.tmp, {
      state,
      clock,
      githubFor: () => null,
      closedMatrix: () => Promise.resolve(unavailable),
    });
    assert.equal(
      deferred.exit,
      0,
      "an unavailable producer remains a bounded deferral",
    );
    assert.equal(deferred.result.reason, "deferred_unexpected_error");
    assert.equal(deferred.result.appliedHead, null);
    assert.deepEqual(await rig.state.readRepair(), repair);
    assert.equal(rig.writes, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
