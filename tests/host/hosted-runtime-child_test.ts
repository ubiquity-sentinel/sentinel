/** Hosted hosted-runtime-child_test responsibility. */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portError } from "../../src/contracts/ports.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type { ReplayCommandResultV1 } from "../../src/replay/runtime.ts";
import { ACTIONS_UOS_BASE_URL } from "../../src/host/actions.ts";
import {
  emitHostedRuntimeCliResult,
  HOSTED_RUNTIME_CHILD_ENTRYPOINT,
  HOSTED_RUNTIME_STATIC_IDENTITY,
  HOSTED_RUNTIME_WORKFLOW_REF,
} from "../../src/host/hosted-runtime.ts";
import {
  localCheckoutKey,
  writeLocalModelResult,
} from "../../src/host/local.ts";
import { T0 } from "../state/helpers.ts";
import {
  APP_TOKEN,
  FIXED_LAUNCHER,
  hostedEnv,
  launch,
  makeRig,
  OBSERVED_BASE,
  pathExists,
  ROOT,
  seedRelease,
} from "./hosted-runtime-fixture.ts";
import {
  forgedFixtureScript,
  HOSTED_FIXTURE_CHANGED_PATH,
  HOSTED_FIXTURE_EVIDENCE_REF,
  HOSTED_FIXTURE_FAILURE_DETAIL,
  HOSTED_FIXTURE_INVOCATION,
  HOSTED_FIXTURE_ISSUE_BODY,
  HOSTED_FIXTURE_PROVIDER,
  HOSTED_FIXTURE_RAW_ERROR,
  hostedFixtureReceipt,
  hostedFixtureRequest,
  validFixtureScript,
} from "./hosted-runtime-child-fixture.ts";

Deno.test("hosted runtime: actual owned host child keeps its App token but receives no unverified mint evidence", async () => {
  const grant = "fixture-inert-mint-grant";
  const rig = await makeRig({
    runtimeFiles: {
      "src/host/actions.ts":
        `if (Deno.env.get("SENTINEL_SUPERVISOR_TOKEN") !== ${
          JSON.stringify(APP_TOKEN)
        } || Deno.env.get("SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT") !== undefined || Deno.env.get("SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER") !== ${
          JSON.stringify(String(T0 + 58 * 60_000))
        } || Deno.env.get("SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE") !== undefined) throw new Error("fixture handoff refused");\n` +
        validFixtureScript(""),
      ".gitignore": ".sentinel/\n",
    },
  });
  try {
    await seedRelease(rig);
    rig.process.realChild = true;
    const result = await launch(rig, {
      env: {
        ...rig.env,
        SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN,
        SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: grant,
        SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE: String(T0),
      },
    });
    assert.equal(result.status, "healthy");
    assert.equal(rig.process.childCalls().length, 1);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a real owned-group child cannot forge the wrapper terminal", async () => {
  const forged = await makeRig({
    runtimeFiles: {
      "src/host/actions.ts": forgedFixtureScript(),
      ".gitignore": ".sentinel/\n",
    },
  });
  try {
    await seedRelease(forged);
    forged.process.realChild = true;
    const result = await launch(forged);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(forged.process.childCalls().length, 1);
    assert.equal(
      await pathExists(`${forged.runtimeDir}/child-ran.txt`),
      true,
      "the real fixture child must have executed",
    );
  } finally {
    await forged.cleanup();
  }

  const fixtureRequest = hostedFixtureRequest();
  const fixtureTaskKey = await localCheckoutKey(fixtureRequest.taskId);
  const privateRoot = await Deno.makeTempDir({
    prefix: "sentinel-hosted-model-results-",
    dir: ROOT,
  });
  let diagnosticStdout = "";
  try {
    const emitted: string[] = [];
    const originalLog = console.log;
    let firstPath = "";
    let secondPath = "";
    try {
      console.log = ((...args: unknown[]) => {
        emitted.push(
          args.map((arg) => typeof arg === "string" ? arg : String(arg)).join(
            " ",
          ),
        );
      }) as typeof console.log;
      firstPath = await writeLocalModelResult(
        privateRoot,
        fixtureRequest,
        hostedFixtureReceipt(),
        T0,
      );
      secondPath = await writeLocalModelResult(
        privateRoot,
        fixtureRequest,
        portError("unavailable", HOSTED_FIXTURE_RAW_ERROR),
        T0,
      );
    } finally {
      console.log = originalLog;
    }
    assert.equal(emitted.length, 2, "one advisory per written result");
    diagnosticStdout = emitted.join("\n");

    // Both private files are real 0600 projections inside 0700 directories and
    // never retain the raw error.
    for (const path of [firstPath, secondPath]) {
      assert.equal((await Deno.stat(path)).mode! & 0o777, 0o600);
      assert.equal(
        (await Deno.stat(path.slice(0, path.lastIndexOf("/")))).mode! & 0o777,
        0o700,
      );
      const privateText = await Deno.readTextFile(path);
      const privateRecord = JSON.parse(privateText) as Record<string, unknown>;
      assert.equal(privateRecord.version, "v1");
      assert.equal(privateRecord.kind, "local_model_result");
      assert.equal(privateRecord.taskId, fixtureRequest.taskId);
      assert.equal(privateText.includes(HOSTED_FIXTURE_RAW_ERROR), false);
    }
    const firstPrivate = await Deno.readTextFile(firstPath);
    assert.equal(
      firstPrivate.includes(HOSTED_FIXTURE_PROVIDER),
      true,
      "the private projection keeps the acknowledged provider",
    );
  } finally {
    await Deno.remove(privateRoot, { recursive: true }).catch(() => {});
  }

  const valid = await makeRig({
    runtimeFiles: {
      "src/host/actions.ts": validFixtureScript(diagnosticStdout),
      ".gitignore": ".sentinel/\n",
    },
  });
  try {
    await seedRelease(valid);
    valid.process.realChild = true;
    const result = await launch(valid);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    const terminal = result.terminal;
    assert.ok(terminal !== null);
    if (terminal === null) throw new Error("unreachable");
    assert.equal(terminal.outcome, "healthy");
    assert.equal(terminal.settled, true);
    assert.equal(terminal.baseSha, OBSERVED_BASE);
    assert.equal(
      canonicalStringify(terminal.execution),
      canonicalStringify(valid.execution),
    );
    // The real fixture child stdout crosses the actual owned-group border; the
    // two advisories written by the actual local host are reconstructed and
    // wrapper-stamped here.
    assert.equal(result.diagnostics.length, 2);
    const timeoutAdvisory = result.diagnostics[0];
    const portAdvisory = result.diagnostics[1];
    assert.ok(timeoutAdvisory !== undefined && portAdvisory !== undefined);
    if (timeoutAdvisory === undefined || portAdvisory === undefined) {
      throw new Error("unreachable");
    }
    for (const advisory of result.diagnostics) {
      assert.equal(advisory.kind, "hosted_model_diagnostic");
      assert.equal(advisory.advisory, true);
      assert.equal(
        canonicalStringify(advisory.execution),
        canonicalStringify(valid.execution),
      );
      assert.equal(advisory.diagnostic.taskKey, fixtureTaskKey);
      assert.equal(advisory.diagnostic.base, OBSERVED_BASE);
      assert.equal(advisory.diagnostic.observedAt, T0);
    }
    assert.deepEqual(timeoutAdvisory.diagnostic, {
      version: "v1",
      kind: "sentinel_model_diagnostic",
      taskKey: fixtureTaskKey,
      base: OBSERVED_BASE,
      observedAt: T0,
      outcome: "failed",
      reason: "host_timeout",
      errorKind: null,
      terminalOrigin: "host-timeout",
      observedTerminalStatus: null,
      durationMs: 4_321,
      outputChars: 99,
      candidatePresent: false,
      reasonCode: null,
    });
    assert.deepEqual(portAdvisory.diagnostic, {
      version: "v1",
      kind: "sentinel_model_diagnostic",
      taskKey: fixtureTaskKey,
      base: OBSERVED_BASE,
      observedAt: T0,
      outcome: "port_error",
      reason: "runtime_error",
      errorKind: "unavailable",
      terminalOrigin: null,
      observedTerminalStatus: null,
      durationMs: null,
      outputChars: null,
      candidatePresent: false,
      reasonCode: null,
    });
    const serialized = JSON.stringify(result.diagnostics);
    for (
      const marker of [
        HOSTED_FIXTURE_ISSUE_BODY,
        HOSTED_FIXTURE_EVIDENCE_REF,
        HOSTED_FIXTURE_RAW_ERROR,
        HOSTED_FIXTURE_CHANGED_PATH,
        HOSTED_FIXTURE_INVOCATION,
      ]
    ) {
      assert.equal(serialized.includes(marker), false, marker);
    }
    assert.equal(
      await pathExists(`${valid.runtimeDir}/child-ran.txt`),
      true,
      "the real fixture child must have executed",
    );
    // Synthetic fixture evidence for the existing CI job log only.
    for (const advisory of result.diagnostics) {
      console.log(`SENTINEL_DIAGNOSTIC_FIXTURE ${JSON.stringify(advisory)}`);
    }
  } finally {
    await valid.cleanup();
  }
});

Deno.test("hosted runtime: a settled state_error child surfaces its bounded failure detail", async () => {
  const mergeEvent = {
    version: "v1",
    kind: "sentinel_merge_event",
    event: "merge_port_error",
    prNumber: 1004,
    errorKind: "rate_limited",
    detailCode: "candidate_binding",
  } as const;
  const rig = await makeRig({
    runtimeFiles: {
      "src/host/actions.ts": validFixtureScript(JSON.stringify(mergeEvent), {
        status: "state_error",
        detail: HOSTED_FIXTURE_FAILURE_DETAIL,
      }),
      ".gitignore": ".sentinel/\n",
    },
  });
  try {
    await seedRelease(rig);
    rig.process.realChild = true;
    const result = await launch(rig);
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.terminal?.outcome, "failed");
    assert.deepEqual(result.childFailure, {
      version: "v1",
      kind: "hosted_runtime_child_failure",
      status: "state_error",
      detail: HOSTED_FIXTURE_FAILURE_DETAIL,
    });
    assert.deepEqual(result.mergeEvents, [{
      version: "v1",
      kind: "hosted_merge_event",
      advisory: true,
      execution: rig.execution,
      merge: mergeEvent,
    }]);
    // The emitted advisory carries the child detail in the workflow log while
    // the exit stays red and the terminal stays the only settlement proof.
    const logged: string[] = [];
    const failed: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    let exitCode = -1;
    try {
      console.log = ((...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(" "));
      }) as typeof console.log;
      console.error = ((...args: unknown[]) => {
        failed.push(args.map((arg) => String(arg)).join(" "));
      }) as typeof console.error;
      exitCode = emitHostedRuntimeCliResult(result);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.equal(exitCode, 1);
    assert.equal(failed.length, 1);
    const advisory = logged
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.kind === "hosted_runtime_child_failure");
    assert.ok(advisory !== undefined, logged.join("\n"));
    assert.equal(advisory?.status, "state_error");
    assert.equal(advisory?.detail, HOSTED_FIXTURE_FAILURE_DETAIL);
    assert.equal(
      logged.some((line) => line.includes("hosted_runtime_terminal")),
      true,
    );
    const mergeAdvisory = logged
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.kind === "hosted_merge_event");
    assert.ok(mergeAdvisory !== undefined, logged.join("\n"));
    assert.deepEqual(mergeAdvisory?.merge, mergeEvent);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: the real repair entrypoint refuses a malformed identity under scoped env grants", async () => {
  const runtime = new DenoReplayRuntime(Deno.execPath());
  const result = await runtime.run({
    executable: Deno.execPath(),
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      `--allow-env=${
        [
          "HOME",
          "PATH",
          "NODE_V8_COVERAGE",
          "GITHUB_RUN_ID",
          "GITHUB_RUN_ATTEMPT",
          "GITHUB_REPOSITORY",
          "GITHUB_REF",
          "GITHUB_SHA",
          "GITHUB_WORKFLOW_SHA",
          "GITHUB_WORKFLOW_REF",
          "GITHUB_JOB",
        ].join(",")
      }`,
      HOSTED_RUNTIME_CHILD_ENTRYPOINT,
    ],
    cwd: ROOT,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: "/tmp",
      GITHUB_JOB: "prepare",
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REPOSITORY: "Ubiquity-Sentinel/sentinel",
      GITHUB_REF: "refs/heads/sentinel-supervisor",
      GITHUB_SHA: FIXED_LAUNCHER,
      GITHUB_WORKFLOW_SHA: FIXED_LAUNCHER,
      GITHUB_WORKFLOW_REF: HOSTED_RUNTIME_WORKFLOW_REF,
    },
    maxDurationMs: 120_000,
    maxOutputBytes: 256 * 1024,
  });
  const stderr = new TextDecoder().decode(result.stderr);
  assert.equal(result.settled, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(stderr.includes(HOSTED_RUNTIME_STATIC_IDENTITY), stderr);
  // Scoped env grants are sufficient: the failure is the static identity
  // refusal, not a permission error, and no GitHub/model request is made.
  assert.equal(stderr.includes("PermissionDenied"), false, stderr);
  assert.equal(stderr.includes("NotCapable"), false, stderr);
  assert.equal(result.truncated, false);
});

Deno.test("hosted runtime: actions environment allowlist", async () => {
  // The committed `repair:actions` task runs the REAL `src/host/actions.ts`
  // entrypoint under one NAMED environment allowlist (deno.json). A named
  // allowlist grants only the listed names and never an unrestricted
  // `Deno.env.toObject()`, so the entrypoint must resolve its route and review
  // configuration through named reads and cross the environment configuration
  // boundary instead of demanding a full environment dump.
  const declaredEnvAllowlist = [
    "HOME",
    "PATH",
    "GITHUB_TOKEN",
    "SENTINEL_SUPERVISOR_TOKEN",
    "SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER",
    "UOS_AI_TOKEN",
    "SENTINEL_MODEL_BASE_URL",
    "SENTINEL_MODEL_ID",
    "SENTINEL_MODEL_FALLBACK",
    "SENTINEL_DEEPSEEK_API_KEY",
    "SENTINEL_COOLDOWN_MODE",
    "SENTINEL_MERGE_QUEUE",
    "SENTINEL_APP_INSTALLATION_ID",
    "NODE_V8_COVERAGE",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_SHA",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_JOB",
    "SENTINEL_REVIEW_MODEL_ID",
  ].join(",");

  // The full valid hosted identity, with the credential keys present but
  // EMPTY, exactly as an absent workflow secret appears. The run must stop at
  // its own credential boundary, so no real Git fetch, model session or
  // GitHub write is reachable; the child also never receives `--allow-run` or
  // `--allow-net`, so even a regression that moved that boundary could not
  // touch the network.
  const identityEnv = {
    ...hostedEnv(FIXED_LAUNCHER),
    GITHUB_TOKEN: "",
    UOS_AI_TOKEN: "",
  };

  const cacheInfo = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(cacheInfo.success, new TextDecoder().decode(cacheInfo.stderr));
  const cachedDenoDir = JSON.parse(
    new TextDecoder().decode(cacheInfo.stdout),
  ).denoDir;
  assert.ok(typeof cachedDenoDir === "string" && cachedDenoDir.length > 0);

  /** Run the real entrypoint once through the owned-group child border. */
  const runEntrypoint = (env: Record<string, string>) =>
    new DenoReplayRuntime(Deno.execPath()).run({
      executable: Deno.execPath(),
      args: [
        "run",
        "--frozen",
        "--cached-only",
        "--allow-read",
        "--allow-write",
        `--allow-env=${declaredEnvAllowlist}`,
        HOSTED_RUNTIME_CHILD_ENTRYPOINT,
      ],
      cwd: ROOT,
      env: { ...env, DENO_DIR: cachedDenoDir },
      maxDurationMs: 120_000,
      maxOutputBytes: 256 * 1024,
    });

  /**
   * Assert one run crossed the environment configuration boundary and stopped
   * at its own credential boundary with no environment-capability denial
   * anywhere, then return its non-empty stdout lines.
   */
  const assertCrossedBoundary = (result: ReplayCommandResultV1): string[] => {
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    assert.equal(result.outcome, "exited", stderr);
    assert.equal(result.settled, true, stderr);
    assert.equal(result.truncated, false, stderr);
    assert.notEqual(result.exitCode, 0, stderr);
    for (
      const denial of [
        "NotCapable",
        "PermissionDenied",
        "Requires env access",
      ]
    ) {
      assert.equal(
        `${stdout}\n${stderr}`.includes(denial),
        false,
        `the declared named allowlist must be sufficient; found ${denial}\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    assert.ok(
      stderr.includes(
        "hosted repair host requires its configured credentials",
      ),
      "the run must cross the environment configuration boundary and stop " +
        `at its credential boundary\nchild: ${
          JSON.stringify({
            outcome: result.outcome,
            exitCode: result.exitCode,
            settled: result.settled,
          })
        }\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    const lines = stdout.split("\n").map((line) => line.trim()).filter((line) =>
      line.length > 0
    );
    assert.equal(
      lines[0]?.includes('"sentinel_run_window"'),
      true,
      `stdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    return lines;
  };

  /** Parse the one strict route/review advisory this run recorded. */
  const routeOf = (lines: readonly string[]): Record<string, unknown> => {
    const line = lines.find((candidate) =>
      candidate.includes('"sentinel_model_route"')
    );
    assert.ok(
      line !== undefined,
      `no model route recorded:\n${lines.join("\n")}`,
    );
    return JSON.parse(line) as Record<string, unknown>;
  };

  // 1. Without a route input the implementation uses the gateway primary and
  //    review selection remains owned by native mode.
  const plainRoute = routeOf(
    assertCrossedBoundary(await runEntrypoint({ ...identityEnv })),
  );
  assert.deepEqual(plainRoute, {
    kind: "sentinel_model_route",
    provider: "uos",
    model: "gpt-reserve",
    baseUrl: ACTIONS_UOS_BASE_URL,
    reviewMode: "native",
  });

  // 2. The explicit implementation fallback uses the same named allowlist;
  //    a legacy review-model selector cannot override native review mode.
  //    The fallback key is a synthetic marker, and the
  //    empty GitHub credential still stops the run before any budget, state or
  //    transport work.
  const fallbackRoute = routeOf(
    assertCrossedBoundary(
      await runEntrypoint({
        ...identityEnv,
        SENTINEL_MODEL_FALLBACK: "deepseek",
        SENTINEL_DEEPSEEK_API_KEY: "synthetic-marker-not-a-credential",
        SENTINEL_REVIEW_MODEL_ID: "codex-auto-review-canary",
      }),
    ),
  );
  assert.deepEqual(fallbackRoute, {
    kind: "sentinel_model_route",
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com/v1",
    reviewMode: "native",
  });
});
