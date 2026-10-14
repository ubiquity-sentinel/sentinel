import type { WorkItemId } from "./brands.ts";
import { canonicalStringify } from "./canonical.ts";
import { parseRepositoryIdentity } from "./shared.ts";
import {
  expectArray,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectString,
  expectTimestamp,
  expectVersion,
  fail,
  type ParseRecordResult,
  tryParse,
} from "./validation.ts";
import {
  BUNDLE_KEYS,
  CELL_KEYS,
  MATRIX_CELL_RESULT_VERSION,
  MATRIX_PLAN_VERSION,
  MAX_ERROR_CHARS,
  MAX_ID_CHARS,
  MAX_MATRIX_CELLS,
  parseMatrixRunIdentityV1,
  PLAN_KEYS,
  RESULT_KEYS,
} from "./matrix-identity.ts";
import type {
  MatrixCellGrantV1,
  MatrixCellPlanV1,
  MatrixCellResultV1,
  MatrixPlanV1,
} from "./matrix-identity.ts";
import {
  parseMatrixModelReceiptV1,
  parseMatrixModelRequestV1,
} from "./matrix-model.ts";

/**
 * m19 matrix plan/cell/result contracts.
 *
 * The trusted planner writes ONE immutable plan per wave; every matrix cell
 * receives exactly one `MatrixCellGrantV1` and emits one
 * `MatrixCellResultV1`. These records are identity/binding carriers only: the
 * embedded `ModelRunRequestV1`/`ModelRunReceiptV1` are parsed strictly here,
 * but no field is acceptance authority. The trusted ingester re-reads
 * authoritative state, re-verifies the receipt projection against the exact
 * request, and reuses the production receipt/candidate consumers.
 *
 * Bounded at `MAX_MATRIX_CELLS` (the native platform matrix ceiling; never a
 * lower artificial throttle). No durable state-store field or ref is added:
 * plan/result artifacts live in the runner workspace and Actions artifacts.
 */
/** Deterministic bundle basename for one cell: the opaque cell id + suffix. */
export function matrixBundleFileNameV1(cellId: string): string {
  return `${cellId}.bundle`;
}

/**
 * Stable opaque per-cell identity derived from the exact bound wave, task and
 * admission reservation. It is 64 lowercase hex characters so it is safe as a
 * native artifact/upload name (never a colon-delimited task id).
 */
export function matrixCellIdV1(
  waveId: string,
  taskId: string,
  reservationId: string,
): Promise<string> {
  return matrixDigestV1({ waveId, taskId, reservationId });
}

/** Canonical SHA-256 digest binding the exact planned request bytes. */
export async function matrixDigestV1(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseMatrixCellPlanV1(
  input: unknown,
  path: string,
): MatrixCellPlanV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CELL_KEYS, path);
  return {
    cellId: expectNonEmptyString(obj.cellId, `${path}.cellId`, MAX_ID_CHARS),
    taskId: expectPattern(
      obj.taskId,
      `${path}.taskId`,
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected a bounded work id",
      MAX_ID_CHARS,
    ) as WorkItemId,
    repository: parseRepositoryIdentity(obj.repository, `${path}.repository`),
    reservationId: expectNonEmptyString(
      obj.reservationId,
      `${path}.reservationId`,
      MAX_ID_CHARS,
    ),
    intentKey: expectNonEmptyString(
      obj.intentKey,
      `${path}.intentKey`,
      MAX_ID_CHARS,
    ),
    expectedBase: expectGitSha(obj.expectedBase, `${path}.expectedBase`),
    runtimeSha: expectGitSha(obj.runtimeSha, `${path}.runtimeSha`),
    generation: expectPositiveInt(obj.generation, `${path}.generation`),
    requestDigest: expectNonEmptyString(
      obj.requestDigest,
      `${path}.requestDigest`,
      MAX_ID_CHARS,
    ),
    request: parseMatrixModelRequestV1(obj.request, `${path}.request`),
  };
}

export function parseMatrixPlanV1(input: unknown): MatrixPlanV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, PLAN_KEYS, "$");
  expectVersion(obj.version, "$.version");
  if (obj.kind !== "matrix_plan") {
    fail("$.kind", "invalid_enum", "kind must be matrix_plan");
  }
  const cells = expectArray(
    obj.cells,
    "$.cells",
    MAX_MATRIX_CELLS,
    parseMatrixCellPlanV1,
  );
  return {
    version: MATRIX_PLAN_VERSION,
    kind: "matrix_plan",
    waveId: expectNonEmptyString(obj.waveId, "$.waveId", MAX_ID_CHARS),
    run: parseMatrixRunIdentityV1(obj.run, "$.run"),
    plannedAt: expectTimestamp(obj.plannedAt, "$.plannedAt"),
    cells,
  };
}

export function parseMatrixCellResultV1(input: unknown): MatrixCellResultV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, RESULT_KEYS, "$");
  expectVersion(obj.version, "$.version");
  if (obj.kind !== "matrix_cell_result") {
    fail("$.kind", "invalid_enum", "kind must be matrix_cell_result");
  }
  const status = expectEnum(
    obj.status,
    ["completed", "failed", "not_started"],
    "$.status",
  );
  const receipt = expectNullable(
    obj.receipt,
    "$.receipt",
    parseMatrixModelReceiptV1,
  );
  if (status === "completed" && receipt === null) {
    fail("$.receipt", "missing_field", "a completed result requires a receipt");
  }
  if (status !== "completed" && receipt !== null) {
    fail(
      "$.receipt",
      "invalid_lifecycle",
      "a non-completed result cannot carry a receipt",
    );
  }
  const bundle = expectNullable(
    obj.bundle,
    "$.bundle",
    (value, at) => {
      const item = expectRecord(value, at);
      expectExactKeys(item, BUNDLE_KEYS, at);
      const file = expectPattern(
        item.file,
        `${at}.file`,
        /^[0-9a-f]{64}\.bundle$/,
        "invalid_pattern",
        "expected a 64-hex cell id plus .bundle",
        80,
      );
      return {
        file,
        digest: expectSha256Hex(item.digest, `${at}.digest`),
        head: expectGitSha(item.head, `${at}.head`),
        checkpointSha: expectNullable(
          item.checkpointSha,
          `${at}.checkpointSha`,
          expectGitSha,
        ),
      };
    },
  );
  if (status !== "completed" && bundle !== null) {
    fail(
      "$.bundle",
      "invalid_lifecycle",
      "a non-completed result cannot carry a candidate bundle",
    );
  }
  const candidateHead = receipt?.candidate?.head ?? null;
  if (status === "completed" && candidateHead !== null) {
    if (bundle === null) {
      fail(
        "$.bundle",
        "missing_field",
        "a completed result with a candidate head requires its bundle",
      );
    }
    if (bundle.head !== candidateHead) {
      fail(
        "$.bundle.head",
        "invalid_lifecycle",
        "the bundle must carry the exact receipt candidate head",
      );
    }
    if (bundle.checkpointSha !== (receipt?.candidate?.checkpointSha ?? null)) {
      fail(
        "$.bundle.checkpointSha",
        "invalid_lifecycle",
        "the bundle checkpoint identity must match the receipt",
      );
    }
  }
  const detail = expectNullable(
    obj.detail,
    "$.detail",
    (value, at) => expectString(value, at, MAX_ERROR_CHARS),
  );
  if (status !== "completed" && detail === null) {
    fail(
      "$.detail",
      "missing_field",
      "a non-completed result requires a detail",
    );
  }
  return {
    version: MATRIX_CELL_RESULT_VERSION,
    kind: "matrix_cell_result",
    waveId: expectNonEmptyString(obj.waveId, "$.waveId", MAX_ID_CHARS),
    cellId: expectNonEmptyString(obj.cellId, "$.cellId", MAX_ID_CHARS),
    taskId: expectPattern(
      obj.taskId,
      "$.taskId",
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected a bounded work id",
      MAX_ID_CHARS,
    ) as WorkItemId,
    repository: parseRepositoryIdentity(obj.repository, "$.repository"),
    run: parseMatrixRunIdentityV1(obj.run, "$.run"),
    runtimeSha: expectGitSha(obj.runtimeSha, "$.runtimeSha"),
    generation: expectPositiveInt(obj.generation, "$.generation"),
    reservationId: expectNonEmptyString(
      obj.reservationId,
      "$.reservationId",
      MAX_ID_CHARS,
    ),
    intentKey: expectNonEmptyString(obj.intentKey, "$.intentKey", MAX_ID_CHARS),
    requestDigest: expectNonEmptyString(
      obj.requestDigest,
      "$.requestDigest",
      MAX_ID_CHARS,
    ),
    status,
    receipt,
    bundle,
    detail,
    completedAt: expectTimestamp(obj.completedAt, "$.completedAt"),
  };
}

export function tryParseMatrixPlanV1(
  input: unknown,
): ParseRecordResult<MatrixPlanV1> {
  return tryParse(parseMatrixPlanV1, input);
}

export function tryParseMatrixCellResultV1(
  input: unknown,
): ParseRecordResult<MatrixCellResultV1> {
  return tryParse(parseMatrixCellResultV1, input);
}

export function tryParseMatrixCellGrantV1(
  input: unknown,
): ParseRecordResult<MatrixCellGrantV1> {
  return tryParse((value) => {
    const obj = expectRecord(value, "$");
    expectExactKeys(obj, ["waveId", "run", "cell"], "$");
    return {
      waveId: expectNonEmptyString(obj.waveId, "$.waveId", MAX_ID_CHARS),
      run: parseMatrixRunIdentityV1(obj.run, "$.run"),
      cell: parseMatrixCellPlanV1(obj.cell, "$.cell"),
    };
  }, input);
}

export {
  MATRIX_CELL_PATH,
  MATRIX_CELL_RESULT_VERSION,
  MATRIX_DECOMPOSE_AFTER_TIMEOUTS,
  MATRIX_DECOMPOSE_MAX_PARTS,
  MATRIX_PLAN_PATH,
  MATRIX_PLAN_VERSION,
  MATRIX_RESULT_PATH,
  MATRIX_RESULTS_DIR,
  MAX_MATRIX_ARCHIVE_BYTES,
  MAX_MATRIX_ARCHIVE_OVERHEAD_BYTES,
  MAX_MATRIX_ARTIFACT_BYTES,
  MAX_MATRIX_BUNDLE_BYTES,
  MAX_MATRIX_CELLS,
  parseMatrixRunIdentityV1,
} from "./matrix-identity.ts";

export type {
  MatrixCellActualIdentityV1,
  MatrixCellBundleV1,
  MatrixCellGrantV1,
  MatrixCellPlanV1,
  MatrixCellResultStatusV1,
  MatrixCellResultV1,
  MatrixPlanV1,
  MatrixRunIdentityV1,
} from "./matrix-identity.ts";

export {
  parseMatrixModelReceiptV1,
  parseMatrixModelRequestV1,
} from "./matrix-model.ts";
