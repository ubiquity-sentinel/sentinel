/**
 * A pass whose committed targets were all unreadable (supervisor run
 * 43790005563: every default-branch read of the serial repair job failed
 * during a GitHub 403 burst and the job threw `targets_empty`, turning the
 * run red) defers instead, through the actual hosted composition over the
 * matrix rig's real Git state remote, release custody and native identity:
 *
 * - an ordinary serial pass settles healthy with the idle deferral outcome,
 *   one text-free deferral line the launcher re-emits, no target cycle, no
 *   model start and no state or GitHub write;
 * - a setting that lists no repository still refuses `targets_empty`;
 * - a verification execution and an admitted matrix cell fail
 *   `targets_unavailable`, writing nothing;
 * - the matrix planner publishes its empty zero-grant plan and a repository
 *   cell its refusal and marker, as for a cell whose target is not
 *   configured.
 */
import assert from "node:assert/strict";
import { ensureRepairStateSeed } from "../../src/host/actions-host-io.ts";
import { runActionsRepairHost } from "../../src/host/actions-repair-host.ts";
import {
  parseChildStatus,
  scanChildStatusRecords,
} from "../../src/host/hosted-runtime-status.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-native-host.ts";
import { scanPlanDiagnostic } from "../../src/host/matrix-plan-diagnostic.ts";
import {
  REPAIR_CELL_SETTLED_WITHOUT_STARTUP,
  runRepairCellHost,
} from "../../src/host/repair-cell-actions.ts";
import {
  STATIC_TARGETS_DEFERRED,
  STATIC_TARGETS_EMPTY,
  STATIC_TARGETS_UNAVAILABLE,
  TARGETS_MAX,
} from "../../src/host/targets.ts";
import { parseRepairCellRefusalV1 } from "../../src/contracts/repair-delta.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { scanStepLines } from "../../src/repair/step-line.ts";
import {
  MAX_TARGETS_DEFERRAL_LISTED,
  TARGETS_DEFERRAL_KIND,
} from "../../src/repair/targets-deferral-line.ts";
import { rig } from "./matrix-actions-fixtures.ts";

const D = "a".repeat(64);
const CELL = "c".repeat(64);

/** Every listed target unreadable: a named target's default branch and a
 * generic target's tree facts. */
const UNREADABLE = {
  resolveDefaultBranch: (target: { slug: string }) =>
    Promise.resolve(target.slug === "ubiquity/prospector" ? "main" : null),
  resolveTreeFacts: () => Promise.resolve(null),
};

const LISTED = JSON.stringify([
  "ubiquity-sentinel/sentinel",
  "ubiquity/prospector",
]);

const NO_MODEL = {
  modelId: "synthetic-model",
  runModel: () => {
    throw new Error("a deferred pass never starts a model");
  },
};

async function quietly<T>(
  body: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { value: await body(), lines };
  } finally {
    console.log = original;
  }
}

/** Records every request; the rig's own transport answers it. */
function observed(http: HttpTransportV1) {
  const requests: string[] = [];
  const transport: HttpTransportV1 = (request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return http(request);
  };
  return { requests, http: transport };
}

function deferralLines(lines: readonly string[]) {
  return scanStepLines(lines.join("\n")).filter((line) =>
    line.kind === TARGETS_DEFERRAL_KIND
  );
}

const EXPECTED_LINE = {
  kind: TARGETS_DEFERRAL_KIND,
  reasonCode: "targets_unavailable",
  listed: 2,
  branchUnavailable: 1,
  factsUnavailable: 1,
};

Deno.test("targets deferral: an ordinary serial pass with every target read unavailable defers healthy and writes nothing", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const deps = await r.job("deferral-serial", "repair");
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
    const repairBefore = await r.store.readRepair();
    const releaseBefore = await r.release.readRelease();
    const http = observed(deps.http);
    let cycles = 0;
    let probes = 0;
    const { value: result, lines } = await quietly(() =>
      runActionsRepairHost({
        ...deps,
        ...UNREADABLE,
        state: r.store,
        http: http.http,
        model: NO_MODEL,
        preflight: () => {
          probes++;
          return Promise.resolve();
        },
        runTargetCycles: () => {
          cycles++;
          throw new Error("a deferred pass runs no target cycle");
        },
      })
    );
    assert.deepEqual(result.outcome, {
      status: "idle",
      detail: STATIC_TARGETS_DEFERRED,
    });
    assert.equal(result.startupReady, true);
    assert.equal(probes, 1, "the actual startup probe still owns health");
    assert.equal(cycles, 0);
    assert.deepEqual(result.ciApproval, {
      approved: 0,
      pending: 0,
      unavailable: 0,
    });
    // The launcher reads exactly one healthy child record from this stdout
    // and re-emits the one text-free deferral line with its counts.
    const stdout = lines.join("\n");
    const scan = scanChildStatusRecords(stdout);
    assert.equal(scan.kind, "one");
    assert.equal(
      scan.kind === "one" &&
        parseChildStatus(scan.value, result.execution)?.healthy,
      true,
    );
    assert.deepEqual(deferralLines(lines), [EXPECTED_LINE]);
    const raw = lines.find((line) => line.includes(TARGETS_DEFERRAL_KIND));
    assert.ok(raw !== undefined);
    for (const text of ["prospector", "sentinel/", "status", "main"]) {
      assert.equal(raw.includes(text), false, `${text} in ${raw}`);
    }
    // No state write and no GitHub request: nothing after the target load ran.
    assert.deepEqual(await r.store.readRepair(), repairBefore);
    assert.deepEqual(await r.release.readRelease(), releaseBefore);
    assert.deepEqual(http.requests, []);
    assert(
      [...r.github.values()].every((port) => port.calls.length === 0),
      "no target port composed",
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("targets deferral: a setting that lists no repository still refuses as an empty setting", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    for (const setting of ["[]", "{}", null]) {
      const deps = await r.job(`deferral-empty-${setting}`, "repair");
      const path = `${deps.workDir}/sentinel.targets.json`;
      if (setting === null) await Deno.remove(path);
      else await Deno.writeTextFile(path, setting);
      const before = await r.store.readRepair();
      const { lines } = await quietly(() =>
        assert.rejects(
          () =>
            runActionsRepairHost({
              ...deps,
              ...UNREADABLE,
              state: r.store,
              model: NO_MODEL,
            }),
          new Error(STATIC_TARGETS_EMPTY),
        )
      );
      assert.deepEqual(deferralLines(lines), [], `setting ${setting}`);
      assert.deepEqual(await r.store.readRepair(), before);
    }
  } finally {
    await r.cleanup();
  }
});

for (const purpose of ["bootstrap", "rollback"] as const) {
  Deno.test(`targets deferral: a ${purpose} execution with every target read unavailable fails as unavailable`, async () => {
    const r = await rig(true, purpose);
    try {
      await ensureRepairStateSeed(r.store, r.clock);
      const deps = await r.job(`deferral-${purpose}`, "repair");
      await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
      const repairBefore = await r.store.readRepair();
      const releaseBefore = await r.release.readRelease();
      let cycles = 0;
      const { lines } = await quietly(() =>
        assert.rejects(
          () =>
            runActionsRepairHost({
              ...deps,
              ...UNREADABLE,
              state: r.store,
              model: NO_MODEL,
              runTargetCycles: () => {
                cycles++;
                throw new Error("no target cycle");
              },
            }),
          new Error(STATIC_TARGETS_UNAVAILABLE),
        )
      );
      // Unavailable evidence never passes an install or rollback gate, but
      // the job log still names why.
      assert.equal(cycles, 0);
      assert.deepEqual(deferralLines(lines), [EXPECTED_LINE]);
      assert.equal(scanChildStatusRecords(lines.join("\n")).kind, "none");
      assert.deepEqual(await r.store.readRepair(), repairBefore);
      assert.deepEqual(await r.release.readRelease(), releaseBefore);
    } finally {
      await r.cleanup();
    }
  });
}

Deno.test("targets deferral: the matrix planner publishes an empty zero-grant plan that says why", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const deps = await r.job("deferral-plan", "matrix_plan");
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
    const before = await r.store.readRepair();
    const { value: result, lines } = await quietly(() =>
      runActionsMatrixHost({
        ...deps,
        ...UNREADABLE,
        state: r.store,
        model: NO_MODEL,
      })
    );
    assert("plan" in result);
    assert.deepEqual(result.plan.cells, []);
    assert.equal(result.prepared, 0);
    const output = await Deno.readTextFile(deps.env.GITHUB_OUTPUT);
    for (
      const expected of [
        'matrix={"include":[]}\n',
        "hasCells=false\n",
        "hasRepairCells=false\n",
        `planDigest=${result.planDigest}\n`,
      ]
    ) assert(output.includes(expected), `${expected} in ${output}`);
    const parsed = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    assert.equal(
      parsed.filter((line) => line.kind === "sentinel_matrix_plan").length,
      1,
    );
    const diagnostic = parsed.filter((line) =>
      line.kind === "sentinel_matrix_plan_diagnostic"
    );
    assert.equal(diagnostic.length, 1, JSON.stringify(parsed));
    assert.equal(diagnostic[0].cause, "targets_unavailable");
    // The launcher's own re-parse accepts the cause it re-emits.
    assert.equal(
      scanPlanDiagnostic(lines.join("\n"), { id: result.plan.waveId })?.cause,
      "targets_unavailable",
    );
    assert.deepEqual(deferralLines(lines), [EXPECTED_LINE]);
    assert.deepEqual(await r.store.readRepair(), before);
    assert(
      [...r.github.values()].every((port) => port.calls.length === 0),
      "no discovery or source admission",
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("targets deferral: an admitted matrix cell fails as unavailable and writes no result", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const deps = await r.job("deferral-cell", "matrix_cell");
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
    const before = await r.store.readRepair();
    await quietly(() =>
      assert.rejects(
        () =>
          runActionsRepairHost({
            ...deps,
            ...UNREADABLE,
            job: "matrix_cell",
            state: r.store,
            model: NO_MODEL,
          }),
        new Error(STATIC_TARGETS_UNAVAILABLE),
      )
    );
    assert.deepEqual(await r.store.readRepair(), before);
    await assert.rejects(
      () => Deno.stat(`${deps.workDir}/../.sentinel-matrix`),
      Deno.errors.NotFound,
    );
  } finally {
    await r.cleanup();
  }
});

for (const startup of ["ready", "unavailable"] as const) {
  Deno.test(`targets deferral: a repository cell writes its refusal and marker (startup ${startup})`, async () => {
    const r = await rig();
    try {
      await ensureRepairStateSeed(r.store, r.clock);
      const deps = await r.job(
        `deferral-repair-cell-${startup}`,
        "repair_cell",
      );
      await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
      const before = await r.store.readRepair();
      const { value, lines } = await quietly(() =>
        runRepairCellHost({
          ...deps,
          ...UNREADABLE,
          state: r.store,
          model: NO_MODEL,
          preflight: () =>
            startup === "ready"
              ? Promise.resolve()
              : Promise.reject(new Error("no model sandbox")),
          // No fan-out plan was downloaded: `plan_unavailable`, exactly as
          // the cell's own pass would refuse.
          carrier: { planDigest: D, repairPlanDigest: D, cellId: CELL },
        })
      );
      if (startup === "ready") {
        assert(typeof value === "object");
        assert.deepEqual(value.outcome, {
          status: "idle",
          detail: STATIC_TARGETS_DEFERRED,
        });
      } else assert.equal(value, REPAIR_CELL_SETTLED_WITHOUT_STARTUP);
      const result = JSON.parse(
        await Deno.readTextFile(
          `${deps.workDir}/../.sentinel-repair/result.json`,
        ),
      );
      assert.deepEqual(parseRepairCellRefusalV1(result), {
        version: "v1",
        kind: "repair_cell_refusal",
        cellId: CELL,
        reason: "plan_unavailable",
      });
      const markers = lines.flatMap((line) => {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          return value.kind === "sentinel_repair_cell" ? [value] : [];
        } catch {
          return [];
        }
      });
      assert.equal(markers.length, 1);
      assert.equal(markers[0].cellId, CELL);
      assert.equal(markers[0].transitions, 0);
      assert.deepEqual(await r.store.readRepair(), before);
    } finally {
      await r.cleanup();
    }
  });
}

Deno.test("targets deferral: the line's listed bound is the committed setting's bound", () => {
  assert.equal(MAX_TARGETS_DEFERRAL_LISTED, TARGETS_MAX);
});
