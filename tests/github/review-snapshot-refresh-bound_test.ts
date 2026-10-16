// review snapshot refresh-bound_test.
//
// A base refresh merges the published candidate H1 with the authenticated new
// base B1. Its H1 -> H2 parent edge replays the whole base movement, which is
// trusted base history: a base that moved by more paths than the changed-path
// bound must not turn the refresh into a deterministic structural refusal
// (ai.ubq.fi issue 649 blocked on exactly this), while content the merge itself
// introduces is still inspected on the base edge.

import assert from "node:assert/strict";
import { asGitSha, type GitSha } from "../../src/contracts/brands.ts";
import { MAX_CHANGED_PATHS } from "../../src/github/review-snapshot.ts";
import {
  commitAll,
  contains,
  git,
  producer,
  publicationInput,
  seedProtectedRepo,
  withRepo,
} from "./review-snapshot-helpers.ts";

async function mergeCommit(
  repo: string,
  tree: string,
  parents: readonly GitSha[],
): Promise<GitSha> {
  return asGitSha(
    (await git(repo, [
      "commit-tree",
      tree,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      "Sentinel deterministic base refresh",
    ])).trim(),
  );
}

/** H1 (candidate), B1 (base moved by more than the path bound) and their merge. */
async function wideRefresh(repo: string) {
  const base = await seedProtectedRepo(repo);
  await git(repo, ["checkout", "-q", "-b", "candidate"]);
  await Deno.writeTextFile(`${repo}/public.txt`, "public v2\n");
  const h1 = await commitAll(repo, "candidate H1");

  await git(repo, ["checkout", "-q", "-b", "moved", base]);
  await Deno.mkdir(`${repo}/moved`, { recursive: true });
  for (let index = 0; index <= MAX_CHANGED_PATHS + 8; index++) {
    await Deno.writeTextFile(
      `${repo}/moved/file-${index}.txt`,
      `base movement ${index}\n`,
    );
  }
  await Deno.writeTextFile(`${repo}/protected/keep.txt`, "keep base v2\n");
  const b1 = await commitAll(repo, "authenticated wide base movement B1");

  await git(repo, ["checkout", "-q", "-b", "refresh", b1]);
  await git(repo, ["merge", "-q", "--no-commit", "--no-ff", h1]);
  const tree = (await git(repo, ["write-tree"])).trim();
  await git(repo, ["merge", "--abort"]);
  return { b1, h1, tree };
}

Deno.test(
  "publication: a refresh over a base movement wider than the path bound passes",
  async () => {
    await withRepo(async (repo) => {
      const { b1, h1, tree } = await wideRefresh(repo);
      const h2 = await mergeCommit(repo, tree, [h1, b1]);
      const edge = await git(repo, [
        "diff",
        "--raw",
        "--no-renames",
        h1,
        h2,
      ]);
      assert.ok(
        edge.trim().split("\n").length > MAX_CHANGED_PATHS,
        "the H1 edge genuinely exceeds the changed-path bound",
      );
      const refreshed = await producer(repo).validatePublication(
        publicationInput(b1, h2, {
          publishedHead: h1,
          protectedPaths: ["protected/"],
        }),
      );
      assert.ok(refreshed.ok, refreshed.ok ? "" : refreshed.error.detail);
    });
  },
);

Deno.test(
  "publication: content a wide refresh merge introduces is still inspected",
  async () => {
    await withRepo(async (repo) => {
      const { b1, h1, tree } = await wideRefresh(repo);
      // The merge resolution smuggles secret-shaped content that neither
      // parent carries: it differs from the base, so the base edge exposes it.
      await git(repo, ["checkout", "-q", "-b", "smuggle", b1]);
      await git(repo, ["read-tree", tree]);
      await git(repo, ["checkout", "-q", "--", "."]);
      await Deno.writeTextFile(
        `${repo}/token.txt`,
        `token ghp_${"A".repeat(30)}\n`,
      );
      await git(repo, ["add", "token.txt"]);
      const smuggledTree = (await git(repo, ["write-tree"])).trim();
      const h2 = await mergeCommit(repo, smuggledTree, [h1, b1]);
      const rejected = await producer(repo).validatePublication(
        publicationInput(b1, h2, {
          publishedHead: h1,
          protectedPaths: ["protected/"],
        }),
      );
      assert.ok(!rejected.ok, "merge-introduced secret material must reject");
      if (rejected.ok) assert.fail("expected rejection");
      assert.equal(rejected.error.kind, "invalid");
      contains(rejected.error.detail, "secret");
    });
  },
);
