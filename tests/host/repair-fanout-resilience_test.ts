/**
 * Fan-out never fails the run (issue #328, live run 41983696059):
 *
 * - the serial repair job reads the delegation from a plan beside a
 *   `.sentinel-matrix` root that does not exist in that job;
 * - an absent, unreadable or digest-mismatched plan means no delegation:
 *   one bounded line, and the serial pass steps every record as before;
 * - a repository cell that cannot proceed writes its bounded refusal record
 *   and settles normally, so its artifact always exists.
 *
 * Temporary directories inside the checkout only; no network, no model.
 */
import assert from "node:assert/strict";
import { parseRepairCellRefusalV1 } from "../../src/contracts/repair-delta.ts";
import type { ActionsTargetCyclesInputV1 } from "../../src/host/actions.ts";
import { isRepairCellMarker } from "../../src/host/hosted-runtime-repair-cell.ts";
import {
  delegatedRecordsOfRun,
  publishRepairFanoutOrNone,
  REPAIR_FANOUT_DELEGATION_KIND,
  runRepairCellTargetCycles,
} from "../../src/host/repair-fanout-host.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { STEP_LINE_KIND } from "../../src/repair/step-line.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";
import {
  captured,
  makeRig,
  REPOS,
  reviewing,
  type Rig,
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

function hostInput(rig: Rig, artifactRoot: string) {
  return {
    ...rig.deps,
    controllerSha: SHA2,
    deadline: rig.clock.now() + 90 * 60_000,
    stepLimit: 1_000,
    modelStartsEnabled: true,
    runOrigin: rig.clock.now(),
    composeGithub: () => rig.github,
    host: { execution: EXECUTION, run: RUN, artifactRoot },
  } as unknown as ActionsTargetCyclesInputV1;
}

async function inTemp(body: (work: string) => Promise<void>) {
  const work = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-repair-test-resilience-",
  });
  try {
    await body(work);
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

/** Publish the plan from a planner whose matrix root existed. */
async function published(rig: Rig, work: string): Promise<string> {
  const output = work + "/github-output";
  await Deno.writeTextFile(output, "");
  await Deno.mkdir(work + "/planner/.sentinel-matrix", { recursive: true });
  await publishRepairFanoutOrNone({
    state: rig.state,
    configs: rig.configs,
    run: RUN,
    artifactRoot: work + "/planner/.sentinel-matrix",
    output,
  });
  const line = (await Deno.readTextFile(output)).split("\n").find((row) =>
    row.startsWith("repairPlanDigest=")
  )!;
  return line.slice("repairPlanDigest=".length);
}

Deno.test("fan-out resilience: the serial job reads its delegation without a matrix root", async () => {
  const rig = makeRig([reviewing(REPOS[0], 0), reviewing(REPOS[1], 100)]);
  await inTemp(async (work) => {
    const digest = await published(rig, work);
    // The serial job's own root: `.sentinel-matrix` was never created there,
    // only the downloaded `.sentinel-repair/plan.json` beside it.
    await Deno.mkdir(work + "/job/.sentinel-repair", { recursive: true });
    await Deno.copyFile(
      work + "/planner/.sentinel-repair/plan.json",
      work + "/job/.sentinel-repair/plan.json",
    );
    const delegated = await delegatedRecordsOfRun(
      hostInput(rig, work + "/job/runtime/../.sentinel-matrix"),
      { planDigest: D, repairPlanDigest: digest },
    );
    assert.deepEqual([...delegated!].sort(), [
      "issue-alpha-0",
      "issue-beta-100",
    ]);
  });
});

Deno.test("fan-out resilience: an absent, unreadable or mismatched plan delegates nothing and the serial pass steps every record", async () => {
  for (const name of ["absent", "unreadable", "mismatched"]) {
    const rig = makeRig([reviewing(REPOS[0], 0), reviewing(REPOS[1], 100)]);
    await inTemp(async (work) => {
      const digest = await published(rig, work);
      const job = work + "/job";
      const plan = job + "/.sentinel-repair/plan.json";
      await Deno.mkdir(job + "/.sentinel-repair", { recursive: true });
      if (name === "unreadable") await Deno.writeTextFile(plan, "{not json");
      if (name === "mismatched") {
        await Deno.copyFile(work + "/planner/.sentinel-repair/plan.json", plan);
      }
      const { value, lines } = await captured(() =>
        delegatedRecordsOfRun(hostInput(rig, job + "/.sentinel-matrix"), {
          planDigest: D,
          repairPlanDigest: name === "mismatched" ? "b".repeat(64) : digest,
        })
      );
      assert.equal(value, undefined, name);
      assert.deepEqual(
        lines.filter((line) => line.kind === REPAIR_FANOUT_DELEGATION_KIND),
        [{ kind: REPAIR_FANOUT_DELEGATION_KIND, status: "unavailable" }],
        name,
      );
      // No delegation: the serial pass steps every record as before.
      const serial = await captured(() =>
        runRepairCycle(rig.deps, {
          deadline: rig.clock.now() + 90 * 60_000,
          stepLimit: 1_000,
          modelStartsEnabled: true,
          ...(value === undefined ? {} : { excludeRecords: value }),
        })
      );
      const stepped = serial.lines.filter((line) =>
        line.kind === STEP_LINE_KIND
      ).map((line) => line.recordId).sort();
      assert.deepEqual(stepped, ["issue-alpha-0", "issue-beta-100"], name);
    });
  }
});

Deno.test("fan-out resilience: a repair cell that cannot proceed writes its bounded refusal and settles", async () => {
  const rig = makeRig([reviewing(REPOS[0], 0)]);
  await inTemp(async (work) => {
    const digest = await published(rig, work);
    const root = work + "/job/.sentinel-matrix";
    const result = work + "/job/.sentinel-repair/result.json";
    const cases: [string, string, string, boolean][] = [
      // No plan artifact at all.
      ["plan_unavailable", digest, D, false],
      // The plan is there but does not plan this cell.
      ["cell_unplanned", digest, "c".repeat(64), true],
    ];
    for (const [reason, planDigest, cellId, withPlan] of cases) {
      if (withPlan) {
        await Deno.mkdir(work + "/job/.sentinel-repair", { recursive: true });
        await Deno.copyFile(
          work + "/planner/.sentinel-repair/plan.json",
          work + "/job/.sentinel-repair/plan.json",
        );
      }
      const { value, lines } = await captured(() =>
        runRepairCellTargetCycles(hostInput(rig, root), {
          planDigest: D,
          repairPlanDigest: planDigest,
          cellId,
        })
      );
      assert.match(JSON.stringify(value.outcome), /refused/);
      const refusal = parseRepairCellRefusalV1(
        JSON.parse(await Deno.readTextFile(result)),
      );
      assert.deepEqual(refusal, {
        version: "v1",
        kind: "repair_cell_refusal",
        cellId,
        reason,
      });
      // Exactly one valid marker, so the launcher settles the cell healthy.
      const markers = lines.filter((line) =>
        line.kind === "sentinel_repair_cell"
      );
      assert.equal(markers.length, 1);
      assert.ok(isRepairCellMarker(markers[0], EXECUTION, cellId), reason);
      assert.equal(rig.state.repairWrites, 0);
    }
  });
});
