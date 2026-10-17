/**
 * Generation-77 runtime modules for rollback tests. A failed generation 78
 * restores the installed generation-77 runtime (R77) once, and R77's own code
 * then consumes whatever generation 78 left behind: matrix cells it planned
 * but never ingested and every repair-state shape it wrote. This helper
 * extracts the exact `src/` and `tests/` trees of the pinned generation-77
 * commit read-only from the local object store (`git archive`) into a
 * disposable directory under the repository root and imports the requested
 * modules from it, so R77's own fixtures and rigs run R77's own code. No
 * network, no checkout mutation. A checkout without the pinned commit reports
 * `gen77Available() === false` so callers mark the case ignored. The same
 * helpers exist for the installed generation-78 runtime (R78), the rollback
 * target of generation 79: `gen78Available` and `loadGen78Modules`, and for
 * the installed generation-79 runtime (R79): `gen79Available` and
 * `loadGen79Modules`, for the installed generation-80 runtime (R80), the
 * rollback target of generation 81: `gen80Available` and `loadGen80Modules`,
 * and for the live generation-79 launcher (L79, whose `ops/` tree is
 * extracted too): `l79Available` and `loadL79Modules`.
 */
import {
  OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN78_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN79_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION,
} from "../../src/host/owner-install-runtime-pins.ts";

/** Installed generation-77 runtime revision (the rollback target of 78). */
export const GEN77_RUNTIME: string = OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION;
/** Installed generation-78 runtime revision (the rollback target of 79). */
export const GEN78_RUNTIME: string = OWNER_DEVELOPMENT_INSTALL_GEN78_REVISION;
/** Installed generation-79 runtime revision. */
export const GEN79_RUNTIME: string = OWNER_DEVELOPMENT_INSTALL_GEN79_REVISION;
/** Installed generation-80 runtime revision (the rollback target of 81). */
export const GEN80_RUNTIME: string = OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION;
/**
 * The live generation-79 launcher (L79: the R79 pin 4b8be3b9f plus the
 * protected-path refusal recording), the launcher rollback target of every
 * generation-80 launcher change.
 */
export const L79_LAUNCHER = "7e38d16a4c87c27857312517e1dcd7016ea2a299";

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

/** True when the pinned generation-80 commit is in the local object store. */
export function gen80Available(): Promise<boolean> {
  return revisionAvailable(GEN80_RUNTIME);
}

/** True when the L79 launcher commit is in the local object store. */
export function l79Available(): Promise<boolean> {
  return revisionAvailable(L79_LAUNCHER);
}

interface LoadedRuntimeV1 {
  modules: Record<string, unknown>[];
  dispose(): Promise<void>;
}

/**
 * Import `paths` (repository-relative, e.g. `src/host/matrix-artifacts.ts` or
 * `tests/repair/ci-correction-rig.ts`) from the generation-77 tree. The
 * extracted tree stays until `dispose`, so the modules' own lazy imports and
 * the temporary rigs they create under their own root still resolve.
 */
export function loadGen77Modules(
  paths: readonly string[],
): Promise<LoadedRuntimeV1> {
  return loadRevisionModules(GEN77_RUNTIME, 77, paths);
}

/** `loadGen77Modules` for the generation-78 `src/` and `tests/` trees. */
export function loadGen78Modules(
  paths: readonly string[],
): Promise<LoadedRuntimeV1> {
  return loadRevisionModules(GEN78_RUNTIME, 78, paths);
}

/** `loadGen77Modules` for the generation-79 `src/` and `tests/` trees. */
export function loadGen79Modules(
  paths: readonly string[],
): Promise<LoadedRuntimeV1> {
  return loadRevisionModules(GEN79_RUNTIME, 79, paths);
}

/** `loadGen77Modules` for the generation-80 `src/` and `tests/` trees. */
export function loadGen80Modules(
  paths: readonly string[],
): Promise<LoadedRuntimeV1> {
  return loadRevisionModules(GEN80_RUNTIME, 80, paths);
}

/** `loadGen77Modules` for the L79 launcher's `src/`, `tests/` and `ops/`. */
export function loadL79Modules(
  paths: readonly string[],
): Promise<LoadedRuntimeV1> {
  return loadRevisionModules(L79_LAUNCHER, 79, paths, ["ops"]);
}

async function loadRevisionModules(
  revision: string,
  generation: number,
  paths: readonly string[],
  extraTrees: readonly string[] = [],
): Promise<LoadedRuntimeV1> {
  const label = `generation-${generation}`;
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: `sentinel-gen${generation}-runtime-`,
  });
  const dispose = () => Deno.remove(dir, { recursive: true }).catch(() => {});
  try {
    const archive = await new Deno.Command("git", {
      args: [
        "-C",
        ROOT,
        "archive",
        "--format=tar",
        revision,
        "src",
        "tests",
        ...extraTrees,
      ],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error(`${label} source unavailable`);
    await Deno.writeFile(`${dir}/tree.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/tree.tar`, "-C", dir],
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
