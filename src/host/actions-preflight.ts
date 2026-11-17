/**
 * Finite credential-free Codex startup diagnostic.
 *
 * Proves the installed app-server can be spawned, initialized and can
 * acknowledge a `thread/start` bound to the ROUTE-SELECTED model/provider/
 * reasoning and the sentinel-local permission profile WITHOUT any model
 * operation: no `turn/start`, no authoritative token, no host credentials. It
 * runs before budget admission so an actual GitHub-runner startup-boundary
 * failure is attributed exactly instead of being lost inside the first model
 * reservation (the observed hosted failure was a five-second `server_error`
 * with no detail). Passing this diagnostic is NOT repair-delivery success.
 *
 * The provider/model come from the trusted resolved route so a fallback run
 * acknowledges its own provider instead of failing startup on a gateway
 * mismatch; no model call is ever made (the client's endpoint stays the
 * non-routable dummy below and only `thread/start` is submitted).
 */
import {
  CodexProtocolError,
  CodexSubprocessSession,
  signalGroup,
} from "../repair/codex-transport.ts";
import {
  parseStartupPreflightLine,
  STARTUP_PREFLIGHT_KIND,
  type StartupPreflightCodexV1,
  type StartupPreflightErrorV1,
} from "../repair/startup-preflight-line.ts";
import { ensurePrivateDir, ensureTaskClient, joinPath } from "./local.ts";
import { type ModelRouteV1, resolveModelRoute } from "./model-route.ts";

const REASONING = "max";
const PROFILE = "sentinel-local";
const BASE_URL = "http://127.0.0.1:1/v1";
const TOKEN = "unused-no-model-call";
const OPERATION_DEADLINE_MS = 20_000;
const ERROR_CAP = 2_000;
const KIND = STARTUP_PREFLIGHT_KIND;
/** Bound of the post-failure `codex --version` check. */
const CODEX_CHECK_DEADLINE_MS = 5_000;
/** Its TERM-then-KILL grace: the check never adds more than both. */
const CODEX_CHECK_GRACE_MS = 1_000;
const INSIDE_MARKER = "sentinel-inside-probe-marker";
const OUTSIDE_MARKER = "sentinel-outside-probe-marker";
const OVERWRITE_MARKER = "sentinel-outside-probe-overwrite";

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ kind: KIND, ...entry }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

/** A preflight check of its own, with its closed category. */
class PreflightCheckError extends Error {
  constructor(
    readonly code: "codex_not_found" | "evidence" | "sandbox" | "unsettled",
    message: string,
  ) {
    super(message);
  }
}

/** The closed category of a failure; never derived from its text. */
export function preflightErrorCategory(
  stage: string,
  error: unknown,
): StartupPreflightErrorV1 {
  if (error instanceof PreflightCheckError) return error.code;
  if (error instanceof CodexProtocolError) {
    if (
      error.detail === "operation_deadline" ||
      error.detail === "timeout_without_terminal"
    ) return "deadline";
    if (error.detail === "server_error") return "server_error";
    if (error.detail === "child_exited_without_terminal") {
      return stage === "open" ? "spawn_failed" : "child_exited";
    }
    return "protocol";
  }
  const native = Object.values(Deno.errors) as (new () => Error)[];
  return native.some((type) => error instanceof type) ? "io" : "other";
}

/** The settled value, or `undefined` once `ms` passed first. */
async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * After a failure only: does the resolved `codex` run at all? `--version`
 * with PATH alone and no output captured, so a missing executable or
 * interpreter, a non-executable file or a non-zero exit (a wrapper whose
 * native binary is missing) is told apart from a hung or refusing
 * app-server. Never throws and never changes the preflight's outcome.
 *
 * Bounded: the check runs in its own process group. At `deadlineMs` the
 * whole group gets TERM, then KILL, and the check stops waiting after
 * `graceMs` more whatever the group does (`timed_out`); a wrapper that traps
 * TERM, or a descendant it left, is never waited for and never outlives the
 * check (the group is killed after every outcome).
 */
export async function checkCodexExecutable(
  executable: string | null,
  path: string,
  deadlineMs = CODEX_CHECK_DEADLINE_MS,
  graceMs = CODEX_CHECK_GRACE_MS,
): Promise<{ codex: StartupPreflightCodexV1; exitCode?: number }> {
  if (executable === null) return { codex: "not_run" };
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(executable, {
      args: ["--version"],
      clearEnv: true,
      env: { PATH: path },
      stdin: "null",
      stdout: "null",
      stderr: "null",
      // Group leader (pgid = pid): the signals below reach exactly the
      // check's own descendants, never a sibling.
      detached: true,
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { codex: "not_found" };
    if (error instanceof Deno.errors.PermissionDenied) {
      return { codex: "not_executable" };
    }
    return { codex: "spawn_failed" };
  }
  const exited = child.status.then((status) => status, () => null);
  const status = await settleWithin(exited, deadlineMs);
  if (status === undefined) {
    signalGroup(child, "SIGTERM");
    await settleWithin(exited, graceMs / 2);
  }
  // Nothing of the check outlives it, whether it exited or timed out.
  signalGroup(child, "SIGKILL");
  if (status === undefined) {
    await settleWithin(exited, graceMs / 2);
    return { codex: "timed_out" };
  }
  if (status === null) return { codex: "spawn_failed" };
  if (status.success) return { codex: "ok" };
  return {
    codex: "exited",
    exitCode: Math.min(255, Math.max(1, status.code)),
  };
}

/** Print the text-free failure line beside the bounded-text one. */
function logFailureCode(
  stage: string,
  error: unknown,
  check: { codex: StartupPreflightCodexV1; exitCode?: number },
  started: number,
): void {
  try {
    const line = parseStartupPreflightLine({
      kind: KIND,
      pass: false,
      stage,
      errorCode: preflightErrorCategory(stage, error),
      ...check,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    });
    if (line !== null) console.log(JSON.stringify(line));
  } catch {
    // Advisory only: the failure itself is still thrown.
  }
}

/** Bound any failure message; the probe holds no secret or private payload. */
function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    ERROR_CAP,
  );
}

/**
 * One `command/exec` sandbox probe. The response is the verified
 * `{ exitCode, stdout, stderr }` evidence shape.
 */
async function execProbe(
  session: CodexSubprocessSession,
  cwd: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const record = asRecord(
    await session.send("command/exec", {
      command,
      cwd,
      permissionProfile: PROFILE,
      timeoutMs: 5_000,
      outputBytesCap: 2_048,
    }),
  );
  if (
    record === null || typeof record.exitCode !== "number" ||
    typeof record.stdout !== "string"
  ) {
    throw new PreflightCheckError(
      "evidence",
      "command/exec response missing exitCode/stdout evidence",
    );
  }
  return { exitCode: record.exitCode, stdout: record.stdout };
}

/** Resolve the installed codex from the explicit trusted PATH and realPath it. */
async function resolveCodex(path: string): Promise<string> {
  for (const directory of path.split(":")) {
    const candidate = joinPath(directory.length > 0 ? directory : "/", "codex");
    try {
      if (!(await Deno.stat(candidate)).isDirectory) {
        return await Deno.realPath(candidate);
      }
    } catch {
      // Continue through the explicitly trusted PATH only.
    }
  }
  throw new PreflightCheckError(
    "codex_not_found",
    "installed codex executable not found on PATH",
  );
}

export async function runActionsPreflight(
  route: ModelRouteV1 = resolveModelRoute(Deno.env.toObject()),
): Promise<void> {
  const MODEL = route.model;
  const PROVIDER = route.provider;
  // The only host input read is PATH; no credential is ever resolved.
  const path = Deno.env.get("PATH");
  if (path === undefined || path.length === 0) {
    throw new Error("PATH is required to resolve the installed codex");
  }
  const started = performance.now();
  let codexExecutable: string | null = null;
  let root: string | null = null;
  let session: CodexSubprocessSession | null = null;
  let passed = false;
  let primary: unknown = null;
  let stage = "temp_root";
  try {
    // Unique private root (0700); client/tmp/deno are private subdirectories.
    // An independent fixture avoids loading parent repository AGENTS.md
    // instructions. Linux synthetic mounts require host readback for
    // outside-write protection.
    root = await Deno.makeTempDir({ prefix: "sentinel-preflight-" });
    const checkout = joinPath(root, "checkout");
    const clientHome = joinPath(root, "client");
    const tmpDir = joinPath(root, "tmp");
    const denoDir = joinPath(root, "deno");
    const insideMarker = joinPath(checkout, "inside-marker.txt");
    const outsideMarker = joinPath(root, "outside-marker.txt");

    stage = "resolve_codex";
    codexExecutable = await resolveCodex(path);
    log({ stage, codexExecutable });

    stage = "client";
    await ensurePrivateDir(checkout);
    await ensureTaskClient({
      clientHome,
      tmpDir,
      denoDir,
      checkout,
      token: TOKEN,
      codexExecutable,
      denoExecutable: Deno.execPath(),
      trustedPath: path,
      // The route names the provider the thread acknowledgement must echo; the
      // endpoint stays the non-routable dummy because no model call is made.
      route,
      baseUrl: BASE_URL,
    });
    // Trusted-host fixture outside the checkout: the sandboxed session must
    // neither read nor overwrite it.
    await Deno.writeTextFile(outsideMarker, OUTSIDE_MARKER, { mode: 0o600 });
    log({ stage });

    stage = "open";
    session = new CodexSubprocessSession({
      command: [codexExecutable, "app-server"],
      cwd: checkout,
      // Minimal child environment: PATH plus temp HOME/CODEX_HOME/TMPDIR/DENO_DIR.
      env: {
        PATH: path,
        HOME: clientHome,
        CODEX_HOME: clientHome,
        TMPDIR: tmpDir,
        DENO_DIR: denoDir,
      },
      operationDeadlineMs: OPERATION_DEADLINE_MS,
    });
    session.open();
    log({ stage });

    stage = "initialize";
    const initialized = asRecord(
      await session.send("initialize", {
        clientInfo: { name: "sentinel-actions-preflight", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
    );
    if (initialized === null || typeof initialized.userAgent !== "string") {
      throw new PreflightCheckError(
        "evidence",
        "initialize response missing evidence",
      );
    }
    session.notify("initialized", {});
    log({ stage });

    // No turn/start and no model operation is ever submitted: this stops at
    // the startup acknowledgement boundary.
    stage = "thread_start";
    const response = asRecord(
      await session.send("thread/start", {
        model: MODEL,
        modelProvider: PROVIDER,
        cwd: checkout,
        approvalPolicy: "never",
        ephemeral: true,
        permissions: PROFILE,
        config: { model_reasoning_effort: REASONING },
      }),
    );
    const threadId = asRecord(response?.thread)?.id;
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new PreflightCheckError(
        "evidence",
        "thread/start response missing a thread id",
      );
    }
    if (
      response === null || response.model !== MODEL ||
      response.modelProvider !== PROVIDER ||
      response.reasoningEffort !== REASONING
    ) {
      throw new PreflightCheckError(
        "evidence",
        "thread/start response does not acknowledge model/provider/reasoning",
      );
    }
    if (asRecord(response.activePermissionProfile)?.id !== PROFILE) {
      throw new PreflightCheckError(
        "evidence",
        "thread/start response does not acknowledge the permission profile",
      );
    }
    log({ stage, threadId });

    // Sandbox boundary probes after the thread acknowledgement. No model turn
    // is submitted and the child holds no host credential; the trusted host
    // owns the marker outside the checkout. Only booleans are logged.
    stage = "sandbox_inside_write";
    const inside = await execProbe(session, checkout, [
      "/bin/sh",
      "-c",
      `printf %s ${INSIDE_MARKER} > "$1"`,
      "sentinel-probe",
      insideMarker,
    ]);
    if (inside.exitCode !== 0) {
      throw new PreflightCheckError(
        "sandbox",
        "sandbox inside write did not succeed",
      );
    }
    if (await Deno.readTextFile(insideMarker) !== INSIDE_MARKER) {
      throw new PreflightCheckError(
        "sandbox",
        "sandbox inside write not observed on host",
      );
    }
    log({ stage, ok: true });

    stage = "sandbox_outside_read";
    const read = await execProbe(session, checkout, [
      "/bin/cat",
      outsideMarker,
    ]);
    if (read.exitCode === 0 || read.stdout.includes(OUTSIDE_MARKER)) {
      throw new PreflightCheckError(
        "sandbox",
        "sandbox outside read was not denied",
      );
    }
    log({ stage, ok: true });

    stage = "sandbox_outside_write";
    const write = await execProbe(session, checkout, [
      "/bin/sh",
      "-c",
      `printf %s ${OVERWRITE_MARKER} > "$1"`,
      "sentinel-probe",
      outsideMarker,
    ]);
    // Linux may accept a write into its synthetic mount; the unchanged real
    // host marker is authoritative, not the command's exit status.
    if (await Deno.readTextFile(outsideMarker) !== OUTSIDE_MARKER) {
      throw new PreflightCheckError(
        "sandbox",
        "sandbox outside marker changed",
      );
    }
    log({
      stage,
      ok: true,
      hostWritePrevented: true,
      commandExitCode: write.exitCode,
    });

    passed = true;
  } catch (error) {
    // The probe holds no real token, prompt or private task data, so the
    // bounded message is safe to surface for the hosted startup boundary.
    primary = error;
    log({ pass: false, stage, error: boundedMessage(error) });
    const check = await checkCodexExecutable(codexExecutable, path);
    logFailureCode(stage, error, check, started);
  }

  // Cleanup is sequential, never a throwing `finally`: the primary startup
  // failure survives, and cleanup failure is reported only when no primary
  // exists. An unsettled session is never cleaned up, and the probe root is
  // removed only after settlement is observed. Pass is emitted last.
  let cleanup: unknown = null;
  let settled = session === null;
  if (session !== null) {
    try {
      await session.close();
      settled = session.isSettled();
      if (!settled) {
        cleanup = new PreflightCheckError(
          "unsettled",
          "codex preflight session did not settle",
        );
      }
    } catch (error) {
      cleanup = error;
    }
  }
  if (root !== null && settled) {
    try {
      await Deno.remove(root, { recursive: true });
    } catch (error) {
      if (cleanup === null) cleanup = error;
    }
  }
  if (primary !== null) {
    if (cleanup !== null) {
      log({ pass: false, stage: "cleanup", error: boundedMessage(cleanup) });
      logFailureCode("cleanup", cleanup, { codex: "not_run" }, started);
    }
    throw primary;
  }
  if (cleanup !== null) {
    log({ pass: false, stage: "close", error: boundedMessage(cleanup) });
    logFailureCode("close", cleanup, { codex: "not_run" }, started);
    throw cleanup;
  }
  if (passed) log({ pass: true });
}

if (import.meta.main) {
  await runActionsPreflight();
}
