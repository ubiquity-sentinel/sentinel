import type { GitSha } from "./brands.ts";
import { HOSTED_CONTROLLER_REPOSITORY } from "./hosted-controller-deployment.ts";
import type { HostedExecutionIntentV1 } from "./hosted-supervisor.ts";
import { parseHostedExecutionIntentV1 } from "./hosted-supervisor-execution.ts";
import { MAX_MATRIX_CELLS } from "./matrix-identity.ts";
import type { PortResultV1 } from "./ports.ts";
import {
  expectArray,
  expectCount,
  expectExactKeys,
  expectExactKeysWithOptional,
  expectGitSha,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectVersion,
  fail,
} from "./validation.ts";

export const MAINTENANCE_INDEX_REF =
  "refs/heads/sentinel-state/maintenance-index";
export const MATRIX_INDEX_RELEASE_REF = "refs/heads/sentinel-state/release";
export const MAINTENANCE_INDEX_PATH = "current-matrix.json";

export interface MatrixHistoryPointV1 {
  head: GitSha;
  sequence: number;
}

/** A verified inclusive prefix; next is the first still-unexamined parent. */
export interface MatrixHistoryRangeV1 {
  from: MatrixHistoryPointV1;
  through: MatrixHistoryPointV1;
  next: MatrixHistoryPointV1 | null;
}

export interface MatrixProducerLocationV1 extends MatrixHistoryPointV1 {
  execution: HostedExecutionIntentV1;
  proofFingerprint: string;
  plan?: MatrixProducerPlanMembershipV1;
}

/** Positive complete plan membership; never a result or artifact-absence cache. */
export interface MatrixProducerPlanMembershipV1 {
  planDigest: string;
  plannerJobId: number;
  reservationIds: readonly string[];
}

export function parseMatrixProducerPlanMembershipV1(
  input: unknown,
  path = "matrixProducerPlanMembership",
): MatrixProducerPlanMembershipV1 {
  const row = expectRecord(input, path);
  expectExactKeys(row, ["planDigest", "plannerJobId", "reservationIds"], path);
  const reservationIds = expectArray(
    row.reservationIds,
    `${path}.reservationIds`,
    MAX_MATRIX_CELLS,
    expectSha256Hex,
  );
  if (new Set(reservationIds).size !== reservationIds.length) {
    fail(path, "invalid_value", "plan reservations must be unique");
  }
  return {
    planDigest: expectSha256Hex(row.planDigest, `${path}.planDigest`),
    plannerJobId: expectPositiveInt(row.plannerJobId, `${path}.plannerJobId`),
    reservationIds,
  };
}

/** Reconstructible discovery and positive plans; no state or settlement. */
export interface CurrentMatrixIndexV1 {
  version: "v1";
  kind: "current_matrix_index";
  controller: typeof HOSTED_CONTROLLER_REPOSITORY;
  releaseRef: typeof MATRIX_INDEX_RELEASE_REF;
  anchor: MatrixHistoryPointV1;
  ranges: MatrixHistoryRangeV1[];
  producers: MatrixProducerLocationV1[];
}

export interface CurrentMatrixIndexPortV1 {
  read(): Promise<
    PortResultV1<{
      head: GitSha | null;
      index: CurrentMatrixIndexV1 | null;
    }>
  >;
  write(input: {
    expectedHead: GitSha | null;
    index: CurrentMatrixIndexV1;
  }): Promise<
    PortResultV1<{
      status: "applied" | "conflict" | "ambiguous";
      head: GitSha | null;
    }>
  >;
}

function point(input: unknown, path: string): MatrixHistoryPointV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ["head", "sequence"], path);
  const sequence = expectCount(obj.sequence, `${path}.sequence`);
  if (sequence === 0) {
    fail(path, "invalid_count", "history sequence is positive");
  }
  return { head: expectGitSha(obj.head, `${path}.head`), sequence };
}

export function parseCurrentMatrixIndexV1(
  input: unknown,
): CurrentMatrixIndexV1 {
  const path = "currentMatrixIndex";
  const obj = expectRecord(input, path);
  expectExactKeys(obj, [
    "version",
    "kind",
    "controller",
    "releaseRef",
    "anchor",
    "ranges",
    "producers",
  ], path);
  expectVersion(obj.version, path);
  if (
    obj.kind !== "current_matrix_index" ||
    obj.controller !== HOSTED_CONTROLLER_REPOSITORY ||
    obj.releaseRef !== MATRIX_INDEX_RELEASE_REF
  ) fail(path, "invalid_value", "maintenance index identity changed");
  const anchor = point(obj.anchor, `${path}.anchor`);
  // No retention/count ceiling may discard an unexamined historical suffix.
  const ranges = expectArray(
    obj.ranges,
    `${path}.ranges`,
    Number.MAX_SAFE_INTEGER,
    (value, at): MatrixHistoryRangeV1 => {
      const row = expectRecord(value, at);
      expectExactKeys(row, ["from", "through", "next"], at);
      const from = point(row.from, `${at}.from`);
      const through = point(row.through, `${at}.through`);
      const next = row.next === null ? null : point(row.next, `${at}.next`);
      if (
        through.sequence > from.sequence ||
        (through.sequence === from.sequence && through.head !== from.head) ||
        (next === null
          ? through.sequence !== 1
          : next.sequence !== through.sequence - 1)
      ) {
        fail(at, "invalid_lifecycle", "range must advance to an older parent");
      }
      return { from, through, next };
    },
  );
  const seen = new Set<string>();
  let last = anchor.sequence + 1;
  for (const range of ranges) {
    if (seen.has(range.from.head) || range.from.sequence >= last) {
      fail(path, "invalid_lifecycle", "ranges are unique and newest first");
    }
    seen.add(range.from.head);
    last = range.next?.sequence ?? 0;
  }
  const producers = expectArray(
    obj.producers,
    `${path}.producers`,
    Number.MAX_SAFE_INTEGER,
    (value, at): MatrixProducerLocationV1 => {
      const row = expectRecord(value, at);
      expectExactKeysWithOptional(
        row,
        [
          "head",
          "sequence",
          "execution",
          "proofFingerprint",
        ],
        ["plan"],
        at,
      );
      const location = point({ head: row.head, sequence: row.sequence }, at);
      const execution = parseHostedExecutionIntentV1(
        row.execution,
        `${at}.execution`,
      );
      if (
        execution.purpose !== "ordinary" || execution.releaseId !== null ||
        typeof row.proofFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.proofFingerprint)
      ) {
        fail(at, "invalid_value", "ordinary producer fingerprint required");
      }
      if (
        !ranges.some((range) =>
          location.sequence <= range.from.sequence &&
          location.sequence > (range.next?.sequence ?? 0)
        )
      ) {
        fail(at, "invalid_lifecycle", "producer is outside verified ranges");
      }
      return {
        ...location,
        execution,
        proofFingerprint: row.proofFingerprint,
        ...(row.plan === undefined ? {} : {
          plan: parseMatrixProducerPlanMembershipV1(row.plan, `${at}.plan`),
        }),
      };
    },
  );
  if (new Set(producers.map((row) => row.head)).size !== producers.length) {
    fail(path, "invalid_lifecycle", "producer locations must be unique");
  }
  return {
    version: "v1",
    kind: "current_matrix_index",
    controller: HOSTED_CONTROLLER_REPOSITORY,
    releaseRef: MATRIX_INDEX_RELEASE_REF,
    anchor,
    ranges,
    producers,
  };
}
