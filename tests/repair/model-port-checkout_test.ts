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
              "candidate checkout could not be committed",
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
      await Deno.writeTextFile(`${root}/src.ts`, "after\n");

      const committed = await new LocalCandidateCommitter(root).commit(base);
      assert.equal(committed, true);
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
