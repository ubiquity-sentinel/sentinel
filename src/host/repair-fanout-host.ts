/**
 * The hosted runtime's side of the repository repair fan-out (issue #328).
 *
 * - The planner (`matrix_plan`) publishes the run's fan-out plan next to the
 *   matrix plan: `.sentinel-repair/plan.json`, uploaded as the immutable
 *   `sentinel-repair-plan-<run>-<attempt>` artifact, and the native outputs
 *   `repairMatrix`, `repairPlanDigest` and `hasRepairCells`.
 * - A repository cell (`repair_cell`) reads that plan, verified against the
 *   digest the native outputs carried, steps exactly its delegated records
 *   with the matrix cell's read-only capabilities, writes its sealed delta to
 *   `.sentinel-repair/result.json` and prints one `sentinel_repair_cell`
 *   marker the launcher re-emits for finalize's authentication.
 * - The serial repair job reads the same verified plan and never selects a
 *   delegated record.
 *
 * Nothing here writes repair state.
 */
import { canonicalStringify } from "../contracts/canonical.ts";
import { resolve } from "node:path";
import {
  canonicalDigestV1,
  encodeRepairDeltaArtifactV1,
  REPAIR_CELL_REFUSAL_KIND,
  type RepairCellRefusalReasonV1,
  type RepairCellRefusalV1,
} from "../contracts/repair-delta.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  delegatedRecordsV1,
  parseRepairFanoutPlanV1,
  planRepairFanoutV1,
  repairFanoutBindingV1,
  repairFanoutMatrixV1,
  repairFanoutPlanDigestV1,
  type RepairFanoutPlanV1,
} from "../repair/repair-fanout-plan.ts";
import { runRepositoryRepairPass } from "../repair/repository-pass.ts";
import {
  type ActionsTargetCyclesInputV1,
  type ActionsTargetCyclesResultV1,
  childRunDeadlineV1,
} from "./actions-target-cycles.ts";
import { REPAIR_CELL_MARKER_KIND } from "./hosted-runtime-repair-cell.ts";
import { joinPath } from "./local.ts";
import {
  configured,
  hostOf,
  type MatrixNativeCarrierV1,
  targetDeps,
} from "./matrix-actions-shared.ts";

export const REPAIR_FANOUT_DIR = ".sentinel-repair";
/** The fan-out plan file bound (the archive reader's own file bound). */
const MAX_PLAN_BYTES = 2 * 1024 * 1024;

/**
 * `.sentinel-repair` beside the run's `.sentinel-matrix` artifact root,
 * resolved lexically: the matrix root need not exist in a job that never
 * downloads the matrix plan (the serial repair job, a repository cell).
 */
export function repairFanoutRootOf(artifactRoot: string): string {
  return resolve(artifactRoot, "..", REPAIR_FANOUT_DIR);
}

async function appendOutput(output: string, text: string): Promise<void> {
  await Deno.writeTextFile(output, text, { append: true });
}

/** The native outputs of a run that delegates nothing. */
export function noRepairFanoutOutputs(): string {
  return 'repairMatrix={"include":[]}\nrepairPlanDigest=\nhasRepairCells=false\n';
}

/**
 * Plan the fan-out on the state the planner just left and publish it: the
 * plan file and the native outputs. Returns the published plan.
 */
export async function publishRepairFanoutPlan(input: {
  snapshot: RepairStateSnapshotV1;
  head: GitSha;
  configs: ActionsTargetCyclesInputV1["configs"];
  run: { runId: number; runAttempt: number };
  artifactRoot: string;
  output: string;
}): Promise<RepairFanoutPlanV1> {
  const plan = await planRepairFanoutV1({
    snapshot: input.snapshot,
    head: input.head,
    configs: input.configs,
    runId: input.run.runId,
    runAttempt: input.run.runAttempt,
  });
  const root = repairFanoutRootOf(input.artifactRoot);
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    joinPath(root, "plan.json"),
    canonicalStringify(plan) + "\n",
    { mode: 0o600 },
  );
  const matrix = repairFanoutMatrixV1(plan);
  await appendOutput(
    input.output,
    matrix.include.length === 0
      ? noRepairFanoutOutputs()
      : "repairMatrix=" + JSON.stringify(matrix) + "\nrepairPlanDigest=" +
        await repairFanoutPlanDigestV1(plan) + "\nhasRepairCells=true\n",
  );
  return plan;
}

/** Publish the plan, or the no-cell outputs when it cannot be planned. */
export async function publishRepairFanoutOrNone(input: {
  state: Pick<ActionsTargetCyclesInputV1["state"], "readRepair">;
  configs: ActionsTargetCyclesInputV1["configs"];
  run: { runId: number; runAttempt: number };
  artifactRoot: string;
  output: string;
}): Promise<RepairFanoutPlanV1 | null> {
  try {
    const read = await input.state.readRepair();
    if (read.ok && read.value.status === "found") {
      return await publishRepairFanoutPlan({
        snapshot: read.value.snapshot,
        head: read.value.head,
        configs: input.configs,
        run: input.run,
        artifactRoot: input.artifactRoot,
        output: input.output,
      });
    }
  } catch { /* plans no repository cell */ }
  await appendOutput(input.output, noRepairFanoutOutputs());
  return null;
}

/**
 * The run's own fan-out plan from the downloaded artifact, verified against
 * the digest the native outputs carried and bound to this run attempt.
 */
export async function readRepairFanoutPlan(
  artifactRoot: string,
  expectedDigest: string,
  run: { runId: number; runAttempt: number },
): Promise<RepairFanoutPlanV1> {
  const path = joinPath(repairFanoutRootOf(artifactRoot), "plan.json");
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size > MAX_PLAN_BYTES) {
    throw new Error("repair fan-out plan file is invalid");
  }
  const plan = await parseRepairFanoutPlanV1(
    JSON.parse(await Deno.readTextFile(path)),
  );
  if (
    await repairFanoutPlanDigestV1(plan) !== expectedDigest ||
    plan.runId !== run.runId || plan.runAttempt !== run.runAttempt
  ) throw new Error("repair fan-out plan does not match its native digest");
  return plan;
}

export const REPAIR_FANOUT_DELEGATION_KIND =
  "sentinel_repair_fanout_delegation";

/**
 * The records the serial pass leaves to this run's repository cells. Total:
 * fan-out is an optimization, so an absent, unreadable, mismatched or
 * foreign plan means no delegation this pass (one bounded advisory line) and
 * the serial pass steps every record exactly as before.
 */
export async function delegatedRecordsOfRun(
  input: ActionsTargetCyclesInputV1,
  carrier: MatrixNativeCarrierV1 | undefined,
): Promise<ReadonlySet<string> | undefined> {
  if (carrier?.repairPlanDigest === undefined) return undefined;
  try {
    const host = hostOf(input);
    const plan = await readRepairFanoutPlan(
      host.artifactRoot,
      carrier.repairPlanDigest,
      host.run,
    );
    return delegatedRecordsV1(plan);
  } catch {
    try {
      console.log(JSON.stringify({
        kind: REPAIR_FANOUT_DELEGATION_KIND,
        status: "unavailable",
      }));
    } catch { /* advisory */ }
    return undefined;
  }
}

async function writeCellResult(root: string, bytes: Uint8Array) {
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  await Deno.writeFile(joinPath(root, "result.json"), bytes, { mode: 0o600 });
}

/**
 * One repository cell: its pass, its sealed delta and its marker. A cell
 * that cannot produce a delta still writes its bounded refusal record (so
 * its artifact always exists and finalize counts it `refused`) and settles
 * normally; no state is touched either way.
 */
export async function runRepairCellTargetCycles(
  input: ActionsTargetCyclesInputV1,
  carrier: MatrixNativeCarrierV1,
): Promise<ActionsTargetCyclesResultV1> {
  const host = hostOf(input);
  const cellId = carrier.cellId;
  const planDigest = carrier.repairPlanDigest;
  if (planDigest === undefined || cellId === undefined) {
    throw new Error("repair cell lacks native selection");
  }
  const root = repairFanoutRootOf(host.artifactRoot);
  const marker = (deltaDigest: string, transitions: number) =>
    console.log(JSON.stringify({
      kind: REPAIR_CELL_MARKER_KIND,
      run: host.run,
      runtimeSha: input.controllerSha,
      generation: host.execution.generation,
      cellId,
      deltaDigest,
      transitions,
    }));
  let reason: RepairCellRefusalReasonV1 = "plan_unavailable";
  let addressed: string[] = [];
  try {
    const plan = await readRepairFanoutPlan(
      host.artifactRoot,
      planDigest,
      host.run,
    );
    reason = "cell_unplanned";
    const cell = plan.cells.find((entry) => entry.cellId === cellId);
    if (cell === undefined) throw new Error("cell unplanned");
    reason = "pass_failed";
    const config = configured(input, cell.repository);
    addressed = [config.repository.owner + "/" + config.repository.name];
    await input.prepareTarget?.(config);
    // The cell anchors its own bounded window at this trusted child
    // invocation, exactly like a matrix cell.
    const origin = input.runOrigin ?? host.execution.createdAt;
    const result = await runRepositoryRepairPass(targetDeps(input, config), {
      repository: cell.repository,
      binding: await repairFanoutBindingV1(plan),
      records: cell.records,
      deadline: Math.min(input.deadline, childRunDeadlineV1(origin)),
      runStartedAt: origin,
      stepLimit: input.stepLimit,
      modelStartsEnabled: input.modelStartsEnabled,
    });
    if (result.status !== "sealed") {
      reason = "base_unavailable";
      throw new Error("base unavailable");
    }
    await writeCellResult(root, encodeRepairDeltaArtifactV1(result.envelope));
    marker(result.envelope.digest, result.envelope.delta.transitions.length);
    return {
      outcome: { status: "idle", detail: "repair cell settled" },
      addressed,
      skipped: [],
      failed: [],
    };
  } catch {
    const refusal: RepairCellRefusalV1 = {
      version: "v1",
      kind: REPAIR_CELL_REFUSAL_KIND,
      cellId,
      reason,
    };
    await writeCellResult(
      root,
      new TextEncoder().encode(canonicalStringify(refusal) + "\n"),
    );
    marker(await canonicalDigestV1(refusal), 0);
    return {
      outcome: { status: "idle", detail: "repair cell refused: " + reason },
      addressed,
      skipped: [],
      failed: [],
    };
  }
}
