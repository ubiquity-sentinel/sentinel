/**
 * Tested-tip delivery train contract (redesign 2026-10-25 C12, WP3.1).
 *
 * A delivery train lands the literal reviewed heads of up to 63 member pull
 * requests onto one exact tip T as a single octopus commit C whose parents
 * are `[T, H_1..H_k]`. Its identity is a digest of its canonical manifest,
 * so every stage is observable on GitHub (the digest-named ref, the commit's
 * manifest trailer, the checks on C, the tip) and any pass can re-derive it.
 * No stored state shape is added; this is a Git-artifact contract only.
 */
import {
  type GitSha,
  isGitSha,
  isWorkItemId,
  type WorkItemId,
} from "./brands.ts";
import { canonicalStringify, canonicalStringifySha256 } from "./canonical.ts";
import {
  expectArray,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectString,
  expectVersion,
  fail,
  MaxText,
} from "./validation.ts";

/** The 64-hex digest naming one train (`sha256hex(canonical([domain, m]))`). */
export type DeliveryTrainId = string & {
  readonly __brand: "sentinel/DeliveryTrainId";
};

export const DELIVERY_TRAIN_DIGEST_DOMAIN = "sentinel-delivery-train-v1";
/** One base parent plus at most 63 member heads. */
export const DELIVERY_TRAIN_MAX_MEMBERS = 63;
export const DELIVERY_TRAIN_BRANCH_PREFIX = "sentinel-train/";
export const DELIVERY_TRAIN_REF_PREFIX =
  `refs/heads/${DELIVERY_TRAIN_BRANCH_PREFIX}`;
export const DELIVERY_TRAIN_TRAILER = "Sentinel-Train: ";
export const DELIVERY_TRAIN_MANIFEST_TRAILER = "Sentinel-Train-Manifest: ";
/** Bound on one train commit message (a maximal manifest is about 70 KB). */
export const DELIVERY_TRAIN_MAX_MESSAGE_CHARS = 262_144;

export interface DeliveryTrainRepositoryV1 {
  owner: string;
  name: string;
}

export interface DeliveryTrainMemberV1 {
  recordId: WorkItemId;
  pr: number;
  /** The literal current head the receipt reviewed; it lands unchanged. */
  head: GitSha;
  /** The base the authorizing receipt recorded. */
  reviewedBase: GitSha;
  receiptId: string;
  issueNumber: number;
}

export interface DeliveryTrainManifestV1 {
  version: "v1";
  kind: "delivery_train";
  repository: DeliveryTrainRepositoryV1;
  /** The target's default branch the train lands on. */
  branch: string;
  /** The exact tip T the overlay was computed on (C's first parent). */
  base: GitSha;
  /** 1..63 members, strictly ordered by (pr, recordId). */
  members: DeliveryTrainMemberV1[];
}

/** A manifest paired with the digest computed from it. */
export interface DeliveryTrainV1 {
  readonly trainId: DeliveryTrainId;
  readonly manifest: DeliveryTrainManifestV1;
}

const MANIFEST_KEYS = [
  "version",
  "kind",
  "repository",
  "branch",
  "base",
  "members",
] as const;
const MEMBER_KEYS = [
  "recordId",
  "pr",
  "head",
  "reviewedBase",
  "receiptId",
  "issueNumber",
] as const;
const RECEIPT_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const TRAIN_ID = /^[0-9a-f]{64}$/;

export function isDeliveryTrainId(value: unknown): value is DeliveryTrainId {
  return typeof value === "string" && TRAIN_ID.test(value);
}

/** Train member order: pull request number, then record id. */
export function compareDeliveryTrainMembersV1(
  a: Pick<DeliveryTrainMemberV1, "pr" | "recordId">,
  b: Pick<DeliveryTrainMemberV1, "pr" | "recordId">,
): number {
  if (a.pr !== b.pr) return a.pr - b.pr;
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

/** Exact member tuple equality (every field). */
export function sameDeliveryTrainMemberV1(
  a: DeliveryTrainMemberV1,
  b: DeliveryTrainMemberV1,
): boolean {
  return a.recordId === b.recordId && a.pr === b.pr && a.head === b.head &&
    a.reviewedBase === b.reviewedBase && a.receiptId === b.receiptId &&
    a.issueNumber === b.issueNumber;
}

/** A Git branch name Sentinel may land on (never the train namespace). */
function isLandingBranch(name: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false;
  if (name.startsWith(DELIVERY_TRAIN_BRANCH_PREFIX)) return false;
  if (/\.\.|\/\/|\/\.|@\{/.test(name) || /[./]$/.test(name)) return false;
  return !name.split("/").some((part) => part.endsWith(".lock"));
}

export function parseDeliveryTrainMemberV1(
  input: unknown,
  path = "$",
): DeliveryTrainMemberV1 {
  const o = expectRecord(input, path);
  expectExactKeys(o, MEMBER_KEYS, path);
  const recordId = expectString(o.recordId, `${path}.recordId`, 256);
  if (!isWorkItemId(recordId)) {
    fail(`${path}.recordId`, "invalid_pattern", "expected work item id");
  }
  return {
    recordId,
    pr: expectPositiveInt(o.pr, `${path}.pr`),
    head: expectGitSha(o.head, `${path}.head`),
    reviewedBase: expectGitSha(o.reviewedBase, `${path}.reviewedBase`),
    receiptId: expectPattern(
      o.receiptId,
      `${path}.receiptId`,
      RECEIPT_ID,
      "invalid_pattern",
      "expected review receipt id",
      MaxText.recordId,
    ),
    issueNumber: expectPositiveInt(o.issueNumber, `${path}.issueNumber`),
  };
}

function parseRepository(
  input: unknown,
  path: string,
): DeliveryTrainRepositoryV1 {
  const o = expectRecord(input, path);
  expectExactKeys(o, ["owner", "name"], path);
  return {
    owner: expectPattern(
      o.owner,
      `${path}.owner`,
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
      "invalid_pattern",
      "expected GitHub owner",
      MaxText.owner,
    ),
    name: expectPattern(
      o.name,
      `${path}.name`,
      /^[A-Za-z0-9._-]{1,100}$/,
      "invalid_pattern",
      "expected GitHub repository name",
      MaxText.name,
    ),
  };
}

/**
 * Strict manifest parser: exact keys at every level, 1..63 members strictly
 * ordered by (pr, recordId), full SHAs, and no duplicate pull request,
 * record, head or issue. No member head may equal the base (C's parents
 * would repeat T).
 */
export function parseDeliveryTrainManifestV1(
  input: unknown,
  path = "$",
): DeliveryTrainManifestV1 {
  const o = expectRecord(input, path);
  expectExactKeys(o, MANIFEST_KEYS, path);
  expectVersion(o.version, `${path}.version`);
  expectEnum(o.kind, ["delivery_train"], `${path}.kind`);
  const repository = parseRepository(o.repository, `${path}.repository`);
  const branch = expectString(o.branch, `${path}.branch`, MaxText.branch);
  if (!isLandingBranch(branch)) {
    fail(`${path}.branch`, "invalid_pattern", "expected a landing branch");
  }
  const base = expectGitSha(o.base, `${path}.base`);
  const members = expectArray(
    o.members,
    `${path}.members`,
    DELIVERY_TRAIN_MAX_MEMBERS,
    parseDeliveryTrainMemberV1,
  );
  if (members.length === 0) {
    fail(`${path}.members`, "invalid_array", "a train has 1..63 members");
  }
  const records = new Set<string>();
  const heads = new Set<string>();
  const issues = new Set<number>();
  members.forEach((member, index) => {
    const at = `${path}.members[${index}]`;
    const previous = members[index - 1];
    if (previous !== undefined && previous.pr === member.pr) {
      fail(`${at}.pr`, "invalid_value", "duplicate train pull request");
    }
    if (
      previous !== undefined &&
      compareDeliveryTrainMembersV1(previous, member) >= 0
    ) fail(at, "invalid_value", "members must be ordered by (pr, recordId)");
    if (records.has(member.recordId)) {
      fail(`${at}.recordId`, "invalid_value", "duplicate train record");
    }
    if (heads.has(member.head) || member.head === base) {
      fail(`${at}.head`, "invalid_value", "duplicate train parent");
    }
    if (issues.has(member.issueNumber)) {
      fail(`${at}.issueNumber`, "invalid_value", "duplicate train issue");
    }
    records.add(member.recordId);
    heads.add(member.head);
    issues.add(member.issueNumber);
  });
  return {
    version: "v1",
    kind: "delivery_train",
    repository,
    branch,
    base,
    members,
  };
}

/** Builds a manifest from members in any order (sorted, then strictly parsed). */
export function deliveryTrainManifestV1(input: {
  repository: DeliveryTrainRepositoryV1;
  branch: string;
  base: GitSha;
  members: readonly DeliveryTrainMemberV1[];
}): DeliveryTrainManifestV1 {
  return parseDeliveryTrainManifestV1({
    version: "v1",
    kind: "delivery_train",
    repository: { owner: input.repository.owner, name: input.repository.name },
    branch: input.branch,
    base: input.base,
    members: [...input.members].sort(compareDeliveryTrainMembersV1).map((
      member,
    ) => ({ ...member })),
  });
}

/** The prefix train `M[:length]` on the same base (a bisection probe). */
export function deliveryTrainPrefixV1(
  manifest: DeliveryTrainManifestV1,
  length: number,
): DeliveryTrainManifestV1 {
  if (
    !Number.isSafeInteger(length) || length < 1 ||
    length > manifest.members.length
  ) throw new RangeError("train prefix length out of range");
  return parseDeliveryTrainManifestV1({
    ...manifest,
    repository: { ...manifest.repository },
    members: manifest.members.slice(0, length).map((member) => ({
      ...member,
    })),
  });
}

/** `sha256hex(canonical(["sentinel-delivery-train-v1", manifest]))`. */
export async function deliveryTrainIdV1(
  manifest: DeliveryTrainManifestV1,
): Promise<DeliveryTrainId> {
  const parsed = parseDeliveryTrainManifestV1(manifest);
  return await canonicalStringifySha256([
    DELIVERY_TRAIN_DIGEST_DOMAIN,
    parsed,
  ]) as DeliveryTrainId;
}

export async function deliveryTrainV1(
  manifest: DeliveryTrainManifestV1,
): Promise<DeliveryTrainV1> {
  const parsed = parseDeliveryTrainManifestV1(manifest);
  return { trainId: await deliveryTrainIdV1(parsed), manifest: parsed };
}

export function deliveryTrainBranchV1(trainId: DeliveryTrainId): string {
  if (!isDeliveryTrainId(trainId)) throw new TypeError("invalid train id");
  return `${DELIVERY_TRAIN_BRANCH_PREFIX}${trainId}`;
}

export function deliveryTrainRefV1(trainId: DeliveryTrainId): string {
  return `refs/heads/${deliveryTrainBranchV1(trainId)}`;
}

/** The train id a `refs/heads/sentinel-train/<id>` ref names, else null. */
export function parseDeliveryTrainRefV1(ref: string): DeliveryTrainId | null {
  if (!ref.startsWith(DELIVERY_TRAIN_REF_PREFIX)) return null;
  const id = ref.slice(DELIVERY_TRAIN_REF_PREFIX.length);
  return isDeliveryTrainId(id) ? id : null;
}

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

/** Canonical unpadded base64url to UTF-8 text, or null. */
function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return encodeBase64Url(text) === value ? text : null;
}

/**
 * The exact train commit message. It names the delivered issues without a
 * closing keyword (closure is the launcher's, after booking) and carries the
 * id and the canonical manifest as trailers.
 */
export function deliveryTrainCommitMessageV1(train: DeliveryTrainV1): string {
  const manifest = parseDeliveryTrainManifestV1(train.manifest);
  if (!isDeliveryTrainId(train.trainId)) throw new TypeError("invalid id");
  const issues = manifest.members.map((member) => `#${member.issueNumber}`);
  return [
    `Sentinel delivery train ${train.trainId.slice(0, 12)}`,
    "",
    `Delivers ${issues.join(", ")}`,
    "",
    `${DELIVERY_TRAIN_TRAILER}${train.trainId}`,
    `${DELIVERY_TRAIN_MANIFEST_TRAILER}${
      encodeBase64Url(canonicalStringify(manifest))
    }`,
  ].join("\n");
}

/** True when a commit message carries a train id trailer (valid or not). */
export function hasDeliveryTrainTrailerV1(message: string): boolean {
  return message.split("\n").some((line) =>
    line.startsWith(DELIVERY_TRAIN_TRAILER)
  );
}

/**
 * Strict inverse of {@link deliveryTrainCommitMessageV1}: the manifest is
 * decoded from canonical base64url and must itself be canonical JSON, its
 * digest must equal the id trailer, and the whole message must equal the
 * one rebuilt from them (one trailing newline is tolerated, as Git readers
 * append it). Throws `RecordParseError` otherwise.
 */
export async function parseDeliveryTrainCommitMessageV1(
  message: string,
  path = "$",
): Promise<DeliveryTrainV1> {
  const text = expectString(message, path, DELIVERY_TRAIN_MAX_MESSAGE_CHARS);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const last = body.slice(body.lastIndexOf("\n") + 1);
  if (!last.startsWith(DELIVERY_TRAIN_MANIFEST_TRAILER)) {
    fail(path, "invalid_pattern", "missing train manifest trailer");
  }
  const json = decodeBase64Url(
    last.slice(DELIVERY_TRAIN_MANIFEST_TRAILER.length),
  );
  if (json === null) {
    fail(path, "invalid_base64", "expected canonical base64url manifest");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    fail(path, "invalid_value", "train manifest is not JSON");
  }
  const manifest = parseDeliveryTrainManifestV1(decoded, `${path}.manifest`);
  if (canonicalStringify(manifest) !== json) {
    fail(path, "invalid_value", "train manifest is not canonical JSON");
  }
  const train = await deliveryTrainV1(manifest);
  if (deliveryTrainCommitMessageV1(train) !== body) {
    fail(path, "invalid_value", "train message does not match its manifest");
  }
  return train;
}

/** Commit parents of the train commit: `[T, H_1..H_k]`. */
export function deliveryTrainParentsV1(
  manifest: DeliveryTrainManifestV1,
): GitSha[] {
  return [manifest.base, ...manifest.members.map((member) => member.head)];
}

/** Exact parent list equality against {@link deliveryTrainParentsV1}. */
export function hasDeliveryTrainParentsV1(
  manifest: DeliveryTrainManifestV1,
  parents: readonly string[],
): boolean {
  const expected = deliveryTrainParentsV1(manifest);
  return parents.length === expected.length &&
    parents.every((parent, index) =>
      isGitSha(parent) && parent === expected[index]
    );
}
