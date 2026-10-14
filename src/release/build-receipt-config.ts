// Frozen resolver configuration, bounds, static errors and strict primitive reads.
import type { GitSha } from "../contracts/brands.ts";
import { isGitSha } from "../contracts/brands.ts";
import type { Clock, PortResultV1 } from "../contracts/ports.ts";
import type { ReleaseTargetEnvironmentV1 } from "../contracts/release.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";

export const API_ORIGIN = "https://api.github.com";
export const API_ACCEPT = "application/vnd.github+json";
export const API_VERSION = "2022-11-28";

export const WORKFLOW_PATH = ".github/workflows/deno-deploy.yml";
export const WORKFLOW_FILENAME = "deno-deploy.yml";
export const RECEIPT_ARTIFACT_PREFIX = "sentinel-build-receipt-";

/** Hard response/body bounds. */
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 262144;
export const MAX_SIGNED_URL_CHARS = 8192;
export const PAGE_SIZE = 100;
export const MAX_PAGES = 10;
export const MAX_TOTAL_ITEMS = 1000;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1;
export const MAX_TIMEOUT_MS = 30_000;

export const BASE_BRANCH_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/;
export const REVISION_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
export const ARTIFACT_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const CONTROL_CHARS_RE = /[\p{Cc}]/u;

/** Exact production/isolated projects trusted for this resolver. */
export const PROJECT_FOR_ENVIRONMENT: Record<
  ReleaseTargetEnvironmentV1,
  string
> = {
  production: "ai-ubq-fi",
  isolated: "p-ai-ubq-fi",
};

// ---------------------------------------------------------------------------
// Static (never raw) error details.
// ---------------------------------------------------------------------------

export const ERR_CONFIG = "resolver configuration is invalid";
export const ERR_REQUEST = "release request is invalid";
export const ERR_REQUEST_REPOSITORY =
  "release request repository does not match the configured repository";
export const ERR_REQUEST_ENVIRONMENT =
  "release request environment does not match the configured environment";
export const ERR_TIMEOUT = "build receipt resolution timed out";
export const ERR_TRANSPORT = "GitHub API request failed";
export const ERR_AUTH = "GitHub API authentication failed";
export const ERR_RATE = "GitHub API rate limit exceeded";
export const ERR_NOT_FOUND = "GitHub API resource not found";
export const ERR_PAYLOAD = "GitHub API response is invalid";
export const ERR_PR = "GitHub pull request response is invalid";
export const ERR_WORKFLOW = "GitHub workflow response is invalid";
export const ERR_RUNS = "GitHub workflow runs response is invalid";
export const ERR_RUNS_PAGINATION = "GitHub workflow runs pagination is invalid";
export const ERR_ATTEMPT = "GitHub workflow run attempt response is invalid";
export const ERR_ARTIFACTS =
  "GitHub workflow run artifacts response is invalid";
export const ERR_ARTIFACTS_PAGINATION =
  "GitHub workflow run artifacts pagination is invalid";
export const ERR_ARTIFACT = "build receipt artifact is invalid";
export const ERR_ARTIFACT_EXPIRED = "build receipt artifact is expired";
export const ERR_ARTIFACT_SIZE = "build receipt artifact size mismatch";
export const ERR_ARTIFACT_DIGEST = "build receipt artifact digest mismatch";
export const ERR_SIGNED_URL = "build receipt artifact download URL is invalid";
export const ERR_STORAGE = "build receipt artifact download failed";
export const ERR_RECEIPT = "build receipt payload is invalid";
export const ERR_RERUN = "build workflow run attempt changed during resolution";
export const ERR_UNEXPECTED = "build receipt resolution failed";

export class BadPayload extends Error {}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadPayload();
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string {
  if (typeof value !== "string") throw new BadPayload();
  return value;
}

export function asBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new BadPayload();
  return value;
}

export function asPosInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new BadPayload();
  }
  return value;
}

export function asNonNegInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BadPayload();
  }
  return value;
}

export function field(obj: Record<string, unknown>, key: string): unknown {
  if (!(key in obj)) throw new BadPayload();
  return obj[key];
}

export function repoField(obj: Record<string, unknown>): {
  id: number;
  fullName: string;
} {
  const repo = asRecord(field(obj, "repository"));
  return {
    id: asPosInt(field(repo, "id")),
    fullName: asString(field(repo, "full_name")),
  };
}

export function headRepoField(obj: Record<string, unknown>): {
  id: number;
  fullName: string;
} {
  const repo = asRecord(field(obj, "head_repository"));
  return {
    id: asPosInt(field(repo, "id")),
    fullName: asString(field(repo, "full_name")),
  };
}

// ---------------------------------------------------------------------------
// GithubApi: bounded authenticated GETs against the fixed API origin.
// ---------------------------------------------------------------------------

export interface GithubBuildReceiptResolverAuthV1 {
  /** Returns the full `Authorization` header value, e.g. `Bearer <token>`. */
  authorizationHeader(): Promise<PortResultV1<string>>;
}

export interface GithubBuildReceiptResolverOptionsV1 {
  repository: RepositoryIdentityV1;
  environment: ReleaseTargetEnvironmentV1;
  project: string;
  baseBranch: string;
  workflowBlobSha: GitSha;
  clock: Clock;
  auth: GithubBuildReceiptResolverAuthV1;
  fetch?: typeof globalThis.fetch;
  /** Internal deterministic test timeout only; default 30000ms. */
  timeoutMs?: number;
}

export interface ValidatedConfig {
  repository: RepositoryIdentityV1;
  environment: ReleaseTargetEnvironmentV1;
  project: string;
  baseBranch: string;
  workflowBlobSha: GitSha;
  clock: Clock;
  auth: GithubBuildReceiptResolverAuthV1;
  fetchImpl: typeof globalThis.fetch;
  timeoutMs: number;
}

export function validateConfig(value: unknown): ValidatedConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  let repository: RepositoryIdentityV1;
  try {
    repository = parseRepositoryIdentity(raw.repository, "$");
  } catch {
    return null;
  }
  const environment = raw.environment;
  if (environment !== "production" && environment !== "isolated") return null;
  const project = raw.project;
  if (typeof project !== "string" || project === "") return null;
  if (project !== PROJECT_FOR_ENVIRONMENT[environment]) return null;
  const baseBranch = raw.baseBranch;
  if (
    typeof baseBranch !== "string" ||
    baseBranch.length === 0 ||
    CONTROL_CHARS_RE.test(baseBranch) ||
    baseBranch !== baseBranch.trim() ||
    !BASE_BRANCH_RE.test(baseBranch)
  ) {
    return null;
  }
  const workflowBlobSha = raw.workflowBlobSha;
  if (typeof workflowBlobSha !== "string" || !isGitSha(workflowBlobSha)) {
    return null;
  }
  const clock = raw.clock;
  if (
    typeof clock !== "object" || clock === null ||
    typeof (clock as Record<string, unknown>).now !== "function"
  ) {
    return null;
  }
  const auth = raw.auth;
  if (
    typeof auth !== "object" || auth === null ||
    typeof (auth as Record<string, unknown>).authorizationHeader !==
      "function"
  ) {
    return null;
  }
  const customFetch = raw.fetch;
  if (customFetch !== undefined && typeof customFetch !== "function") {
    return null;
  }
  const timeoutMs = raw.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : raw.timeoutMs;
  if (
    typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS
  ) {
    return null;
  }
  return {
    repository,
    environment,
    project,
    baseBranch,
    workflowBlobSha: workflowBlobSha as GitSha,
    clock: clock as Clock,
    auth: auth as GithubBuildReceiptResolverAuthV1,
    fetchImpl: (customFetch ?? globalThis.fetch) as typeof globalThis.fetch,
    timeoutMs,
  };
}
