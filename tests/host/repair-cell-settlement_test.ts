/**
 * A repository repair cell settles healthy once it wrote its delta or its
 * refusal record (issue #328, live run 42003007949: every cell's child
 * printed its marker and then exited 1 on the model-startup verdict).
 *
 * - The actual hosted composition (`runRepairCellHost` over the matrix
 *   rig's real Git state, release custody and native identity) with an
 *   unavailable startup probe still settles the cell, and a crash before its
 *   result still fails it.
 * - The launcher maps the settled child to exit 0 for the delta and the
 *   refusal marker alike, and a crashed child to exit 1.
 * - The workflow's refusal fallback never overwrites an existing result.
 */
import assert from "node:assert/strict";
import { ensureRepairStateSeed } from "../../src/host/actions-host-io.ts";
import {
  emitHostedRuntimeCliResult,
} from "../../src/host/hosted-runtime-main.ts";
import { resolveRepairCellLauncherResult } from "../../src/host/hosted-runtime-repair-cell.ts";
import {
  REPAIR_CELL_SETTLED_WITHOUT_STARTUP,
  runRepairCellHost,
} from "../../src/host/repair-cell-actions.ts";
import { parseRepairCellRefusalV1 } from "../../src/contracts/repair-delta.ts";
import { rig } from "./matrix-actions-fixtures.ts";

const D = "a".repeat(64);
const CELL = "c".repeat(64);

async function quietly<T>(body: () => Promise<T>): Promise<
  { value: T; lines: Record<string, unknown>[] }
> {
  const raw: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => raw.push(args.map(String).join(" "));
  try {
    const value = await body();
    return {
      value,
      lines: raw.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      }),
    };
  } finally {
    console.log = original;
  }
}

Deno.test("repair cell child: a cell that wrote its result settles even when the startup probe is unavailable", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const deps = await r.job("repair-cell", "repair_cell");
    const before = await r.store.readRepair();
    const { value, lines } = await quietly(() =>
      runRepairCellHost({
        ...deps,
        state: r.store,
        preflight: () => Promise.reject(new Error("no model sandbox")),
        // No fan-out plan was downloaded: the cell refuses `plan_unavailable`.
        carrier: { planDigest: D, repairPlanDigest: D, cellId: CELL },
      })
    );
    assert.equal(value, REPAIR_CELL_SETTLED_WITHOUT_STARTUP);
    const result = JSON.parse(
      await Deno.readTextFile(
        r.root + "/repair-cell/.sentinel-repair/result.json",
      ),
    );
    assert.deepEqual(parseRepairCellRefusalV1(result), {
      version: "v1",
      kind: "repair_cell_refusal",
      cellId: CELL,
      reason: "plan_unavailable",
    });
    const markers = lines.filter((line) =>
      line.kind === "sentinel_repair_cell"
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].cellId, CELL);
    // A cell writes no shared state.
    const after = await r.store.readRepair();
    assert.ok(before.ok && after.ok);
    assert.equal(
      after.value.status === "found" ? after.value.head : null,
      before.value.status === "found" ? before.value.head : null,
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("repair cell child: a crash before its result still fails the cell", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const deps = await r.job("repair-cell-crash", "repair_cell");
    await assert.rejects(() =>
      quietly(() =>
        runRepairCellHost({
          ...deps,
          state: r.store,
          preflight: () => Promise.reject(new Error("no model sandbox")),
          carrier: { planDigest: D, repairPlanDigest: D, cellId: CELL },
          // The host's own composition fails before the cell's pass.
          env: { ...deps.env, GITHUB_RUN_ID: "999" },
        })
      )
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("launcher: a settled repair cell exits 0 for its delta and its refusal marker; a crash exits 1", async () => {
  const execution = {
    id: "41:1:repair",
    runId: 41,
    runAttempt: 1,
    launcherSha: "1".repeat(40),
    purpose: "ordinary" as const,
    revision: "2".repeat(40),
    generation: 3,
    releaseId: null,
    createdAt: 1,
  };
  const marker = (transitions: number) => ({
    kind: "sentinel_repair_cell",
    run: {
      runId: execution.runId,
      runAttempt: execution.runAttempt,
      launcherSha: execution.launcherSha,
    },
    runtimeSha: execution.revision,
    generation: execution.generation,
    cellId: CELL,
    deltaDigest: D,
    transitions,
  });
  const stdin = JSON.stringify({
    planDigest: D,
    repairPlanDigest: D,
    cellId: CELL,
  });
  const run = (exitCode: number, line: unknown) => ({
    outcome: "exited" as const,
    exitCode,
    stdout: new TextEncoder().encode(
      JSON.stringify({ kind: "sentinel_run_window" }) + "\n" +
        JSON.stringify(line) + "\n",
    ),
    stderr: new Uint8Array(),
    truncated: false,
    settled: true,
  });
  // The delta case (transitions written) and the refusal case (none).
  for (const transitions of [4, 0]) {
    const resolved = resolveRepairCellLauncherResult(
      run(0, marker(transitions)) as never,
      execution as never,
      stdin,
    );
    assert.equal(resolved.status, "healthy");
    const printed = await quietly(() =>
      Promise.resolve(emitHostedRuntimeCliResult(resolved))
    );
    assert.equal(printed.value, 0, `transitions ${transitions}`);
    assert.ok(
      printed.lines.some((line) =>
        line.kind === "sentinel_repair_cell" &&
        line.transitions === transitions
      ),
      "the launcher re-emits the producer marker finalize authenticates",
    );
  }
  const crashed = resolveRepairCellLauncherResult(
    run(1, marker(0)) as never,
    execution as never,
    stdin,
  );
  assert.equal(crashed.status, "failed");
  const originalError = console.error;
  console.error = () => {};
  try {
    const printed = await quietly(() =>
      Promise.resolve(emitHostedRuntimeCliResult(crashed))
    );
    assert.equal(printed.value, 1);
  } finally {
    console.error = originalError;
  }
});

Deno.test("workflow: the refusal fallback never overwrites an existing cell result", async () => {
  const workflow = await Deno.readTextFile(".github/workflows/supervisor.yml");
  const start = workflow.indexOf("      - name: Record a refused repair cell");
  const end = workflow.indexOf("      - name: Upload sealed repair delta");
  assert.ok(start > 0 && end > start);
  const step = workflow.slice(start, end);
  assert.match(step, /if: \$\{\{ !cancelled\(\) \}\}/);
  const script = step.slice(step.indexOf("run: |") + "run: |".length)
    .split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n")
    .replaceAll("${{ matrix.cellId }}", CELL);
  const work = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-repair-test-fallback-",
  });
  try {
    const bash = async () => {
      const output = await new Deno.Command("bash", {
        args: ["-c", script],
        cwd: work,
        env: { PATH: "/usr/bin:/bin" },
        clearEnv: true,
      }).output();
      assert.equal(output.code, 0, new TextDecoder().decode(output.stderr));
    };
    // Without a result the fallback writes one bounded refusal record.
    await bash();
    const written = JSON.parse(
      await Deno.readTextFile(work + "/.sentinel-repair/result.json"),
    );
    assert.equal(parseRepairCellRefusalV1(written)?.reason, "cell_unavailable");
    // An existing delta (or refusal) is left byte for byte.
    const delta = '{"kind":"repair_delta_envelope","digest":"x"}\n';
    await Deno.writeTextFile(work + "/.sentinel-repair/result.json", delta);
    await bash();
    assert.equal(
      await Deno.readTextFile(work + "/.sentinel-repair/result.json"),
      delta,
    );
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});
