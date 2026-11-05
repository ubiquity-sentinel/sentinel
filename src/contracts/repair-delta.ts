/**
 * RepairDeltaV1: the bounded result of one repository's fan-out repair pass
 * (issue #328).
 *
 * A repository cell steps its repository's live records against a read-only
 * hot snapshot and writes nothing shared: it returns this delta instead. The
 * delta carries only replacement rows for EXISTING work records of its one
 * repository (their waits, intents, blockers, targets and #326 step stamps),
 * the exact state head it was planned on and the digest of the repository
 * projection it read at that head. It never carries a reservation, a charge,
 * a review receipt, a replay, a release request or a new record.
 *
 * Sealing: the envelope's `digest` is the canonical SHA-256 of the delta,
 * bound to the producing run, attempt and plan. Authenticity is the same
 * mechanism the matrix cells use: the trusted consumer downloads the exact
 * named artifact of the exact producer job of this run attempt through the
 * authenticated Actions transport, which verifies the archive digest GitHub
 * recorded at upload. The seal then binds the bytes inside that archive to
 * the run, plan and repository the consumer expects; an unsealed, rebound or
 * edited delta is refused before any of its rows is considered.
 */
import type { GitSha } from "./brands.ts";
import { canonicalStringify } from "./canonical.ts";
import {
  parseRepositoryIdentity,
  type RepositoryIdentityV1,
} from "./shared.ts";
import type { RepairStateSnapshotV1 } from "./state-snapshots.ts";
import {
  expectArray,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  expectVersion,
  fail,
  MaxItems,
} from "./validation.ts";
import { parseWorkRecordV1, type WorkRecordV1 } from "./work-record.ts";

export const REPAIR_DELTA_KIND = "repair_delta";
export const REPAIR_DELTA_ENVELOPE_KIND = "repair_delta_envelope";
/** Every transition is one existing record; never more than the hot ledger. */
export const MAX_REPAIR_DELTA_TRANSITIONS = MaxItems.snapshotRecords;
/**
 * Serialized envelope bound (the consumer refuses larger bytes unread); the
 * same bound the authenticated archive reader applies to a `result.json`.
 */
export const MAX_REPAIR_DELTA_BYTES = 2 * 1024 * 1024;

/** The run, attempt and plan one delta was produced for. */
export interface RepairDeltaBindingV1 {
  runId: number;
  runAttempt: number;
  /** Canonical digest of the repository fan-out plan of that run. */
  planDigest: string;
}

/** One existing record's replacement row. */
export interface RepairDeltaTransitionV1 {
  /** Canonical SHA-256 of the record exactly as it was at the base head. */
  before: string;
  after: WorkRecordV1;
}

export interface RepairDeltaV1 {
  version: "v1";
  kind: typeof REPAIR_DELTA_KIND;
  repository: RepositoryIdentityV1;
  binding: RepairDeltaBindingV1;
  /** Exact authoritative repair state head the cell read. */
  baseHead: GitSha;
  /** `repairProjectionDigestV1` of the repository at `baseHead`. */
  baseDigest: string;
  /** Sorted by record id; each id at most once. */
  transitions: RepairDeltaTransitionV1[];
  /**
   * Ids whose step needed an effect a cell may not perform (a GitHub write,
   * a model start, a reservation, a replay or a shared-collection write):
   * none of their rows is in `transitions`; the trusted path steps them.
   */
  deferredToTrusted: string[];
  /** Wall time of the cell's pass (advisory, for the metrics collector). */
  startedAt: number;
  finishedAt: number;
}

export interface RepairDeltaEnvelopeV1 {
  version: "v1";
  kind: typeof REPAIR_DELTA_ENVELOPE_KIND;
  delta: RepairDeltaV1;
  /** `repairDeltaDigestV1(delta)`. */
  digest: string;
}

const DELTA_KEYS = [
  "version",
  "kind",
  "repository",
  "binding",
  "baseHead",
  "baseDigest",
  "transitions",
  "deferredToTrusted",
  "startedAt",
  "finishedAt",
] as const;
const BINDING_KEYS = ["runId", "runAttempt", "planDigest"] as const;
const TRANSITION_KEYS = ["before", "after"] as const;
const ENVELOPE_KEYS = ["version", "kind", "delta", "digest"] as const;
const RECORD_ID = /^[A-Za-z0-9._:-]{1,256}$/;

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Canonical SHA-256 of any JSON value (record digests, the seal). */
export function canonicalDigestV1(value: unknown): Promise<string> {
  return sha256Hex(canonicalStringify(value));
}

export function sameRepositoryV1(
  left: RepositoryIdentityV1,
  right: RepositoryIdentityV1,
): boolean {
  return left.owner === right.owner && left.name === right.name &&
    left.installationId === right.installationId;
}

function rowRepository(row: unknown): RepositoryIdentityV1 | null {
  if (typeof row !== "object" || row === null) return null;
  const value = row as Record<string, unknown>;
  const direct = value.repository;
  const nested = typeof value.target === "object" && value.target !== null
    ? (value.target as Record<string, unknown>).repository
    : undefined;
  const candidate = direct ?? nested;
  if (
    typeof candidate !== "object" || candidate === null ||
    typeof (candidate as RepositoryIdentityV1).owner !== "string" ||
    typeof (candidate as RepositoryIdentityV1).name !== "string"
  ) return null;
  return candidate as RepositoryIdentityV1;
}

/**
 * Snapshot keys the projection leaves out: write bookkeeping, the advisory
 * cooldown records (the existing synchronization admits cooldown-only
 * movement the same way) and the deterministic lesson view, which is rebuilt
 * from attempt memory, itself part of the projection.
 */
const PROJECTION_EXCLUDED = new Set([
  "stateHead",
  "sequence",
  "updatedAt",
  "githubCooldowns",
  "lessons",
]);

function pullNumberOf(row: unknown): number | null {
  const value = row as {
    target?: { pr?: unknown };
    intent?: { pr?: unknown } | null;
  };
  const pr = value.target?.pr ?? value.intent?.pr ?? null;
  return typeof pr === "number" ? pr : null;
}

/**
 * Canonical digest of everything a repository's pass can read from repair
 * state: every collection row bound to that repository, every row bound to no
 * repository, and none of another repository's rows. Two heads with the same
 * projection are indistinguishable to that pass, so a delta planned on one is
 * exactly as valid on the other; any movement of a row the pass could have
 * read changes the digest.
 *
 * With `scope` (the records delegated to that repository's cell), the
 * repository's rows narrow to the scope: its work records, the rows keyed to
 * them by `taskId` (reservations, archive, replays, attempt memory) and the
 * reviews and release requests of their pull requests. Rows bound to no
 * repository and the repository's other unkeyed rows stay in, so the trusted
 * serial pass moving another record of the same repository does not make a
 * delegated delta stale, while any movement a delegated step could read does.
 */
export function repairProjectionDigestV1(
  snapshot: RepairStateSnapshotV1,
  repository: RepositoryIdentityV1,
  scope?: ReadonlySet<string>,
): Promise<string> {
  const pulls = new Set<number>();
  if (scope !== undefined) {
    for (const record of snapshot.work) {
      const pr = pullNumberOf(record);
      if (scope.has(record.id) && pr !== null) pulls.add(pr);
    }
  }
  const inScope = (key: string, row: unknown): boolean => {
    if (scope === undefined || typeof row !== "object" || row === null) {
      return true;
    }
    const value = row as Record<string, unknown>;
    if (key === "work") return scope.has(String(value.id));
    if (typeof value.taskId === "string") return scope.has(value.taskId);
    if (key === "reviews") {
      const pr = (value.pullRequest as { number?: unknown } | undefined)
        ?.number;
      return typeof pr === "number" && pulls.has(pr);
    }
    if (key === "releaseRequests") {
      const pr = (value.source as { pullRequest?: unknown } | undefined)
        ?.pullRequest;
      return typeof pr === "number" && pulls.has(pr);
    }
    return true;
  };
  const projection: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (PROJECTION_EXCLUDED.has(key) || value === undefined) continue;
    projection[key] = Array.isArray(value)
      ? value.filter((row) => {
        const owner = rowRepository(row);
        if (owner === null) return true;
        return sameRepositoryV1(owner, repository) && inScope(key, row);
      })
      : value;
  }
  return canonicalDigestV1(projection);
}

/** The seal of one delta. */
export function repairDeltaDigestV1(delta: RepairDeltaV1): Promise<string> {
  return canonicalDigestV1({ kind: REPAIR_DELTA_ENVELOPE_KIND, delta });
}

export async function sealRepairDeltaV1(
  delta: RepairDeltaV1,
): Promise<RepairDeltaEnvelopeV1> {
  const parsed = parseRepairDeltaV1(delta);
  return {
    version: "v1",
    kind: REPAIR_DELTA_ENVELOPE_KIND,
    delta: parsed,
    digest: await repairDeltaDigestV1(parsed),
  };
}

function parseBinding(input: unknown, path: string): RepairDeltaBindingV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, BINDING_KEYS, path);
  return {
    runId: expectPositiveInt(obj.runId, `${path}.runId`),
    runAttempt: expectPositiveInt(obj.runAttempt, `${path}.runAttempt`),
    planDigest: expectSha256Hex(obj.planDigest, `${path}.planDigest`),
  };
}

export function parseRepairDeltaV1(input: unknown): RepairDeltaV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, DELTA_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, [REPAIR_DELTA_KIND], "$.kind");
  const repository = parseRepositoryIdentity(obj.repository, "$.repository");
  const transitions = expectArray(
    obj.transitions,
    "$.transitions",
    MAX_REPAIR_DELTA_TRANSITIONS,
    (item, path) => {
      const row = expectRecord(item, path);
      expectExactKeys(row, TRANSITION_KEYS, path);
      const after = parseWorkRecordV1(row.after);
      if (!sameRepositoryV1(after.repository, repository)) {
        fail(`${path}.after.repository`, "invalid_value", "foreign record");
      }
      return {
        before: expectSha256Hex(row.before, `${path}.before`),
        after,
      };
    },
  );
  for (let index = 1; index < transitions.length; index++) {
    if (transitions[index - 1].after.id >= transitions[index].after.id) {
      fail("$.transitions", "invalid_value", "unsorted or duplicate ids");
    }
  }
  const deferredToTrusted = expectArray(
    obj.deferredToTrusted,
    "$.deferredToTrusted",
    MAX_REPAIR_DELTA_TRANSITIONS,
    (item, path) =>
      expectPattern(
        item,
        path,
        RECORD_ID,
        "invalid_pattern",
        "expected work item id",
        256,
      ),
  );
  if (new Set(deferredToTrusted).size !== deferredToTrusted.length) {
    fail("$.deferredToTrusted", "invalid_value", "duplicate ids");
  }
  const startedAt = expectTimestamp(obj.startedAt, "$.startedAt");
  const finishedAt = expectTimestamp(obj.finishedAt, "$.finishedAt");
  if (finishedAt < startedAt) {
    fail("$.finishedAt", "invalid_value", "finished before started");
  }
  return {
    version: "v1",
    kind: REPAIR_DELTA_KIND,
    repository,
    binding: parseBinding(obj.binding, "$.binding"),
    baseHead: expectGitSha(obj.baseHead, "$.baseHead"),
    baseDigest: expectSha256Hex(obj.baseDigest, "$.baseDigest"),
    transitions,
    deferredToTrusted,
    startedAt,
    finishedAt,
  };
}

export type RepairDeltaOpenResultV1 =
  | { ok: true; delta: RepairDeltaV1 }
  | { ok: false; reason: "unauthenticated" | "invalid" };

/**
 * Open one envelope for the expected run, attempt, plan and repository. A
 * missing or wrong seal, or a delta bound to another run, plan or repository,
 * is `unauthenticated`; a sealed delta that fails the strict parse is
 * `invalid`. Nothing is trusted from a refused envelope.
 */
export async function openRepairDeltaV1(
  input: unknown,
  expected: {
    binding: RepairDeltaBindingV1;
    repository: RepositoryIdentityV1;
  },
): Promise<RepairDeltaOpenResultV1> {
  if (
    typeof input !== "object" || input === null || Array.isArray(input)
  ) return { ok: false, reason: "unauthenticated" };
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort().join();
  if (
    keys !== [...ENVELOPE_KEYS].sort().join() || obj.version !== "v1" ||
    obj.kind !== REPAIR_DELTA_ENVELOPE_KIND ||
    typeof obj.digest !== "string" || !/^[0-9a-f]{64}$/.test(obj.digest)
  ) return { ok: false, reason: "unauthenticated" };
  // The seal is checked over the raw bytes first: an edited body is
  // unauthenticated whatever else is wrong with it.
  let sealed: string;
  try {
    sealed = await canonicalDigestV1({
      kind: REPAIR_DELTA_ENVELOPE_KIND,
      delta: obj.delta,
    });
  } catch {
    return { ok: false, reason: "unauthenticated" };
  }
  if (sealed !== obj.digest) return { ok: false, reason: "unauthenticated" };
  // A sealed body must also parse strictly to exactly itself (no key the
  // parser would drop or rewrite).
  let delta: RepairDeltaV1;
  try {
    delta = parseRepairDeltaV1(obj.delta);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (canonicalStringify(delta) !== canonicalStringify(obj.delta)) {
    return { ok: false, reason: "invalid" };
  }
  if (
    delta.binding.runId !== expected.binding.runId ||
    delta.binding.runAttempt !== expected.binding.runAttempt ||
    delta.binding.planDigest !== expected.binding.planDigest ||
    !sameRepositoryV1(delta.repository, expected.repository)
  ) return { ok: false, reason: "unauthenticated" };
  return { ok: true, delta };
}

/** The artifact bytes of one sealed envelope; refuses an oversized delta. */
export function encodeRepairDeltaArtifactV1(
  envelope: RepairDeltaEnvelopeV1,
): Uint8Array {
  const bytes = new TextEncoder().encode(canonicalStringify(envelope));
  if (bytes.byteLength > MAX_REPAIR_DELTA_BYTES) {
    throw new RangeError("repair delta exceeds its artifact bound");
  }
  return bytes;
}

/**
 * The untrusted JSON value of one downloaded delta artifact, or null when it
 * exceeds the bound or is not JSON. `openRepairDeltaV1` decides the rest.
 */
export function decodeRepairDeltaArtifactV1(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_REPAIR_DELTA_BYTES) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}
