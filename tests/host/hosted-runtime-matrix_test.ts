/** Hosted hosted-runtime-matrix_test responsibility. */
import assert from "node:assert/strict";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
} from "../../src/replay/runtime.ts";
import {
  emitHostedRuntimeCliResult,
  HOSTED_RUNTIME_UNAVAILABLE_DETAIL,
  parseHostedEnvironment,
  readHostedRuntimeExecution,
} from "../../src/host/hosted-runtime.ts";
import type { HostedRuntimeLauncherResultV1 } from "../../src/host/hosted-runtime.ts";
import { matrixPlanCarrierOf } from "../../src/host/matrix-actions.ts";
import {
  childLine,
  exited,
  launch,
  makeRig,
  OTHER_REVISION,
  RUN_ATTEMPT,
  RUN_ID,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

Deno.test("hosted matrix launcher: native plan role reads one repair intent without a terminal", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const planDigest = "d".repeat(64);
    const carrier = {
      kind: "sentinel_matrix_plan",
      waveId: rig.execution.id,
      run: {
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        launcherSha: rig.identity.launcherSha,
      },
      runtimeSha: rig.execution.revision,
      generation: rig.execution.generation,
      planDigest,
      prepared: 1,
    };
    rig.process.child = exited(JSON.stringify(carrier) + "\n");
    const result = await launch(rig, {
      env: {
        ...rig.env,
        GITHUB_JOB: "matrix_plan",
        GITHUB_OUTPUT: "/tmp/native-output",
      },
    });
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal, null);
    assert.deepEqual(
      (result as unknown as { matrixCarrier: unknown }).matrixCarrier,
      carrier,
    );
    const child = rig.process.calls.find((call) =>
      call.args.includes("src/host/matrix-actions.ts")
    );
    assert.ok(child);
    assert.equal(child.env.GITHUB_JOB, "matrix_plan");
    assert.equal(child.env.GITHUB_OUTPUT, "/tmp/native-output");
    assert.equal(await rig.releaseHead() !== null, true);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted matrix launcher: native cell stdin and carrier never settle aggregate repair", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const head = await rig.releaseHead();
    const cellId = "c".repeat(64);
    const stdin = JSON.stringify({ planDigest: "d".repeat(64), cellId });
    const carrier = {
      kind: "sentinel_matrix_cell",
      run: {
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        launcherSha: rig.identity.launcherSha,
      },
      runtimeSha: rig.execution.revision,
      generation: rig.execution.generation,
      cellId,
      reservationId: "reservation-1",
      resultDigest: "e".repeat(64),
      bundleDigest: "f".repeat(64),
      status: "completed",
    };
    rig.process.child = exited(
      JSON.stringify(carrier) + "\n" + childLine(rig.execution),
    );
    const input = Object.assign({
      env: { ...rig.env, GITHUB_JOB: "matrix_cell" },
    }, { stdin });
    const result = await launch(rig, input);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(
      result.terminal,
      null,
      "cell may never mint the repair terminal",
    );
    const child = rig.process.calls.find((call) =>
      call.args.includes("src/host/matrix-actions.ts")
    );
    assert.ok(child);
    assert.equal(
      (child as ReplayCommandInputV1 & { stdin?: string }).stdin,
      stdin,
    );
    assert.equal("GITHUB_OUTPUT" in child.env, false);
    assert.equal(child.env.GITHUB_JOB, "matrix_cell");
    assert.equal(
      await rig.releaseHead(),
      head,
      "only aggregate owns settlement",
    );
    for (
      const forged of [
        { ...carrier, run: { ...carrier.run, runAttempt: RUN_ATTEMPT + 1 } },
        { ...carrier, runtimeSha: OTHER_REVISION },
        { ...carrier, generation: 2 },
        { ...carrier, cellId: "a".repeat(64) },
        { ...carrier, rawModelOutput: "do not disclose" },
      ]
    ) {
      rig.process.child = exited(JSON.stringify(forged));
      const refused = await launch(rig, input);
      assert.equal(refused.status, "unavailable");
      assert.equal(refused.terminal, null);
      assert.equal(refused.matrixCarrier, undefined);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted matrix launcher: rejection receipts distinguish collapsed failures", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const cellId = "c".repeat(64);
    const stdin = JSON.stringify({ planDigest: "d".repeat(64), cellId });
    const input = Object.assign({
      env: { ...rig.env, GITHUB_JOB: "matrix_cell" },
    }, { stdin });
    const carrier = {
      kind: "sentinel_matrix_cell",
      run: {
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        launcherSha: rig.identity.launcherSha,
      },
      runtimeSha: rig.execution.revision,
      generation: rig.execution.generation,
      cellId,
      reservationId: "reservation-1",
      resultDigest: "e".repeat(64),
      bundleDigest: "f".repeat(64),
      status: "completed",
    };
    const line = JSON.stringify(carrier) + "\n";
    const rejected = async (child: ReplayCommandResultV1) => {
      rig.process.child = child;
      const result = await launch(rig, input);
      assert.equal(result.status, "unavailable", JSON.stringify(result));
      assert.equal(result.terminal, null);
      assert.equal(result.matrixCarrier, undefined);
      return result.launcherRejection;
    };
    // Unsettled child: typed outcome metadata surfaced, no carrier parse.
    const unsettled = await rejected(exited(line, 0, { settled: false }));
    assert.ok(unsettled);
    assert.deepEqual({ ...unsettled }, {
      version: "v1",
      kind: "hosted_runtime_matrix_launcher_rejection",
      condition: "child_unsettled",
      outcome: "exited",
      exitCode: 0,
      settled: false,
      truncated: false,
    });
    // Mismatched runtime binding stays fail-closed and names the field group.
    const runtimeSha = await rejected(
      exited(JSON.stringify({ ...carrier, runtimeSha: OTHER_REVISION }) + "\n"),
    );
    assert.equal(runtimeSha?.condition, "carrier_field");
    assert.equal(runtimeSha?.field, "runtime_sha");
    assert.equal(runtimeSha?.carrierCount, 0);
    // Forged launcher identity stays fail-closed.
    const identity = await rejected(
      exited(
        JSON.stringify({
          ...carrier,
          run: { ...carrier.run, runAttempt: RUN_ATTEMPT + 1 },
        }) + "\n",
      ),
    );
    assert.equal(identity?.condition, "carrier_field");
    assert.equal(identity?.field, "identity");
    // Zero and duplicate carriers report counts instead of silent collapse.
    const zero = await rejected(exited(""));
    assert.equal(zero?.condition, "carrier_count");
    assert.equal(zero?.carrierCount, 0);
    const two = await rejected(exited(line + line));
    assert.equal(two?.condition, "carrier_count");
    assert.equal(two?.carrierCount, 2);
    // Receipt is absent on acceptance; carrier validation stays strict.
    rig.process.child = exited(line + childLine(rig.execution));
    const accepted = await launch(rig, input);
    assert.equal(accepted.status, "healthy", JSON.stringify(accepted));
    assert.equal(accepted.launcherRejection, undefined);
    assert.deepEqual(
      (accepted as unknown as { matrixCarrier: unknown }).matrixCarrier,
      carrier,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted matrix CLI: unavailable result emits rejection receipt before generic failure detail", () => {
  const receipt = {
    version: "v1" as const,
    kind: "hosted_runtime_matrix_launcher_rejection" as const,
    condition: "child_unsettled" as const,
    outcome: "exited" as const,
    exitCode: 1,
    settled: false,
    truncated: false,
  };
  const capture = (
    result: HostedRuntimeLauncherResultV1,
  ): { exit: 0 | 1; stdout: string[]; stderr: string[] } => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    console.log = (line: unknown) => stdout.push(String(line));
    console.error = (line: unknown) => stderr.push(String(line));
    let exit: 0 | 1 = 0;
    try {
      exit = emitHostedRuntimeCliResult(result);
    } finally {
      console.log = realLog;
      console.error = realError;
    }
    return { exit, stdout, stderr };
  };
  const unavailable: HostedRuntimeLauncherResultV1 = {
    status: "unavailable",
    terminal: null,
    detail: HOSTED_RUNTIME_UNAVAILABLE_DETAIL,
    diagnostics: [],
    launcherRejection: receipt,
  };
  const failed = capture(unavailable);
  assert.equal(failed.exit, 1, "unavailable still exits nonzero");
  assert.equal(failed.stdout.length, 2, JSON.stringify(failed));
  const emitted = JSON.parse(failed.stdout[0]) as typeof receipt;
  assert.equal(emitted.kind, "hosted_runtime_matrix_launcher_rejection");
  assert.equal(emitted.condition, "child_unsettled");
  assert.equal(emitted.outcome, "exited");
  assert.equal(emitted.exitCode, 1);
  assert.equal(emitted.settled, false);
  assert.equal(emitted.truncated, false);
  assert.equal(JSON.parse(failed.stdout[1]).kind, "hosted_runtime_summary");
  assert.equal(JSON.parse(failed.stdout[1]).outcome, "unavailable");
  assert.ok(
    failed.stderr.some((line) =>
      line.includes(HOSTED_RUNTIME_UNAVAILABLE_DETAIL)
    ),
    "generic failure detail still reaches stderr after the receipt",
  );
  const plain = capture({
    status: "unavailable",
    terminal: null,
    detail: HOSTED_RUNTIME_UNAVAILABLE_DETAIL,
    diagnostics: [],
  });
  assert.equal(plain.exit, 1);
  assert.equal(
    plain.stdout.length,
    1,
    "one summary without a rejection receipt",
  );
  assert.equal(JSON.parse(plain.stdout[0]).kind, "hosted_runtime_summary");
  const healthy = capture({
    status: "healthy",
    terminal: null,
    detail: "healthy",
    diagnostics: [],
  });
  assert.equal(healthy.exit, 0);
  assert.equal(healthy.stderr.length, 0);
  assert.equal(healthy.stdout.length, 1);
  assert.equal(JSON.parse(healthy.stdout[0]).kind, "hosted_runtime_summary");
});

Deno.test("hosted matrix plan: producer emits exact consumer carrier schema", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const planDigest = "d".repeat(64);
    // The rig's launcher checkout SHA differs from its runtime SHA, exactly
    // the fixture the hosted run 37905961284 failure confused.
    assert.notEqual(
      rig.identity.launcherSha,
      rig.execution.revision,
      "fixture requires launcher SHA != runtime SHA",
    );
    const carrier = matrixPlanCarrierOf({
      waveId: rig.execution.id,
      run: {
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        launcherSha: rig.identity.launcherSha,
      },
      controllerSha: rig.execution.revision,
      generation: rig.execution.generation,
      planDigest,
      prepared: 1,
    });
    assert.deepEqual(Object.keys(carrier).sort(), [
      "generation",
      "kind",
      "planDigest",
      "prepared",
      "run",
      "runtimeSha",
      "waveId",
    ], "producer must emit exactly the consumer contract keys");
    const input = {
      env: {
        ...rig.env,
        GITHUB_JOB: "matrix_plan",
        GITHUB_OUTPUT: "/tmp/native-output",
      },
    };
    rig.process.child = exited(JSON.stringify(carrier) + "\n");
    const accepted = await launch(rig, input);
    assert.equal(accepted.status, "healthy", JSON.stringify(accepted));
    assert.deepEqual(
      (accepted as unknown as { matrixCarrier: unknown }).matrixCarrier,
      carrier,
    );
    for (
      const forged of [
        { ...carrier, attempted: 1 },
        { ...carrier, diagnostic: { zero: true } },
        { ...carrier, runtimeSha: OTHER_REVISION },
        { ...carrier, generation: 2 },
      ]
    ) {
      rig.process.child = exited(JSON.stringify(forged) + "\n");
      const refused = await launch(rig, input);
      assert.equal(refused.status, "unavailable", JSON.stringify(refused));
      assert.equal(refused.terminal, null);
      assert.equal(refused.matrixCarrier, undefined);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted matrix identity: explicit native roles share read-only repair identity", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const head = await rig.releaseHead();
    for (const job of ["matrix_plan", "matrix_cell"] as const) {
      const identity = parseHostedEnvironment(
        { ...rig.env, GITHUB_JOB: job },
        job,
      );
      assert.equal(identity.job, job);
      assert.throws(() =>
        parseHostedEnvironment({ ...rig.env, GITHUB_JOB: "repair" }, job)
      );
      assert.equal(
        (await readHostedRuntimeExecution({
          state: rig.release,
          identity,
          controllerSha: rig.execution.revision,
        })).id,
        rig.execution.id,
      );
      await assert.rejects(readHostedRuntimeExecution({
        state: rig.release,
        identity: { ...identity, runAttempt: RUN_ATTEMPT + 1 },
        controllerSha: rig.execution.revision,
      }));
      assert.equal(await rig.releaseHead(), head);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted matrix launcher: aggregate receives only native digest JSON", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(childLine(rig.execution));
    const stdin = JSON.stringify({ planDigest: "d".repeat(64) });
    const result = await launch(rig, { stdin });
    assert.equal(result.status, "healthy");
    assert.ok(result.terminal);
    assert.equal(rig.process.childCalls()[0].stdin, stdin);
    const before = rig.process.childCalls().length;
    assert.equal(
      (await launch(rig, {
        stdin: JSON.stringify({ planDigest: "bad", secret: "no" }),
      })).status,
      "unavailable",
    );
    assert.equal(rig.process.childCalls().length, before);
  } finally {
    await rig.cleanup();
  }
});
