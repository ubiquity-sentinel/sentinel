/**
 * The listing behind the CI rule's reference (`src/repair/ci-success-rule.ts`):
 * the heads of the (up to) `MERGED_PULLS_WANTED` most recently merged pull
 * requests into one base branch, newest merge first.
 *
 * GitHub cannot sort pull requests by merge time, and anyone can comment on a
 * closed pull request, which moves its update time. The closed pull requests
 * into the branch are read sorted by update time, newest first, a page at a
 * time; a pull request's update time is never before its merge time, so once
 * the wanted number of merged ones is seen and the last of them merged at or
 * after the last update time read, no unread pull request merged later: the
 * set is proven. A comment flood can only push the proof past the bound
 * (`MERGED_PULLS_PAGES` pages): then the listing is unproven (null) and the
 * rule waits, never an older reference. The runtime client and the launcher
 * adapter send `mergedPullsQuery` and prove with `collectMergedPullHeads`.
 */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type { MergedPullHeadsV1 } from "../contracts/ports-github-requests.ts";

/** Merged pull requests the reference walks at most. */
export const MERGED_PULLS_WANTED = 5;

/** Closed pull requests one page reads (a page stays well under 1 MiB). */
export const MERGED_PULLS_PAGE = 30;

/** Pages one listing reads at most (240 closed pull requests). */
export const MERGED_PULLS_PAGES = 8;

/** One page's exact query for `baseRef`. */
export function mergedPullsQuery(
  baseRef: string,
  page: number,
): Record<string, string> {
  return {
    state: "closed",
    base: baseRef,
    sort: "updated",
    direction: "desc",
    per_page: String(MERGED_PULLS_PAGE),
    page: String(page),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function instant(value: unknown): number | null {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** One page: every item's update time and, when merged, its merge and head. */
export function parseMergedPullPage(
  body: unknown,
  baseRef: string,
): {
  readonly items: { updated: number; merged: number | null; head: GitSha }[];
  readonly full: boolean;
} | null {
  if (!Array.isArray(body) || body.length > MERGED_PULLS_PAGE) return null;
  const items = [];
  for (const item of body) {
    const pull = record(item);
    if (pull === null || record(pull["base"])?.["ref"] !== baseRef) return null;
    const updated = instant(pull["updated_at"]);
    const merged = pull["merged_at"] === null
      ? null
      : instant(pull["merged_at"]);
    const head = record(pull["head"])?.["sha"];
    if (updated === null || !isGitSha(head)) return null;
    if (merged === null && pull["merged_at"] !== null) return null;
    items.push({ updated, merged, head });
  }
  return { items, full: body.length === MERGED_PULLS_PAGE };
}

/**
 * The proven most recently merged heads (module header), reading pages
 * through `fetchPage`; `complete` when the listing ended (every merged pull
 * request into the branch was seen). Unreadable, malformed or unproven
 * within the bound: null.
 */
export async function collectMergedPullHeads(
  fetchPage: (page: number) => Promise<unknown | null>,
  baseRef: string,
): Promise<MergedPullHeadsV1 | null> {
  const merged: { head: GitSha; at: number; order: number }[] = [];
  let lastUpdated = Infinity;
  const top = () =>
    [...merged].sort((a, b) => b.at - a.at || a.order - b.order).slice(
      0,
      MERGED_PULLS_WANTED,
    );
  for (let page = 1; page <= MERGED_PULLS_PAGES; page++) {
    let parsed;
    try {
      parsed = parseMergedPullPage(await fetchPage(page), baseRef);
    } catch {
      return null;
    }
    if (parsed === null) return null;
    for (const item of parsed.items) {
      lastUpdated = Math.min(lastUpdated, item.updated);
      if (item.merged !== null) {
        merged.push({ head: item.head, at: item.merged, order: merged.length });
      }
    }
    if (!parsed.full) {
      return { heads: top().map((pull) => pull.head), complete: true };
    }
    const best = top();
    if (
      best.length === MERGED_PULLS_WANTED &&
      best[MERGED_PULLS_WANTED - 1].at >= lastUpdated
    ) return { heads: best.map((pull) => pull.head), complete: false };
  }
  return null;
}
