/** Repository-scoped, bounded planning artifacts; never a state-write capability. */
import type { GitSha } from "./brands.ts";
import { canonicalStringify } from "./canonical.ts";
import {
  parseRepositoryIdentity,
  type RepositoryIdentityV1,
} from "./shared.ts";
import { parseWorkRecordV1, type WorkRecordV1 } from "./work-record.ts";
import {
  expectArray,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectRecord,
  expectTimestamp,
  MaxItems,
} from "./validation.ts";

export const MAX_REPAIR_DELTA_BYTES = 1024 * 1024;

export interface RepairDeltaPlanV1 {
  runId: string;
  baseHead: GitSha;
  repository: RepositoryIdentityV1;
  /** Absolute shared deadline, not a fresh per-cell window. */
  runDeadline: number;
  records: readonly WorkRecordV1[];
}

/** Full replacement records carry intended transitions, waits and intents only. */
export interface RepairDeltaV1 {
  version: "v1";
  kind: "repair_delta";
  runId: string;
  baseHead: GitSha;
  repository: RepositoryIdentityV1;
  runDeadline: number;
  startedAt: number;
  completedAt: number;
  changes: WorkRecordV1[];
}

export interface SignedRepairDeltaV1 {
  delta: RepairDeltaV1;
  signature: string;
}

export function sameRepairRepository(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

function bounded(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_REPAIR_DELTA_BYTES) {
    throw new Error("repair delta exceeds artifact bound");
  }
}

/** Check the wire size before parsing any untrusted JSON. */
export function parseSignedRepairDelta(text: string): SignedRepairDeltaV1 {
  bounded(text);
  const envelope = expectRecord(JSON.parse(text), "$");
  expectExactKeys(envelope, ["delta", "signature"], "$");
  const obj = expectRecord(envelope.delta, "$.delta");
  expectExactKeys(obj, [
    "version",
    "kind",
    "runId",
    "baseHead",
    "repository",
    "runDeadline",
    "startedAt",
    "completedAt",
    "changes",
  ], "$.delta");
  if (obj.version !== "v1" || obj.kind !== "repair_delta") {
    throw new Error("invalid repair delta version or kind");
  }
  const delta: RepairDeltaV1 = {
    version: "v1",
    kind: "repair_delta",
    runId: expectNonEmptyString(obj.runId, "$.delta.runId", 128),
    baseHead: expectGitSha(obj.baseHead, "$.delta.baseHead"),
    repository: parseRepositoryIdentity(obj.repository, "$.delta.repository"),
    runDeadline: expectTimestamp(obj.runDeadline, "$.delta.runDeadline"),
    startedAt: expectTimestamp(obj.startedAt, "$.delta.startedAt"),
    completedAt: expectTimestamp(obj.completedAt, "$.delta.completedAt"),
    changes: expectArray(
      obj.changes,
      "$.delta.changes",
      MaxItems.snapshotRecords,
      parseWorkRecordV1,
    ),
  };
  const signature = expectNonEmptyString(
    envelope.signature,
    "$.signature",
    128,
  );
  if (!/^[0-9a-f]{128}$/.test(signature)) {
    throw new Error("invalid repair delta signature encoding");
  }
  if (
    delta.startedAt > delta.completedAt ||
    delta.completedAt > delta.runDeadline ||
    new Set(delta.changes.map((record) => record.id)).size !==
      delta.changes.length
  ) throw new Error("invalid repair delta bounds or duplicate records");
  return { delta, signature };
}

function signingBytes(delta: RepairDeltaV1): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    "sentinel.repair-delta.v1\n" + canonicalStringify(delta),
  );
}

/** The host supplies only a per-cell signing capability, never an App/state key. */
export async function signRepairDelta(
  delta: RepairDeltaV1,
  sign: (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>,
): Promise<string> {
  // Freeze and validate before an asynchronous signer can yield to its caller.
  const copy = parseSignedRepairDelta(canonicalStringify({
    delta,
    signature: "0".repeat(128),
  })).delta;
  const signature = [...await sign(signingBytes(copy))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const text = canonicalStringify({ delta: copy, signature });
  parseSignedRepairDelta(text);
  return text;
}

/** Public key is pinned by trusted preparation, never taken from the artifact. */
export function verifyRepairDelta(
  artifact: SignedRepairDeltaV1,
  publicKey: CryptoKey,
): Promise<boolean> {
  const signature = Uint8Array.from(
    artifact.signature.match(/../g)!,
    (byte) => parseInt(byte, 16),
  );
  return crypto.subtle.verify(
    "Ed25519",
    publicKey,
    signature,
    signingBytes(artifact.delta),
  );
}

/** Cells can propose bookkeeping for existing live records, not admissions. */
export function assertRepairDeltaScope(
  plan: RepairDeltaPlanV1,
  changes: readonly WorkRecordV1[],
): void {
  const records = new Map(plan.records.map((record) => [record.id, record]));
  for (const record of changes) {
    const prior = records.get(record.id);
    if (
      prior === undefined || prior.nextStep === "done" ||
      !sameRepairRepository(record.repository, plan.repository) ||
      !sameRepairRepository(prior.repository, plan.repository) ||
      canonicalStringify(record.counters) !== canonicalStringify(prior.counters)
    ) {
      throw new Error(
        "repair delta is outside its repository bookkeeping scope",
      );
    }
  }
}
