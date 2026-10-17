/**
 * The live generation-79 launcher (L79, 7e38d16a4: the R79 pin plus the
 * protected-path refusal recording) for rollback tests. Generation 80 keeps
 * L79 as the launcher a rollback restores, so its own maintenance planners
 * must leave every state generation 80 writes alone. Like
 * `gen77-runtime-source.ts`, this extracts the exact pinned tree read-only
 * from the local object store (`git archive`), but with `ops/` beside `src/`
 * and `tests/`, into a disposable directory under the repository root, and
 * imports the requested modules from it. A checkout without the commit
 * reports `l79Available() === false` so callers mark the case ignored.
 */

/** The live generation-79 launcher revision. */
export const L79_LAUNCHER = "7e38d16a4c87c27857312517e1dcd7016ea2a299";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");

const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** True when the pinned launcher commit is in the local object store. */
export async function l79Available(): Promise<boolean> {
  try {
    const probe = await new Deno.Command("git", {
      args: ["-C", ROOT, "cat-file", "-e", `${L79_LAUNCHER}^{commit}`],
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

/** Import repository-relative `paths` from the L79 `src/`, `ops/` and `tests/`. */
export async function loadL79Modules(paths: readonly string[]): Promise<{
  modules: Record<string, unknown>[];
  dispose(): Promise<void>;
}> {
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-l79-launcher-",
  });
  const dispose = () => Deno.remove(dir, { recursive: true }).catch(() => {});
  try {
    const archive = await new Deno.Command("git", {
      args: [
        "-C",
        ROOT,
        "archive",
        "--format=tar",
        L79_LAUNCHER,
        "src",
        "ops",
        "tests",
      ],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error("L79 source unavailable");
    await Deno.writeFile(`${dir}/tree.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/tree.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    if (!extracted.success) throw new Error("L79 source unreadable");
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
