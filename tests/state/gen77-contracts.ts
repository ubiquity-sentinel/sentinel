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
 * The same proof runs against the installed generation-78 runtime (R78,
 * 474f87eb6), the rollback target of generation 79 (`gen78Available`,
 * `loadGen78Modules`, `loadGen78Parsers`, `assertGen78Parses`), and against
 * the installed generation-79 runtime (R79, 549c7a691) itself
 * (`gen79Available`, `loadGen79Parsers`, `assertGen79Parses`).
 *
 * A shallow clone that does not hold the pinned commit cannot run the proof:
 * `gen77Available` (or `gen78Available`) reports that and callers mark the
 * case ignored instead of silently passing it. The literal key-set guard
 * (`assertGen76Shape`; the generation-77 and generation-78 work-record
 * contracts are byte-identical to generation 76's) always runs.
 */
import type { MatrixPlanV1 } from "../../src/contracts/matrix.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { assertGen76Shape } from "./gen76-contracts.ts";

/** Installed generation-77 runtime revision (the rollback target of 78). */
export const GEN77_RUNTIME = "ab3613e0224ff92266bed21dde6f40e6b0aab54a";
/** Installed generation-78 runtime revision (the rollback target of 79). */
export const GEN78_RUNTIME = "474f87eb639f97cd72b9bc4b9e56101488f841aa";
/** Installed generation-79 runtime revision. */
export const GEN79_RUNTIME = "549c7a69186b3d2070aa4e69c92ee846d183ce8f";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");

const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function revisionAvailable(revision: string): Promise<boolean> {
  try {
    const probe = await new Deno.Command("git", {
      args: ["-C", ROOT, "cat-file", "-e", `${revision}^{commit}`],
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

/** True when the pinned generation-77 commit is in the local object store. */
export function gen77Available(): Promise<boolean> {
  return revisionAvailable(GEN77_RUNTIME);
}

/** True when the pinned generation-78 commit is in the local object store. */
export function gen78Available(): Promise<boolean> {
  return revisionAvailable(GEN78_RUNTIME);
}

/** True when the pinned generation-79 commit is in the local object store. */
export function gen79Available(): Promise<boolean> {
  return revisionAvailable(GEN79_RUNTIME);
}

interface LoadedModulesV1 {
  modules: Record<string, unknown>[];
  dispose(): Promise<void>;
}

async function loadRevisionModules(
  revision: string,
  generation: number,
  paths: readonly string[],
): Promise<LoadedModulesV1> {
  const label = `generation-${generation}`;
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: `sentinel-gen${generation}-src-`,
  });
  const dispose = () => Deno.remove(dir, { recursive: true }).catch(() => {});
  try {
    const archive = await new Deno.Command("git", {
      args: ["-C", ROOT, "archive", "--format=tar", revision, "src"],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error(`${label} source unavailable`);
    await Deno.writeFile(`${dir}/src.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/src.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    if (!extracted.success) throw new Error(`${label} source unreadable`);
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

/**
 * Import `paths` (repository-relative, e.g. `src/repair/loop.ts`) from the
 * generation-77 `src/` tree. The extracted tree stays until `dispose`, so the
 * modules' own lazy imports still resolve.
 */
export function loadGen77Modules(
  paths: readonly string[],
): Promise<LoadedModulesV1> {
  return loadRevisionModules(GEN77_RUNTIME, 77, paths);
}

/** `loadGen77Modules` for the generation-78 `src/` tree. */
export function loadGen78Modules(
  paths: readonly string[],
): Promise<LoadedModulesV1> {
  return loadRevisionModules(GEN78_RUNTIME, 78, paths);
}

export interface Gen77ParsersV1 {
  parseRepairStateSnapshotV1(input: unknown): RepairStateSnapshotV1;
  parseMatrixPlanV1(input: unknown): MatrixPlanV1;
}
/** The generation-78 and generation-79 parsers have the same shape. */
export type Gen78ParsersV1 = Gen77ParsersV1;

const cached = new Map<string, Promise<Gen77ParsersV1>>();

function loadRevisionParsers(
  revision: string,
  generation: number,
): Promise<Gen77ParsersV1> {
  const hit = cached.get(revision);
  if (hit !== undefined) return hit;
  const loading = (async () => {
    const loaded = await loadRevisionModules(revision, generation, [
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
  cached.set(revision, loading);
  return loading;
}

/**
 * The generation-77 snapshot and matrix-plan parsers. The extracted tree is
 * removed right after the import (the module graph is held in memory).
 */
export function loadGen77Parsers(): Promise<Gen77ParsersV1> {
  return loadRevisionParsers(GEN77_RUNTIME, 77);
}

/** The generation-78 snapshot and matrix-plan parsers. */
export function loadGen78Parsers(): Promise<Gen78ParsersV1> {
  return loadRevisionParsers(GEN78_RUNTIME, 78);
}

/** The generation-79 snapshot and matrix-plan parsers. */
export function loadGen79Parsers(): Promise<Gen78ParsersV1> {
  return loadRevisionParsers(GEN79_RUNTIME, 79);
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

/**
 * Full rollback proof for one snapshot generation 79 wrote: the literal shape
 * guard, then the pinned generation-78 parser.
 */
export async function assertGen78Parses(
  snapshot: RepairStateSnapshotV1,
): Promise<void> {
  assertGen76Shape(snapshot);
  const parsers = await loadGen78Parsers();
  parsers.parseRepairStateSnapshotV1(JSON.parse(JSON.stringify(snapshot)));
}

/**
 * The same proof for one snapshot under the installed generation-79 runtime:
 * the literal shape guard, then the pinned generation-79 parser.
 */
export async function assertGen79Parses(
  snapshot: RepairStateSnapshotV1,
): Promise<void> {
  assertGen76Shape(snapshot);
  const parsers = await loadGen79Parsers();
  parsers.parseRepairStateSnapshotV1(JSON.parse(JSON.stringify(snapshot)));
}
