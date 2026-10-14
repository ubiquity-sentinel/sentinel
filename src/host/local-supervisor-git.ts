import { DenoReplayRuntime } from "../replay/runtime.ts";
import {
  GIT_MAX_OUTPUT_BYTES,
  GIT_TIMEOUT_MS,
  type LocalSupervisorInputV1,
} from "./local-supervisor-shared.ts";

interface GitRunV1 {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
}

/**
 * Bounded git with explicit args, never a shell string. The run reuses the
 * shared owned-group runtime, so both captured streams are drained
 * concurrently (no full-pipe deadlock), the deadline covers the whole process
 * group, and the aggregate retained output is bounded. Owner Git configuration
 * is never consulted: a disposable private HOME, no global/system config and a
 * null hooks path keep the command credential-free. A normal nonzero exit is
 * still `ok: true` so ancestry can read its documented exit 1; only an
 * unsettled, timed-out, spawn-failed or truncated run is `ok: false`.
 */
export async function runGit(
  input: LocalSupervisorInputV1,
  args: readonly string[],
): Promise<GitRunV1> {
  const git = gitExecutable();
  try {
    const result = await new DenoReplayRuntime(git).run({
      executable: git,
      args: ["-c", "core.hooksPath=/dev/null", ...args],
      cwd: input.stateRoot,
      env: {
        PATH: input.env.PATH,
        HOME: input.stateRoot,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    });
    const stdout = new TextDecoder().decode(result.stdout);
    if (result.outcome !== "exited" || !result.settled || result.truncated) {
      return { ok: false, exitCode: result.exitCode, stdout };
    }
    return { ok: true, exitCode: result.exitCode, stdout };
  } catch {
    return { ok: false, exitCode: null, stdout: "" };
  }
}

function gitExecutable(): string {
  try {
    Deno.statSync("/usr/bin/git");
    return "/usr/bin/git";
  } catch {
    return "git";
  }
}
