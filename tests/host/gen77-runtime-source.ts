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
 * `gen77Available() === false` so callers mark the case ignored.
 */
import { OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION } from "../../src/host/owner-install-runtime-pins.ts";

/** Installed generation-77 runtime revision (the rollback target of 78). */
export const GEN77_RUNTIME: string = OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION;

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
 * Import `paths` (repository-relative, e.g. `src/host/matrix-artifacts.ts` or
 * `tests/repair/ci-correction-rig.ts`) from the generation-77 tree. The
 * extracted tree stays until `dispose`, so the modules' own lazy imports and
 * the temporary rigs they create under their own root still resolve.
 */
export async function loadGen77Modules(paths: readonly string[]): Promise<{
  modules: Record<string, unknown>[];
  dispose(): Promise<void>;
}> {
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-gen77-runtime-",
  });
  const dispose = () => Deno.remove(dir, { recursive: true }).catch(() => {});
  try {
    const archive = await new Deno.Command("git", {
      args: [
        "-C",
        ROOT,
        "archive",
        "--format=tar",
        GEN77_RUNTIME,
        "src",
        "tests",
      ],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error("generation-77 source unavailable");
    await Deno.writeFile(`${dir}/tree.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/tree.tar`, "-C", dir],
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
