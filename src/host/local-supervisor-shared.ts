import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type { Clock } from "../contracts/ports.ts";
import {
  LOCAL_RUN_FAILED_STATUSES,
  LOCAL_RUN_HEALTHY_STATUSES,
  type LocalRunProofV1,
} from "../contracts/local-release.ts";

/** Static, value-free detail texts (never a path, SHA, token or body). */
export const DETAIL_POINTER_MISSING =
  "local supervisor refused: the private active runtime pointer is missing; the installer must initialize it to the reviewed installed runtime";

export const DETAIL_POINTER_UNREADABLE =
  "local supervisor failed: the private active runtime pointer is unreadable";

export const DETAIL_RECEIPTS_UNREADABLE =
  "local supervisor failed: private local release receipts are unreadable";

export const DETAIL_RUNTIME_INVALID =
  "local supervisor refused: the runtime checkout is not the exact clean revision";

export const DETAIL_LOCK_NOT_RELEASED =
  "local supervisor paused: the child runner lock was not released after the child settled";

export const DETAIL_LOCK_HELD =
  "local supervisor paused: the child runner lock is held before a new child may start";

export const DETAIL_MARKER_PRESENT =
  "local supervisor paused: the private session marker is present after the child settled";

export const DETAIL_STATUS_UNREADABLE =
  "local supervisor paused: the private run status receipt is unreadable";

export const DETAIL_STATUS_STALE =
  "local supervisor paused: the private run status receipt is not a fresh observed run";

export const DETAIL_STATUS_DUPLICATE =
  "local supervisor paused: the private run status receipt repeats a known invocation";

export const DETAIL_STATE_UNAVAILABLE =
  "local supervisor paused: the child reported its repair state as unavailable";

export const DETAIL_CHILD_UNSETTLED =
  "local supervisor paused: the child process did not settle";

export const DETAIL_RECEIPT_WRITE =
  "local supervisor failed: the private local release receipt could not be persisted";

export const DETAIL_POINTER_CHANGED =
  "local supervisor refused: the active runtime pointer is not the expected exact revision; an unrelated newer pointer is preserved";

export const DETAIL_STAGE_FAILED =
  "local supervisor failed: the candidate runtime could not be staged";

export const DETAIL_STATE_ABSENT =
  "local supervisor paused: the private repair state is absent";

export const DETAIL_STATE_READ =
  "local supervisor failed: the private repair state could not be read";

export const DETAIL_SOURCE_UNAVAILABLE =
  "local supervisor failed: the exact source revision is not available in the local development ref";

export const DETAIL_ALREADY_ACTIVE =
  "local supervisor refused: the requested revision is already the active runtime and no distinct prior revision exists for an activation receipt";

export const DETAIL_CHILD_EXIT_FAILED =
  "local supervisor refused: the child process exited nonzero after it settled and left no healthy run proof";

export const DETAIL_PROOF_INVALID =
  "local supervisor refused: the observed run proof was not a healthy observed run";

export const REPAIR_TASK_NAME = "repair:run";

/** The local source development ref the healthy real child host refreshes. */
export const LOCAL_DEVELOPMENT_REF = "refs/remotes/origin/development";

export const CHILD_DEADLINE_MS = 3_600_000;

export const GIT_TIMEOUT_MS = 120_000;

export const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

export const RUNTIMES_DIR = "runtimes";

export const SOURCE_DIR = "source";

export const STATE_GIT_DIR = "state.git";

export const STATE_SCRATCH_DIR = "state-scratch";

export const MAX_TRACKED_SYMLINKS = 64;

/**
 * The one OS mechanism that confines a real child's write authority: the
 * fixed platform sandbox. No platform without it ever runs a real child.
 */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * The owner-installed native Codex executable, relative to the child's HOME.
 * Pinned to the exact spelling the local repair host launches
 * (`joinPath(home, ".codex", "bin", "codex")` in `src/host/local.ts`); a drift
 * test keeps the two identical. Only this one file may leave the child's
 * Seatbelt boundary, and only after the owner opted in (`CODEX_OPT_IN_*`), so
 * Codex can apply its own narrower tool sandbox instead of failing nested
 * (`sandbox_apply: Operation not permitted`, issue #100).
 */
export const CODEX_EXECUTABLE_SEGMENTS = [".codex", "bin", "codex"] as const;

/** The exact file name an exempted Codex executable must carry. */
export const CODEX_EXECUTABLE_NAME = "codex";

/**
 * Platform directories whose executables are never exempted: a link from the
 * Codex spelling into one of them would let a general-purpose system program
 * (a shell, an interpreter) run outside the child boundary.
 */
export const SYSTEM_EXECUTABLE_PREFIXES = [
  "/bin/",
  "/sbin/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/lib/",
  "/usr/libexec/",
  "/System/",
  "/Library/Apple/",
] as const;

/** Bounded symlink hops followed while resolving the Codex executable. */
export const CODEX_EXEMPTION_MAX_LINK_HOPS = 16;

/**
 * The owner's explicit opt-in to the Codex exemption, relative to the
 * supervisor's HOME: `~/.config/sentinel-local/codex-exemption-opt-in`. It
 * sits outside the private state root (`~/.local/state/sentinel-local`), so
 * neither the confined child nor any installed runtime (all beneath that
 * root's `runtimes/`) can create it: the child may write nothing outside the
 * state root. Without it the child keeps today's exact profile.
 *
 * Opting in lets merged repair-host code reach an unconfined Codex; only a
 * supervisor-owned broker removes that. Any code running in the confined
 * repair host (every module of the `repair:run` graph that is not a protected
 * path, not only the files that launch Codex) can start the exempted
 * executable with arguments, environment, config and per-command sandbox of
 * its own choosing, for example `codex sandbox` with `danger-full-access`,
 * and so write the pointer, receipts and runtimes the outer profile protects.
 */
export const CODEX_OPT_IN_SEGMENTS = [
  ".config",
  "sentinel-local",
  "codex-exemption-opt-in",
] as const;

/** The exact acknowledgment the opt-in file holds (surrounding space aside). */
export const CODEX_OPT_IN_ACK =
  "I accept that merged repair-host code can reach an unconfined Codex (sentinel issue 100)";

/** The opt-in file is read only when it is at most this large. */
export const CODEX_OPT_IN_MAX_BYTES = 4096;

/** One bounded platform validation of the exemption profile per launch. */
export const SANDBOX_VALIDATION_PROGRAM = "/usr/bin/true";

export const SANDBOX_VALIDATION_TIMEOUT_MS = 10_000;

export const SANDBOX_VALIDATION_MAX_OUTPUT_BYTES = 64 * 1024;

/** Dedicated child cache and temp directories beneath the private state. */
export const CHILD_DENO_DIR = "deno/host";

export const CHILD_TMP_DIR = "tmp/host";

/**
 * Exact private state directories a sandboxed child may write and hardlink
 * beneath. Nothing else in or outside the state root is writable, so an
 * arbitrary child process, Git object link, shell or Deno subprocess cannot
 * reach the supervisor pointer, receipts, locks, runtimes or its own code.
 */
export const CHILD_MUTABLE_STATE_DIRS = [
  STATE_GIT_DIR,
  STATE_SCRATCH_DIR,
  SOURCE_DIR,
  "checkouts",
  "clients",
  "tmp",
  "deno",
  "model-results",
  "review-checkout",
] as const;

/** Exact child-owned root entries the local host already writes directly. */
export const CHILD_MUTABLE_STATE_FILES = [
  "runner.lock",
  "session-active.json",
  "status.json",
] as const;

/** The exact existing trusted environment the child task runs with. */
export interface LocalSupervisorEnvV1 {
  HOME: string;
  PATH: string;
  GITHUB_TOKEN: string;
  UOS_AI_TOKEN: string;
}

/** Inputs of one child execution; revisions and secrets are never shell text. */
export interface LocalSupervisorChildInputV1 {
  stateRoot: string;
  runtimeDir: string;
  revision: GitSha;
  taskName: string;
  env: Readonly<Record<string, string>>;
  /** The exact trusted Deno executable this supervisor was configured with. */
  denoExecutable: string;
  deadlineMs: number;
  logPath: string;
}

export interface LocalSupervisorChildResultV1 {
  /** True only when the child process was reaped after a normal exit. */
  settled: boolean;
  exitCode: number | null;
}

/** The one injected border: child process execution, never the state machine. */
export type LocalSupervisorChildRunnerV1 = (
  input: LocalSupervisorChildInputV1,
) => Promise<LocalSupervisorChildResultV1>;

export interface LocalSupervisorOptionsV1 {
  stateRoot: string;
  env: LocalSupervisorEnvV1;
  denoExecutable: string;
  clock?: Clock;
  runChild?: LocalSupervisorChildRunnerV1;
}

export type LocalSupervisorResultV1 =
  | { status: "busy" }
  | { status: "idle"; activeRevision: GitSha }
  | {
    status: "accepted";
    requestId: string;
    revision: GitSha;
    priorRevision: GitSha;
  }
  | {
    status: "rolled_back";
    requestId: string;
    revision: GitSha;
    priorRevision: GitSha;
  }
  | { status: "pending"; detail: string }
  | { status: "failed"; detail: string };

export interface LocalSupervisorInputV1 {
  stateRoot: string;
  sourceDir: string;
  env: LocalSupervisorEnvV1;
  denoExecutable: string;
  runChild: LocalSupervisorChildRunnerV1;
}

/** Mutable per-invocation observation set: child invocations must be unique. */
export type KnownInvocationsV1 = Set<string>;

export type RunObservationV1 =
  | { kind: "proof"; proof: LocalRunProofV1 }
  // An objective failed run may leave no usable proof at all (for example a
  // startup failure with a nonzero exit and no fresh status receipt).
  | { kind: "failed"; proof: LocalRunProofV1 | null; detail: string }
  | { kind: "pending"; detail: string };

export function isHealthyOutcome(outcome: LocalRunProofV1["outcome"]): boolean {
  return LOCAL_RUN_HEALTHY_STATUSES.includes(outcome);
}

export function isFailedOutcome(outcome: LocalRunProofV1["outcome"]): boolean {
  return LOCAL_RUN_FAILED_STATUSES.includes(outcome);
}

export function runtimePath(stateRoot: string, revision: GitSha): string {
  if (!isGitSha(revision)) {
    throw new TypeError(
      "local supervisor rejected: revision is not an exact SHA",
    );
  }
  return joinPath(stateRoot, RUNTIMES_DIR, revision);
}

export function joinPath(base: string, ...parts: string[]): string {
  let out = base.replace(/\/+$/, "");
  for (const part of parts) {
    out += "/" + part.replace(/^\/+|\/+$/g, "");
  }
  return out.length === 0 ? "/" : out;
}
