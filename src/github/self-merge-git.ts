import type { GitSha } from "../contracts/brands.ts";
export interface SelfMergeCommitV1 {
  sha: GitSha;
  tree: GitSha;
  parents: GitSha[];
  sources: {
    workflow: GitSha | null;
    harness: GitSha | null;
    emitter: GitSha | null;
  };
  pipeline: {
    workflows: GitSha | null;
    operations: GitSha | null;
    config: GitSha | null;
    lock: GitSha | null;
  };
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
