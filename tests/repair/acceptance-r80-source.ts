/**
 * R80 (e48e7e110, the rollback target of the generation shipping JAM B6)
 * for its rollback tests: its exact `src/` and `tests/` trees, extracted
 * read-only from the local object store (`git archive`) into a disposable
 * directory under the repository root, and imported from there so R80's own
 * code runs over what the new generation wrote. A checkout without R80 (CI
 * checkouts are shallow) reports `r80Available() === false` and the callers
 * mark their cases ignored. No network, no checkout mutation.
 */
import { OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION as R80 } from "../../src/host/owner-install-runtime-pins.ts";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");
const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** True when R80's commit is in the local object store. */
export async function r80Available(): Promise<boolean> {
  try {
    const probe = await new Deno.Command("git", {
      args: ["-C", ROOT, "cat-file", "-e", `${R80}^{commit}`],
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
 * Import `paths` (repository-relative) from R80's trees; the tree stays until
 * `dispose`, so the modules' own lazy imports and rigs still resolve.
 */
export async function loadR80Modules(paths: readonly string[]): Promise<{
  modules: Record<string, unknown>[];
  dispose(): Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ dir: ROOT, prefix: "sentinel-r80-b6-" });
  const dispose = () => Deno.remove(dir, { recursive: true }).catch(() => {});
  try {
    const archive = await new Deno.Command("git", {
      args: ["-C", ROOT, "archive", "--format=tar", R80, "src", "tests"],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error("R80 source unavailable");
    await Deno.writeFile(`${dir}/tree.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/tree.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    if (!extracted.success) throw new Error("R80 source unreadable");
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
