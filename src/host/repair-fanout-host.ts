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
import { encodeRepairDeltaArtifactV1 } from "../contracts/repair-delta.ts";
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

/** `.sentinel-repair` beside the run's `.sentinel-matrix` artifact root. */
export function repairFanoutRootOf(artifactRoot: string): string {
  return joinPath(artifactRoot, "..", REPAIR_FANOUT_DIR);
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

/** The records the serial pass leaves to this run's repository cells. */
export async function delegatedRecordsOfRun(
  input: ActionsTargetCyclesInputV1,
  carrier: MatrixNativeCarrierV1 | undefined,
): Promise<ReadonlySet<string> | undefined> {
  if (carrier?.repairPlanDigest === undefined) return undefined;
  const host = hostOf(input);
  const plan = await readRepairFanoutPlan(
    host.artifactRoot,
    carrier.repairPlanDigest,
    host.run,
  );
  return delegatedRecordsV1(plan);
}

/** One repository cell: its pass, its sealed delta and its marker. */
export async function runRepairCellTargetCycles(
  input: ActionsTargetCyclesInputV1,
  carrier: MatrixNativeCarrierV1,
): Promise<ActionsTargetCyclesResultV1> {
  const host = hostOf(input);
  if (
    carrier.repairPlanDigest === undefined || carrier.cellId === undefined
  ) throw new Error("repair cell lacks native selection");
  const plan = await readRepairFanoutPlan(
    host.artifactRoot,
    carrier.repairPlanDigest,
    host.run,
  );
  const cell = plan.cells.find((entry) => entry.cellId === carrier.cellId);
  if (cell === undefined) {
    throw new Error("repair cell is absent from its plan");
  }
  const config = configured(input, cell.repository);
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
    throw new Error("repair cell could not read its base state");
  }
  const root = repairFanoutRootOf(host.artifactRoot);
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  await Deno.writeFile(
    joinPath(root, "result.json"),
    encodeRepairDeltaArtifactV1(result.envelope),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({
    kind: REPAIR_CELL_MARKER_KIND,
    run: host.run,
    runtimeSha: input.controllerSha,
    generation: host.execution.generation,
    cellId: cell.cellId,
    deltaDigest: result.envelope.digest,
    transitions: result.envelope.delta.transitions.length,
  }));
  return {
    outcome: { status: "idle", detail: "repair cell settled" },
    addressed: [config.repository.owner + "/" + config.repository.name],
    skipped: [],
    failed: [],
  };
}
