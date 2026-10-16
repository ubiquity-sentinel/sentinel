/**
 * Generation-77 rollback parsers and runtime modules. A failed generation-78
 * first trial restores the installed generation-77 runtime (R77, ab3613e02)
 * once, and that runtime's STRICT contract parsers and repair loop then read
 * and execute every record generation 78 wrote. This helper extracts the exact
 * `src/` tree of the pinned commit read-only from the local object store
 * (`git archive`) into a disposable directory under the repository root and
 * imports the requested modules from it, so a test can prove that every
 * snapshot or matrix plan written by new code parses (or is refused) under the
 * runtime a rollback would reinstate, and run R77's own loop over it. No
 * network, no checkout mutation.
 *
 * A shallow clone that does not hold the pinned commit cannot run the proof:
 * `gen77Available` reports that and callers mark the case ignored instead of
 * silently passing it. The literal key-set guard (`assertGen76Shape`; the
 * generation-77 work-record contracts are byte-identical to generation 76's)
 * always runs.
 */
import type { MatrixPlanV1 } from "../../src/contracts/matrix.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { assertGen76Shape } from "./gen76-contracts.ts";

/** Installed generation-77 runtime revision (the rollback target of 78). */
export const GEN77_RUNTIME = "ab3613e0224ff92266bed21dde6f40e6b0aab54a";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");

const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** True when the pinned generation-77 commit is in the local object store. */
export async function gen77Available(): Promise<boolean> {
  try {
    const probe = await new Deno.Command("git", {
      args: ["-C", ROOT, "cat-file", "-e", `${GEN77_RUNTIME}^{commit}`],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "null",
      stderr: "null",
    }).output();
    return probe.success;
  } catch {
    return false;
  }
}

/**
 * Import `paths` (repository-relative, e.g. `src/repair/loop.ts`) from the
 * generation-77 `src/` tree. The extracted tree stays until `dispose`, so the
 * modules' own lazy imports still resolve.
 */
export async function loadGen77Modules(paths: readonly string[]): Promise<{
  modules: Record<string, unknown>[];
  dispose(): Promise<void>;
}> {
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-gen77-src-",
  });
  const dispose = () => Deno.remove(dir, { recursive: true }).catch(() => {});
  try {
    const archive = await new Deno.Command("git", {
      args: ["-C", ROOT, "archive", "--format=tar", GEN77_RUNTIME, "src"],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error("generation-77 source unavailable");
    await Deno.writeFile(`${dir}/src.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/src.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    if (!extracted.success) throw new Error("generation-77 source unreadable");
    const modules: Record<string, unknown>[] = [];
    for (const path of paths) {
      modules.push(await import(new URL(`file://${dir}/${path}`).href));
    }
    return { modules, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export interface Gen77ParsersV1 {
  parseRepairStateSnapshotV1(input: unknown): RepairStateSnapshotV1;
  parseMatrixPlanV1(input: unknown): MatrixPlanV1;
}

let cached: Promise<Gen77ParsersV1> | null = null;

/**
 * The generation-77 snapshot and matrix-plan parsers. The extracted tree is
 * removed right after the import (the module graph is held in memory).
 */
export function loadGen77Parsers(): Promise<Gen77ParsersV1> {
  if (cached !== null) return cached;
  cached = (async () => {
    const loaded = await loadGen77Modules([
      "src/contracts/state-snapshots.ts",
      "src/contracts/matrix.ts",
    ]);
    try {
      const [snapshots, matrix] = loaded.modules as [
        Pick<Gen77ParsersV1, "parseRepairStateSnapshotV1">,
        Pick<Gen77ParsersV1, "parseMatrixPlanV1">,
      ];
      return {
        parseRepairStateSnapshotV1: snapshots.parseRepairStateSnapshotV1,
        parseMatrixPlanV1: matrix.parseMatrixPlanV1,
      };
    } finally {
      await loaded.dispose();
    }
  })();
  return cached;
}

/**
 * Full rollback proof for one written snapshot: the literal shape guard, then
 * the pinned generation-77 parser (which also re-validates every reservation,
 * review, attempt-memory and lesson row the snapshot carries).
 */
export async function assertGen77Parses(
  snapshot: RepairStateSnapshotV1,
): Promise<void> {
  assertGen76Shape(snapshot);
  const parsers = await loadGen77Parsers();
  parsers.parseRepairStateSnapshotV1(JSON.parse(JSON.stringify(snapshot)));
}
