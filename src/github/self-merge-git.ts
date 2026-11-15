import type { GitSha } from "../contracts/brands.ts";

/**
 * The trusted CI pipeline a self merge requires unchanged from the PR's base
 * to the commit CI tested: what CI runs and how, never the code it tests. The
 * `.github` tree (workflows, actions), the shard runner and its timing table,
 * the size gate the harness runs, `deno.json` and `deno.lock`; the workflow,
 * harness and emitter are pinned separately as `sources`. Launcher and
 * maintenance code elsewhere under `ops/` is ordinary tested code (owner
 * decision 2026-11-15).
 */
export const SELF_MERGE_TRUSTED_PIPELINE = [
  ["workflows", ".github"],
  ["shards", "ops/ci-shards.ts"],
  ["timings", "ops/ci-test-timings.json"],
  ["size", "ops/code-size.ts"],
  ["config", "deno.json"],
  ["lock", "deno.lock"],
] as const;

export type SelfMergePipelineKeyV1 =
  typeof SELF_MERGE_TRUSTED_PIPELINE[number][0];

export interface SelfMergeCommitV1 {
  sha: GitSha;
  tree: GitSha;
  parents: GitSha[];
  sources: {
    workflow: GitSha | null;
    harness: GitSha | null;
    emitter: GitSha | null;
  };
  pipeline: Record<SelfMergePipelineKeyV1, GitSha | null>;
}
export interface SelfMergeClosureV1 {
  merge: GitSha;
  head: GitSha;
  base: GitSha;
  tree: GitSha;
}
export function parseSelfMergeCommit(
  sha: GitSha,
  text: string,
): Omit<SelfMergeCommitV1, "sources" | "pipeline"> | null {
  const headers = text.split("\n\n", 1)[0].split("\n");
  const trees = headers.filter((line) => line.startsWith("tree "));
  const parents = headers.filter((line) => line.startsWith("parent ")).map((
    line,
  ) => line.slice(7));
  if (
    trees.length !== 1 || !/^tree [a-f0-9]{40}$/.test(trees[0]) ||
    parents.length > 4 || parents.some((p) => !/^[a-f0-9]{40}$/.test(p))
  ) return null;
  return {
    sha,
    tree: trees[0].slice(5) as GitSha,
    parents: parents as GitSha[],
  };
}
