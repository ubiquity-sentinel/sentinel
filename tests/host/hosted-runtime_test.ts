/** Hosted hosted-runtime_test responsibility. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedRuntimeTerminalV1 } from "../../src/contracts/hosted-execution.ts";
import {
  HOSTED_RUNTIME_CHILD_ENTRYPOINT,
  HOSTED_RUNTIME_DEADLINE_MS,
  HOSTED_RUNTIME_MAX_OUTPUT_BYTES,
  HOSTED_RUNTIME_STATIC_IDENTITY,
  parseHostedEnvironment,
  readHostedRuntimeExecution,
  runHostedRuntimeLauncher,
} from "../../src/host/hosted-runtime.ts";
import type { HostedRuntimeIdentityV1 } from "../../src/host/hosted-runtime.ts";
import { T0 } from "../state/helpers.ts";
import {
  BorderRuntime,
  childLine,
  exited,
  FakeClock,
  FIXED_LAUNCHER,
  hostedEnv,
  launch,
  makeRig,
  OBSERVED_BASE,
  OTHER_REVISION,
  requiredChildEnvKeys,
  RUN_ATTEMPT,
  RUN_ID,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

Deno.test("hosted runtime: native identity parsing is exact and rejects every foreign field", () => {
  const env = hostedEnv(FIXED_LAUNCHER);
  const identity = parseHostedEnvironment(env, "repair");
  assert.equal(identity.runId, RUN_ID);
  assert.equal(identity.runAttempt, RUN_ATTEMPT);
  assert.equal(identity.launcherSha, FIXED_LAUNCHER);
  assert.equal(identity.job, "repair");
  assert.equal(
    parseHostedEnvironment({ ...env, GITHUB_JOB: "prepare" }, "prepare").job,
    "prepare",
  );

  const bad: Record<string, string | undefined>[] = [
    { ...env, GITHUB_JOB: "finalize" },
    { ...env, GITHUB_REPOSITORY: "ubiquity/other" },
    { ...env, GITHUB_REF: "refs/heads/main" },
    {
      ...env,
      GITHUB_WORKFLOW_REF:
        "ubiquity-sentinel/sentinel/.github/workflows/other.yml@refs/heads/sentinel-supervisor",
    },
    { ...env, GITHUB_WORKFLOW_SHA: "c".repeat(40) },
    { ...env, GITHUB_SHA: "not-a-sha" },
    { ...env, GITHUB_RUN_ID: "0" },
    { ...env, GITHUB_RUN_ID: "1e3" },
    { ...env, GITHUB_RUN_ATTEMPT: "-1" },
    { ...env, GITHUB_RUN_ATTEMPT: "1.5" },
    { ...env, GITHUB_RUN_ID: undefined },
  ];
  for (const candidate of bad) {
    assert.throws(
      () => parseHostedEnvironment(candidate, "repair"),
      { message: HOSTED_RUNTIME_STATIC_IDENTITY },
      JSON.stringify(candidate),
    );
  }
});

Deno.test("hosted runtime: the saved pointer execution is read strictly from real release state", async () => {
  const rig = await makeRig();
  try {
    // Absent release state is a refusal, never an inferred intent.
    await assert.rejects(
      readHostedRuntimeExecution({
        state: rig.release,
        identity: rig.identity,
        controllerSha: rig.execution.revision,
      }),
    );
    await seedRelease(rig);
    const execution = await readHostedRuntimeExecution({
      state: rig.release,
      identity: rig.identity,
      controllerSha: rig.execution.revision,
    });
    assert.equal(execution.id, `${RUN_ID}:${RUN_ATTEMPT}:repair`);
    assert.equal(
      canonicalStringify(execution),
      canonicalStringify(rig.execution),
    );

    const mismatches: {
      identity?: HostedRuntimeIdentityV1;
      controllerSha?: GitSha;
    }[] = [
      { identity: { ...rig.identity, runAttempt: RUN_ATTEMPT + 1 } },
      { identity: { ...rig.identity, runId: RUN_ID + 1 } },
      { identity: { ...rig.identity, launcherSha: OTHER_REVISION } },
      { controllerSha: OTHER_REVISION },
    ];
    for (const mismatch of mismatches) {
      await assert.rejects(
        readHostedRuntimeExecution({
          state: rig.release,
          identity: mismatch.identity ?? rig.identity,
          controllerSha: mismatch.controllerSha ?? rig.execution.revision,
        }),
      );
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a malformed native identity launches nothing at all", async () => {
  const process = new BorderRuntime();
  const inert = {
    readRepair: () => {
      throw new Error("state must not be read");
    },
    readRelease: () => {
      throw new Error("state must not be read");
    },
  };
  const result = await runHostedRuntimeLauncher({
    state: inert,
    clock: new FakeClock(T0),
    env: { ...hostedEnv(FIXED_LAUNCHER), GITHUB_JOB: "prepare" },
    launcherDir: "/nonexistent/launcher",
    runtimeDir: "/nonexistent/runtime",
    denoExecutable: "deno",
    process,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.terminal, null);
  assert.equal(process.calls.length, 0);
});

Deno.test("hosted runtime: a dirty source checkout or stale pointer launches no child and writes no state", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const head = await rig.releaseHead();

    await Deno.writeTextFile(`${rig.launcherDir}/untracked.txt`, "dirty\n");
    let result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);
    assert.equal(rig.process.childCalls().length, 0);

    await Deno.remove(`${rig.launcherDir}/untracked.txt`);
    await Deno.writeTextFile(`${rig.runtimeDir}/untracked.txt`, "dirty\n");
    result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(rig.process.childCalls().length, 0);
    assert.equal(await rig.releaseHead(), head);
  } finally {
    await rig.cleanup();
  }

  const stale = await makeRig({ executionRevision: OTHER_REVISION });
  try {
    await seedRelease(stale);
    const head = await stale.releaseHead();
    const result = await launch(stale);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);
    assert.equal(stale.process.childCalls().length, 0);
    assert.equal(await stale.releaseHead(), head);
  } finally {
    await stale.cleanup();
  }
});

Deno.test("hosted runtime: exact identity and clean source settle one healthy terminal and one fixed child", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(childLine(rig.execution));
    const result = await launch(rig);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    const terminal = result.terminal;
    assert.ok(terminal !== null);
    if (terminal === null) throw new Error("unreachable");
    assert.deepEqual(terminal, parseHostedRuntimeTerminalV1(terminal));
    assert.equal(terminal.outcome, "healthy");
    assert.equal(terminal.startupReady, true);
    assert.equal(terminal.settled, true);
    assert.equal(terminal.baseSha, OBSERVED_BASE);
    assert.equal(terminal.controllerSha, rig.execution.revision);
    assert.equal(
      canonicalStringify(terminal.execution),
      canonicalStringify(rig.execution),
    );
    assert.ok(terminal.finishedAt >= terminal.startedAt);

    const childCalls = rig.process.childCalls();
    assert.equal(childCalls.length, 1);
    const child = childCalls[0];
    assert.equal(child.executable, Deno.execPath());
    assert.deepEqual(child.args, [
      "run",
      "-A",
      HOSTED_RUNTIME_CHILD_ENTRYPOINT,
    ]);
    assert.equal(child.cwd, await Deno.realPath(rig.runtimeDir));
    assert.equal(child.maxDurationMs, HOSTED_RUNTIME_DEADLINE_MS);
    assert.equal(child.maxOutputBytes, HOSTED_RUNTIME_MAX_OUTPUT_BYTES);
    // The allow-list is exact: every listed key crosses except the optional
    // values this run did not supply.
    assert.deepEqual(
      Object.keys(child.env).sort(),
      requiredChildEnvKeys(),
    );
    assert.equal("SENTINEL_SUPERVISOR_TOKEN" in child.env, false);
    assert.equal("SENTINEL_DEEPSEEK_API_KEY" in child.env, false);
    assert.equal("GITHUB_OUTPUT" in child.env, false);
    assert.equal("GITHUB_ENV" in child.env, false);
    assert.equal(child.env.GITHUB_JOB, "repair");
    assert.equal(child.env.GITHUB_SHA, rig.identity.launcherSha);
    assert.equal(child.env.GITHUB_WORKFLOW_SHA, rig.identity.launcherSha);
    assert.equal(child.env.GITHUB_RUN_ID, String(RUN_ID));
    assert.equal(child.env.GITHUB_RUN_ATTEMPT, String(RUN_ATTEMPT));

    const gitCalls = rig.process.gitCalls();
    assert.ok(gitCalls.length >= 4);
    for (const call of gitCalls) {
      assert.equal(call.executable, "/usr/bin/git");
      assert.equal(call.args[0], "-c");
      assert.equal(call.args[1], "core.hooksPath=/dev/null");
      assert.ok(call.maxDurationMs > 0 && call.maxDurationMs <= 60_000);
      assert.ok(call.maxOutputBytes <= 64 * 1024);
      assert.equal("GITHUB_TOKEN" in call.env, false);
      assert.equal("GIT_CONFIG_COUNT" in call.env, false);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: settled early failure is failed; unattestable zero exit is unavailable", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);

    rig.process.child = exited("", 3);
    let result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.outcome, "failed");
    assert.equal(result.terminal?.startupReady, false);
    assert.equal(result.terminal?.baseSha, null);
    assert.equal(result.terminal?.settled, true);

    rig.process.child = exited(
      childLine(rig.execution, { startupReady: false }),
      0,
    );
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, false);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);

    // An explicit child failure preserves its observed startup flag and base.
    rig.process.child = exited(
      childLine(rig.execution, {
        outcome: { status: "source_error", detail: "source unavailable" },
      }),
      0,
    );
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);

    // A healthy-looking record beside a nonzero exit is still failed, with the
    // observed metadata preserved rather than rewritten.
    rig.process.child = exited(childLine(rig.execution), 1);
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);

    // A zero exit with no attestable child record is uncertain, not healthy.
    rig.process.child = exited("", 0);
    result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);

    rig.process.child = exited(
      childLine(rig.execution, { outcome: { status: "step_limit", steps: 4 } }),
      0,
    );
    assert.equal((await launch(rig)).status, "healthy");
  } finally {
    await rig.cleanup();
  }
});
