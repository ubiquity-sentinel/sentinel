/**
 * Idle-cycle attribution (2026-11-15): the planner and the serial repair child
 * print advisory `sentinel_host_phase` and `sentinel_target_timing` lines
 * (closed phase names, committed slugs, integer milliseconds and counts), the
 * launcher re-emits them through `scanStepLines` for the repair AND planner
 * jobs, and they never read as a child status record.
 */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import {
  runActionsRepairHost,
  runActionsTargetCycles,
} from "../../src/host/actions.ts";
import { emitHostedRuntimeCliResult } from "../../src/host/hosted-runtime.ts";
import type { HostedRuntimeLauncherResultV1 } from "../../src/host/hosted-runtime.ts";
import { scanChildStatusRecords } from "../../src/host/hosted-runtime-status.ts";
import { matrixPlanCarrierOf } from "../../src/host/matrix-actions.ts";
import { runActionsMatrixAggregateCycles } from "../../src/host/matrix-aggregate.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-native-host.ts";
import { scanStepLines } from "../../src/repair/step-line.ts";
import {
  HOST_PHASE_KIND,
  logHostPhase,
  logTargetTiming,
  parseHostPhaseLine,
  parseTargetTimingLine,
  TARGET_TIMING_KIND,
} from "../../src/repair/timing-lines.ts";
import {
  FOREIGN_REPO,
  makeTargetHostRig,
  targetCycleInput,
  THIRD_REPO,
} from "./actions-target-fixture.ts";
import {
  exited,
  launch,
  makeRig,
  RUN_ATTEMPT,
  RUN_ID,
  seedRelease,
} from "./hosted-runtime-fixture.ts";
import { captureConsoleLog } from "./local-test-helpers.ts";
import { rig as actionsRig } from "./matrix-actions-fixtures.ts";

const COUNTS = {
  prepareMs: 4_210,
  premergeMs: 0,
  progressMs: 1_120,
  cycleMs: 2_305,
  advances: 1,
  finishMs: 3,
};

function lines(log: (sink: (line: string) => void) => void): string[] {
  const out: string[] = [];
  log((line) => out.push(line));
  return out;
}

function parsedOf(logged: readonly string[]): Record<string, unknown>[] {
  return logged.flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return typeof value === "object" && value !== null ? [value] : [];
    } catch {
      return [];
    }
  });
}

Deno.test("timing lines: only the exact closed shapes parse, scan and stay out of the status scan", () => {
  const phase = lines((sink) => logHostPhase("intake", 251_400.6, sink));
  const target = lines((sink) =>
    logTargetTiming("ubiquity/prospector-chrome-extension", COUNTS, sink)
  );
  assert.deepEqual(phase.map((line) => JSON.parse(line)), [{
    kind: HOST_PHASE_KIND,
    phase: "intake",
    elapsedMs: 251_401,
  }]);
  assert.deepEqual(JSON.parse(target[0]), {
    kind: TARGET_TIMING_KIND,
    repository: "ubiquity/prospector-chrome-extension",
    ...COUNTS,
  });
  const good = JSON.parse(target[0]);
  for (
    const forged of [
      { ...good, status: "idle" },
      { ...good, repository: "ubiquity/a b" },
      { ...good, repository: "issue body text" },
      { ...good, cycleMs: -1 },
      { ...good, cycleMs: 1.5 },
      { ...good, finishMs: 24 * 60 * 60_000 + 1 },
      { ...good, extra: 1 },
    ]
  ) assert.equal(parseTargetTimingLine(forged), null, JSON.stringify(forged));
  for (
    const forged of [
      { kind: HOST_PHASE_KIND, phase: "secret", elapsedMs: 1 },
      { kind: HOST_PHASE_KIND, phase: "plan", elapsedMs: 1, status: "x" },
      { kind: HOST_PHASE_KIND, phase: "plan" },
    ]
  ) assert.equal(parseHostPhaseLine(forged), null, JSON.stringify(forged));
  // A non-finite or negative measurement clamps instead of dropping the line.
  assert.deepEqual(
    lines((sink) => logHostPhase("plan", Number.NaN, sink)).map((line) =>
      JSON.parse(line).elapsedMs
    ),
    [0],
  );
  const stdout = [
    ...phase,
    JSON.stringify({ ...good, status: "ran" }),
    ...target,
  ].join("\n") + "\n";
  assert.deepEqual(scanStepLines(stdout), [JSON.parse(phase[0]), good]);
  assert.deepEqual(scanChildStatusRecords([...phase, ...target].join("\n")), {
    kind: "none",
  });
});

Deno.test("timing lines: the launcher re-emits the planner child's lines beside its unchanged carrier", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const carrier = matrixPlanCarrierOf({
      waveId: rig.execution.id,
      run: {
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        launcherSha: rig.identity.launcherSha,
      },
      controllerSha: rig.execution.revision,
      generation: rig.execution.generation,
      planDigest: "d".repeat(64),
      prepared: 0,
    });
    const phase = lines((sink) => logHostPhase("setup", 58_000, sink))[0];
    const target = lines((sink) =>
      logTargetTiming("ubiquity/ai.ubq.fi", COUNTS, sink)
    )[0];
    rig.process.child = exited(
      [phase, JSON.stringify(carrier), target].join("\n") + "\n",
    );
    const result = await launch(rig, {
      env: {
        ...rig.env,
        GITHUB_JOB: "matrix_plan",
        GITHUB_OUTPUT: "/tmp/native-output",
      },
    });
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.deepEqual(result.matrixCarrier, carrier, "carrier untouched");
    assert.deepEqual(result.stepLines, [JSON.parse(phase), JSON.parse(target)]);
    const captured = captureConsoleLog();
    let exit: number;
    try {
      exit = emitHostedRuntimeCliResult(
        result as HostedRuntimeLauncherResultV1,
      );
    } finally {
      captured.restore();
    }
    assert.equal(exit, 0);
    assert.deepEqual(
      captured.lines.map((line) => JSON.parse(line).kind),
      [
        HOST_PHASE_KIND,
        TARGET_TIMING_KIND,
        "sentinel_matrix_plan",
        "hosted_runtime_summary",
      ],
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("timing lines: the shared target flow prints one line per started target", async () => {
  const rig = makeTargetHostRig(["sentinel", FOREIGN_REPO, THIRD_REPO]);
  const captured = captureConsoleLog();
  try {
    await runActionsTargetCycles(targetCycleInput(rig, {
      prepareTarget: (config) =>
        config.repository.name === THIRD_REPO
          ? Promise.reject(new Error("owned setup refusal"))
          : Promise.resolve(),
      runCycle: () =>
        Promise.resolve({ status: "idle", detail: "nothing to do" }),
      progressComments: () => Promise.resolve(),
    }));
  } finally {
    captured.restore();
  }
  const timings = parsedOf(captured.lines).flatMap((row) => {
    const line = parseTargetTimingLine(row);
    return line === null ? [] : [line];
  });
  assert.deepEqual(
    timings.map((line) => [line.repository, line.advances]),
    [
      ["ubiquity-sentinel/sentinel", 1],
      ["ubiquity/ai.ubq.fi", 1],
      // A refused preparation still reports the time it took, no advance.
      ["ubiquity/web", 0],
    ],
  );
});

Deno.test("timing lines: the native planner and the serial aggregate print each phase once, in order", async () => {
  const r = await actionsRig();
  try {
    for (const port of r.github.values()) {
      port.listOpenIssues = () => Promise.resolve(portOk([]));
    }
    const deps = await r.job("timed-plan", "matrix_plan");
    const captured = captureConsoleLog();
    try {
      await runActionsMatrixHost({
        ...deps,
        model: {
          modelId: "gpt-reserve",
          runModel: () => {
            throw new Error("a zero-cell plan starts no model");
          },
        },
      });
    } finally {
      captured.restore();
    }
    const parsed = parsedOf(captured.lines);
    assert.deepEqual(
      parsed.flatMap((row) => parseHostPhaseLine(row)?.phase ?? []),
      ["setup", "intake", "plan", "fanout"],
    );
    assert.ok(
      parsed.some((row) => parseTargetTimingLine(row) !== null),
      "the planner's intake prints its target lines",
    );
    const serial = await r.job("timed-serial", "repair");
    const serialLog = captureConsoleLog();
    try {
      await runActionsRepairHost({
        ...serial,
        model: {
          modelId: "gpt-reserve",
          runModel: () => Promise.reject(new Error("an idle pass infers none")),
        },
        runTargetCycles: (input) =>
          runActionsMatrixAggregateCycles(input, {
            recover: () => Promise.resolve([]),
          }),
      });
    } finally {
      serialLog.restore();
    }
    assert.deepEqual(
      parsedOf(serialLog.lines).flatMap((row) =>
        parseHostPhaseLine(row)?.phase ?? []
      ),
      ["setup", "scan", "cycles", "handback", "finish"],
    );
  } finally {
    await r.cleanup();
  }
});
