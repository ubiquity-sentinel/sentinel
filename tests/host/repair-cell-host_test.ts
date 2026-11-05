/**
 * The hosted runtime and launcher sides of a repository repair cell (issue
 * #328): the planner's published plan, the cell child's sealed delta and
 * marker, the serial pass's delegation read, and the launcher's carrier and
 * marker acceptance. Temporary directories only; no network, no model.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  decodeRepairDeltaArtifactV1,
  openRepairDeltaV1,
} from "../../src/contracts/repair-delta.ts";
import type { ActionsTargetCyclesInputV1 } from "../../src/host/actions.ts";
import {
  isRepairCellMarker,
  resolveRepairCellLauncherResult,
} from "../../src/host/hosted-runtime-repair-cell.ts";
import { nativeMatrixStdin } from "../../src/host/hosted-runtime-matrix.ts";
import {
  delegatedRecordsOfRun,
  publishRepairFanoutOrNone,
  readRepairFanoutPlan,
  runRepairCellTargetCycles,
} from "../../src/host/repair-fanout-host.ts";
import { repairFanoutBindingV1 } from "../../src/repair/repair-fanout-plan.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";
import {
  captured,
  makeRig,
  pendingArtifact,
  REPOS,
  reviewing,
} from "../repair/repository-pass-rig.ts";

const RUN = { runId: 41, runAttempt: 1, launcherSha: SHA1 };
const EXECUTION = {
  id: "41:1:repair",
  runId: 41,
  runAttempt: 1,
  launcherSha: SHA1,
  purpose: "ordinary" as const,
  revision: SHA2,
  generation: 3,
  releaseId: null,
  createdAt: T0,
};
const D = "a".repeat(64);

function outputs(text: string): Record<string, string> {
  return Object.fromEntries(
    text.trim().split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
}

Deno.test("repair cell host: the planner publishes a verified plan, a cell seals its delta and the serial pass reads the delegation", async () => {
  const [ALPHA, BETA] = REPOS;
  const rig = makeRig([
    reviewing(ALPHA, 0),
    pendingArtifact(ALPHA, 9),
    reviewing(BETA, 100),
  ]);
  const work = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-repair-test-cell-",
  });
  try {
    const artifactRoot = work + "/.sentinel-matrix";
    const output = work + "/github-output";
    await Deno.writeTextFile(output, "");
    const fanout = await publishRepairFanoutOrNone({
      state: rig.state,
      configs: rig.configs,
      run: RUN,
      artifactRoot,
      output,
    });
    assert.ok(fanout !== null);
    const written = outputs(await Deno.readTextFile(output));
    assert.equal(written.hasRepairCells, "true");
    const matrix = JSON.parse(written.repairMatrix);
    assert.equal(matrix.include.length, 2);
    const plan = await readRepairFanoutPlan(
      artifactRoot,
      written.repairPlanDigest,
      RUN,
    );
    assert.deepEqual(plan, fanout);
    await assert.rejects(() => readRepairFanoutPlan(artifactRoot, D, RUN));
    await assert.rejects(() =>
      readRepairFanoutPlan(artifactRoot, written.repairPlanDigest, {
        runId: 41,
        runAttempt: 2,
      })
    );

    const input = {
      ...rig.deps,
      // The runtime revision the saved execution names.
      controllerSha: SHA2,
      deadline: rig.clock.now() + 90 * 60_000,
      stepLimit: 1_000,
      modelStartsEnabled: true,
      runOrigin: rig.clock.now(),
      composeGithub: () => rig.github,
      host: { execution: EXECUTION, run: RUN, artifactRoot },
    } as unknown as ActionsTargetCyclesInputV1;
    // The serial pass's delegation is exactly the plan's records.
    const delegated = await delegatedRecordsOfRun(input, {
      planDigest: D,
      repairPlanDigest: written.repairPlanDigest,
    });
    assert.deepEqual([...delegated!].sort(), [
      "issue-alpha-0",
      "issue-beta-100",
    ]);
    assert.equal(
      await delegatedRecordsOfRun(input, { planDigest: D }),
      undefined,
    );

    const alpha = plan.cells.find((cell) => cell.repository.name === "alpha")!;
    const { value: cycles, lines } = await captured(() =>
      runRepairCellTargetCycles(input, {
        planDigest: D,
        repairPlanDigest: written.repairPlanDigest,
        cellId: alpha.cellId,
      })
    );
    assert.deepEqual(cycles.addressed, ["ubiquity/alpha"]);
    assert.equal(rig.state.repairWrites, 0, "a cell writes no shared state");
    const envelope = decodeRepairDeltaArtifactV1(
      await Deno.readFile(work + "/.sentinel-repair/result.json"),
    );
    const opened = await openRepairDeltaV1(envelope, {
      binding: await repairFanoutBindingV1(plan),
      repository: ALPHA,
    });
    assert.ok(opened.ok);
    assert.deepEqual(opened.delta.transitions.map((t) => t.after.id), [
      "issue-alpha-0",
    ]);
    const markers = lines.filter((line) =>
      line.kind === "sentinel_repair_cell"
    );
    assert.equal(markers.length, 1);
    assert.ok(isRepairCellMarker(markers[0], EXECUTION, alpha.cellId));
    assert.equal(
      markers[0].deltaDigest,
      (envelope as { digest: string }).digest,
    );
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});

Deno.test("repair cell host: a run with nothing delegable plans no repository cell", async () => {
  const rig = makeRig([pendingArtifact(REPOS[0], 1)]);
  const work = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-repair-test-cell-",
  });
  try {
    const output = work + "/github-output";
    await Deno.writeTextFile(output, "");
    await publishRepairFanoutOrNone({
      state: rig.state,
      configs: rig.configs,
      run: RUN,
      artifactRoot: work + "/.sentinel-matrix",
      output,
    });
    const written = outputs(await Deno.readTextFile(output));
    assert.equal(written.hasRepairCells, "false");
    assert.equal(written.repairMatrix, '{"include":[]}');
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});

Deno.test("launcher: repository repair cell carriers and markers are exact", () => {
  const carrier = JSON.stringify({
    planDigest: D,
    repairPlanDigest: "b".repeat(64),
    cellId: "c".repeat(64),
  });
  assert.equal(nativeMatrixStdin(carrier, "repair_cell"), carrier);
  assert.throws(() =>
    nativeMatrixStdin(
      JSON.stringify({ planDigest: D, cellId: D }),
      "repair_cell",
    )
  );
  assert.throws(() => nativeMatrixStdin(undefined, "repair_cell"));
  // The serial repair job may carry the fan-out digest, nothing else new.
  const serial = JSON.stringify({ planDigest: D, repairPlanDigest: D });
  assert.equal(nativeMatrixStdin(serial, "repair"), serial);
  assert.throws(() =>
    nativeMatrixStdin(
      JSON.stringify({ planDigest: D, repairPlanDigest: "x" }),
      "repair",
    )
  );
  assert.throws(() => nativeMatrixStdin(carrier, "matrix_cell"));

  const marker = {
    kind: "sentinel_repair_cell",
    run: RUN,
    runtimeSha: SHA2,
    generation: 3,
    cellId: "c".repeat(64),
    deltaDigest: D,
    transitions: 2,
  };
  const run = (lines: unknown[]) => ({
    outcome: "exited" as const,
    exitCode: 0,
    stdout: new TextEncoder().encode(
      lines.map((line) => JSON.stringify(line)).join("\n"),
    ),
    stderr: new Uint8Array(),
    truncated: false,
    settled: true,
  });
  const accepted = resolveRepairCellLauncherResult(
    run([{ kind: "other" }, marker]) as never,
    EXECUTION,
    carrier,
  );
  assert.equal(accepted.status, "healthy");
  assert.deepEqual(accepted.matrixCarrier, marker);
  for (
    const lines of [
      [],
      [marker, marker],
      [{ ...marker, cellId: D }],
      [{ ...marker, runtimeSha: SHA1 as GitSha }],
      [{ ...marker, extra: 1 }],
    ]
  ) {
    const refused = resolveRepairCellLauncherResult(
      run(lines) as never,
      EXECUTION,
      carrier,
    );
    assert.equal(refused.status, "unavailable", JSON.stringify(lines));
    assert.equal(refused.matrixCarrier, undefined);
  }
});
