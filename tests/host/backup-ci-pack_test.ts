/** Platform archive boundary, without the workflow parser or external APIs. */
import assert from "node:assert/strict";
import {
  BACKUP_CI_EXEC_REF,
  createBackupCiGit,
  fetchBackupCiBare,
  fileSha256,
  packBackupCiBare,
} from "../../ops/backup-ci-materialize.ts";
import {
  archiveFixtureBare,
  fixtureGit,
  targetRepo,
} from "./backup-ci-test-repo.ts";

Deno.test("planner archive adapter works when GNU-only tar flags are rejected", async () => {
  const repo = await targetRepo("backup-ci-pack-");
  const Command = Deno.Command;
  const rejected: string[][] = [];
  try {
    const head = await repo.commit({ "src/a.ts": "export const a = 1;\n" });
    const bare = await fetchBackupCiBare({
      git: createBackupCiGit(`${repo.root}/home`),
      dir: `${repo.root}/m/bare`,
      remoteUrl: repo.url,
      token: null,
      commits: [head],
      protocols: ["file"],
    });
    assert(bare);
    assert(await bare.setExec(head));
    await Deno.writeTextFile(`${bare.dir}/unit.json`, "{}");
    // A deterministic capability probe, not an assertion about the host OS:
    // BSD tar rejects the GNU creation flags; POSIX tar creation still works.
    Deno.Command = class extends Command {
      constructor(command: string | URL, options: Deno.CommandOptions = {}) {
        const reject = command === "tar" &&
          options.args?.some((arg) => arg.startsWith("--"));
        if (reject) rejected.push([...(options.args ?? [])]);
        super(
          reject ? "sh" : command,
          reject ? { ...options, args: ["-c", "exit 64"] } : options,
        );
      }
    };
    assert.deepEqual(
      await packBackupCiBare(bare, `${repo.root}/gnu.tar`, []),
      { ok: false, reason: "tar_failed" },
    );
    assert.equal(rejected.length, 1);
    assert(rejected[0].includes("--sort=name"));
    assert(rejected[0].includes("--mtime=@0"));
    const out = `${repo.root}/portable.tar`;
    const packed = await packBackupCiBare(bare, out, [], archiveFixtureBare);
    assert(packed.ok, "GNU metadata flags are not a planner prerequisite");
    assert.equal(packed.sha256, await fileSha256(out));
    const unpack = `${repo.root}/unpack`;
    await Deno.mkdir(unpack);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", out, "-C", unpack],
    }).output();
    assert(extracted.success);
    assert.equal(
      await fixtureGit(unpack, [
        "--git-dir=bare",
        "rev-parse",
        BACKUP_CI_EXEC_REF,
      ]),
      head,
      "the adapter ships the real selected Git object, not a placeholder tar",
    );
    assert.equal(await Deno.readTextFile(`${unpack}/bare/unit.json`), "{}");
    assert.deepEqual(
      await packBackupCiBare(bare, out, [], () => Promise.resolve(false)),
      { ok: false, reason: "tar_failed" },
    );
    assert.deepEqual(
      await packBackupCiBare(
        bare,
        out,
        [],
        () => Promise.reject(new Error("tar")),
      ),
      { ok: false, reason: "tar_failed" },
    );
    // Even a successful adapter cannot bypass the post-archive custody scan.
    assert.deepEqual(
      await packBackupCiBare(
        bare,
        out,
        ["fixture-secret"],
        async (_p, path) => {
          await Deno.writeTextFile(path, "fixture-secret");
          return true;
        },
      ),
      { ok: false, reason: "credential" },
    );
    assert.equal(await Deno.stat(out).then(() => true, () => false), false);
    await Deno.writeTextFile(`${bare.dir}/config`, "extraheader", {
      append: true,
    });
    let calls = 0;
    assert.deepEqual(
      await packBackupCiBare(bare, out, [], () => {
        calls++;
        return Promise.resolve(true);
      }),
      { ok: false, reason: "credential" },
    );
    assert.equal(calls, 0, "pre-archive custody scan is not injectable");
  } finally {
    Deno.Command = Command;
    await repo.close();
  }
});
