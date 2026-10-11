/** Hosted actions-host-io responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import type {
  Clock,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { joinPath } from "./local.ts";
import {
  STATIC_CONTROLLER,
  STATIC_ENV,
  STATIC_EXECUTABLE,
  STATIC_RUNNER,
} from "./actions-target-cycles.ts";

/** Create the dedicated repair ref once, before any gated GitHub read. */
export async function ensureRepairStateSeed(
  state: StateReadView & RepairStateWriter,
  clock: Clock,
): Promise<void> {
  const current = await state.readRepair();
  if (!current.ok) throw new Error(STATIC_RUNNER);
  if (current.value.status === "found") return;
  const seed = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: clock.now(),
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  const written = await state.writeRepair(seed, null);
  if (written.ok && written.value.status === "applied") return;
  // A concurrent serialized retry may have seeded the ref after our read;
  // accept it only after an authoritative reread proves a valid state exists.
  const reread = await state.readRepair();
  if (!reread.ok || reread.value.status !== "found") {
    throw new Error(STATIC_RUNNER);
  }
}

export function requireEnv(
  read: (name: string) => string | undefined,
  name: string,
): string {
  const value = read(name);
  if (value === undefined || value.length === 0) throw new Error(STATIC_ENV);
  return value;
}

/** An optional credential: absent and empty both mean "not supplied". */
export function optionalEnv(
  read: (name: string) => string | undefined,
  name: string,
): string | undefined {
  const value = read(name);
  return value === undefined || value.length === 0 ? undefined : value;
}

export async function resolveExecutable(
  name: string,
  trustedPath: string,
): Promise<string> {
  for (const directory of trustedPath.split(":")) {
    const candidate = joinPath(directory.length > 0 ? directory : "/", name);
    try {
      const info = await Deno.stat(candidate);
      if (!info.isDirectory) {
        try {
          return await Deno.realPath(candidate);
        } catch {
          return candidate;
        }
      }
    } catch {
      // Continue through the explicitly trusted PATH only.
    }
  }
  throw new Error(STATIC_EXECUTABLE);
}

export async function readControllerSha(
  sourceDir: string,
  trustedPath: string,
): Promise<GitSha> {
  const result = await new Deno.Command("git", {
    args: ["-C", sourceDir, "rev-parse", "HEAD"],
    clearEnv: true,
    env: {
      PATH: trustedPath,
      HOME: sourceDir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const sha = result.success
    ? new TextDecoder().decode(result.stdout).trim()
    : "";
  if (!isGitSha(sha)) throw new Error(STATIC_CONTROLLER);
  return sha;
}
