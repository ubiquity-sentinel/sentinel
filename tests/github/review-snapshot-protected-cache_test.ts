/** The full protected-path policy must fit the validator's finite total deadline. */
import assert from "node:assert/strict";
import { GitReviewSnapshot } from "../../src/github/review-snapshot.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { git, PATH, withRepo } from "./review-snapshot-helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";

Deno.test("publication: identical protected ancestor trees fit the total validation deadline", async () => {
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
          now += 500;
          return result;
        },
      },
    });
    const protectedPaths = [
      "src/host/retained.txt",
      ...Array.from(
        { length: 100 },
        (_, index) => `src/host/policy-${index}.json`,
      ),
    ];
    const result = await snapshot.validatePublication({
      base,
      head,
      publishedHead: null,
      protectedPaths,
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    // The same budget must reject a changed protected descendant, even when
    // an earlier newly exposed commit has identical ancestor trees.
    await Deno.writeTextFile(`${repo}/src/host/retained.txt`, "changed\n");
    await git(repo, ["commit", "-qam", "edit protected descendant"]);
    const changedHead = (await git(repo, ["rev-parse", "HEAD"]))
      .trim() as GitSha;
    now = 1;
    const changed = await snapshot.validatePublication({
      base,
      head: changedHead,
      publishedHead: null,
      protectedPaths,
    });
    assert.equal(changed.ok, false);
    if (!changed.ok) {
      assert.equal(changed.error.kind, "invalid");
      assert.match(changed.error.detail ?? "", /protected/);
    }
  });
});

Deno.test("publication: sibling batches reject malformed duplicate and unrequested records", async (t) => {
  await withRepo(async (repo) => {
    await Deno.mkdir(`${repo}/guard`);
    for (const path of ["a.txt", "b.txt", "ordinary.txt"]) {
      await Deno.writeTextFile(`${repo}/guard/${path}`, "before\n");
    }
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "base"]);
    const base = (await git(repo, ["rev-parse", "HEAD"])).trim() as GitSha;
    await Deno.writeTextFile(`${repo}/guard/ordinary.txt`, "after\n");
    await git(repo, ["commit", "-qam", "allowed sibling change"]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim() as GitSha;
    const real = new DenoReplayRuntime(PATH);
    for (
      const mutation of [
        "malformed",
        "duplicate",
        "unrequested",
        "unterminated",
        "mode",
        "truncated",
      ]
    ) {
      await t.step(mutation, async () => {
        const snapshot = new GitReviewSnapshot({
          repositoryDir: repo,
          trustedPath: PATH,
          runtime: {
            run: async (command) => {
              const result = await real.run(command);
              if (
                !command.args.includes("ls-tree") ||
                !command.args.includes("guard/a.txt") ||
                !command.args.includes("guard/b.txt")
              ) return result;
              if (mutation === "truncated") {
                return { ...result, truncated: true };
              }
              const text = new TextDecoder().decode(result.stdout);
              const first = text.slice(0, text.indexOf("\u0000") + 1);
              const stdout = mutation === "malformed"
                ? "not-a-record\u0000"
                : mutation === "duplicate"
                ? text + first
                : mutation === "unrequested"
                ? text + first.slice(0, first.indexOf("\t")) +
                  "\tguard/foreign.txt\u0000"
                : mutation === "unterminated"
                ? text.slice(0, -1)
                : "100600" + text.slice(6);
              return { ...result, stdout: new TextEncoder().encode(stdout) };
            },
          },
        });
        const result = await snapshot.validatePublication({
          base,
          head,
          publishedHead: null,
          protectedPaths: ["guard/a.txt", "guard/b.txt"],
        });
        assert.equal(result.ok, false, mutation);
        if (!result.ok) {
          assert.equal(result.error.kind, "invalid", mutation);
          assert.match(result.error.detail ?? "", /protected/, mutation);
        }
      });
    }
  });
});

Deno.test("publication: identical outer trees do not hide non-directory protected ancestors", async () => {
  await withRepo(async (repo) => {
    await Deno.mkdir(`${repo}/src`);
    const linked = await new Deno.Command("ln", {
      args: ["-s", "../other", `${repo}/src/alias`],
      cwd: repo,
      clearEnv: true,
      env: { PATH },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(linked.code, 0);
    await Deno.writeTextFile(`${repo}/ordinary.txt`, "before\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "base with symlink ancestor"]);
    const base = (await git(repo, ["rev-parse", "HEAD"])).trim() as GitSha;
    await Deno.writeTextFile(`${repo}/ordinary.txt`, "after\n");
    await git(repo, ["commit", "-qam", "ordinary candidate"]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim() as GitSha;
    const result = await new GitReviewSnapshot({
      repositoryDir: repo,
      trustedPath: PATH,
    }).validatePublication({
      base,
      head,
      publishedHead: null,
      protectedPaths: ["src/alias/missing.txt"],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, "invalid");
      assert.match(result.error.detail ?? "", /protected/);
    }
  });
});

Deno.test("publication: many absent sibling leaves fit the budget below changed ancestors", async () => {
  await withRepo(async (repo) => {
    await Deno.mkdir(`${repo}/src/host`, { recursive: true });
    await Deno.writeTextFile(`${repo}/src/host/ordinary.txt`, "before\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "base"]);
    const base = (await git(repo, ["rev-parse", "HEAD"])).trim() as GitSha;
    await Deno.writeTextFile(`${repo}/src/host/ordinary.txt`, "after\n");
    await git(repo, ["commit", "-qam", "ordinary candidate"]);
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
          now += 500;
          return result;
        },
      },
    });
    const protectedPaths = Array.from(
      { length: 100 },
      (_, index) => `src/host/policy-${index}.json`,
    );
    const result = await snapshot.validatePublication({
      base,
      head,
      publishedHead: null,
      protectedPaths,
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    await Deno.writeTextFile(`${repo}/${protectedPaths[0]}`, "new authority\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "create protected leaf"]);
    now = 1;
    const changed = await snapshot.validatePublication({
      base,
      head: (await git(repo, ["rev-parse", "HEAD"])).trim() as GitSha,
      publishedHead: null,
      protectedPaths,
    });
    assert.equal(changed.ok, false);
    if (!changed.ok) {
      assert.equal(changed.error.kind, "invalid");
      assert.match(changed.error.detail ?? "", /protected/);
    }
  });
});

Deno.test("publication: equal absent ancestors fit the budget below changed directories", async () => {
  await withRepo(async (repo) => {
    await Deno.mkdir(`${repo}/src/host`, { recursive: true });
    await Deno.writeTextFile(`${repo}/src/host/ordinary.txt`, "before\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "base"]);
    const base = (await git(repo, ["rev-parse", "HEAD"])).trim() as GitSha;
    await Deno.writeTextFile(`${repo}/src/host/ordinary.txt`, "after\n");
    await git(repo, ["commit", "-qam", "ordinary candidate"]);
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
          now += 500;
          return result;
        },
      },
    });
    const protectedPaths = Array.from(
      { length: 100 },
      (_, index) => `src/host/missing/policy-${index}.json`,
    );
    const result = await snapshot.validatePublication({
      base,
      head,
      publishedHead: null,
      protectedPaths,
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    // Only equal absence proves unchanged descendants; a newly present
    // directory must still fail the ancestor existence check.
    await Deno.mkdir(`${repo}/src/host/missing`);
    await Deno.writeTextFile(`${repo}/${protectedPaths[0]}`, "new authority\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "create protected ancestor"]);
    const changedHead = (await git(repo, ["rev-parse", "HEAD"]))
      .trim() as GitSha;
    now = 1;
    const changed = await snapshot.validatePublication({
      base,
      head: changedHead,
      publishedHead: null,
      protectedPaths,
    });
    assert.equal(changed.ok, false);
    if (!changed.ok) {
      assert.equal(changed.error.kind, "invalid");
      assert.match(changed.error.detail ?? "", /protected/);
    }
  });
});
