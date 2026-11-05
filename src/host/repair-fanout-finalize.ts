/**
 * Finalize's application of the run's repository repair deltas (issue #328).
 *
 * Finalize is the single trusted writer of the deltas. Every input is
 * authenticated the way the matrix cells' artifacts are:
 *
 * - the run attempt itself is this protected supervisor workflow's own
 *   dispatch at the exact launcher head;
 * - every artifact carries this run's native provenance and is downloaded
 *   through the bounded Actions transport, which verifies the archive digest
 *   GitHub recorded at upload before one byte is extracted;
 * - the fan-out plan's digest must equal the one the native `matrix_plan`
 *   outputs carried, and the `matrix_plan` job must have succeeded;
 * - each delta's producer is the exact completed `repair_cell (<cellId>)` job,
 *   whose own signed log carries exactly one `sentinel_repair_cell` marker in
 *   its "Run repository repair cell" step binding the run, the saved runtime
 *   revision and generation, the cell and the delta's seal.
 *
 * A cell without a completed producer or artifact counts as missing; a cell
 * failing any check counts as unauthenticated. The opened deltas are then
 * applied by `applyRepairDeltas` in one expected-head write. Bounded; nothing
 * here reserves, charges or starts anything.
 */
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS as TOLERANCE,
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY as REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../contracts/hosted-supervisor.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { Clock } from "../contracts/ports.ts";
import { decodeRepairDeltaArtifactV1 } from "../contracts/repair-delta.ts";
import { createDeadline, type HttpTransportV1 } from "../github/http.ts";
import type { RepairCycleDepsV1 } from "../repair/loop-types.ts";
import {
  applyRepairDeltas,
  type RepairDeltaApplyResultV1,
  type RepairDeltaArtifactV1,
} from "../repair/repair-delta-apply.ts";
import {
  parseRepairFanoutPlanV1,
  repairFanoutPlanDigestV1,
  type RepairFanoutPlanV1,
} from "../repair/repair-fanout-plan.ts";
import {
  isRepairCellMarker,
  REPAIR_CELL_MARKER_KIND,
} from "./hosted-runtime-repair-cell.ts";
import { createMatrixArtifactArchive } from "./matrix-artifact-archive.ts";
import { createMatrixArtifactHttp } from "./matrix-artifact-http.ts";
import type { MatrixArtifactReaderV1 } from "./matrix-artifact-context.ts";
import {
  instant,
  type Json,
  positive,
  record,
  refuse,
} from "./matrix-artifact-values.ts";

const API = `https://api.github.com/repos/${REPOSITORY}/actions`;
/** Bound of the whole authenticated read; the apply has its own deadline. */
export const REPAIR_FANOUT_READ_BUDGET_MS = 120_000;
export const REPAIR_CELL_STEP = "Run repository repair cell";

export interface RepairFanoutFinalizeInputV1 {
  /** Native read token (Actions read). */
  token: string;
  /** Bounded Actions transport (`createActionsMatrixArtifactHttpTransport`). */
  http: HttpTransportV1;
  clock: Clock;
  /** The trusted repair state writer (the existing tiered Git store). */
  state: RepairCycleDepsV1["state"];
  run: { runId: number; runAttempt: number; launcherSha: GitSha };
  /** The saved execution's runtime revision and generation. */
  runtime: { revision: GitSha; generation: number };
  /** The digest the native `matrix_plan` outputs carried. */
  planDigest: string;
  /** The shared run deadline: no write starts at or after it. */
  deadline: number;
}

type Reader = Pick<MatrixArtifactReaderV1, "json" | "pages" | "download">;
type Archive = ReturnType<typeof createMatrixArtifactArchive>;

function provenanceOf(
  attempt: Json,
  run: RepairFanoutFinalizeInputV1["run"],
): (artifact: Json) => void {
  const repo = record(attempt.repository);
  const headRepo = record(attempt.head_repository);
  if (
    attempt.id !== run.runId || attempt.run_attempt !== run.runAttempt ||
    attempt.workflow_id !== HOSTED_SUPERVISOR_WORKFLOW_ID ||
    attempt.path !== HOSTED_SUPERVISOR_WORKFLOW_PATH ||
    attempt.event !== "workflow_dispatch" ||
    attempt.head_branch !== HOSTED_SUPERVISOR_REF.replace("refs/heads/", "") ||
    attempt.head_sha !== run.launcherSha ||
    repo.full_name !== REPOSITORY || headRepo.full_name !== REPOSITORY
  ) refuse();
  positive(repo.id);
  positive(headRepo.id);
  return (artifact) => {
    const provenance = record(artifact.workflow_run);
    if (
      provenance.id !== run.runId ||
      provenance.repository_id !== repo.id ||
      provenance.head_repository_id !== headRepo.id ||
      provenance.head_branch !== attempt.head_branch ||
      provenance.head_sha !== run.launcherSha
    ) refuse();
  };
}

/** The one marker in the producer job's own log, inside its step window. */
async function cellMarker(
  reader: Reader,
  job: Json,
  input: RepairFanoutFinalizeInputV1,
  cellId: string,
): Promise<Json> {
  if (
    job.run_id !== input.run.runId ||
    job.run_attempt !== input.run.runAttempt ||
    job.head_sha !== input.run.launcherSha || job.status !== "completed" ||
    !["success", "failure"].includes(String(job.conclusion)) ||
    !Array.isArray(job.steps)
  ) refuse();
  const steps = job.steps.map(record).filter((step) =>
    step.name === REPAIR_CELL_STEP
  );
  if (
    steps.length !== 1 || steps[0].status !== "completed" ||
    !["success", "failure"].includes(String(steps[0].conclusion))
  ) refuse();
  const start = instant(steps[0].started_at);
  const end = instant(steps[0].completed_at);
  if (
    end < start || end > input.clock.now() + TOLERANCE ||
    start + TOLERANCE < instant(job.started_at) ||
    end > instant(job.completed_at) + TOLERANCE
  ) refuse();
  const log = await reader.download(`/jobs/${positive(job.id)}/logs`, false);
  const found: Json[] = [];
  for (const line of log.bodyText.split("\n")) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\S+Z)\s+(\{.*\})\s*$/);
    if (!match) continue;
    let value: Json;
    try {
      value = record(JSON.parse(match[2]));
    } catch {
      continue;
    }
    if (value.kind !== REPAIR_CELL_MARKER_KIND) continue;
    const at = instant(match[1]);
    if (
      at + TOLERANCE < start || at > end + TOLERANCE ||
      !isRepairCellMarker(value, {
        ...input.run,
        revision: input.runtime.revision,
        generation: input.runtime.generation,
      }, cellId)
    ) refuse();
    found.push(value);
  }
  if (found.length !== 1) refuse();
  return found[0];
}

function only(files: Map<string, Uint8Array>, name: string): Uint8Array {
  const bytes = files.get(name);
  if (files.size !== 1 || bytes === undefined) refuse();
  return bytes;
}

/**
 * Authenticate the plan and every cell's delta. Null when the plan itself
 * cannot be authenticated (nothing is applied).
 */
export async function authenticateRepairFanout(
  input: RepairFanoutFinalizeInputV1,
  reader: Reader,
  archive: Archive,
): Promise<
  { plan: RepairFanoutPlanV1; artifacts: RepairDeltaArtifactV1[] } | null
> {
  const { runId, runAttempt } = input.run;
  let plan: RepairFanoutPlanV1;
  let artifacts: Json[];
  let jobs: Json[];
  let provenance: (artifact: Json) => void;
  try {
    const attempt = await reader.json(
      `${API}/runs/${runId}/attempts/${runAttempt}`,
    );
    provenance = provenanceOf(attempt, input.run);
    artifacts = await reader.pages(`/runs/${runId}/artifacts`, "artifacts");
    jobs = await reader.pages(
      `/runs/${runId}/attempts/${runAttempt}/jobs`,
      "jobs",
    );
    const planners = jobs.filter((job) => job.name === "matrix_plan");
    if (planners.length !== 1 || planners[0].conclusion !== "success") {
      refuse();
    }
    const plans = artifacts.filter((row) =>
      row.name === `sentinel-repair-plan-${runId}-${runAttempt}`
    );
    if (plans.length !== 1) refuse();
    provenance(plans[0]);
    const bytes = only(await archive(plans[0]), "plan.json");
    plan = await parseRepairFanoutPlanV1(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      await repairFanoutPlanDigestV1(plan) !== input.planDigest ||
      plan.runId !== runId || plan.runAttempt !== runAttempt
    ) refuse();
  } catch {
    return null;
  }
  const cells: RepairDeltaArtifactV1[] = [];
  for (const cell of plan.cells) {
    const name = `sentinel-repair-cell-${runId}-${runAttempt}-${cell.cellId}`;
    const rows = artifacts.filter((row) => row.name === name);
    const producers = jobs.filter((job) =>
      job.name === `repair_cell (${cell.cellId})`
    );
    if (
      rows.length === 0 || producers.length === 0 ||
      producers.some((job) => job.status !== "completed")
    ) {
      cells.push({ cellId: cell.cellId, envelope: null });
      continue;
    }
    try {
      if (rows.length !== 1 || producers.length !== 1) refuse();
      provenance(rows[0]);
      const marker = await cellMarker(reader, producers[0], input, cell.cellId);
      const envelope = decodeRepairDeltaArtifactV1(
        only(await archive(rows[0]), "result.json"),
      );
      if (
        typeof envelope !== "object" || envelope === null ||
        (envelope as Json).digest !== marker.deltaDigest
      ) refuse();
      cells.push({ cellId: cell.cellId, envelope });
    } catch {
      // Not a sealed envelope: `applyRepairDeltas` counts it unauthenticated.
      cells.push({ cellId: cell.cellId, envelope: "unauthenticated" });
    }
  }
  return { plan, artifacts: cells };
}

/** Authenticate and apply; null when the plan could not be authenticated. */
export async function runRepairFanoutFinalize(
  input: RepairFanoutFinalizeInputV1,
  seams: { reader?: Reader; archive?: Archive } = {},
): Promise<RepairDeltaApplyResultV1 | null> {
  const started = input.clock.now();
  const until = Math.min(
    started + REPAIR_FANOUT_READ_BUDGET_MS,
    input.deadline,
  );
  if (until <= started) return null;
  const deadline = createDeadline(until - started);
  const controller = new AbortController();
  try {
    const reader = seams.reader ?? createMatrixArtifactHttp(
      {
        state: input.state,
        token: input.token,
        http: input.http,
        clock: input.clock,
        artifactRoot: "",
      },
      until,
      deadline,
      { id: null },
    );
    const archive = seams.archive ??
      createMatrixArtifactArchive(reader.download, deadline, controller);
    const authenticated = await authenticateRepairFanout(
      input,
      reader,
      archive,
    );
    if (authenticated === null) return null;
    return await applyRepairDeltas(input, {
      plan: authenticated.plan,
      artifacts: authenticated.artifacts,
      deadline: input.deadline,
    });
  } finally {
    controller.abort();
    deadline.dispose();
  }
}
