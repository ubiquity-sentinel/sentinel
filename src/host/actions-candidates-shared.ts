/** Hosted actions-candidates-shared responsibility. */
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
  PortResultV1,
  StateReadView,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import type { ReplayRuntimeV1 } from "../replay/runtime.ts";
import type { CandidateProofPassV1 } from "./actions-candidates-proof.ts";

/**
 * The sentinel self remote. It is the default only for callers that supply
 * neither `repository` nor `remoteUrl`; the hosted multi-target host names each
 * target's own repository, so its remote is derived from that identity instead.
 */
export const ACTIONS_CANDIDATES_REMOTE_URL =
  "https://github.com/ubiquity-sentinel/sentinel.git";

export const SELF_REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

const CANDIDATE_BRANCH_PREFIX = "sentinel/repair/";

export const GIT_TIMEOUT_MS = 120_000;

export const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

export const STATIC_INPUT = "candidate restore input is invalid";

export const STATIC_BINDING = "candidate restore has no exact durable binding";

export const STATIC_REMOTE = "candidate restore remote identity is not exact";

export const STATIC_FETCH = "candidate restore fetch did not verify";

export const STATIC_PRESERVE_INPUT =
  "candidate preservation request is invalid";

export const STATIC_PRESERVE_BINDING =
  "candidate preservation has no exact durable binding";

export const STATIC_PRESERVE_LOCAL =
  "candidate preservation local candidate objects are unavailable";

export const STATIC_PRESERVE_CONFLICT =
  "candidate preservation ref conflicts with an existing head";

export const STATIC_PRESERVE_REMOTE =
  "candidate preservation remote ref did not verify";

export const STATIC_PRESERVE_PUSH =
  "candidate preservation push did not verify";

export const STATIC_PRESERVE_PROOF =
  "candidate preservation fresh-store proof failed";

// Git refs must reject control characters, so the control range is intentional.
// deno-lint-ignore no-control-regex
const FORBIDDEN_BRANCH = /[\u0000-\u001f\u007f ~^:?*\\\[\]]/;

/** Exact preservation ref identity: one 64-hex digest ref body, no variants. */
const PRESERVATION_REF_PATTERN =
  /^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/;

export interface ActionsCandidateRestoreRequestV1 {
  base: GitSha;
  head: GitSha;
}

export interface ActionsCandidateRestorerV1 {
  /** Ensure the exact base/head commit objects exist locally. */
  ensure(input: ActionsCandidateRestoreRequestV1): Promise<PortResultV1<void>>;
}

export interface ActionsCandidateRestorerInputV1 {
  state: StateReadView;
  gate: GitHubCooldownGateV1;
  token: string;
  http: HttpTransportV1;
  clock: Clock;
  /** Private trusted source object repository (never a worktree write). */
  sourcePath: string;
  /**
   * Exact target repository these objects belong to. Omitted callers keep the
   * sentinel self-identity. A multi-target host supplies the committed
   * target's own identity so the ref namespace, the authenticated remote and
   * the durable record filter all address exactly that repository.
   */
  repository?: RepositoryIdentityV1;
  /** Private git home for the credential child environment. */
  scratch: string;
  trustedPath: string;
  gitExecutable: string;
  /** Injectable bounded subprocess runtime; default `DenoReplayRuntime`. */
  runtime?: ReplayRuntimeV1;
  /** Fixed self remote; overridden ONLY by tests with a fixture file:// URL. */
  remoteUrl?: string;
  /** Trusted API base for tests; production uses the public API. */
  apiBaseUrl?: string;
}

/**
 * Trusted candidate-preservation factory input. The repository identity and
 * the authenticated read/push transport are fixed by `port` (the SAME host
 * port instance); `token`/`http`/`apiBaseUrl` mirror the restorer inputs and
 * are consumed by that port, never by a second transport here. The trusted
 * callback supplies the exact candidate objects for one task/head, and
 * `protectedPaths` is the trusted configured publication allowlist.
 */
export interface ActionsCandidatePreserverInputV1 {
  state: StateReadView;
  gate: GitHubCooldownGateV1;
  token: string;
  http: HttpTransportV1;
  clock: Clock;
  /** Private trusted source object repository (validated, never a model cwd). */
  sourcePath: string;
  /**
   * Exact target repository these objects belong to. Omitted callers keep the
   * sentinel self-identity, so the authenticated remote and every gate
   * admission still scope to the repository that actually owns the objects.
   */
  repository?: RepositoryIdentityV1;
  /** Private owned scratch root for the fresh empty object store. */
  scratch: string;
  trustedPath: string;
  gitExecutable: string;
  /** Injectable bounded subprocess runtime; default `DenoReplayRuntime`. */
  runtime?: ReplayRuntimeV1;
  /** Fixed self remote; overridden ONLY by tests with a fixture file:// URL. */
  remoteUrl?: string;
  /** Trusted API base for tests; production uses the public API. */
  apiBaseUrl?: string;
  /** THE same host port instance: authenticated readRef + create-only push. */
  port: Pick<
    GitHubPort,
    "readRef" | "pushHead" | "nativeQueue" | "existingPrTakeover"
  >;
  /** Trusted configured protected paths (from the real repository config). */
  protectedPaths: readonly string[];
  /**
   * Trusted exact-object loader: ensure the exact candidate `head` exists in
   * the private source mirror, importing it from the exact task-mapped
   * producer checkout when needed. `not_found` is a proven absence;
   * transport/auth/read failures are `unavailable`.
   */
  ensureLocalCandidate(
    taskId: WorkItemId,
    head: GitSha,
  ): Promise<PortResultV1<void>>;
  /**
   * The owning maintenance pass whose one fresh store per remote every
   * durability proof of that pass uses (#185). Omitted, each proof creates
   * and removes its own new empty store.
   */
  proofPass?: CandidateProofPassV1;
}

/** Safe exact candidate branch: prefixed, slash-separated, no forbidden refs. */
export function isDurableCandidateBranch(branch: unknown): branch is string {
  if (
    typeof branch !== "string" || branch.length === 0 || branch.length > 256
  ) {
    return false;
  }
  if (!branch.startsWith(CANDIDATE_BRANCH_PREFIX)) return false;
  if (FORBIDDEN_BRANCH.test(branch)) return false;
  if (
    branch.includes("..") || branch.includes("@{") || branch.includes("//") ||
    branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")
  ) {
    return false;
  }
  return branch.split("/").every((part) =>
    part.length > 0 && !part.startsWith(".") && !part.startsWith("-") &&
    !part.endsWith(".lock")
  );
}

/** Exact shape of one operation-bound preservation ref. */
export function isPreservationRef(ref: unknown): ref is string {
  return typeof ref === "string" && PRESERVATION_REF_PATTERN.test(ref);
}

/** Exact repository identity equality (owner/name/installation). */
export function sameRepository(
  left: RepositoryIdentityV1,
  right: RepositoryIdentityV1,
): boolean {
  return left.installationId === right.installationId &&
    left.owner === right.owner && left.name === right.name;
}
