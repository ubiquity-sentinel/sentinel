import assert from "node:assert/strict";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { git, PATH, withRepo } from "./review-snapshot-helpers.ts";

Deno.test("Git executor: completed operations release their deadline so a fresh worker exits", async () => {
  await withRepo(async (repo) => {
    await git(repo, ["commit", "--allow-empty", "-qm", "fixture"]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const worker = `${repo}/worker.ts`;
    const module = new URL("../../src/github/git-executor.ts", import.meta.url);
    await Deno.writeTextFile(
      worker,
      `import { DenoGitExecutor } from ${JSON.stringify(module.href)};
const executor = new DenoGitExecutor({
  localDir: ${JSON.stringify(repo)}, remoteUrl: ${JSON.stringify(repo)},
  gitHome: ${JSON.stringify(repo)}, timeoutMs: 60_000,
});
const result = await executor.isAncestor(${JSON.stringify(head)}, ${
        JSON.stringify(head)
      });
if (!result.ok || !result.value) throw new Error("real Git ancestry failed");
console.log("git operation completed");
`,
    );
    const result = await new DenoReplayRuntime(PATH).run({
      executable: Deno.execPath(),
      args: [
        "run",
        "--no-config",
        "--no-lock",
        "--allow-read",
        "--allow-run",
        "--allow-write",
        "--allow-env=PATH,NODE_V8_COVERAGE",
        worker,
      ],
      cwd: repo,
      env: { PATH },
      maxDurationMs: 5_000,
      maxOutputBytes: 8192,
    });
    assert.match(
      new TextDecoder().decode(result.stdout),
      /git operation completed/,
    );
    assert.equal(
      result.outcome,
      "exited",
      JSON.stringify({
        outcome: result.outcome,
        detail: result.detail,
        stderr: new TextDecoder().decode(result.stderr),
      }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.settled, true);
  });
});
