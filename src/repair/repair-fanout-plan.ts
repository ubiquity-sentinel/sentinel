/**
 * The repository fan-out plan of one supervisor run (issue #328).
 *
 * The plan delegates, per configured repository, the live records whose last
 * settled step was an observation (they carry a #326 step stamp) and whose
 * next step therefore most likely needs only reads: not done or blocked, no
 * model implementation or replay intent (those stay with the planner, cells
 * and the trusted ingest), and no dependency on another record. An
 * observation includes a step that only re-armed a running read wait of an
 * intent-free record (`backoff`, `unavailable`, `deployment`, `ci_pending`,
 * `review_pending`; `step-observation.ts`), so waiting records and CI and
 * review result reads are delegated once one such step settled. One
 * repository cell steps exactly its delegated records; the trusted serial pass
 * skips them and keeps every other record (intake, new work, effects). A
 * delegated record whose step turns out to need an effect is handed back: its
 * cell's delta drops the record's stamp, so the next plan leaves it with the
 * trusted path.
 *
 * The plan is bound to the run, its attempt and the planning head by a
 * canonical digest; every delta a cell returns names that digest, so the
 * trusted writer accepts only deltas of the plan it expects. Planning reads
 * state and writes nothing.
 */
import type { GitSha } from "../contracts/brands.ts";
import {
  canonicalDigestV1,
  type RepairDeltaBindingV1,
  sameRepositoryV1,
} from "../contracts/repair-delta.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import {
  parseRepositoryIdentity,
  type RepositoryIdentityV1,
} from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  expectArray,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectVersion,
  fail,
} from "../contracts/validation.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

/** GitHub Actions caps one matrix at 256 jobs. */
export const MAX_REPAIR_FANOUT_CELLS = 256;
/** Delegated records per cell; keeps one delta inside its artifact bound. */
export const MAX_REPAIR_FANOUT_RECORDS = 256;
export const REPAIR_FANOUT_PLAN_KIND = "repair_fanout_plan";

export interface RepairFanoutCellV1 {
  /** `repairFanoutCellIdV1(repository)`. */
  cellId: string;
  repository: RepositoryIdentityV1;
  /** Delegated record ids, sorted, each once. */
  records: string[];
}

export interface RepairFanoutPlanV1 {
  version: "v1";
  kind: typeof REPAIR_FANOUT_PLAN_KIND;
  runId: number;
  runAttempt: number;
  /** The repair state head the plan read. */
  baseHead: GitSha;
  /** Sorted by cell id; each repository at most once. */
  cells: RepairFanoutCellV1[];
}

export interface RepairFanoutMatrixV1 {
  include: { cellId: string; repository: string }[];
}

/** The deterministic cell identity of one repository. */
export function repairFanoutCellIdV1(
  repository: RepositoryIdentityV1,
): Promise<string> {
  return canonicalDigestV1({
    kind: "repair_fanout_cell",
    repository: {
      owner: repository.owner,
      name: repository.name,
      installationId: repository.installationId,
    },
  });
}

const NON_DELEGATED_INTENTS = new Set(["implementation", "replay"]);

/** True when a repository cell may step `record` (see the module notes). */
export function delegableRecordV1(record: WorkRecordV1): boolean {
  return record.nextStep !== "done" && record.nextStep !== "blocked" &&
    record.stepInputs !== undefined &&
    !NON_DELEGATED_INTENTS.has(record.intent?.kind ?? "") &&
    record.dependencies.length === 0;
}

export async function planRepairFanoutV1(input: {
  snapshot: RepairStateSnapshotV1;
  head: GitSha;
  configs: readonly RepositoryConfigV1[];
  runId: number;
  runAttempt: number;
}): Promise<RepairFanoutPlanV1> {
  const cells: RepairFanoutCellV1[] = [];
  const seen = new Set<string>();
  for (const config of input.configs) {
    const repository = config.repository;
    const cellId = await repairFanoutCellIdV1(repository);
    if (seen.has(cellId)) continue;
    seen.add(cellId);
    const records = input.snapshot.work
      .filter((record) =>
        sameRepositoryV1(record.repository, repository) &&
        delegableRecordV1(record)
      )
      .map((record) => record.id as string)
      .sort()
      .slice(0, MAX_REPAIR_FANOUT_RECORDS);
    if (records.length === 0) continue;
    cells.push({
      cellId,
      repository: {
        owner: repository.owner,
        name: repository.name,
        installationId: repository.installationId,
      },
      records,
    });
  }
  cells.sort((left, right) =>
    left.cellId < right.cellId ? -1 : left.cellId > right.cellId ? 1 : 0
  );
  return {
    version: "v1",
    kind: REPAIR_FANOUT_PLAN_KIND,
    runId: input.runId,
    runAttempt: input.runAttempt,
    baseHead: input.head,
    cells: cells.slice(0, MAX_REPAIR_FANOUT_CELLS),
  };
}

/** The plan's canonical digest (the `planDigest` every delta binds). */
export function repairFanoutPlanDigestV1(
  plan: RepairFanoutPlanV1,
): Promise<string> {
  return canonicalDigestV1(plan);
}

/** The binding every delta of this plan must carry. */
export async function repairFanoutBindingV1(
  plan: RepairFanoutPlanV1,
): Promise<RepairDeltaBindingV1> {
  return {
    runId: plan.runId,
    runAttempt: plan.runAttempt,
    planDigest: await repairFanoutPlanDigestV1(plan),
  };
}

/** The `strategy.matrix` value of the repository cells (empty: no cell). */
export function repairFanoutMatrixV1(
  plan: RepairFanoutPlanV1,
): RepairFanoutMatrixV1 {
  return {
    include: plan.cells.map((cell) => ({
      cellId: cell.cellId,
      repository: `${cell.repository.owner}/${cell.repository.name}`,
    })),
  };
}

/** Every record id the plan delegates, across all cells. */
export function delegatedRecordsV1(plan: RepairFanoutPlanV1): Set<string> {
  return new Set(plan.cells.flatMap((cell) => cell.records));
}

const PLAN_KEYS = [
  "version",
  "kind",
  "runId",
  "runAttempt",
  "baseHead",
  "cells",
] as const;
const CELL_KEYS = ["cellId", "repository", "records"] as const;
const RECORD_ID = /^[A-Za-z0-9._:-]{1,256}$/;

/** Strict parse of a plan read back from its artifact. */
export async function parseRepairFanoutPlanV1(
  input: unknown,
): Promise<RepairFanoutPlanV1> {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, PLAN_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, [REPAIR_FANOUT_PLAN_KIND], "$.kind");
  const cells = expectArray(
    obj.cells,
    "$.cells",
    MAX_REPAIR_FANOUT_CELLS,
    (item, path) => {
      const cell = expectRecord(item, path);
      expectExactKeys(cell, CELL_KEYS, path);
      const records = expectArray(
        cell.records,
        `${path}.records`,
        MAX_REPAIR_FANOUT_RECORDS,
        (id, at) =>
          expectPattern(
            id,
            at,
            RECORD_ID,
            "invalid_pattern",
            "expected work item id",
            256,
          ),
      );
      if (
        records.length === 0 ||
        records.some((id, index) => index > 0 && records[index - 1] >= id)
      ) fail(`${path}.records`, "invalid_value", "unsorted or empty records");
      return {
        cellId: expectSha256Hex(cell.cellId, `${path}.cellId`),
        repository: parseRepositoryIdentity(
          cell.repository,
          `${path}.repository`,
        ),
        records,
      };
    },
  );
  const ids = new Set<string>();
  for (const [index, cell] of cells.entries()) {
    if (
      cell.cellId !== await repairFanoutCellIdV1(cell.repository) ||
      (index > 0 && cells[index - 1].cellId >= cell.cellId)
    ) fail(`$.cells[${index}]`, "invalid_value", "cell identity or order");
    for (const id of cell.records) {
      if (ids.has(id)) fail("$.cells", "invalid_value", "record in two cells");
      ids.add(id);
    }
  }
  return {
    version: "v1",
    kind: REPAIR_FANOUT_PLAN_KIND,
    runId: expectPositiveInt(obj.runId, "$.runId"),
    runAttempt: expectPositiveInt(obj.runAttempt, "$.runAttempt"),
    baseHead: expectGitSha(obj.baseHead, "$.baseHead"),
    cells,
  };
}
