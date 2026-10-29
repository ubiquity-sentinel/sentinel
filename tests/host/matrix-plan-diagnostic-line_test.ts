/**
 * C5.1 (2026-10-25 redesign): a zero-cell plan prints one sanitized
 * per-repository `sentinel_matrix_plan_diagnostic` line beside its unchanged
 * carrier; the launcher keeps only the closed key vocabulary with integer
 * counts and re-emits it after the carrier.
 */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { emitHostedRuntimeCliResult } from "../../src/host/hosted-runtime.ts";
import type { HostedRuntimeLauncherResultV1 } from "../../src/host/hosted-runtime.ts";
import { matrixPlanCarrierOf } from "../../src/host/matrix-actions.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-native-host.ts";
import {
  MATRIX_PLAN_DIAGNOSTIC_KIND,
  matrixPlanDiagnosticLineOf,
  scanPlanDiagnostic,
} from "../../src/host/matrix-plan-diagnostic.ts";
import { planMatrixWave } from "../../src/host/matrix-planner.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "../repair/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  exited,
  launch,
  makeRig,
  RUN_ATTEMPT,
  RUN_ID,
  seedRelease,
} from "./hosted-runtime-fixture.ts";
import { rig as actionsRig } from "./matrix-actions-fixtures.ts";

const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 7,
} as const;

function capture<T>(run: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { value: run(), lines };
  } finally {
    console.log = original;
  }
}

async function captureAsync<T>(
  run: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { value: await run(), lines };
  } finally {
    console.log = original;
  }
}

Deno.test("plan diagnostic: a zero-cell plan counts skips and not-ready reasons per repository", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const configs = repairConfigs({
    adapter: { kind: "github" },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  state.repair = seededSnapshot([
    workRecord("a-review", {
      nextStep: "review",
      target: {
        base: SHA1,
        branch: "sentinel/repair/a-review",
        checkpoint: null,
        head: SHA2,
        pr: 5,
      },
    }),
    workRecord("a-wait", {
      wait: { reason: "backoff", since: T0, until: T0 + 3_600_000 },
    }),
    workRecord("p-work", { repository: PASSPORT }),
  ]);
  state.repairHead = SHA1;
  const report = await planMatrixWave({
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github: new FakeGithub({ baseSha: SHA1 }),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: new FakeModel({ head: SHA2, changedPaths: [] }),
    budget: new RollingStartBudget({ clock, state, configs }),
  }, {
    waveId: "w-zero",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 82,
    plannedAt: T0,
    deadline: T0 + 3_600_000,
  });
  assert.equal(report.prepared, 0);
  assert.deepEqual(report.diagnostic?.byRepository, {
    "ubiquity/ai.ubq.fi": {
      skippedByReason: { waiting: 1 },
      notReadyByReason: { "nextStep=review": 1 },
    },
    "ubiquity/passport.ubq.fi": {
      skippedByReason: { unconfigured: 1 },
      notReadyByReason: {},
    },
  });
  assert.deepEqual(
    matrixPlanDiagnosticLineOf({
      waveId: "w-zero",
      prepared: 0,
      cause: "planner",
      diagnostic: report.diagnostic,
    }).repositories.map((row) => row.repository),
    ["ubiquity/ai.ubq.fi", "ubiquity/passport.ubq.fi"],
  );
});

Deno.test("plan diagnostic: the child line closes every variable reason part", () => {
  const line = matrixPlanDiagnosticLineOf({
    waveId: "w",
    prepared: 0,
    cause: "planner",
    diagnostic: {
      totalRecords: 9,
      skippedByReason: {},
      notReadyByReason: {},
      notReadySamples: {},
      byRepository: {
        "ubiquity/passport.ubq.fi": {
          skippedByReason: { waiting: 2, "never-seen": 1 },
          notReadyByReason: {
            "intent=impl:res-secret-1": 1,
            "intent=impl:res-secret-2": 1,
            "intent=strange:x": 1,
            "nextStep=delivery": 3,
            "invented reason": 1,
          },
        },
      },
    },
  });
  assert.deepEqual(line, {
    kind: MATRIX_PLAN_DIAGNOSTIC_KIND,
    waveId: "w",
    cause: "planner",
    prepared: 0,
    totalRecords: 9,
    repositories: [{
      repository: "ubiquity/passport.ubq.fi",
      skippedByReason: { waiting: 2, other: 1 },
      notReadyByReason: {
        "intent=impl": 2,
        "intent=other": 1,
        "nextStep=delivery": 3,
        other: 1,
      },
    }],
  });
  assert.equal(JSON.stringify(line).includes("secret"), false);
  assert.equal("status" in line, false, "never a child status record");
});

function carrierFor(rig: Awaited<ReturnType<typeof makeRig>>) {
  return matrixPlanCarrierOf({
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
}

function childDiagnostic(waveId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: MATRIX_PLAN_DIAGNOSTIC_KIND,
    waveId,
    cause: "planner",
    prepared: 0,
    totalRecords: 61,
    repositories: [{
      repository: "ubiquity/passport.ubq.fi",
      skippedByReason: { waiting: 39, forged: 5 },
      notReadyByReason: {
        "nextStep=delivery": 22,
        "intent=impl:res-leak": 1,
        "review_rounds_spent": 1.5,
        "target.branch=null": -1,
      },
    }],
    ...extra,
  };
}

Deno.test("plan diagnostic: the launcher re-emits one sanitized line after the unchanged carrier", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const carrier = carrierFor(rig);
    rig.process.child = exited(
      JSON.stringify(carrier) + "\n" +
        JSON.stringify(childDiagnostic(rig.execution.id)) + "\n",
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
    assert.deepEqual(result.matrixPlanDiagnostic, {
      version: "v1",
      kind: MATRIX_PLAN_DIAGNOSTIC_KIND,
      advisory: true,
      waveId: rig.execution.id,
      cause: "planner",
      prepared: 0,
      totalRecords: 61,
      repositories: [{
        repository: "ubiquity/passport.ubq.fi",
        skippedByReason: { waiting: 39 },
        notReadyByReason: { "nextStep=delivery": 22 },
      }],
    });
    const { value: exit, lines } = capture(() =>
      emitHostedRuntimeCliResult(result as HostedRuntimeLauncherResultV1)
    );
    assert.equal(exit, 0);
    const kinds = lines.map((line) => JSON.parse(line).kind);
    assert.deepEqual(kinds, [
      "sentinel_matrix_plan",
      MATRIX_PLAN_DIAGNOSTIC_KIND,
      "hosted_runtime_summary",
    ]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("plan diagnostic: a foreign, duplicated or malformed line is dropped and a rejected carrier carries none", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const carrier = carrierFor(rig);
    const input = {
      env: {
        ...rig.env,
        GITHUB_JOB: "matrix_plan",
        GITHUB_OUTPUT: "/tmp/native-output",
      },
    };
    const good = JSON.stringify(childDiagnostic(rig.execution.id));
    for (
      const extra of [
        JSON.stringify(childDiagnostic("9:9:repair")),
        good + "\n" + good,
        JSON.stringify(childDiagnostic(rig.execution.id, { status: "x" })),
        JSON.stringify(
          childDiagnostic(rig.execution.id, { repositories: [{ x: 1 }] }),
        ),
      ]
    ) {
      rig.process.child = exited(
        JSON.stringify(carrier) + "\n" + extra + "\n",
      );
      const result = await launch(rig, input);
      assert.deepEqual(result.matrixCarrier, carrier, extra);
      assert.equal(result.matrixPlanDiagnostic, undefined, extra);
    }
    rig.process.child = exited(
      JSON.stringify({ ...carrier, generation: 2 }) + "\n" + good + "\n",
    );
    const refused = await launch(rig, input);
    assert.equal(refused.status, "unavailable");
    assert.equal(refused.matrixPlanDiagnostic, undefined);
    assert.equal(scanPlanDiagnostic(good, { id: "other" }), null);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("plan diagnostic: the native planner prints one carrier and one diagnostic for a zero-cell wave", async () => {
  const r = await actionsRig();
  try {
    for (const port of r.github.values()) {
      port.listOpenIssues = () => Promise.resolve(portOk([]));
    }
    const deps = await r.job("zero-cells", "matrix_plan");
    const { value: result, lines } = await captureAsync(() =>
      runActionsMatrixHost({
        ...deps,
        model: {
          modelId: "gpt-reserve",
          runModel: () => {
            throw new Error("a zero-cell plan starts no model");
          },
        },
      })
    );
    assert.ok("plan" in result);
    assert.equal(result.prepared, 0);
    const parsed = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const carriers = parsed.filter((row) =>
      row.kind === "sentinel_matrix_plan"
    );
    const diagnostics = parsed.filter((row) =>
      row.kind === MATRIX_PLAN_DIAGNOSTIC_KIND
    );
    assert.equal(carriers.length, 1);
    assert.equal(diagnostics.length, 1, lines.join("\n"));
    assert.equal(diagnostics[0].waveId, "71:1:repair");
    assert.equal(diagnostics[0].cause, "planner");
    assert.equal(diagnostics[0].prepared, 0);
    assert.ok(
      parsed.indexOf(carriers[0]) < parsed.indexOf(diagnostics[0]),
      "the diagnostic follows the carrier",
    );
  } finally {
    await r.cleanup();
  }
});
