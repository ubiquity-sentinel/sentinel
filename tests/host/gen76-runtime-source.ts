/**
 * Generation-76 runtime modules for rollback tests. A failed generation 77
 * restores the installed generation-76 runtime once, and that runtime's own
 * code then consumes whatever generation 77 left behind, including matrix
 * artifacts it planned but never ingested. This helper extracts the exact
 * `src/` tree of the pinned generation-76 commit read-only from the local
 * object store (`git archive`) into a disposable directory under the
 * repository root and imports the requested modules from it. No network, no
 * checkout mutation. A checkout without the pinned commit reports
 * `gen76Available() === false` so callers mark the case ignored.
 */
import { GEN76_RUNTIME } from "../state/gen76-contracts.ts";

export { gen76Available } from "../state/gen76-contracts.ts";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");

const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Import `paths` (repository-relative, e.g. `src/host/matrix-artifacts.ts`)
 * from the generation-76 tree. The extracted tree stays until `dispose`, so
 * the modules' own lazy imports still resolve.
 */
export async function loadGen76Modules(paths: readonly string[]): Promise<{
  modules: Record<string, unknown>[];
  dispose(): Promise<void>;
}> {
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-gen76-runtime-",
  });
  const dispose = () => Deno.remove(dir, { recursive: true }).catch(() => {});
  try {
    const archive = await new Deno.Command("git", {
      args: ["-C", ROOT, "archive", "--format=tar", GEN76_RUNTIME, "src"],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error("generation-76 source unavailable");
    await Deno.writeFile(`${dir}/src.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/src.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    if (!extracted.success) throw new Error("generation-76 source unreadable");
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
