// Exact GitHub run/artifact bindings and strict producer receipt verification.

import {
  ARTIFACT_DIGEST_RE,
  asBoolean,
  asPosInt,
  asRecord,
  asString,
  BadPayload,
  CONTROL_CHARS_RE,
  field,
  headRepoField,
  MAX_ARCHIVE_BYTES,
  MAX_SIGNED_URL_CHARS,
  repoField,
  REVISION_ID_RE,
  WORKFLOW_PATH,
} from "./build-receipt-config.ts";

export interface VerifiedRun {
  id: number;
  attempt: number;
}

export type RunSelection =
  | { status: "run"; run: VerifiedRun }
  | { status: "absent" }
  | { status: "ambiguous" };

export interface VerifiedArtifact {
  id: number;
  sizeInBytes: number;
  digestHex: string;
}

export function validatePrPayload(
  payload: unknown,
  expected: {
    pullRequest: number;
    revision: string;
    head: string;
    baseBranch: string;
    repoFull: string;
  },
): { repoId: number } | null {
  try {
    const pr = asRecord(payload);
    if (asPosInt(field(pr, "number")) !== expected.pullRequest) return null;
    if (asBoolean(field(pr, "merged")) !== true) return null;
    if (asString(field(pr, "merge_commit_sha")) !== expected.revision) {
      return null;
    }
    const head = asRecord(field(pr, "head"));
    if (asString(field(head, "sha")) !== expected.head) return null;
    const base = asRecord(field(pr, "base"));
    if (asString(field(base, "ref")) !== expected.baseBranch) return null;
    // GitHub GET /pulls/{n} carries the repository inside base.repo, never a
    // top-level `repository`; the trusted repo id is derived from base.repo.
    const baseRepo = asRecord(field(base, "repo"));
    if (asString(field(baseRepo, "full_name")) !== expected.repoFull) {
      return null;
    }
    return { repoId: asPosInt(field(baseRepo, "id")) };
  } catch {
    return null;
  }
}

export function validateWorkflowPayload(
  payload: unknown,
  expected: { workflowId: number | null },
): number {
  const workflow = asRecord(payload);
  const id = asPosInt(field(workflow, "id"));
  if (expected.workflowId !== null && id !== expected.workflowId) {
    throw new BadPayload();
  }
  if (asString(field(workflow, "path")) !== WORKFLOW_PATH) {
    throw new BadPayload();
  }
  return id;
}

export function validateRunListItem(
  item: unknown,
  expected: {
    revision: string;
    baseBranch: string;
    repoFull: string;
    workflowId: number;
    repoId: number;
  },
): { id: number; attempt: number; terminal: boolean } {
  const run = asRecord(item);
  const id = asPosInt(field(run, "id"));
  const attempt = asPosInt(field(run, "run_attempt"));
  const event = asString(field(run, "event"));
  const status = asString(field(run, "status"));
  const conclusionRaw = field(run, "conclusion");
  const conclusion = conclusionRaw === null ? null : asString(conclusionRaw);
  if (status === "completed" && conclusion === null) throw new BadPayload();
  const repository = repoField(run);
  const headRepository = headRepoField(run);
  if (
    event !== "push" ||
    asString(field(run, "head_sha")) !== expected.revision ||
    asString(field(run, "head_branch")) !== expected.baseBranch ||
    asPosInt(field(run, "workflow_id")) !== expected.workflowId ||
    repository.fullName !== expected.repoFull ||
    repository.id !== expected.repoId ||
    headRepository.fullName !== expected.repoFull ||
    headRepository.id !== expected.repoId
  ) {
    throw new BadPayload();
  }
  const terminal = status === "completed" &&
    (conclusion === "success" || conclusion === "failure");
  return { id, attempt, terminal };
}

export function validateAttemptPayload(
  payload: unknown,
  expected: {
    runId: number;
    attempt: number;
    revision: string;
    baseBranch: string;
    repoFull: string;
    workflowId: number;
    repoId: number;
  },
): "success" | "failure" {
  const attempt = asRecord(payload);
  if (asPosInt(field(attempt, "id")) !== expected.runId) throw new BadPayload();
  if (asPosInt(field(attempt, "run_attempt")) !== expected.attempt) {
    throw new BadPayload();
  }
  const event = asString(field(attempt, "event"));
  const status = asString(field(attempt, "status"));
  const conclusion = asString(field(attempt, "conclusion"));
  const repository = repoField(attempt);
  const headRepository = headRepoField(attempt);
  if (
    event !== "push" || status !== "completed" ||
    (conclusion !== "success" && conclusion !== "failure") ||
    asString(field(attempt, "head_sha")) !== expected.revision ||
    asString(field(attempt, "head_branch")) !== expected.baseBranch ||
    asPosInt(field(attempt, "workflow_id")) !== expected.workflowId ||
    repository.fullName !== expected.repoFull ||
    repository.id !== expected.repoId ||
    headRepository.fullName !== expected.repoFull ||
    headRepository.id !== expected.repoId
  ) {
    throw new BadPayload();
  }
  return conclusion;
}

/** The selected receipt artifact exists but is expired. */
export class ArtifactExpired extends Error {}

/**
 * Structural identity of ANY listed artifact entry. Receipt-specific checks
 * never apply here: a listing can mix unrelated artifact types that are
 * larger than the receipt cap, expired or carry no digest.
 */
export function validateArtifactIdentity(
  item: unknown,
): { id: number; name: string } {
  const artifact = asRecord(item);
  const id = asPosInt(field(artifact, "id"));
  const name = asString(field(artifact, "name"));
  if (name === "") throw new BadPayload();
  return { id, name };
}

/**
 * Receipt-specific checks, applied ONLY to the single exactly-named selected
 * artifact after the target-name count was determined.
 */
export function validateReceiptArtifact(
  item: unknown,
  expected: {
    runId: number;
    revision: string;
    baseBranch: string;
    repoId: number;
    nowMs: number;
  },
): { id: number; name: string; sizeInBytes: number; digestHex: string } {
  const artifact = asRecord(item);
  const id = asPosInt(field(artifact, "id"));
  const name = asString(field(artifact, "name"));
  const sizeInBytes = asPosInt(field(artifact, "size_in_bytes"));
  if (sizeInBytes > MAX_ARCHIVE_BYTES) throw new BadPayload();
  const digest = asString(field(artifact, "digest"));
  if (!ARTIFACT_DIGEST_RE.test(digest)) throw new BadPayload();
  const expired = asBoolean(field(artifact, "expired"));
  const expiresAtRaw = asString(field(artifact, "expires_at"));
  const expiresAt = Date.parse(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) throw new BadPayload();
  if (expired || expiresAt <= expected.nowMs) throw new ArtifactExpired();
  const workflowRun = asRecord(field(artifact, "workflow_run"));
  if (
    asPosInt(field(workflowRun, "id")) !== expected.runId ||
    asPosInt(field(workflowRun, "repository_id")) !== expected.repoId ||
    asPosInt(field(workflowRun, "head_repository_id")) !== expected.repoId ||
    asString(field(workflowRun, "head_sha")) !== expected.revision ||
    asString(field(workflowRun, "head_branch")) !== expected.baseBranch
  ) {
    throw new BadPayload();
  }
  if (name === "") throw new BadPayload();
  return { id, name, sizeInBytes, digestHex: digest.slice("sha256:".length) };
}

// ---------------------------------------------------------------------------
// Strict producer receipt schema.
// ---------------------------------------------------------------------------

export const RECEIPT_KEYS = [
  "version",
  "repository",
  "run_id",
  "run_attempt",
  "workflow_ref",
  "git_sha",
  "project",
  "revision_id",
  "build_transaction_id",
] as const;

/** No control characters and no leading/trailing whitespace (incl. newline). */
export function isCanonicalString(value: string): boolean {
  if (value.length === 0) return false;
  if (CONTROL_CHARS_RE.test(value)) return false;
  if (value !== value.trim()) return false;
  return true;
}

export function parseProducerReceipt(
  payload: unknown,
  expected: {
    repoFull: string;
    runId: string;
    attempt: string;
    workflowRef: string;
    revision: string;
    project: string;
    transaction: string;
  },
): { revisionId: string; buildTransactionId: string } | null {
  let obj: Record<string, unknown>;
  try {
    obj = asRecord(payload);
  } catch {
    return null;
  }
  const keys = Object.keys(obj);
  if (keys.length !== RECEIPT_KEYS.length) return null;
  for (const key of RECEIPT_KEYS) {
    if (!(key in obj)) return null;
  }
  if (obj.version !== 1) return null;
  const strings: Record<string, string> = {};
  for (const key of RECEIPT_KEYS) {
    if (key === "version") continue;
    const value = obj[key];
    if (typeof value !== "string" || !isCanonicalString(value)) return null;
    strings[key] = value;
  }
  if (strings.repository !== expected.repoFull) return null;
  if (strings.run_id !== expected.runId) return null;
  if (strings.run_attempt !== expected.attempt) return null;
  if (strings.workflow_ref !== expected.workflowRef) return null;
  if (strings.git_sha !== expected.revision) return null;
  if (strings.project !== expected.project) return null;
  if (!REVISION_ID_RE.test(strings.revision_id)) return null;
  if (strings.build_transaction_id !== expected.transaction) return null;
  return {
    revisionId: strings.revision_id,
    buildTransactionId: strings.build_transaction_id,
  };
}

// ---------------------------------------------------------------------------
// Signed download URL validation.
// ---------------------------------------------------------------------------

/**
 * Reject control chars, any raw fragment (including the empty `#`), IP
 * literals (IPv4 dotted and IPv6), localhost with or without a trailing DNS
 * dot, non-HTTPS, userinfo, nonstandard port and single-label hosts.
 */
export function parseSignedLocation(location: string): URL | null {
  if (location.length === 0 || location.length > MAX_SIGNED_URL_CHARS) {
    return null;
  }
  if (CONTROL_CHARS_RE.test(location)) return null;
  if (location.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  const host = url.hostname.toLowerCase();
  const hostBase = host.endsWith(".") ? host.slice(0, -1) : host;
  if (hostBase === "" || host.includes(":")) return null; // IPv6 literal
  if (hostBase === "localhost" || hostBase.endsWith(".localhost")) return null;
  const ipv4 = /^[0-9]+(\.[0-9]+){3}$/;
  if (ipv4.test(host) || ipv4.test(hostBase)) return null; // IPv4 literal
  if (!hostBase.includes(".")) return null; // single-label host is not a storage host
  return url;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
