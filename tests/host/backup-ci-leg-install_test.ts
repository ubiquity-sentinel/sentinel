/**
 * The leg's act install under the leg workflow's exact Deno flags (live leg
 * 40161342513, 2026-10-25): `--allow-run` grants the act path, and Deno
 * refuses any write to a path granted there, so the `Deno.chmod` after the
 * extraction failed with NotCapable and no backup leg could ever run. The
 * install now relies on the archive's own 0755 mode and checks it with a
 * read. The test runs the REAL `legInstall` and production dependencies in a
 * subprocess with the flags parsed from `.github/workflows/backup-ci-leg.yml`
 * ($RUNNER_TEMP substituted); only the download is faked (a synthetic
 * archive). All synthetic.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parse } from "@std/yaml";

type Obj = Record<string, unknown>;

/** The deno flags of the leg's install step, `$RUNNER_TEMP` substituted. */
async function installFlags(runTemp: string): Promise<string[]> {
  const yaml = parse(
    await Deno.readTextFile(".github/workflows/backup-ci-leg.yml"),
  ) as Obj;
  const steps = ((yaml.jobs as Obj).leg as Obj).steps as Obj[];
  const step = steps.find((s) => s.name === "Install the pinned act");
  assert(step !== undefined);
  const words = String(step.run).trim().split(/\s+/);
  assert.deepEqual(words.slice(0, 2), ["deno", "run"]);
  assert.equal(words.at(-1), "install");
  assert.equal(words.at(-2), "ops/backup-ci-leg.ts");
  return words.slice(2, -2).map((flag) =>
    flag.replaceAll('"$RUNNER_TEMP', runTemp).replaceAll('"', "")
  );
}

/** A synthetic act release archive: `act` (mode `mode`) printing a version. */
async function archive(dir: string, mode: number): Promise<string> {
  const src = `${dir}/src`;
  await Deno.mkdir(src, { recursive: true });
  await Deno.writeTextFile(
    `${src}/act`,
    "#!/bin/sh\necho 'act version 0.2.89'\n",
  );
  await Deno.chmod(`${src}/act`, mode);
  await Deno.writeTextFile(`${src}/LICENSE`, "synthetic\n");
  const out = `${dir}/act_Linux_x86_64.tar.gz`;
  const tar = await new Deno.Command("tar", {
    args: ["-czf", out, "-C", src, "LICENSE", "act"],
  }).output();
  assert.equal(tar.code, 0);
  return out;
}

async function install(mode: number) {
  // Under the repository: CI grants test reads of `.` only.
  const dir = `${Deno.cwd()}/${
    (await Deno.makeTempDir({ dir: ".", prefix: ".backup-ci-leg-install-" }))
      .replace(/^\.\//, "")
  }`;
  try {
    const runTemp = `${dir}/runner-temp`;
    const launcher = `${dir}/launcher`;
    await Deno.mkdir(runTemp, { recursive: true });
    await Deno.mkdir(`${launcher}/ops`, { recursive: true });
    const path = await archive(dir, mode);
    const sha256 = createHash("sha256").update(await Deno.readFile(path))
      .digest("hex");
    await Deno.writeTextFile(
      `${launcher}/ops/backup-ci-pins.json`,
      JSON.stringify({
        act: {
          version: "v0.2.89",
          releasedAt: "2026-06-01",
          asset: "act_Linux_x86_64.tar.gz",
          sha256,
        },
        node: "24.19.0",
      }),
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        ...await installFlags(runTemp),
        "tests/host/backup-ci-leg-install-driver.ts",
        path,
        launcher,
      ],
      clearEnv: true,
      env: { RUNNER_TEMP: runTemp, HOME: dir, PATH: "/usr/bin:/bin" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    return { code: out.code, text, act: `${runTemp}/backup-ci/bin/act` };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("leg install under the workflow's own flags installs the pinned act", async () => {
  const { code, text } = await install(0o755);
  assert.equal(code, 0, text);
  assert.ok(!text.includes("NotCapable"), text);
});

Deno.test("leg install refuses an act the archive does not mark executable", async () => {
  const { code, text } = await install(0o644);
  assert.equal(code, 1, text);
  assert.match(text, /act is not executable/);
});
