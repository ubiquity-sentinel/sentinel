/**
 * The text-free failure line of the Codex startup preflight
 * (src/host/actions-preflight.ts), as the launcher re-emits it into the
 * hosted job log (`scanStepLines`).
 *
 * The preflight's own failure line carries its bounded error text; the hosted
 * child's stdout filter never prints it. Beside it the preflight prints this
 * line: the failing stage and a closed error category, a closed result of a
 * post-failure check of the installed `codex` executable (`codex --version`
 * with no output captured: missing, not executable, exited with a code, ...),
 * that exit code when it exited, and the elapsed time. Never an error text,
 * path, environment value or command output. It carries `pass`, never
 * `status` (the launcher's child-status scan reads any line with its own
 * `status` as a child record). The parser accepts only the exact key set and
 * closed values and rebuilds the line, so nothing else a child prints is
 * echoed. Advisory only: a failed preflight still ends the run red.
 */
export const STARTUP_PREFLIGHT_KIND = "sentinel_startup_preflight";

/** Every stage the preflight can fail at (cleanup/close: after a pass). */
export const STARTUP_PREFLIGHT_STAGES = [
  "temp_root",
  "resolve_codex",
  "client",
  "open",
  "initialize",
  "thread_start",
  "sandbox_inside_write",
  "sandbox_outside_read",
  "sandbox_outside_write",
  "cleanup",
  "close",
] as const;

/** The closed category of the failing stage's error. */
export const STARTUP_PREFLIGHT_ERRORS = [
  /** No `codex` executable on the trusted PATH. */
  "codex_not_found",
  /** The app-server child could not be spawned. */
  "spawn_failed",
  /** The session's operation deadline passed without an answer. */
  "deadline",
  /** The session reported its child gone without the expected answer. */
  "child_exited",
  /** The app-server answered with a JSON-RPC error. */
  "server_error",
  /** Malformed, unexpected or oversized protocol frames. */
  "protocol",
  /** A response lacked or did not acknowledge the expected evidence. */
  "evidence",
  /** A sandbox boundary probe did not hold. */
  "sandbox",
  /** The session's process group did not settle at close. */
  "unsettled",
  /** A local filesystem or process error. */
  "io",
  "other",
] as const;

/** The closed result of the post-failure `codex --version` check. */
export const STARTUP_PREFLIGHT_CODEX = [
  /** It ran and exited 0. */
  "ok",
  /** The executable (or its interpreter) does not exist. */
  "not_found",
  /** The executable is not executable. */
  "not_executable",
  /** Any other spawn failure. */
  "spawn_failed",
  /** It exited non-zero (`exitCode`). */
  "exited",
  /** It did not exit within its bound. */
  "timed_out",
  /** No executable was resolved, so nothing was checked. */
  "not_run",
] as const;

export type StartupPreflightStageV1 = typeof STARTUP_PREFLIGHT_STAGES[number];
export type StartupPreflightErrorV1 = typeof STARTUP_PREFLIGHT_ERRORS[number];
export type StartupPreflightCodexV1 = typeof STARTUP_PREFLIGHT_CODEX[number];

export interface StartupPreflightLineV1 {
  kind: typeof STARTUP_PREFLIGHT_KIND;
  pass: false;
  stage: StartupPreflightStageV1;
  errorCode: StartupPreflightErrorV1;
  codex: StartupPreflightCodexV1;
  /** Present only when `codex` is `exited`. */
  exitCode?: number;
  elapsedMs: number;
}

const MAX_ELAPSED_MS = 24 * 60 * 60_000;
const KEYS = ["codex", "elapsedMs", "errorCode", "kind", "pass", "stage"];
const PLAIN_KEYS = KEYS.join();
const EXITED_KEYS = [...KEYS, "exitCode"].sort().join();

/** The strictly re-parsed failure line, or null for anything else. */
export function parseStartupPreflightLine(
  value: unknown,
): StartupPreflightLineV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const line = value as Record<string, unknown>;
  const keys = Object.keys(line).sort().join();
  const exited = line.codex === "exited";
  if (
    keys !== (exited ? EXITED_KEYS : PLAIN_KEYS) ||
    line.kind !== STARTUP_PREFLIGHT_KIND || line.pass !== false ||
    !STARTUP_PREFLIGHT_STAGES.includes(line.stage as StartupPreflightStageV1) ||
    !STARTUP_PREFLIGHT_ERRORS.includes(
      line.errorCode as StartupPreflightErrorV1,
    ) ||
    !STARTUP_PREFLIGHT_CODEX.includes(line.codex as StartupPreflightCodexV1) ||
    (exited &&
      (!Number.isSafeInteger(line.exitCode) || (line.exitCode as number) < 1 ||
        (line.exitCode as number) > 255)) ||
    !Number.isSafeInteger(line.elapsedMs) || (line.elapsedMs as number) < 0 ||
    (line.elapsedMs as number) > MAX_ELAPSED_MS
  ) return null;
  return {
    kind: STARTUP_PREFLIGHT_KIND,
    pass: false,
    stage: line.stage as StartupPreflightStageV1,
    errorCode: line.errorCode as StartupPreflightErrorV1,
    codex: line.codex as StartupPreflightCodexV1,
    ...(exited ? { exitCode: line.exitCode as number } : {}),
    elapsedMs: line.elapsedMs as number,
  };
}
