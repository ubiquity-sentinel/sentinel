/**
 * The launcher adapter's reads of a pull request's sources (kept out of
 * `hosted-autonomy-github.ts`, which is at its size ceiling):
 * - `mergedPullHeads`: the CI rule's reference, the proven most recently
 *   merged heads into the base branch (`src/github/merged-pull-heads.ts`,
 *   the runtime's exact query and proof), the default branch when none is
 *   named; a page may carry up to 30 full pull request objects, so it is
 *   read with a 4 MiB bound;
 * - `readIssueFacts`: the source issue with its author (login and numeric
 *   id), for the admission gate (`hosted-autonomy-pull-file-gates.ts`) and
 *   the owner's one-time protected release.
 */
import {
  collectMergedPullHeads,
  mergedPullsQuery,
} from "../src/github/merged-pull-heads.ts";
import type { createHostedAutonomyRequest } from "./hosted-autonomy-github-listing.ts";
import { parseHostedIssueFacts } from "./hosted-autonomy-issue-facts.ts";

/** One merged-head listing page's response bound. */
const MERGED_PAGE_MAX_BYTES = 4 * 1024 * 1024;

export function createHostedSourceReads(
  request: ReturnType<typeof createHostedAutonomyRequest>,
  scope: string,
) {
  return {
    async mergedPullHeads(baseBranch?: string) {
      let branch = baseBranch;
      if (branch === undefined) {
        const repo = await request("GET", `/repos/${scope}`);
        const named = repo !== null && typeof repo === "object"
          ? (repo as Record<string, unknown>)["default_branch"]
          : undefined;
        if (typeof named !== "string" || named.length === 0) return null;
        branch = named;
      }
      const ref = branch;
      return await collectMergedPullHeads(
        (page) =>
          request(
            "GET",
            `/repos/${scope}/pulls?${new URLSearchParams(
              mergedPullsQuery(ref, page),
            )}`,
            undefined,
            MERGED_PAGE_MAX_BYTES,
          ),
        ref,
      );
    },
    async readIssueFacts(number: number) {
      return parseHostedIssueFacts(
        await request("GET", `/repos/${scope}/issues/${number}`),
      );
    },
  };
}
