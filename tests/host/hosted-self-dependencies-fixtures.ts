import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { selfDependencyRig } from "./self-dependency-fixtures.ts";

/** The producer runs as a separate process and the reader receives no JSON seal. */
export async function hostedSeedRig() {
  const rig = await selfDependencyRig();
  const launcher = `${rig.root}/launcher`;
  await Deno.rename(rig.source, launcher);
  await Deno.writeTextFile(
    `${launcher}/.gitignore`,
    ".sentinel-artifacts/\n.sentinel/\n",
  );
  await rig.git(["add", ".gitignore"], launcher);
  await rig.git(
    ["commit", "-qm", "ignore private trusted launcher state"],
    launcher,
  );
  const base = await rig.git(["rev-parse", "HEAD"], launcher) as GitSha;
  const runtime = `${rig.root}/runtime`;
  await rig.git(
    ["clone", "--quiet", "--no-hardlinks", launcher, runtime],
    rig.root,
  );
  const request = { ...rig.request, base };
  const options = { ...rig.options, sourcePath: launcher };
  const input = {
    runtimeDir: runtime,
    launcherSha: base,
    executionLauncherSha: base,
    trustedPath: options.trustedPath,
  };
  const cli = `${Deno.cwd()}/ops/hosted-autonomy-self-dependencies.ts`;
  const producer = async (args: string[] = []) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read=.,/usr,/bin," + Deno.execPath(),
        "--allow-write",
        "--allow-run",
        "--allow-env=PATH,NODE_V8_COVERAGE",
        cli,
        ...args,
      ],
      cwd: launcher,
      clearEnv: true,
      env: {
        PATH: options.trustedPath,
        HOME: `${rig.root}/producer-home`,
        TMPDIR: rig.root,
        DENO_DIR: `${rig.root}/producer-deno`,
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  };
  return {
    ...rig,
    base,
    request,
    options,
    launcher,
    runtime,
    input,
    producer,
    seedDirectory: `${launcher}/.sentinel/self-dependencies`,
    assertClean: async () =>
      assert.equal(
        await rig.git(
          ["status", "--porcelain", "--untracked-files=all"],
          launcher,
        ),
        "",
      ),
  };
}
