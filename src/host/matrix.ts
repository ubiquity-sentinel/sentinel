/** Public matrix plan, cell and ingestion facade with fixed artifact entrypoints. */
import {
  MATRIX_CELL_PATH,
  MATRIX_PLAN_PATH,
  MATRIX_RESULT_PATH,
  MATRIX_RESULTS_DIR,
  type MatrixCellActualIdentityV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  MAX_MATRIX_ARTIFACT_BYTES,
  tryParseMatrixCellGrantV1,
  tryParseMatrixCellResultV1,
  tryParseMatrixPlanV1,
} from "../contracts/matrix.ts";
import type { RepairCycleDepsV1 } from "../repair/loop.ts";
import {
  type MatrixPlanOptionsV1,
  type MatrixPlanReportV1,
  planMatrixWave,
} from "./matrix-planner.ts";
import { type MatrixCellDepsV1, runMatrixCell } from "./matrix-cell.ts";
import {
  ingestMatrixResults,
  type MatrixIngestOptionsV1,
  type MatrixIngestReportV1,
} from "./matrix-ingest.ts";

async function writeJsonArtifact(
  path: string,
  value: unknown,
): Promise<string> {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (new TextEncoder().encode(text).length > MAX_MATRIX_ARTIFACT_BYTES) {
    throw new Error("matrix artifact exceeds the bounded size");
  }
  const slash = path.lastIndexOf("/");
  if (slash > 0) await Deno.mkdir(path.slice(0, slash), { recursive: true });
  await Deno.writeTextFile(path, text);
  return await matrixDigestV1(value);
}

async function readJsonArtifact(path: string): Promise<unknown> {
  const text = await Deno.readTextFile(path);
  if (new TextEncoder().encode(text).length > MAX_MATRIX_ARTIFACT_BYTES) {
    throw new Error("matrix artifact exceeds the bounded size");
  }
  return JSON.parse(text) as unknown;
}

/** Planner entrypoint: writes the immutable plan artifact, returns its digest. */
export async function runMatrixPlanEntrypoint(input: {
  deps: RepairCycleDepsV1;
  options: MatrixPlanOptionsV1;
  planPath?: string;
}): Promise<MatrixPlanReportV1 & { planDigest: string }> {
  const report = await planMatrixWave(input.deps, input.options);
  return await writeMatrixPlanReport(report, input.planPath);
}

/** Persist a strictly constructed report, including an honest zero-grant host hold. */
export async function writeMatrixPlanReport(
  report: MatrixPlanReportV1,
  planPath = MATRIX_PLAN_PATH,
): Promise<MatrixPlanReportV1 & { planDigest: string }> {
  const planDigest = await writeJsonArtifact(
    planPath,
    report.plan,
  );
  return { ...report, planDigest };
}

/**
 * Cell entrypoint: reads one strictly parsed grant artifact, runs it under the
 * host's TRUSTED actual identity, and writes one result artifact.
 */
export async function runMatrixCellEntrypoint(input: {
  deps: MatrixCellDepsV1;
  actual: MatrixCellActualIdentityV1;
  cellPath?: string;
  resultPath?: string;
  completedAt?: number;
}): Promise<MatrixCellResultV1> {
  const raw = await readJsonArtifact(input.cellPath ?? MATRIX_CELL_PATH);
  const parsed = tryParseMatrixCellGrantV1(raw);
  if (!parsed.ok) {
    throw new Error("cell grant artifact is malformed");
  }
  const result = await runMatrixCell(
    input.deps,
    parsed.value,
    input.actual,
    input.completedAt ?? Date.now(),
  );
  await writeJsonArtifact(input.resultPath ?? MATRIX_RESULT_PATH, result);
  return result;
}

/** Ingester entrypoint: strictly parses the plan and every result artifact. */
export async function runMatrixIngestEntrypoint(input: {
  deps: RepairCycleDepsV1;
  options: MatrixIngestOptionsV1;
  planPath?: string;
  resultsDir?: string;
}): Promise<MatrixIngestReportV1> {
  const rawPlan = await readJsonArtifact(input.planPath ?? MATRIX_PLAN_PATH);
  const plan = tryParseMatrixPlanV1(rawPlan);
  if (!plan.ok) {
    throw new Error("plan artifact is malformed");
  }
  const results: MatrixCellResultV1[] = [];
  const dir = input.resultsDir ?? MATRIX_RESULTS_DIR;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const raw = await readJsonArtifact(`${dir}/${entry.name}`);
      const parsed = tryParseMatrixCellResultV1(raw);
      if (!parsed.ok) continue;
      results.push(parsed.value);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return await ingestMatrixResults(
    input.deps,
    plan.value,
    results,
    input.options,
  );
}

export {
  matrixResultsConflictV1,
  verifyMatrixReceiptV1,
} from "./matrix-identity.ts";
export {
  type MatrixPlanDiagnosticV1,
  type MatrixPlanOptionsV1,
  type MatrixPlanReportV1,
  planMatrixWave,
} from "./matrix-planner.ts";
export { type MatrixCellDepsV1, runMatrixCell } from "./matrix-cell.ts";
export {
  ingestMatrixResults,
  type MatrixIngestDispositionV1,
  type MatrixIngestEntryV1,
  type MatrixIngestOptionsV1,
  type MatrixIngestReportV1,
} from "./matrix-ingest.ts";
