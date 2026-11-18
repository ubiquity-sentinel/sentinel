/**
 * The one listing behind the 2026-11-18 CI rule's reference
 * (`src/repair/ci-success-rule.ts`): the heads of the most recently merged
 * pull requests into one base branch, newest merge first. One request for the
 * `MERGED_PULLS_PAGE` most recently updated closed pull requests into that
 * branch (a merged pull request's update time is never before its merge, so
 * every recently merged one is on that page unless as many closed pull
 * requests were updated since). The runtime client and the launcher adapter
 * both send `mergedPullsQuery` and parse with `parseMergedPullHeads`, so they
 * read the same reference.
 */
import { isGitSha } from "../contracts/brands.ts";
import type { MergedPullHeadsV1 } from "../contracts/ports-github-requests.ts";

/** Closed pull requests one merged-head listing reads (one request). */
export const MERGED_PULLS_PAGE = 50;

/** The listing's exact query for `baseRef`. */
export function mergedPullsQuery(baseRef: string): Record<string, string> {
  return {
    state: "closed",
    base: baseRef,
    sort: "updated",
    direction: "desc",
    per_page: String(MERGED_PULLS_PAGE),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The merged heads of one listing page, newest merge first (equal instants
 * keep the listing's order); `complete` only when the page was not full, so
 * no other merged pull request into the branch exists. Any malformed item,
 * an item of another base branch or an oversized page is null (unreadable).
 */
export function parseMergedPullHeads(
  body: unknown,
  baseRef: string,
): MergedPullHeadsV1 | null {
  if (!Array.isArray(body) || body.length > MERGED_PULLS_PAGE) return null;
  const merged: { head: MergedPullHeadsV1["heads"][number]; at: number }[] = [];
  for (const item of body) {
    const pull = record(item);
    if (pull === null) return null;
    const at = pull["merged_at"];
    if (at === null) continue;
    const time = typeof at === "string" ? Date.parse(at) : NaN;
    if (!Number.isFinite(time)) return null;
    if (record(pull["base"])?.["ref"] !== baseRef) return null;
    const head = record(pull["head"])?.["sha"];
    if (!isGitSha(head)) return null;
    merged.push({ head, at: time });
  }
  merged.sort((a, b) => b.at - a.at);
  return {
    heads: merged.map((pull) => pull.head),
    complete: body.length < MERGED_PULLS_PAGE,
  };
}
