/** Strict provenance, archive integrity and charged missing-artifact custody. */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  type HostedExecutionIntentV1,
  type HostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { MatrixMissingCellArtifactError } from "../../src/host/matrix-artifact-port.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import { SHA2, T0 } from "../state/helpers.ts";
import {
  bytes,
  fixture,
  LAUNCHER,
  RUN,
  RUNTIME,
  WAVE,
  zip,
} from "./matrix-artifact-fixtures.ts";

Deno.test("matrix artifacts: exact identity and native provenance conflicts refuse", async (t) => {
  const cases: [string, (rig: Awaited<ReturnType<typeof fixture>>) => void][] =
    [
      ["native run", (rig) => {
        rig.attempt.id = 72;
      }],
      ["native attempt", (rig) => {
        rig.attempt.run_attempt = 1;
      }],
      ["launcher", (rig) => {
        rig.attempt.head_sha = SHA2;
      }],
      ["workflow", (rig) => {
        rig.attempt.workflow_id = 1;
      }],
      ["branch", (rig) => {
        rig.attempt.head_branch = "development";
      }],
      ["workflow path", (rig) => {
        rig.attempt.path = ".github/workflows/other.yml";
      }],
      ["repository", (rig) => {
        rig.attempt.repository = { id: 123, full_name: "attacker/sentinel" };
      }],
      ["task", (rig) => {
        rig.input.requests[0].taskId = "wrong" as never;
      }],
      ["reservation", (rig) => {
        rig.input.requests[0].reservationId = "b".repeat(64);
      }],
      ["base", (rig) => {
        rig.input.requests[0].expectedBase = SHA2;
      }],
      ["attempt grant", (rig) => {
        rig.input.requests[0].attempt = 2;
      }],
      ["intent", (rig) => {
        rig.input.requests[0].intentKey = "impl:wrong";
      }],
      ["runtime", (rig) => {
        rig.input.runtimeSha = SHA2;
      }],
      ["native cell job attempt", (rig) => {
        rig.jobs[1].run_attempt = 1;
      }],
      ["spoofed duplicate planner", (rig) => {
        rig.logs.set(401, rig.logs.get(401)! + rig.logs.get(401)!);
      }],
      ["spoofed duplicate cell", (rig) => {
        rig.logs.set(402, rig.logs.get(402)! + rig.logs.get(402)!);
      }],
      ["artifact provenance", (rig) => {
        rig.artifacts[1].workflow_run = { id: 72 };
      }],
      ["artifact archive digest", (rig) => {
        rig.artifacts[1].digest = `sha256:${"0".repeat(64)}`;
      }],
      ["conflicting names", (rig) => {
        rig.artifacts.push({ ...rig.artifacts[1], id: 503 });
      }],
      ["retained execution disagreement", (rig) => {
        rig.release.hostedRuntimes[0].execution = {
          ...rig.release.hostedRuntimes[0].execution!,
          id: WAVE,
          runId: 71,
          runAttempt: 2,
          revision: SHA2,
        };
      }],
    ];
  for (const [name, change] of cases) {
    await t.step(name, async () => {
      const rig = await fixture();
      try {
        change(rig);
        await assert.rejects(
          () => rig.transport.recover(rig.input),
          /provenance unavailable or conflicting/,
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("matrix artifacts: archive path, file type and content conflicts refuse", async (t) => {
  for (
    const [name, entries] of [
      [
        "traversal",
        (
          rig: Awaited<ReturnType<typeof fixture>>,
        ) => [{ name: "../result.json", content: bytes(rig.result) }],
      ],
      [
        "symlink",
        (
          rig: Awaited<ReturnType<typeof fixture>>,
        ) => [{
          name: "result.json",
          content: bytes(rig.result),
          unixMode: 0o120777,
        }],
      ],
      [
        "unexpected file",
        (
          rig: Awaited<ReturnType<typeof fixture>>,
        ) => [{ name: "secret.txt", content: bytes(rig.result) }],
      ],
      [
        "bundle hash",
        (
          rig: Awaited<ReturnType<typeof fixture>>,
        ) => [{ name: "result.json", content: bytes(rig.result) }, {
          name: rig.result.bundle!.file,
          content: new Uint8Array([1, 2, 3]),
        }],
      ],
      [
        "result hash",
        (
          rig: Awaited<ReturnType<typeof fixture>>,
        ) => [{
          name: "result.json",
          content: bytes({ ...rig.result, runtimeSha: SHA2 }),
        }, { name: rig.result.bundle!.file, content: rig.bundle }],
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const rig = await fixture();
      try {
        await rig.setArchive(502, rig.cellName, await zip(entries(rig)));
        await assert.rejects(
          () => rig.transport.recover(rig.input),
          /provenance unavailable or conflicting/,
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("matrix artifacts: missing artifact preserves charged intent and never proves not submitted", async () => {
  const rig = await fixture();
  try {
    rig.artifacts.splice(1, 1);
    const before = canonicalStringify(rig.repair);
    const waves = await rig.transport.recover(rig.input);
    assert.equal(waves[0].results.length, 0);
    assert.equal(canonicalStringify(rig.repair), before);
    assert.equal(rig.repair.reservations[0].outcome, "reserved");
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: authenticated current nonmatching plan preserves full native identity", async () => {
  const rig = await fixture();
  try {
    const original = rig.repair.work[0];
    const taskId = "nonmatching-current-request" as typeof original.id;
    const reservationId = "b".repeat(64);
    rig.repair.work.push({
      ...structuredClone(original),
      id: taskId,
      source: { ...original.source, id: taskId },
      intent: {
        ...original.intent!,
        requestId: reservationId,
        key: implementationIntentKey(reservationId),
      },
    });
    rig.repair.reservations.push({
      ...structuredClone(rig.repair.reservations[0]),
      id: reservationId,
      taskId,
    });
    const input = {
      ...rig.input,
      requests: [{
        ...rig.input.requests[0],
        taskId,
        reservationId,
        intentKey: implementationIntentKey(reservationId),
      }],
    };
    const before = canonicalStringify(rig.repair);
    const waves = await rig.transport.recover(input);
    assert.equal(
      waves.length,
      1,
      "exact current native plan must authenticate even without requested membership",
    );
    assert.deepEqual(waves[0].plan, rig.plan);
    assert.equal(waves[0].planDigest, await matrixDigestV1(rig.plan));
    assert.deepEqual(waves[0].provenance.run, RUN);
    assert.deepEqual(waves[0].results, []);
    assert.equal(canonicalStringify(rig.repair), before);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: historical missing cell refuses directly with exact uncertainty custody", async () => {
  const rig = await fixture();
  try {
    // The historical wave's cell artifact was never uploaded (cancelled cell):
    // not-started can never be proven for this record.
    rig.artifacts.splice(1, 1);
    // Malformed admission (reservation created after the plan manifest) so the
    // historical rejection pass engages for the recorded execution's wave.
    const admittedAt = T0 + 5000;
    rig.repair.reservations[0].createdAt = admittedAt;
    const intent = rig.repair.work[0].intent;
    assert.ok(intent);
    intent.startedAt = admittedAt;
    rig.repair.work[0].counters.attempts = 1;
    const execution: HostedExecutionIntentV1 = {
      id: "71:2:repair",
      runId: 71,
      runAttempt: 2,
      launcherSha: LAUNCHER,
      purpose: "ordinary",
      revision: RUNTIME,
      generation: 3,
      releaseId: null,
      createdAt: T0,
    };
    rig.release.hostedRuntimes[0].execution = execution;
    const proof: HostedRunProofV1 = {
      execution,
      workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
      workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
      repository: "Ubiquity-Sentinel/sentinel",
      ref: "refs/heads/sentinel-supervisor",
      jobId: 401,
      startedAt: T0,
      finishedAt: T0,
      observedAt: T0,
      outcome: "failed",
      startupReady: true,
      settled: true,
      baseSha: null,
      terminalAt: T0,
      logDigest: "f".repeat(64),
    };
    const transport = createActionsMatrixArtifactTransport({
      state: rig.state,
      token: "fake-local-token",
      http: rig.http,
      clock: { now: () => T0 + 10_000 },
      artifactRoot: `${rig.tmp}/recovered-reject`,
    });
    const originalCwd = Deno.cwd();
    const before = canonicalStringify(rig.repair);
    Deno.chdir(`${rig.tmp}/checkout`);
    try {
      await assert.rejects(
        () => transport.rejectHistorical!({ proof }),
        (error: unknown) => {
          assert(error instanceof MatrixMissingCellArtifactError);
          assert.deepEqual(error.proof, proof);
          assert.equal(error.captured.work.id, rig.repair.work[0].id);
          assert.equal(
            error.captured.reservation.id,
            rig.repair.reservations[0].id,
          );
          return true;
        },
      );
    } finally {
      Deno.chdir(originalCwd);
    }
    assert.equal(canonicalStringify(rig.repair), before);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: unrelated historical launcher wave cannot block admitted old-wave recovery", async () => {
  const rig = await fixture();
  try {
    const unrelated = {
      ...rig.plan,
      waveId: "70:1:repair",
      run: { runId: 70, runAttempt: 1, launcherSha: SHA2 },
      cells: [{ ...rig.cell, reservationId: "b".repeat(64) }],
    };
    await rig.setArchive(
      503,
      "sentinel-matrix-plan-70-1",
      await zip([{ name: "plan.json", content: bytes(unrelated) }]),
    );
    rig.artifacts.push({
      id: 504,
      name: "sentinel-matrix-plan-69-1",
      expired: true,
    });
    const { currentRun: _oldRun, ...input } = rig.input;
    const recovered = await rig.transport.recover(input);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].results.length, 1);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
