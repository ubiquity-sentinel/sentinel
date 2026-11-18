/**
 * The launcher surface's repository read (`GET /repos/{owner}/{name}`): its
 * default branch and GitHub's answer about its visibility. One successful
 * answer is kept for the surface's life (one launcher run), so the
 * private-target gate's visibility read and every later default-branch read
 * share it; a failed read is not kept and the next caller reads again.
 */
import {
  repositoryVisibilityV1,
  type TargetVisibilityV1,
} from "../src/repair/target-visibility.ts";

export function createHostedRepositoryReads(
  request: (method: string, path: string) => Promise<unknown | null>,
  scope: string,
): {
  readDefaultBranch(): Promise<string | null>;
  readVisibility(): Promise<TargetVisibilityV1>;
} {
  let answered: Promise<Record<string, unknown> | null> | null = null;
  const repository = (): Promise<Record<string, unknown> | null> => {
    if (answered !== null) return answered;
    const reading = (async () => {
      const repo = await request("GET", `/repos/${scope}`);
      return repo !== null && typeof repo === "object" && !Array.isArray(repo)
        ? repo as Record<string, unknown>
        : null;
    })();
    answered = reading;
    reading.then((repo) => {
      if (repo === null && answered === reading) answered = null;
    }, () => {
      if (answered === reading) answered = null;
    });
    return reading;
  };
  return {
    async readDefaultBranch() {
      const repo = await repository();
      if (repo === null) return null;
      const branch = repo["default_branch"];
      return typeof branch === "string" && branch.length > 0 ? branch : null;
    },
    async readVisibility() {
      return repositoryVisibilityV1(await repository());
    },
  };
}
