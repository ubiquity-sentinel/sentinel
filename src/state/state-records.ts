import { parseAttemptMemoryRecordV1 } from "../contracts/attempt-memory.ts";
import { parseMemoryLessonsRecordV1 } from "../contracts/memory-lessons.ts";
import { parseBudgetReservationV1 } from "../contracts/budget-reservation.ts";
import { parseGitHubCooldownV1 } from "../contracts/github-cooldown.ts";
import {
  parseHostedReleaseRecordV1,
  parseHostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import {
  parseIncidentEvidenceV1,
  parseIncidentSummaryV1,
} from "../contracts/incident.ts";
import {
  parseReleaseRecordV1,
  parseReleaseRequestV1,
} from "../contracts/release.ts";
import { parseReplayResultV1 } from "../contracts/replay-result.ts";
import { parseReviewReceiptV1 } from "../contracts/review-receipt.ts";
import { parseOwnerSuccessorReviewV1 } from "../contracts/owner-successor-review.ts";
import {
  expectCount,
  expectExactKeys,
  expectGitSha,
  expectNullable,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
} from "../contracts/validation.ts";
import { parseWorkRecordV1 } from "../contracts/work-record.ts";
import { parseVpsReleaseRecordV1 } from "../contracts/vps-release.ts";
import type { GitSha } from "../contracts/brands.ts";

export type StateKind = "repair" | "release";

export interface StateManifestV1 {
  version: "v1";
  kind: "repair_state_manifest" | "release_state_manifest";
  sequence: number;
  updatedAt: number;
  stateHead: GitSha | null;
}

export const MANIFEST_KEYS = [
  "version",
  "kind",
  "sequence",
  "updatedAt",
  "stateHead",
] as const;
export const MANIFEST_KIND: Record<StateKind, StateManifestV1["kind"]> = {
  repair: "repair_state_manifest",
  release: "release_state_manifest",
};

export function parseStateManifest(
  input: unknown,
  path: string,
  kind: StateKind,
): StateManifestV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, MANIFEST_KEYS, path);
  expectVersion(obj.version, path);
  if (obj.kind !== MANIFEST_KIND[kind]) {
    fail(path, "invalid_lifecycle", "manifest kind does not match the ref");
  }
  return {
    version: "v1",
    kind: MANIFEST_KIND[kind],
    sequence: expectCount(obj.sequence, `${path}.sequence`),
    updatedAt: expectTimestamp(obj.updatedAt, `${path}.updatedAt`),
    stateHead: expectNullable(obj.stateHead, `${path}.stateHead`, expectGitSha),
  };
}

/**
 * Identity source of one validated state record. Every record kind carries
 * exactly one of the two: existing records identify by their string `id`,
 * while the durable GitHub cooldown fragment (repair and release roles) is
 * deliberately a kind-less plain data record addressing its storage slot by its
 * positive installation id (`githubCooldowns/sha256(String(installationId)).json`).
 */
export interface RecordIdentitySource {
  id?: string;
  installationId?: number;
}

export interface RecordCollection {
  directory: string;
  kind: string;
  parse: (input: unknown) => RecordIdentitySource;
  rows: { id: string; text: string }[];
}

export const RECORD_COLLECTIONS: Record<StateKind, RecordCollection[]> = {
  repair: [
    {
      directory: "incidents",
      kind: "incident_summary",
      parse: parseIncidentSummaryV1,
      rows: [],
    },
    {
      directory: "evidence",
      kind: "incident_evidence",
      parse: parseIncidentEvidenceV1,
      rows: [],
    },
    {
      directory: "work",
      kind: "work",
      parse: parseWorkRecordV1,
      rows: [],
    },
    {
      directory: "reservations",
      kind: "budget_reservation",
      parse: parseBudgetReservationV1,
      rows: [],
    },
    {
      directory: "reviews",
      kind: "review_receipt",
      parse: parseReviewReceiptV1,
      rows: [],
    },
    {
      directory: "ownerSuccessorReviews",
      kind: "owner_successor_review",
      parse: parseOwnerSuccessorReviewV1,
      rows: [],
    },
    {
      directory: "replays",
      kind: "replay_result",
      parse: parseReplayResultV1,
      rows: [],
    },
    {
      directory: "releaseRequests",
      kind: "release_request",
      parse: parseReleaseRequestV1,
      rows: [],
    },
    {
      directory: "githubCooldowns",
      kind: "github_cooldown",
      parse: parseGitHubCooldownV1,
      rows: [],
    },
    {
      directory: "attemptMemory",
      kind: "attempt_memory",
      parse: parseAttemptMemoryRecordV1,
      rows: [],
    },
    {
      directory: "lessons",
      kind: "memory_lessons",
      parse: parseMemoryLessonsRecordV1,
      rows: [],
    },
  ],
  release: [
    {
      directory: "vpsReleases",
      kind: "vps_release_record",
      parse: parseVpsReleaseRecordV1,
      rows: [],
    },
    {
      directory: "releases",
      kind: "release_record",
      parse: parseReleaseRecordV1,
      rows: [],
    },
    {
      directory: "hostedRuntimes",
      kind: "hosted_runtime",
      parse: parseHostedRuntimeRecordV1,
      rows: [],
    },
    {
      directory: "hostedReleases",
      kind: "hosted_release",
      parse: parseHostedReleaseRecordV1,
      rows: [],
    },
    {
      directory: "githubCooldowns",
      kind: "github_cooldown",
      parse: parseGitHubCooldownV1,
      rows: [],
    },
  ],
};

export function collectionDirectory(
  kind: StateKind,
  recordKind: string,
): string {
  const collection = RECORD_COLLECTIONS[kind].find(
    (c) => c.kind === recordKind,
  );
  if (collection === undefined) {
    throw new Error(`unknown record kind ${recordKind} for ${kind} state`);
  }
  return collection.directory;
}

/**
 * Storage identity of one validated record. Existing records use their string
 * id; the kind-less GitHub cooldown fragment is addressed by its positive
 * installation id (sha256(String(installationId)).json). A validated record
 * carries exactly one of the two; a record carrying neither is corrupt state
 * and fails closed instead of being written to a wrong storage slot.
 */
export function recordIdentity(record: RecordIdentitySource): string {
  if (record.id !== undefined) return record.id;
  if (record.installationId !== undefined) {
    return String(record.installationId);
  }
  throw new Error("state record has no storage identity");
}

export function orderRecords<T>(rows: { id: string; value: unknown }[]): T[] {
  return rows
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => row.value as T);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
