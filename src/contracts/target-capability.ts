/**
 * Cached target capability (issue #332): whether one generic target can supply
 * merge test evidence at one exact default-branch tip, as verified once per
 * runtime generation by the trusted launcher. The row is a cache, never an
 * authority over charges or history: it lives in the repair snapshot's
 * optional `targetCapabilities` collection, written only by the trusted repair
 * writer with an expected-head write, and it is invalidated by a moved tip or
 * a new runtime generation.
 *
 * Version tolerance: a version-1 row validates every known key and keeps any
 * additional key verbatim, so a newer writer's extra fields survive this
 * reader's write-back byte-for-byte. A row with another version is kept
 * opaque (only its id and version are validated) and is never used as a
 * capability verdict; readers treat it as absent.
 */
import type { GitSha } from "./brands.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import { parseRepositoryIdentity } from "./shared.ts";
import {
  expectBoolean,
  expectCount,
  expectEnum,
  expectNullable,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  fail,
} from "./validation.ts";
import { expectGitSha, expectSha256Hex } from "./validation-identities.ts";

/** The one supported row version. */
export const TARGET_CAPABILITY_VERSION = 1;

/** Closed vocabulary of what a target lacks, in canonical (sorted) order. */
export const TARGET_CAPABILITY_MISSING = [
  "pull_request_ci_workflow",
  "runnable_local_verify_command",
] as const;
export type TargetCapabilityMissingV1 =
  (typeof TARGET_CAPABILITY_MISSING)[number];

/** One verified capability verdict for one target at one tip. */
export interface TargetCapabilityRecordV1 {
  /** `target_capability:<installationId>/<owner>/<name>` (lower-case). */
  id: string;
  version: 1;
  repository: RepositoryIdentityV1;
  defaultBranch: string;
  /** Exact default-branch tip the verdict was derived from. */
  tip: GitSha;
  /** Runtime pointer generation that verified it. */
  generation: number;
  /** The target supplies merge test evidence (its own pull_request CI). */
  capable: boolean;
  /** Sorted, unique; empty exactly when nothing is missing. */
  missing: TargetCapabilityMissingV1[];
  /** sha256 of the canonical missing list. */
  missingDigest: string;
  /** The target is listed for cross-org backup CI. */
  backupCovered: boolean;
  /** The one open owner-action issue in the target, or null. */
  ownerIssue: number | null;
  /** The missing digest that issue's body currently states, or null. */
  ownerIssueDigest: string | null;
  checkedAt: number;
  /** Keys a newer version-1 writer added, preserved verbatim. */
  [extra: string]: unknown;
}

/** A row of an unsupported version: kept, never interpreted. */
export interface OpaqueTargetCapabilityV1 {
  id: string;
  version: number;
  [extra: string]: unknown;
}

export type StoredTargetCapabilityV1 =
  | TargetCapabilityRecordV1
  | OpaqueTargetCapabilityV1;

const ID_RE = /^target_capability:[0-9]+\/[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,255}$/;

/** The storage id of one repository's capability row. */
export function targetCapabilityIdV1(
  repository: Pick<RepositoryIdentityV1, "installationId" | "owner" | "name">,
): string {
  return `target_capability:${repository.installationId}/${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
}

/** Whether a stored row is a supported, interpretable verdict. */
export function isKnownTargetCapabilityV1(
  row: StoredTargetCapabilityV1,
): row is TargetCapabilityRecordV1 {
  return row.version === TARGET_CAPABILITY_VERSION;
}

export function parseTargetCapabilityV1(
  input: unknown,
): StoredTargetCapabilityV1 {
  const path = "$.targetCapability";
  const obj = expectRecord(input, path);
  const id = expectPattern(
    obj.id,
    `${path}.id`,
    ID_RE,
    "invalid_pattern",
    "expected target_capability:<installation>/<owner>/<name>",
    220,
  );
  const version = expectPositiveInt(obj.version, `${path}.version`);
  if (version !== TARGET_CAPABILITY_VERSION) {
    return { ...obj, id, version };
  }
  const repository = parseRepositoryIdentity(
    obj.repository,
    `${path}.repository`,
  );
  if (targetCapabilityIdV1(repository) !== id) {
    fail(`${path}.id`, "invalid_lifecycle", "id does not name its repository");
  }
  const defaultBranch = expectPattern(
    obj.defaultBranch,
    `${path}.defaultBranch`,
    BRANCH_RE,
    "invalid_pattern",
    "expected a branch name",
    255,
  );
  const tip = expectGitSha(obj.tip, `${path}.tip`);
  const generation = expectCount(obj.generation, `${path}.generation`);
  const capable = expectBoolean(obj.capable, `${path}.capable`);
  if (!Array.isArray(obj.missing)) {
    fail(`${path}.missing`, "wrong_type", "expected array");
  }
  const missing = (obj.missing as unknown[]).map((item, index) =>
    expectEnum(item, TARGET_CAPABILITY_MISSING, `${path}.missing[${index}]`)
  );
  const canonical = TARGET_CAPABILITY_MISSING.filter((item) =>
    missing.includes(item)
  );
  if (
    canonical.length !== missing.length ||
    canonical.some((item, index) => missing[index] !== item)
  ) {
    fail(`${path}.missing`, "invalid_lifecycle", "missing must be sorted");
  }
  if (capable !== !missing.includes("pull_request_ci_workflow")) {
    fail(`${path}.capable`, "invalid_lifecycle", "verdict contradicts list");
  }
  const missingDigest = expectSha256Hex(
    obj.missingDigest,
    `${path}.missingDigest`,
  );
  const backupCovered = expectBoolean(
    obj.backupCovered,
    `${path}.backupCovered`,
  );
  const ownerIssue = expectNullable(
    obj.ownerIssue,
    `${path}.ownerIssue`,
    expectPositiveInt,
  );
  const ownerIssueDigest = expectNullable(
    obj.ownerIssueDigest,
    `${path}.ownerIssueDigest`,
    expectSha256Hex,
  );
  if ((ownerIssue === null) !== (ownerIssueDigest === null)) {
    fail(`${path}.ownerIssue`, "invalid_lifecycle", "issue needs its digest");
  }
  const checkedAt = expectTimestamp(obj.checkedAt, `${path}.checkedAt`);
  return {
    ...obj,
    id,
    version: TARGET_CAPABILITY_VERSION,
    repository,
    defaultBranch,
    tip,
    generation,
    capable,
    missing,
    missingDigest,
    backupCovered,
    ownerIssue,
    ownerIssueDigest,
    checkedAt,
  };
}
