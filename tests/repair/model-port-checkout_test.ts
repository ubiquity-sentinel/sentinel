/** Cohesive checkout cases for the unchanged model-port facade. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  CodexImplementationPort,
  createRequestRuntimeReceiptVerifier,
  LocalCandidateCommitter,
  LocalCheckoutResolver,
} from "../../src/repair/model-port.ts";
import { gitRun, REPO, testGitEnv } from "../state/helpers.ts";
import { FakeCodexSession } from "./model-port-helpers.ts";

Deno.test("local candidate committer: command refusals remain false and expose only closed branch codes", async () => {
  const original = Deno.Command;
  const base = "a".repeat(40) as GitSha;
  const head = "b".repeat(40);
  try {
    for (
      const reason of [
        "head_unavailable",
        "ancestry_unverified",
        "status_unavailable",
        "unmerged_entries",
        "staging_failed",
        "staged_diff_empty",
        "staged_diff_failed",
        "commit_failed",
        "committed_head_unavailable",
        "committed_head_unchanged",
      ] as const
    ) {
      let headReads = 0;
      Deno.Command = class extends original {
        private args: string[];
        constructor(command: string | URL, options: Deno.CommandOptions = {}) {
          super(command, options);
          this.args = options.args ?? [];
        }
        override output(): Promise<Deno.CommandOutput> {
          const args = this.args.slice(2);
          let code = 0;
          let stdout = "";
          if (args[0] === "rev-parse") {
            const first = headReads++ === 0;
            stdout = first ? base : head;
            if (
              first && reason === "head_unavailable" ||
              !first && reason === "committed_head_unavailable"
            ) stdout = "invalid";
            if (!first && reason === "committed_head_unchanged") stdout = base;
          } else if (args[0] === "merge-base") {
            if (reason === "ancestry_unverified") code = 1;
          } else if (args[0] === "status") {
            if (reason === "status_unavailable") code = 1;
            stdout = reason === "unmerged_entries"
              ? "UU conflict\0"
              : " M src.ts\0";
          } else if (args[0] === "add") {
            if (reason === "staging_failed") code = 1;
          } else if (args[0] === "diff") {
            code = reason === "staged_diff_empty"
              ? 0
              : reason === "staged_diff_failed"
              ? 128
              : 1;
          } else if (args.includes("commit")) {
            if (reason === "commit_failed") code = 1;
          } else throw new Error("unexpected committer command");
          return Promise.resolve({
            code,
            success: code === 0,
            signal: null,
            stdout: new TextEncoder().encode(stdout),
            stderr: new TextEncoder().encode(
              "private git stderr must not escape",
            ),
          });
        }
      };
      const committer = new LocalCandidateCommitter("/unused-fixture");
      assert.equal(await committer.commit(base), false, reason);
      assert.equal(committer.refusalCode, reason);
    }
  } finally {
    Deno.Command = original;
  }
});

Deno.test(
  "issue95: completed descendant candidates reject pending edits through the model port",
  async (t) => {
    for (const pending of ["clean", "unstaged", "staged", "untracked"]) {
      await t.step(pending, async () => {
        const root = await Deno.makeTempDir({ prefix: "sentinel-descendant-" });
        const home = `${root}/home`;
        await Deno.mkdir(home);
        const env = testGitEnv(home);
        const run = async (args: string[]) => {
          const result = await gitRun(root, args, env);
          assert.ok(result.ok, result.stderr);
          return result.stdout;
        };
        try {
          await run(["init", "-q"]);
          await Deno.writeTextFile(`${root}/src.ts`, "before\n");
          await run(["add", "-A"]);
          await run(["commit", "-q", "-m", "base"]);
          const base = (await run(["rev-parse", "HEAD"])).trim() as GitSha;
          await Deno.writeTextFile(`${root}/src.ts`, "committed\n");
          await run(["add", "-A"]);
          await run(["commit", "-q", "-m", "model descendant"]);
          const head = (await run(["rev-parse", "HEAD"])).trim() as GitSha;
          if (pending === "untracked") {
            await Deno.writeTextFile(`${root}/later.ts`, "pending\n");
          } else if (pending !== "clean") {
            await Deno.writeTextFile(`${root}/src.ts`, "pending\n");
            if (pending === "staged") await run(["add", "src.ts"]);
          }
          const statusArgs = ["status", "--porcelain=v1", "-z"];
          const beforeStatus = await run(statusArgs);
          const resolved = await new LocalCheckoutResolver(root, base)
            .resolve();
          assert.equal(
            resolved === null,
            pending !== "clean",
            "a dirty descendant checkout cannot resolve as a candidate",
          );
          const session = new FakeCodexSession();
          const port = new CodexImplementationPort({
            openSession: () => Promise.resolve(session),
            checkoutDir: root,
            checkout: new LocalCheckoutResolver(root, base),
            commitCandidate: new LocalCandidateCommitter(root),
            modelProvider: "sentinel-host",
            receiptVerifier: createRequestRuntimeReceiptVerifier(
              "sentinel-host",
            ),
          });
          const result = await port.runModel({
            taskId: asWorkItemId(`issue95-${pending}`),
            repository: { ...REPO },
            base,
            issue: { number: 95, title: "Preserve final edits", body: "" },
            evidence: [],
            model: "gpt-reserve",
            reasoning: "max",
            maxDurationMs: 5_000,
            maxOutputChars: 10_000,
          });
          assert.equal(result.ok, pending === "clean", JSON.stringify(result));
          if (result.ok) {
            assert.equal(result.value.candidate?.head, head);
          } else {
            assert.equal(result.error.kind, "unavailable");
            assert.equal(
              result.error.detail,
              "candidate descendant checkout has pending edits",
            );
          }
          assert.equal((await run(["rev-parse", "HEAD"])).trim(), head);
          assert.equal(await run(statusArgs), beforeStatus);
          assert.equal(session.closed, true);
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      });
    }
  },
);

Deno.test(
  "local candidate committer: stages sandbox edits and creates one descendant",
  async () => {
    const root = await Deno.makeTempDir({ prefix: "sentinel-model-commit-" });
    const home = `${root}/home`;
    await Deno.mkdir(home);
    const env = testGitEnv(home);
    const run = (args: string[]) => gitRun(root, args, env);
    const sha = async (): Promise<GitSha> => {
      const result = await run(["rev-parse", "HEAD"]);
      assert.ok(result.ok, result.stderr);
      return result.stdout.trim() as GitSha;
    };
    try {
      let result = await run(["init", "-q"]);
      assert.ok(result.ok, result.stderr);
      await Deno.writeTextFile(`${root}/src.ts`, "before\n");
      result = await run(["add", "-A"]);
      assert.ok(result.ok, result.stderr);
      result = await run(["commit", "-q", "-m", "base"]);
      assert.ok(result.ok, result.stderr);
      const base = await sha();
      const committer = new LocalCandidateCommitter(root);
      assert.equal(await committer.commit(base), false);
      assert.equal(Reflect.get(committer, "refusalCode"), "unchanged_base");
      assert.equal(
        await sha(),
        base,
        "a clean base never creates an empty commit",
      );
      await Deno.writeTextFile(`${root}/src.ts`, "after\n");

      const committed = await committer.commit(base);
      assert.equal(committed, true);
      assert.equal(Reflect.get(committer, "refusalCode"), null);
      const head = await sha();
      assert.notEqual(head, base);
      const resolved = await new LocalCheckoutResolver(root, base).resolve();
      assert.deepEqual(resolved?.changedPaths, ["src.ts"]);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "model-port: checkout inventory includes both sides of a source rename",
  async () => {
    const root = await Deno.makeTempDir({ prefix: "sentinel-model-rename-" });
    const home = `${root}/home`;
    await Deno.mkdir(home);
    const env = testGitEnv(home);
    const run = (args: string[]) => gitRun(root, args, env);
    const sha = async (ref: string): Promise<GitSha> => {
      const result = await run(["rev-parse", ref]);
      assert.ok(result.ok, result.stderr);
      return result.stdout.trim() as GitSha;
    };

    try {
      const initialized = await run(["init", "-q"]);
      assert.ok(initialized.ok, initialized.stderr);
      await Deno.mkdir(`${root}/src`);
      await Deno.writeTextFile(`${root}/src/protected.ts`, "protected\n");
      let result = await run(["add", "-A"]);
      assert.ok(result.ok, result.stderr);
      result = await run(["commit", "-q", "-m", "base"]);
      assert.ok(result.ok, result.stderr);
      const base = await sha("HEAD");

      result = await run(["mv", "src/protected.ts", "src/renamed.ts"]);
      assert.ok(result.ok, result.stderr);
      result = await run(["commit", "-q", "-m", "rename"]);
      assert.ok(result.ok, result.stderr);
      const head = await sha("HEAD");

      const resolved = await new LocalCheckoutResolver(root, base).resolve();
      assert.ok(resolved, "the local checkout identity resolves");
      assert.equal(resolved?.head, head);
      assert.deepEqual(
        [...(resolved?.changedPaths ?? [])].sort(),
        ["src/protected.ts", "src/renamed.ts"],
        "protected source removals and destination additions are both visible",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);
