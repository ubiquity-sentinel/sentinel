// review snapshot protected_test.

import assert from "node:assert/strict";
import { asGitSha, type GitSha } from "../../src/contracts/brands.ts";
import {
  MAX_CHANGED_PATHS,
  MAX_FILE_BYTES,
  MAX_NEW_COMMITS,
  MAX_NEW_OBJECTS,
} from "../../src/github/review-snapshot.ts";
import type {
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import {
  commitAll,
  commitIndex,
  contains,
  fakeRuntime,
  git,
  gitWithInput,
  PATH,
  producer,
  publicationInput,
  seedProtectedRepo,
  withRepo,
} from "./review-snapshot-helpers.ts";

Deno.test(
  "publication: protected candidate edits, removals, mode/type and ancestor blocks reject",
  async () => {
    // A protected edit inside a protected subtree.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.writeTextFile(`${repo}/protected/keep.txt`, "keep v2\n");
      const head = await commitAll(repo, "edit protected");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, { protectedPaths: ["protected/"] }),
      );
      assert.ok(!result.ok, "a protected edit must reject");
      if (result.ok) assert.fail("expected rejection");
      assert.equal(result.error.kind, "invalid");
      contains(result.error.detail, "protected");
    });

    // A protected removal.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.remove(`${repo}/protected/keep.txt`);
      const head = await commitAll(repo, "remove protected");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: ["protected/keep.txt"],
        }),
      );
      assert.ok(!result.ok, "a protected removal must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });

    // A protected mode change with the content preserved.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await git(repo, ["add", "-A"]);
      await git(repo, ["update-index", "--chmod=+x", "protected/keep.txt"]);
      const head = await commitIndex(repo, "mode change");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: ["protected/keep.txt"],
        }),
      );
      assert.ok(!result.ok, "a protected mode change must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });

    // A protected type change to a symlink.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.remove(`${repo}/protected/keep.txt`);
      const linked = await new Deno.Command("ln", {
        args: ["-s", "../public.txt", `${repo}/protected/keep.txt`],
        cwd: repo,
        clearEnv: true,
        env: { PATH },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(linked.code, 0, "ln -s must create the symlink");
      const head = await commitAll(repo, "symlink protected");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: ["protected/keep.txt"],
        }),
      );
      assert.ok(!result.ok, "a protected type change must reject");
      if (result.ok) assert.fail("expected rejection");
    });

    // An ancestor-blocking change: the protected path no longer resolves.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.remove(`${repo}/protected`, { recursive: true });
      await Deno.writeTextFile(`${repo}/protected`, "not a directory\n");
      const head = await commitAll(repo, "block protected ancestor");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: ["protected/keep.txt"],
        }),
      );
      assert.ok(!result.ok, "a blocked protected ancestor must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });

    // An allowed sibling change next to an exactly protected entry passes:
    // the ancestor tree SHA changes while the protected entry does not.
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.writeTextFile(`${repo}/protected/sibling.txt`, "sibling v2\n");
      const head = await commitAll(repo, "allowed sibling");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: ["protected/keep.txt"],
        }),
      );
      assert.ok(result.ok, result.ok ? "" : result.error.detail);
    });
  },
);

Deno.test(
  "publication: a replaced protected ancestor is not hidden by an empty leaf diff",
  async () => {
    await withRepo(async (repo) => {
      await Deno.mkdir(`${repo}/dir`, { recursive: true });
      await Deno.writeTextFile(`${repo}/dir/other.txt`, "other v1\n");
      const base = await commitAll(repo, "base with a protected ancestor");
      // The exact protected `dir/missing.txt` is absent in both trees, so a
      // leaf-filtered diff for it is empty; the ancestor `dir` changes from a
      // directory tree to a regular file and must still fail closed.
      await Deno.remove(`${repo}/dir`, { recursive: true });
      await Deno.writeTextFile(`${repo}/dir`, "not a directory\n");
      const head = await commitAll(repo, "replace protected ancestor");

      const result = await producer(repo).validatePublication(
        publicationInput(base, head, { protectedPaths: ["dir/missing.txt"] }),
      );
      assert.ok(!result.ok, "a replaced protected ancestor must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });
  },
);

Deno.test(
  "publication: an explicit empty protected subtree entry is not hidden by an empty leaf diff",
  async () => {
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      // Rebuild the protected subtree with one added explicit empty tree
      // entry: no leaf path changes, but the protected subtree object SHA
      // does, so the protected entry no longer matches the trusted base.
      const emptyTree = (await gitWithInput(repo, ["mktree"], "")).trim();
      const protectedEntries = await git(repo, [
        "ls-tree",
        `${base}:protected`,
      ]);
      const rewrittenProtected = (await gitWithInput(
        repo,
        ["mktree"],
        `${protectedEntries}040000 tree ${emptyTree}\tempty\n`,
      )).trim();
      const rootEntries = (await git(repo, ["ls-tree", base]))
        .split("\n")
        .filter((line) => line !== "" && !line.endsWith("\tprotected"));
      const rootTree = (await gitWithInput(
        repo,
        ["mktree"],
        `${
          rootEntries.join("\n")
        }\n040000 tree ${rewrittenProtected}\tprotected\n`,
      )).trim();
      const head = asGitSha(
        (await git(repo, [
          "commit-tree",
          rootTree,
          "-p",
          base,
          "-m",
          "explicit empty protected tree entry",
        ])).trim(),
      );

      const result = await producer(repo).validatePublication(
        publicationInput(base, head, { protectedPaths: ["protected/"] }),
      );
      assert.ok(
        !result.ok,
        "an explicit empty protected subtree entry must reject",
      );
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "protected");
    });
  },
);

Deno.test(
  "publication: a refreshed H2 with legitimate protected base changes passes",
  async () => {
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await git(repo, ["checkout", "-q", "-b", "candidate"]);
      await Deno.writeTextFile(`${repo}/public.txt`, "public v2\n");
      const h1 = await commitAll(repo, "candidate H1");

      await git(repo, ["checkout", "-q", "-b", "refreshed", base]);
      await Deno.writeTextFile(`${repo}/protected/keep.txt`, "keep base v2\n");
      const b1 = await commitAll(repo, "authenticated base refresh B1");

      // H2 merges the old candidate H1 with the new authenticated base B1:
      // its protected entries come from B1 even though the H1 edge changes
      // protected paths.
      const b1Tree = (await git(repo, ["rev-parse", `${b1}^{tree}`])).trim();
      const h2 = asGitSha(
        (await git(repo, [
          "commit-tree",
          b1Tree,
          "-p",
          h1,
          "-p",
          b1,
          "-m",
          "merge refreshed base",
        ])).trim(),
      );
      const refreshed = await producer(repo).validatePublication(
        publicationInput(b1, h2, {
          publishedHead: h1,
          protectedPaths: ["protected/"],
        }),
      );
      assert.ok(refreshed.ok, refreshed.ok ? "" : refreshed.error.detail);

      // The same merge keeping the old protected tree must reject: protected
      // entries have to match the authenticated base, not the old candidate.
      const h1Tree = (await git(repo, ["rev-parse", `${h1}^{tree}`])).trim();
      const stale = asGitSha(
        (await git(repo, [
          "commit-tree",
          h1Tree,
          "-p",
          h1,
          "-p",
          b1,
          "-m",
          "stale merge",
        ])).trim(),
      );
      const rejected = await producer(repo).validatePublication(
        publicationInput(b1, stale, {
          publishedHead: h1,
          protectedPaths: ["protected/"],
        }),
      );
      assert.ok(!rejected.ok, "a stale protected merge must reject");
      if (rejected.ok) assert.fail("expected rejection");
      contains(rejected.error.detail, "protected");
    });
  },
);

Deno.test(
  "publication: trusted base history is excluded from blob inspection",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      await Deno.writeFile(
        `${repo}/base.bin`,
        new Uint8Array([0x00, 0x01, 0x02, 0xff]),
      );
      const base = await commitAll(repo, "base with an untouched binary");
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed v2\n");
      const head = await commitAll(repo, "candidate");

      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(result.ok, result.ok ? "" : result.error.detail);
    });
  },
);

Deno.test(
  "publication: a merged unrelated root commit exposes and inspects its tree",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/main.txt`, "main v1\n");
      const base = await commitAll(repo, "base");
      const initial = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]))
        .trim();

      await git(repo, ["checkout", "-q", "--orphan", "side"]);
      await git(repo, ["rm", "-rf", "."]);
      await Deno.writeTextFile(`${repo}/side.txt`, "side v1\n");
      await commitAll(repo, "orphan side root");

      await git(repo, ["checkout", "-q", initial]);
      await git(repo, [
        "merge",
        "--no-ff",
        "--allow-unrelated-histories",
        "-q",
        "-m",
        "merge side",
        "side",
      ]);
      const head = asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());

      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(result.ok, result.ok ? "" : result.error.detail);
    });
  },
);

Deno.test(
  "publication: malformed, over-bound and unsettled reads fail closed",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed 2\n");
      const head = await commitAll(repo, "head");
      const input = publicationInput(base, head);

      const timedOut = await producer(repo, {
        runtime: fakeRuntime({ outcome: "timed_out", exitCode: null }),
      }).validatePublication(input);
      assert.ok(!timedOut.ok);
      if (timedOut.ok) assert.fail("expected rejection");
      contains(timedOut.error.detail, "deadline");

      const truncated = await producer(repo, {
        runtime: fakeRuntime({ outcome: "exited", truncated: true }),
      }).validatePublication(input);
      assert.ok(!truncated.ok);
      if (truncated.ok) assert.fail("expected rejection");
      contains(truncated.error.detail, "finite output bound");

      const unsettled = await producer(repo, {
        runtime: fakeRuntime({ outcome: "exited", settled: false }),
      }).validatePublication(input);
      assert.ok(!unsettled.ok);
      if (unsettled.ok) assert.fail("expected rejection");
      contains(unsettled.error.detail, "settlement");

      const malformed = await producer(repo, {
        runtime: fakeRuntime({
          outcome: "exited",
          stdout: new TextEncoder().encode("not-a-sha\n"),
        }),
      }).validatePublication(input);
      assert.ok(!malformed.ok);
      if (malformed.ok) assert.fail("expected rejection");
      contains(malformed.error.detail, "exact commit object");

      const badSha = await producer(repo).validatePublication({
        ...input,
        base: "not-a-sha" as GitSha,
      });
      assert.ok(!badSha.ok);
      if (badSha.ok) assert.fail("expected rejection");
      contains(badSha.error.detail, "expected exact base");

      const badProtected = await producer(repo).validatePublication({
        ...input,
        protectedPaths: ["../escape"],
      });
      assert.ok(!badProtected.ok);
      if (badProtected.ok) assert.fail("expected rejection");
      contains(badProtected.error.detail, "protected paths");
    });

    // One parent edge over the changed-path bound rejects, never trims.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      for (let index = 0; index <= MAX_CHANGED_PATHS; index++) {
        await Deno.writeTextFile(
          `${repo}/f${String(index).padStart(3, "0")}.txt`,
          `file ${index}\n`,
        );
      }
      const head = await commitAll(repo, "over bound edge");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(!result.ok, "an over-bound parent edge must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "structural");
    });

    // One newly exposed blob over the per-file bound rejects.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(
        `${repo}/big.txt`,
        "b".repeat(MAX_FILE_BYTES + 1024),
      );
      const head = await commitAll(repo, "over bound blob");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(!result.ok, "an over-bound blob must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "finite content bound");
    });

    // More newly exposed commits than the bound reject.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      for (let index = 0; index <= MAX_NEW_COMMITS; index++) {
        await git(repo, [
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          `empty ${index}`,
        ]);
      }
      const head = asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(!result.ok, "an over-bound commit list must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "commit bound");
    });

    // More newly exposed objects than the bound reject (scripted runtime:
    // the bounded list read retains exactly one entry past the bound).
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed 2\n");
      const head = await commitAll(repo, "head");
      const objects = Array.from(
        { length: MAX_NEW_OBJECTS + 1 },
        (_, index) => (index + 1).toString(16).padStart(40, "0"),
      );
      const scripted: ReplayRuntimeV1 = {
        run: (command) => {
          const args = command.args;
          const last = args[args.length - 1] ?? "";
          let stdout = "";
          let exitCode = 0;
          if (args.includes("--verify")) {
            stdout = `${last.replace(/\^\{commit\}$/, "")}\n`;
          } else if (args.includes("--objects")) {
            stdout = `${objects.join("\n")}\n`;
          } else if (args.includes("rev-list")) {
            stdout = `${head}\n`;
          } else if (!args.includes("merge-base")) {
            exitCode = 1;
          }
          const result: ReplayCommandResultV1 = {
            outcome: "exited",
            exitCode,
            stdout: new TextEncoder().encode(stdout),
            stderr: new Uint8Array(),
            truncated: false,
            settled: true,
            detail: "scripted",
          };
          return Promise.resolve(result);
        },
      };
      const result = await producer(repo, { runtime: scripted })
        .validatePublication(publicationInput(base, head));
      assert.ok(!result.ok, "an over-bound object list must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "object bound");
    });
  },
);

Deno.test(
  "publication: a protected tree record without a terminal NUL rejects",
  async () => {
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.writeTextFile(`${repo}/public.txt`, "public v2");
      const head = await commitAll(repo, "public change");

      // Dropping only the required trailing NUL leaves one successful,
      // unterminated record: the fail-closed parser must reject it.
      const runtimeModule = await import("../../src/replay/runtime.ts");
      const real = new runtimeModule.DenoReplayRuntime(PATH);
      const withoutTerminalNul: ReplayRuntimeV1 = {
        run: async (command) => {
          const result = await real.run(command);
          if (!command.args.includes("ls-tree")) return result;
          if (!command.args.includes("-z")) return result;
          if (result.outcome !== "exited") return result;
          if (result.exitCode !== 0) return result;
          if (result.truncated || !result.settled) return result;
          if (result.stdout.length === 0) return result;
          if (result.stdout[result.stdout.length - 1] !== 0) return result;
          return { ...result, stdout: result.stdout.slice(0, -1) };
        },
      };

      const result = await producer(repo, { runtime: withoutTerminalNul })
        .validatePublication(
          publicationInput(base, head, { protectedPaths: ["protected/"] }),
        );
      assert.ok(!result.ok, "an unterminated protected record must reject");
      if (result.ok) assert.fail("expected rejection");
    });
  },
);
