/** Hosted hosted-runtime-tokens_test responsibility. */
import assert from "node:assert/strict";
import { T0 } from "../state/helpers.ts";
import {
  APP_LOGIN,
  APP_TOKEN,
  BackwardClock,
  childLine,
  exited,
  hostedEnv,
  launch,
  makeRig,
  NATIVE_LOGIN,
  OBSERVED_BASE,
  OTHER_REVISION,
  requiredChildEnvKeys,
  ROOT,
  RUN_ID,
  seedRelease,
} from "./hosted-runtime-fixture.ts";
import { buildChildEnvironment } from "../../src/host/hosted-runtime-child.ts";
import { readJobScopedLauncherEnv } from "../../src/host/hosted-runtime-main.ts";

Deno.test("hosted runtime: the sentinel App bot login is accepted and an absent App token still forwards the strict child environment", async () => {
  // App-login transition case: a child at or after the migration reports
  // `ubiquity-sentinel[bot]`; it must settle exactly like the native identity.
  const appRig = await makeRig();
  try {
    await seedRelease(appRig);
    appRig.process.child = exited(
      childLine(appRig.execution, { login: "ubiquity-sentinel[bot]" }),
    );
    const result = await launch(appRig);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal?.outcome, "healthy");
  } finally {
    await appRig.cleanup();
  }

  // Absence case: without the App token the child environment keeps exactly
  // the declared key set, and the App token key is genuinely absent rather
  // than present-and-empty.
  const noAppRig = await makeRig();
  try {
    await seedRelease(noAppRig);
    noAppRig.process.child = exited(childLine(noAppRig.execution));
    const env = { ...hostedEnv(noAppRig.identity.launcherSha) };
    delete env.SENTINEL_SUPERVISOR_TOKEN;
    const result = await launch(noAppRig, { env });
    assert.equal(result.status, "healthy", JSON.stringify(result));
    const child = noAppRig.process.childCalls()[0];
    assert.equal("SENTINEL_SUPERVISOR_TOKEN" in child.env, false);
    assert.deepEqual(
      Object.keys(child.env).sort(),
      requiredChildEnvKeys(),
    );
  } finally {
    await noAppRig.cleanup();
  }
});

Deno.test("hosted runtime: duplicate, malformed, foreign or forged child records are unavailable", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    const forged = JSON.stringify({
      version: "v1",
      kind: "hosted_runtime_terminal",
      execution: rig.execution,
      controllerSha: rig.execution.revision,
      startedAt: T0,
      finishedAt: T0,
      outcome: "healthy",
      startupReady: true,
      settled: true,
      baseSha: OBSERVED_BASE,
    });
    for (
      const stdout of [
        `${healthy}\n${healthy}`,
        JSON.stringify({
          status: "ran",
          outcome: { status: "idle", detail: "missing keys" },
        }),
        JSON.stringify({ status: "completed" }),
        forged,
        `${healthy}\n${forged}`,
        childLine(rig.execution, { login: "attacker" }),
        childLine(rig.execution, {
          execution: { ...rig.execution, runId: RUN_ID + 1 },
        }),
        childLine(rig.execution, { controllerSha: OTHER_REVISION }),
      ]
    ) {
      rig.process.child = exited(stdout, 0);
      const result = await launch(rig);
      assert.equal(result.status, "unavailable", stdout);
      assert.equal(result.terminal, null, stdout);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: the optional sentinel App token crosses only when it is non-empty text", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(childLine(rig.execution));
    const withoutToken = await launch(rig);
    assert.equal(withoutToken.status, "healthy", JSON.stringify(withoutToken));
    let child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.equal("SENTINEL_SUPERVISOR_TOKEN" in child.env, false);
    assert.equal(child.env.GITHUB_TOKEN, rig.env.GITHUB_TOKEN);

    rig.process.child = exited(childLine(rig.execution));
    const withToken = await launch(rig, {
      env: { ...rig.env, SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN },
    });
    assert.equal(withToken.status, "healthy", JSON.stringify(withToken));
    child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.equal(child.env.SENTINEL_SUPERVISOR_TOKEN, APP_TOKEN);
    assert.deepEqual(
      Object.keys(child.env).sort(),
      [
        ...requiredChildEnvKeys(),
        "SENTINEL_SUPERVISOR_TOKEN",
      ].sort(),
      "a supplied App token completes the exact allow-list",
    );
    assert.equal(child.env.GITHUB_TOKEN, rig.env.GITHUB_TOKEN);

    // The DeepSeek-direct fallback selection reaches the child exactly as the
    // launcher received it; the launcher never selects or rewrites a route.
    rig.process.child = exited(childLine(rig.execution));
    const routed = await launch(rig, {
      env: {
        ...rig.env,
        SENTINEL_MODEL_FALLBACK: "deepseek",
        SENTINEL_DEEPSEEK_API_KEY: "test-deepseek-key",
      },
    });
    assert.equal(routed.status, "healthy", JSON.stringify(routed));
    const routedChild = rig.process.childCalls().at(-1);
    assert.ok(routedChild !== undefined);
    assert.equal(routedChild.env.SENTINEL_MODEL_FALLBACK, "deepseek");
    assert.equal(
      routedChild.env.SENTINEL_DEEPSEEK_API_KEY,
      "test-deepseek-key",
    );
    assert.deepEqual(
      Object.keys(routedChild.env).sort(),
      [
        ...requiredChildEnvKeys(),
        "SENTINEL_MODEL_FALLBACK",
        "SENTINEL_DEEPSEEK_API_KEY",
      ].sort(),
      "the selected route variables cross with the required keys only",
    );

    rig.process.child = exited(childLine(rig.execution));
    const emptyToken = await launch(rig, {
      env: { ...rig.env, SENTINEL_SUPERVISOR_TOKEN: "" },
    });
    assert.equal(emptyToken.status, "healthy", JSON.stringify(emptyToken));
    child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.equal(
      "SENTINEL_SUPERVISOR_TOKEN" in child.env,
      false,
      "an empty App token never crosses",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: target and self installation identities cross only when supplied", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(childLine(rig.execution));
    const result = await launch(rig, {
      env: {
        ...rig.env,
        SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN,
        SENTINEL_TARGET_INSTALLATION_ID: "173913802",
        SENTINEL_SELF_INSTALLATION_ID: "173834540",
      },
    });
    assert.equal(result.status, "healthy", JSON.stringify(result));
    const child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.equal(child.env.SENTINEL_TARGET_INSTALLATION_ID, "173913802");
    assert.equal(child.env.SENTINEL_SELF_INSTALLATION_ID, "173834540");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a child settled as the sentinel App login is accepted during the transition", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    for (const login of [NATIVE_LOGIN, APP_LOGIN]) {
      rig.process.child = exited(childLine(rig.execution, { login }));
      const result = await launch(rig);
      assert.equal(
        result.status,
        "healthy",
        `${login}: ${JSON.stringify(result)}`,
      );
      assert.equal(result.terminal?.outcome, "healthy", login);
      assert.equal(result.terminal?.baseSha, OBSERVED_BASE, login);
    }
    // Any other login is still refused: the transition set is bounded, not
    // an open prefix or suffix match.
    for (const login of ["ubiquity-sentinel", "github-actions"]) {
      rig.process.child = exited(childLine(rig.execution, { login }));
      const foreign = await launch(rig);
      assert.equal(foreign.status, "unavailable", login);
      assert.equal(foreign.terminal, null, login);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a truncated status record is refused while legitimate noise is tolerated", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    const truncated =
      '{"status":"ran","outcome":{"status":"idle","detail":"x"}';
    for (
      const stdout of [
        `${truncated}\n${healthy}`,
        `${healthy}\n${truncated}`,
        '{"status":"ra',
        '{"status":',
      ]
    ) {
      rig.process.child = exited(stdout, 0);
      const result = await launch(rig);
      assert.equal(result.status, "unavailable", stdout);
      assert.equal(result.terminal, null, stdout);
    }

    // An attempted status key after another key (truncated key/value/tail) and
    // an invalid-typed top-level status are uncertain in either order.
    const lateTruncated = '{"noise":0,"status":';
    const lateTail = '{"noise":0,"status":"ran","outcome":{';
    for (
      const stdout of [
        `${lateTruncated}\n${healthy}`,
        `${healthy}\n${lateTruncated}`,
        `${lateTail}\n${healthy}`,
        `${healthy}\n${lateTail}`,
        `{"noise":0,"status":false}\n${healthy}`,
        `${healthy}\n{"noise":0,"status":false}`,
        `{"noise":0,"status":null}\n${healthy}`,
        `${healthy}\n{"noise":0,"status":null}`,
        `{"noise":0,"status":42}\n${healthy}`,
        `${healthy}\n{"noise":0,"status":42}`,
        `{"noise":0,"sta\n${healthy}`,
        `${healthy}\n{"noise":0,"sta`,
        `{"status\n${healthy}`,
        `${healthy}\n{"status`,
      ]
    ) {
      rig.process.child = exited(stdout, 0);
      const result = await launch(rig);
      assert.equal(result.status, "unavailable", stdout);
      assert.equal(result.terminal, null, stdout);
    }

    // Legitimate preflight records, nested status objects and plain log noise
    // carry no top-level status and must not disturb the one valid record.
    const preflight =
      '{"kind":"sentinel_startup_preflight","stage":"resolve_codex","codexExecutable":"/usr/bin/codex"}';
    const nested =
      '{"kind":"sentinel_startup_preflight","detail":{"status":"ran"}}';
    rig.process.child = exited(
      `${preflight}\n${nested}\nordinary log noise\n${healthy}\n{"kind":"sentinel_startup_preflight","pass":true}\n`,
      0,
    );
    const result = await launch(rig);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal?.outcome, "healthy");
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: unsettled, truncated, spawn-failed or thrown child results are unavailable", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    for (
      const run of [
        exited(healthy, 0, { settled: false }),
        exited(healthy, 0, { truncated: true }),
        exited("", 0, { outcome: "timed_out", exitCode: null, settled: false }),
        exited("", 0, { outcome: "spawn_failed", exitCode: null }),
      ]
    ) {
      rig.process.child = run;
      const result = await launch(rig);
      assert.equal(result.status, "unavailable", JSON.stringify(run));
      assert.equal(result.terminal, null);
    }
    rig.process.throwOnChild = true;
    const thrown = await launch(rig);
    assert.equal(thrown.status, "unavailable");
    assert.equal(thrown.terminal, null);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a settled timeout is an objective failure and a backward clock is unavailable", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);

    // The owned group provably stopped after the deadline: an objective failed
    // invocation, so a failed terminal is emitted with no invented metadata.
    rig.process.child = exited("", 0, {
      outcome: "timed_out",
      exitCode: null,
      settled: true,
    });
    let result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.outcome, "failed");
    assert.equal(result.terminal?.startupReady, false);
    assert.equal(result.terminal?.baseSha, null);
    assert.equal(result.terminal?.settled, true);

    // A valid child record beside the settled timeout keeps its own observed
    // startup flag and valid base instead of derived values.
    rig.process.child = exited(
      childLine(rig.execution, {
        outcome: { status: "source_error", detail: "source unavailable" },
      }),
      0,
      { outcome: "timed_out", exitCode: null, settled: true },
    );
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);

    // A malformed record beside a settled timeout stays unavailable.
    rig.process.child = exited(JSON.stringify({ status: "ran" }), 0, {
      outcome: "timed_out",
      exitCode: null,
      settled: true,
    });
    result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);

    // A backward clock never fabricates a finish instant or a terminal.
    rig.process.child = exited(childLine(rig.execution), 0);
    result = await launch(rig, { clock: new BackwardClock() });
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: the repair child learns when its one App token stops being certainly valid", async () => {
  // The workflow records the runner instant immediately BEFORE the repair
  // job's single App-token mint. GitHub expires that token one hour after its
  // creation, so the launcher forwards the instant 58 minutes after the bound:
  // before it the token is certainly valid, never a guess past its expiry.
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const mintedNotBefore = T0 - 3 * 60_000;
    const minted = {
      ...rig.env,
      SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN,
      SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE: String(mintedNotBefore),
    };
    rig.process.child = exited(childLine(rig.execution));
    const bounded = await launch(rig, { env: minted });
    assert.equal(bounded.status, "healthy", JSON.stringify(bounded));
    let child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.equal(
      child.env.SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER,
      String(mintedNotBefore + 58 * 60_000),
    );
    assert.equal(
      "SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE" in child.env,
      false,
      "only the derived bound crosses, never the raw workflow value",
    );
    assert.deepEqual(
      Object.keys(child.env).sort(),
      [
        ...requiredChildEnvKeys(),
        "SENTINEL_SUPERVISOR_TOKEN",
        "SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER",
      ].sort(),
    );

    // Without an App token every write uses the job-lifetime native token:
    // there is no one-hour credential to bound, so no window crosses.
    const nativeOnly: Record<string, string> = { ...minted };
    delete nativeOnly.SENTINEL_SUPERVISOR_TOKEN;
    rig.process.child = exited(childLine(rig.execution));
    const native = await launch(rig, { env: nativeOnly });
    assert.equal(native.status, "healthy", JSON.stringify(native));
    child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.deepEqual(Object.keys(child.env).sort(), requiredChildEnvKeys());

    // A blank bound is an absent one: the legacy child environment exactly.
    rig.process.child = exited(childLine(rig.execution));
    const blank = await launch(rig, {
      env: { ...minted, SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE: "" },
    });
    assert.equal(blank.status, "healthy", JSON.stringify(blank));
    child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.equal("SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER" in child.env, false);

    // The bound and the launcher read the same runner wall clock seconds
    // apart: a small clock step between the two reads is not a refusal.
    rig.process.child = exited(childLine(rig.execution));
    const stepped = await launch(rig, {
      env: {
        ...minted,
        SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE: String(T0 + 60_000),
      },
    });
    assert.equal(stepped.status, "healthy", JSON.stringify(stepped));
    child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.equal(
      child.env.SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER,
      String(T0 + 60_000 + 58 * 60_000),
    );

    // A malformed bound, or one clearly after the launcher's own clock (a
    // lower bound on a mint that already happened cannot lie in the future),
    // refuses the run before any child exists instead of guessing a window.
    for (
      const malformed of [
        "soon",
        "1.5",
        "-1",
        "0",
        " 1",
        "1e12",
        "9".repeat(17),
        String(T0 + 60_001),
      ]
    ) {
      const spawned = rig.process.childCalls().length;
      const refused = await launch(rig, {
        env: {
          ...minted,
          SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE: malformed,
        },
      });
      assert.equal(refused.status, "unavailable", malformed);
      assert.equal(refused.terminal, null, malformed);
      assert.equal(rig.process.childCalls().length, spawned, malformed);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: only repair and planner read or forward App mint evidence", async () => {
  const workflow = await Deno.readTextFile(
    `${ROOT}/.github/workflows/supervisor.yml`,
  );
  /** The exact `--allow-env` names one job's runtime step grants. */
  const grantedFor = (job: string, step: string): Set<string> => {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.ok(start >= 0, job);
    const at = workflow.indexOf(`- name: ${step}\n`, start);
    assert.ok(at > start, step);
    const grant = /--allow-env=(\S+)/.exec(workflow.slice(at));
    assert.ok(grant !== null, step);
    return new Set(grant[1].split(","));
  };
  const steps = {
    repair: "Run selected Sentinel runtime",
    matrix_plan: "Plan isolated issue matrix",
    matrix_cell: "Run isolated issue cell",
  } as const;
  for (const job of ["repair", "matrix_plan", "matrix_cell"] as const) {
    // A name the step does not grant would refuse the whole launch, so the
    // launcher may ask only for what that exact step grants.
    const granted = grantedFor(job, steps[job]);
    const asked: string[] = [];
    const scoped = readJobScopedLauncherEnv(job, (name) => {
      asked.push(name);
      return `value-of-${name}`;
    });
    for (const name of asked) {
      assert.ok(granted.has(name), `${job} grants ${name}`);
    }
    assert.equal(
      asked.includes("SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE"),
      job !== "matrix_cell",
      `${job} reads the mint bound only in repair/planner`,
    );
    assert.deepEqual(Object.keys(scoped).sort(), [...asked].sort());

    assert.equal(
      asked.includes("SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT"),
      job !== "matrix_cell",
    );
    // Cells never receive takeover metadata, even if handed a forged grant.
    const child = buildChildEnvironment(
      {
        PATH: "/usr/bin:/bin",
        GITHUB_TOKEN: "test-native-token",
        UOS_AI_TOKEN: "test-model-token",
        SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN,
        SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE: String(T0 - 60_000),
        SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: "fixture-inert-mint-grant",
        GITHUB_OUTPUT: "/fixture/github-output",
      },
      { runId: RUN_ID, runAttempt: 1, launcherSha: OTHER_REVISION, job },
      { home: "/fixture/home", tmp: "/fixture/tmp", denoDir: "/fixture/deno" },
      T0,
    );
    assert.equal(
      "SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER" in child,
      job !== "matrix_cell",
      job,
    );
    assert.equal(
      "SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT" in child,
      job !== "matrix_cell",
      job,
    );
    assert.equal(child.SENTINEL_SUPERVISOR_TOKEN, APP_TOKEN, job);
  }
});

Deno.test("hosted runtime: optional mint metadata requires its App/window and stays bounded", () => {
  const base = {
    PATH: "/usr/bin:/bin",
    GITHUB_TOKEN: "fixture-native",
    UOS_AI_TOKEN: "fixture-model",
    SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN,
    SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE: String(T0),
    SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: "fixture-inert-grant",
    GITHUB_OUTPUT: "/fixture/output",
  };
  for (const job of ["repair", "matrix_plan"] as const) {
    const identity = {
      runId: RUN_ID,
      runAttempt: 1,
      launcherSha: OTHER_REVISION,
      job,
    };
    const dirs = {
      home: "/fixture/home",
      tmp: "/fixture/tmp",
      denoDir: "/fixture/deno",
    };
    for (
      const patch of [
        { SENTINEL_SUPERVISOR_TOKEN: "" },
        { SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE: "" },
        { SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: "" },
        { SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: "x".repeat(16_385) },
        { SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: "€".repeat(6000) },
      ]
    ) {
      const child = buildChildEnvironment(
        { ...base, ...patch },
        identity,
        dirs,
        T0,
      );
      assert.equal("SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT" in child, false, job);
      assert.equal(child.GITHUB_TOKEN, base.GITHUB_TOKEN);
    }
    assert.throws(
      () =>
        buildChildEnvironment(
          { ...base, SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE: "invalid" },
          identity,
          dirs,
          T0,
        ),
      /hosted runtime launcher credentials are unavailable/,
    );
  }
});
