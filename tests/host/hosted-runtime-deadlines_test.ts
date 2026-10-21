/** Hosted hosted-runtime-deadlines_test responsibility. */
import assert from "node:assert/strict";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  ACTIONS_UOS_BASE_URL,
  childRunDeadlineV1,
  runActionsRepairHost,
  runActionsTargetCycles,
} from "../../src/host/actions.ts";
import {
  HOSTED_RUNTIME_CHILD_ENTRYPOINT,
  HOSTED_RUNTIME_DEADLINE_MS,
} from "../../src/host/hosted-runtime.ts";
import {
  createLocalRepositoryConfig,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";
import { OPERATION_MARGIN_MS } from "../../src/repair/loop-bounds.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { makeRemoteCtx, T0, testGitEnv } from "../state/helpers.ts";
import {
  childLine,
  exited,
  FakeClock,
  FIXED_LAUNCHER,
  hostedEnv,
  launch,
  makeCheckout,
  makeRig,
  pathExists,
  ROOT,
  RUN_ATTEMPT,
  RUN_ID,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

Deno.test("hosted runtime: source preparation is charged against the one absolute child deadline", async () => {
  // The launcher's own bounded wait over the child process stays 112 minutes,
  // measured from the instant it spawns the child. It is not the child's
  // deadline: the child anchors its own 110-minute budget before its setup.
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(childLine(rig.execution));
    const launched = await launch(rig);
    assert.equal(launched.status, "healthy", JSON.stringify(launched));
    assert.equal(launched.terminal?.startedAt, T0);
    const launchedChild = rig.process.childCalls()[0];
    assert.ok(launchedChild !== undefined);
    assert.equal(launchedChild.maxDurationMs, HOSTED_RUNTIME_DEADLINE_MS);
  } finally {
    await rig.cleanup();
  }

  // ONE absolute child deadline, derived exactly as production derives it:
  // the origin plus the unchanged 110-minute child budget. The test adds no
  // separate deadline arithmetic of its own.
  const deadline = childRunDeadlineV1(T0);

  const self = createLocalRepositoryConfig();
  const foreign: RepositoryConfigV1 = {
    ...self,
    repository: { ...self.repository, name: "foreign-target" },
  };
  const third: RepositoryConfigV1 = {
    ...self,
    repository: { ...self.repository, name: "third-target" },
  };
  const slugOf = (config: RepositoryConfigV1): string =>
    `${config.repository.owner}/${config.repository.name}`;
  const capability = {} as never;

  // Slow setup: the foreign target's own source preparation and base refresh
  // consume the remaining clock time and cross the absolute deadline.
  const clock = new FakeClock(T0);
  const prepared: string[] = [];
  const composed: string[] = [];
  const cycles: string[] = [];
  const selfOutcome = { status: "idle", detail: "self fixture" } as const;
  const foreignOutcome = {
    status: "margin",
    detail: "hosted repair run deadline reached",
  } as const;
  const result = await runActionsTargetCycles({
    clock,
    state: capability,
    configs: [self, foreign, third],
    controllerSha: FIXED_LAUNCHER,
    githubCooldown: capability,
    incidents: unavailableIncidents,
    replay: unavailableReplay,
    model: capability,
    budget: capability,
    deadline,
    stepLimit: 16,
    modelStartsEnabled: false,
    composeGithub: (config) => {
      composed.push(slugOf(config));
      return capability;
    },
    prepareTarget: (config) => {
      const slug = slugOf(config);
      prepared.push(slug);
      // The self mirror is prepared before the loop; a foreign target's own
      // mirror seed and base refresh consume clock time here.
      if (slug !== "Ubiquity-Sentinel/sentinel") clock.advance(6 * 60_000);
      return Promise.resolve();
    },
    runCycle: (deps, options) => {
      const slug = slugOf(deps.configs[0]!);
      cycles.push(slug);
      assert.equal(options.deadline, deadline);
      if (slug === "Ubiquity-Sentinel/sentinel") {
        // The self cycle consumes the budget up to the operation margin
        // before the ONE absolute deadline, the latest instant a later
        // target's preparation still begins.
        clock.advance(deadline - clock.now() - OPERATION_MARGIN_MS);
        return Promise.resolve(selfOutcome);
      }
      return Promise.resolve(foreignOutcome);
    },
  });

  assert.deepEqual(prepared, [
    "Ubiquity-Sentinel/sentinel",
    "ubiquity/foreign-target",
  ]);
  // The third target's cycle never starts either: the one absolute deadline
  // stops the run instead of spending remaining budget on doomed work.
  assert.deepEqual(composed, ["Ubiquity-Sentinel/sentinel"]);
  assert.deepEqual(cycles, ["Ubiquity-Sentinel/sentinel"]);
  assert.deepEqual(result.addressed, ["Ubiquity-Sentinel/sentinel"]);
  assert.deepEqual(result.skipped, [
    "ubiquity/foreign-target",
    "ubiquity/third-target",
  ]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.outcome, selfOutcome);

  // Control: a preparation that finishes inside the bound still starts, and
  // the cycle receives exactly the one absolute deadline.
  const controlClock = new FakeClock(T0);
  const controlComposed: string[] = [];
  const controlDeadlines: number[] = [];
  const control = await runActionsTargetCycles({
    clock: controlClock,
    state: capability,
    configs: [foreign],
    controllerSha: FIXED_LAUNCHER,
    githubCooldown: capability,
    incidents: unavailableIncidents,
    replay: unavailableReplay,
    model: capability,
    budget: capability,
    deadline,
    stepLimit: 16,
    modelStartsEnabled: false,
    composeGithub: (config) => {
      controlComposed.push(slugOf(config));
      return capability;
    },
    prepareTarget: () => {
      controlClock.advance(5 * 60_000);
      return Promise.resolve();
    },
    runCycle: (_deps, options) => {
      controlDeadlines.push(options.deadline);
      return Promise.resolve(foreignOutcome);
    },
  });
  assert.deepEqual(controlComposed, ["ubiquity/foreign-target"]);
  assert.deepEqual(controlDeadlines, [deadline]);
  assert.deepEqual(control.addressed, ["ubiquity/foreign-target"]);
  assert.deepEqual(control.skipped, []);
  assert.deepEqual(control.outcome, foreignOutcome);
});

Deno.test("hosted runtime: the real child announces its run window before its own setup begins, inside the launcher bound from the same spawn instant", async () => {
  // The child's origin is the earliest instant it can observe for ITSELF, and
  // the ONE absolute deadline is derived from it before any identity, state,
  // source or target preparation. Proved on the actual entrypoint: its first
  // setup step is made to fail, so a run window in that run's stdout can only
  // have been established before setup began.
  const root = await Deno.makeTempDir({
    prefix: "sentinel-hosted-runtime-",
    dir: ROOT,
  });
  try {
    // A disposable cwd keeps the child's private state directory out of the
    // checkout. The child runs the real entrypoint file by absolute path, so
    // its module graph is the real runtime source and its cwd is disposable.
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    const marker = `${root}/git-ran`;
    await Deno.writeTextFile(
      `${bin}/git`,
      `#!/bin/sh\n: > ${marker}\nexit 1\n`,
    );
    await Deno.chmod(`${bin}/git`, 0o755);
    // Executable resolution only stats PATH entries; this file never runs.
    await Deno.writeTextFile(`${bin}/codex`, "");

    // The launcher arms its own bound at the instant it spawns the child, so
    // this is the origin the launcher measures from.
    const spawnedAt = Date.now();
    const child = await new Deno.Command(Deno.execPath(), {
      // The launcher's fixed child invocation is `run -A <entrypoint>`; the
      // child environment below is complete and controlled by this test.
      args: ["run", "-A", `${ROOT}/${HOSTED_RUNTIME_CHILD_ENTRYPOINT}`],
      cwd: root,
      clearEnv: true,
      env: {
        ...hostedEnv(FIXED_LAUNCHER),
        PATH: bin,
        HOME: root,
        TMPDIR: root,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    const lines = stdout.split("\n").map((line) => line.trim()).filter((line) =>
      line.length > 0
    );

    // Setup began at the controller-revision read and failed there, so the
    // child never reached any later preparation.
    assert.equal(await pathExists(marker), true, stderr);
    assert.notEqual(child.code, 0, stderr);
    assert.ok(
      stderr.includes("could not read an exact controller commit"),
      stderr,
    );

    // The announced window therefore proves the origin and its ONE absolute
    // deadline were established before that setup, and the arithmetic is the
    // production derivation, not a second copy of it.
    const windowLine = lines.find((line) =>
      line.includes('"sentinel_run_window"')
    );
    assert.ok(windowLine !== undefined, `stdout: ${stdout}\nstderr: ${stderr}`);
    const parsed = JSON.parse(windowLine) as Record<string, unknown>;
    assert.equal(parsed.kind, "sentinel_run_window");
    assert.equal(typeof parsed.originAt, "number");
    assert.equal(typeof parsed.deadlineAt, "number");
    assert.equal(
      parsed.deadlineAt,
      childRunDeadlineV1(parsed.originAt as number),
    );
    // It is emitted before the first credential read, so it is the child's
    // first advisory line.
    assert.equal(lines[0], windowLine);

    // Measured from the launcher's own origin (the spawn instant), not by
    // comparing the two constants: the child cannot anchor before it was
    // spawned, and the real drain cushion before the launcher kills the child
    // is the nominal two minutes less only the child's own startup. Setup was
    // charged to the child's budget, so a slow setup cannot erode it.
    const originAt = parsed.originAt as number;
    const deadlineAt = parsed.deadlineAt as number;
    const nominalCushion = HOSTED_RUNTIME_DEADLINE_MS - childRunDeadlineV1(0);
    assert.equal(nominalCushion, 2 * 60_000);
    assert.ok(originAt >= spawnedAt, `${originAt} < ${spawnedAt}`);
    const cushion = spawnedAt + HOSTED_RUNTIME_DEADLINE_MS - deadlineAt;
    assert.equal(cushion, nominalCushion - (originAt - spawnedAt));
    assert.ok(
      cushion >= 60_000,
      `drain cushion ${cushion} ms after ${originAt - spawnedAt} ms startup`,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("hosted runtime: the real host hands its origin-anchored deadline to the production target-cycle call", async () => {
  // The defect under regression is a deadline computed LATE: a host that
  // recomputes `childRunDeadlineV1(clock.now())` after its own setup hands the
  // cycles a deadline shifted by however long setup took. This scenario runs
  // the REAL `runActionsRepairHost` setup to completion over one local fixture
  // checkout and one local bare state remote, with the injected clock advancing
  // during that setup, then observes the deadline production actually supplies
  // to its target-cycle call. No live GitHub, model or network request is made.
  const root = await Deno.makeTempDir({
    prefix: "sentinel-host-wiring-",
    dir: ROOT,
  });
  const env = testGitEnv(`${root}/git-home`);
  await Deno.mkdir(`${root}/git-home`, { recursive: true });
  try {
    // The real checkout the host reads its controller revision and its
    // committed target setting from, plus the executable-resolution stub.
    const checkoutDir = `${root}/checkout`;
    const checkoutSha = await makeCheckout(checkoutDir, env, {
      "sentinel.targets.json": JSON.stringify(["Ubiquity-Sentinel/sentinel"]),
      ".gitignore": ".sentinel-actions-state/\n",
    });
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(`${bin}/codex`, "");

    // One disposable bare remote holds BOTH durable state refs. Its release
    // ref carries the exact saved execution pointer the host must read before
    // it may run.
    const remote = await makeRemoteCtx(root, env);
    await Deno.mkdir(`${root}/release-scratch`, { recursive: true });
    const release = createReleaseStateStore({
      scratchDir: `${root}/release-scratch`,
      remoteUrl: remote.remoteUrl,
    });
    const execution = parseHostedExecutionIntentV1({
      id: `${RUN_ID}:${RUN_ATTEMPT}:repair`,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      launcherSha: checkoutSha,
      purpose: "ordinary",
      revision: checkoutSha,
      generation: 1,
      releaseId: null,
      createdAt: T0,
    });
    const releaseSnapshot = parseReleaseStateSnapshotV1({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      releases: [],
      hostedRuntimes: [{
        version: "v1",
        kind: "hosted_runtime",
        id: HOSTED_RUNTIME_ID,
        activeRevision: checkoutSha,
        generation: 1,
        lastHealthyProof: null,
        lastExecutionProof: null,
        nextOrdinaryAt: T0,
        execution,
        createdAt: T0,
        updatedAt: T0,
      }],
      hostedReleases: [],
      githubCooldowns: [],
    });
    const seeded = await release.writeRelease(releaseSnapshot, null);
    assert.ok(
      seeded.ok && seeded.value.status === "applied",
      JSON.stringify(seeded),
    );

    // The injected clock advances ONLY at fake external setup boundaries, so a
    // deadline recomputed after setup is strictly later than the run origin.
    const clock = new FakeClock(T0);
    const setupSpentMs = 7 * 60_000;
    const setup: string[] = [];
    const captured: Parameters<typeof runActionsTargetCycles>[0][] = [];
    const capturedAt: number[] = [];
    let queueReads = 0;
    let unexpectedHttp = 0;
    let observedRoute = "";
    const fakeOutcome = { status: "idle", detail: "fixture" } as const;
    const capability = {} as never;

    const stdoutLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((value) => String(value)).join(" "));
    };
    let result: Awaited<ReturnType<typeof runActionsRepairHost>>;
    try {
      result = await runActionsRepairHost({
        clock,
        env: {
          ...hostedEnv(checkoutSha),
          PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
        },
        workDir: checkoutDir,
        stateRemoteUrl: remote.remoteUrl,
        http: (request) => {
          const url = new URL(request.url);
          if (
            request.method === "GET" &&
            url.origin === "https://api.github.com" &&
            url.pathname ===
              "/repos/ubiquity/ai.ubq.fi/rules/branches/development"
          ) {
            queueReads++;
            return Promise.resolve({
              status: 200,
              headers: new Headers(),
              bodyText: "[]",
            });
          }
          unexpectedHttp++;
          throw new Error("fixture forbids other HTTP");
        },
        refreshSelf: () => {
          setup.push("refresh-self");
          // The self mirror refresh is real setup work; here it consumes
          // simulated run time exactly like an external fetch would.
          clock.advance(setupSpentMs);
          return Promise.resolve(checkoutSha);
        },
        resolveDefaultBranch: () => Promise.resolve("development"),
        preflight: (route) => {
          setup.push("preflight");
          observedRoute = `${route.provider}:${route.model}:${route.baseUrl}`;
          return Promise.resolve();
        },
        runTargetCycles: (input) => {
          setup.push("target-cycles");
          captured.push(input);
          capturedAt.push(clock.now());
          // The production call site has now supplied its deadline. Delegate
          // the REAL multi-target loop with only the per-target cycle faked,
          // so production code both states and consumes that exact deadline.
          return runActionsTargetCycles({
            ...input,
            composeGithub: () => capability,
            runCycle: () => Promise.resolve(fakeOutcome),
          });
        },
      });
    } finally {
      console.log = originalLog;
    }

    // The host ran its real setup and reached the production call.
    assert.deepEqual(setup, ["refresh-self", "preflight", "target-cycles"]);
    assert.equal(queueReads, 1);
    assert.equal(unexpectedHttp, 0);
    assert.equal(captured.length, 1);
    const supplied = captured[0]!.deadline;
    const atCall = capturedAt[0]!;
    // Setup advanced the clock, so a deadline recomputed at the call site
    // (`childRunDeadlineV1(clock.now())`) is strictly different from the one
    // the host captured before setup. This assertion is the regression: it
    // fails when ONLY that call-site expression is restored to the late form.
    assert.equal(atCall, T0 + setupSpentMs);
    assert.notEqual(
      childRunDeadlineV1(atCall),
      supplied,
      "the supplied deadline must not be a post-setup recomputation",
    );
    // The ONE absolute deadline is the value captured at the run origin.
    assert.equal(supplied, childRunDeadlineV1(T0));
    // The early advisory and the cycle argument are the same production value.
    const windowLine = stdoutLines.find((line) =>
      line.includes('"sentinel_run_window"')
    );
    assert.ok(windowLine !== undefined, `stdout: ${stdoutLines.join("\n")}`);
    const window = JSON.parse(windowLine) as Record<string, unknown>;
    assert.equal(window.kind, "sentinel_run_window");
    assert.equal(window.originAt, T0);
    assert.equal(window.deadlineAt, supplied);

    // The real production call settled normally on the fixture, with the
    // untouched native identity, admission and model-route defaults.
    assert.equal(result.status, "ran");
    assert.equal(result.controllerSha, checkoutSha);
    assert.equal(result.baseSha, checkoutSha);
    assert.equal(result.execution.id, `${RUN_ID}:${RUN_ATTEMPT}:repair`);
    assert.equal(result.startupReady, true);
    assert.deepEqual(result.outcome, fakeOutcome);
    assert.deepEqual(result.ciApproval, {
      approved: 0,
      pending: 0,
      unavailable: 0,
    });
    assert.equal(observedRoute, `uos:gpt-reserve:${ACTIONS_UOS_BASE_URL}`);
    // The setup really ran against the fixture: its self source mirror exists.
    assert.equal(
      await pathExists(`${checkoutDir}/.sentinel-actions-state/source/.git`),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
