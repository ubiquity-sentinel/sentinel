/** The full protected-path policy must fit the validator's finite total deadline. */
import assert from "node:assert/strict";
import { GitReviewSnapshot } from "../../src/github/review-snapshot.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { git, PATH, withRepo } from "./review-snapshot-helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";

Deno.test("publication: shared protected ancestors do not exhaust the total validation deadline", async () => {
  await withRepo(async (repo) => {
    await Deno.mkdir(`${repo}/src/host`, { recursive: true });
    await Deno.writeTextFile(`${repo}/src/host/retained.txt`, "retained\n");
    await Deno.writeTextFile(`${repo}/repair.txt`, "before\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "base"]);
    const base = (await git(repo, ["rev-parse", "HEAD"])).trim() as GitSha;
    await Deno.writeTextFile(`${repo}/repair.txt`, "after\n");
    await git(repo, ["commit", "-qam", "candidate"]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim() as GitSha;
    const real = new DenoReplayRuntime(PATH);
    let now = 1;
    const snapshot = new GitReviewSnapshot({
      repositoryDir: repo,
      trustedPath: PATH,
      now: () => now,
      runtime: {
        run: async (command) => {
          const result = await real.run(command);
          // Model finite process overhead without a wall-clock sleep.
          now += 100;
          return result;
        },
      },
    });
    const result = await snapshot.validatePublication({
      base,
      head,
      publishedHead: null,
      protectedPaths: Array.from(
        { length: 100 },
        (_, index) => `src/host/policy-${index}.json`,
      ),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  });
});
