/**
 * Which existing issues hold a new base-repair filing: the bounds of the
 * base-repair pass (`hosted-autonomy-base-repair.ts`). Two reads feed them,
 * and every bound fails toward not filing:
 *
 * - the complete listing of every issue and pull request the App created
 *   in the target (`listingHold`): an issue marked for this very tip or an
 *   open base-repair issue;
 * - GitHub's created-since listing, which has no `creator` filter
 *   (`recentHold`): the daily brake and the open ceiling, which also count
 *   what the App listing cannot show (a create GitHub answered under another
 *   author, a `creator` filter that silently matched nothing).
 *
 * Issue text is untrusted. The daily brake and the open ceiling, which bound
 * the filing rate and the open issues, count every App issue whatever it
 * says (the ceiling leaves out only the App's review follow-ups, by their
 * own marker). In the App listing, the marker and exact title identify a
 * base-repair issue and can hold filing. A closed repair for a different tip
 * does not carry a hold into another UTC day.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  baseRepairMarker,
  parseBaseRepairMarker,
} from "../src/repair/base-repair.ts";
import { parseFollowUpMarker } from "./hosted-autonomy-follow-up-render.ts";
import { HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR } from "./hosted-autonomy-policy.ts";
import type {
  HostedAppIssueV1,
  HostedBaseRepairIssuesV1,
  HostedIssueListingItemV1,
} from "./hosted-autonomy-types.ts";

const DAY_MS = 24 * 60 * 60_000;

/**
 * Daily brake (2026-11-16): at most one filing per target per UTC day,
 * whatever the App listing says and whatever any issue says. Across runs it
 * reads GitHub's own record through the created-since listing, which has no
 * `creator` filter and is the one the follow-up pass already reads live:
 * since the start of the current UTC day, less `BASE_REPAIR_DAY_SKEW_MS` of
 * clock skew, ANY issue the App opened in the target (any title or body, so
 * rewriting both cannot lift it) holds every new filing, and so does an
 * issue with a base-repair marker on its first line opened by one of
 * `BASE_REPAIR_TRUSTED_ASSOCIATIONS` (a create GitHub answered under
 * another author: 24 issues in two hours before the brake). Nobody else's
 * issue holds anything, whatever it says (third review: any GitHub user
 * could suppress filing for a day with the base-repair title). A listing
 * that cannot be read, lists nothing older than that instant (so cannot
 * show it reached back that far) or does not say who opened a marked issue
 * files nothing. Within a run, a repository and UTC day get one create
 * attempt at most. No state Sentinel already persists records a filing:
 * this pass writes none, and the persisted shapes it could extend (the
 * maintenance index, the metrics ledger) have exact-key readers an older
 * runtime would reject.
 */
export const BASE_REPAIR_DAY_SKEW_MS = 10 * 60_000;

/**
 * The creators, besides the App, whose base-repair-marked issue holds a
 * filing (`author_association`): an owner, member or collaborator of the
 * target. Sentinel's only credentials for a target are the App's and, as a
 * stopgap, the owner's own, so a create GitHub answered under another
 * author comes back as one of these; an outsider (`NONE`, `CONTRIBUTOR`,
 * `FIRST_TIMER`, ...) never holds filing.
 */
export const BASE_REPAIR_TRUSTED_ASSOCIATIONS: readonly string[] = Object
  .freeze(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Open ceiling (2026-11-16, third review): nothing is filed while
 * `BASE_REPAIR_OPEN_LIMIT` issues this pass may have filed are open in the
 * target, WHATEVER their title or body: every open issue the App opened
 * there, at any age (the complete App listing), and every open issue the
 * created-since listing shows within `BASE_REPAIR_OPEN_WINDOW_MS` that holds
 * filing (`holdsFiling`: the App's, or a trusted creator's marked one, which
 * the App listing never shows). Only the App's review follow-ups, by their
 * own marker naming this target (one issue per finding, so many), are left
 * out: a person never types one by accident. The third review found two
 * ways to more than one open base-repair issue: a person rewrites both the
 * title and the first line of the open one, so nothing recognises it, and a
 * create answered under another author is never in the App listing (one more
 * open issue each day). Both now stop at this ceiling: a rewritten issue
 * counts while it is open, at any age, and a create answered under another
 * author counts for the window. A capability issue the App keeps open
 * counts too, so with one open, one rewritten issue holds filing.
 */
export const BASE_REPAIR_OPEN_LIMIT = 2;
export const BASE_REPAIR_OPEN_WINDOW_MS = 14 * DAY_MS;

/**
 * Pages of the created-since listing one pass may read, back to the start
 * of the open ceiling's window (the daily brake reads the same answer).
 */
export const BASE_REPAIR_RECENT_LISTING_PAGES = 10;

/** The exact title shape every base-repair issue is filed with. */
const BASE_REPAIR_TITLE = /^CI is failing on [A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/**
 * Whether one item of the App's listing is a base-repair issue: an issue,
 * never a pull request, whose first line is a base-repair marker (any branch
 * or tip, the first tip-less form included) OR whose title is exactly the
 * filed shape `CI is failing on <branch>`. Either one is enough, so a person
 * editing one of them leaves the issue recognised.
 */
export function isBaseRepairListed(
  issue: Pick<HostedAppIssueV1, "pullRequest" | "firstLine"> & {
    title?: string;
  },
): boolean {
  return !issue.pullRequest &&
    (parseBaseRepairMarker(issue.firstLine) !== null ||
      (issue.title !== undefined && BASE_REPAIR_TITLE.test(issue.title)));
}

/**
 * Why the complete App listing holds a new issue. A marker for the exact
 * branch and tip takes precedence, even on a closed issue. Otherwise the
 * lowest-numbered open base-repair issue holds filing until it closes.
 */
export function listingHold(
  issues: readonly HostedAppIssueV1[],
  branch: string,
  tip: string,
): string | null {
  const marker = baseRepairMarker(branch, tip);
  const same = issues.find((issue) =>
    !issue.pullRequest && issue.firstLine === marker
  );
  if (same !== undefined) return `filed_before=#${same.number}`;
  const open =
    issues.filter((issue) =>
      issue.state === "open" && isBaseRepairListed(issue)
    ).sort((a, b) => a.number - b.number)[0];
  return open === undefined ? null : `open=#${open.number}`;
}

/**
 * Whether one created-since item holds filing whoever's listing it is: an
 * issue the App opened (any title or body), or one with a base-repair
 * marker on its first line opened by a trusted creator
 * (`BASE_REPAIR_TRUSTED_ASSOCIATIONS`). Null when a marked issue does not
 * say who opened it, which proves nothing.
 */
function holdsFiling(item: HostedIssueListingItemV1): boolean | null {
  if (item.pullRequest) return false;
  if (item.author === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR) return true;
  if (parseBaseRepairMarker(item.firstLine) === null) return false;
  if (item.authorAssociation === undefined) return null;
  return BASE_REPAIR_TRUSTED_ASSOCIATIONS.includes(item.authorAssociation);
}

/** Whether `firstLine` is the App's review follow-up marker for `target`. */
function followUpOf(
  firstLine: string,
  target: Pick<RepositoryIdentityV1, "owner" | "name">,
): boolean {
  const marker = parseFollowUpMarker(firstLine);
  return marker !== null && marker.owner === target.owner &&
    marker.name === target.name;
}

/**
 * The holds read from GitHub's created-since listing, read once back to the
 * start of the open ceiling's window, as the action suffix, or null when
 * none holds. In order:
 *
 * - the daily brake (`BASE_REPAIR_DAY_SKEW_MS`): `day_unproven` for a
 *   listing that cannot be read, does not reach back past the UTC day's
 *   start or holds a marked issue of unknown standing that day,
 *   `filed_today=#n` for an issue that day that holds filing
 *   (`holdsFiling`);
 * - the open ceiling (`BASE_REPAIR_OPEN_LIMIT`), over that listing and the
 *   complete App listing `app`: `ceiling_unproven` for a listing that does
 *   not reach back past the window's start or holds a marked issue of
 *   unknown standing in it, `open_ceiling=#n` (the newest counted issue)
 *   when as many issues are open as the ceiling allows.
 */
export async function recentHold(
  issues: HostedBaseRepairIssuesV1,
  target: Pick<RepositoryIdentityV1, "owner" | "name">,
  app: readonly HostedAppIssueV1[],
  now: number,
): Promise<string | null> {
  const day = Math.floor(now / DAY_MS) * DAY_MS - BASE_REPAIR_DAY_SKEW_MS;
  const window = Math.min(day, now - BASE_REPAIR_OPEN_WINDOW_MS);
  const listing = await issues.listCreatedSince({
    sinceMs: window,
    maxPages: BASE_REPAIR_RECENT_LISTING_PAGES,
  });
  if (listing === null || !listing.some((item) => item.createdAt < day)) {
    return "day_unproven";
  }
  const recent = listing.filter((item) => item.createdAt >= window)
    .map((item) => ({ item, holds: holdsFiling(item) }));
  const today = recent.filter(({ item }) => item.createdAt >= day);
  if (today.some(({ holds }) => holds === null)) return "day_unproven";
  const filed = today.find(({ holds }) => holds)?.item;
  if (filed !== undefined) return `filed_today=#${filed.number}`;
  if (
    !listing.some((item) => item.createdAt < window) ||
    recent.some(({ holds }) => holds === null)
  ) return "ceiling_unproven";
  const open = new Set<number>();
  for (const issue of app) {
    if (
      !issue.pullRequest && issue.state === "open" &&
      !followUpOf(issue.firstLine, target)
    ) open.add(issue.number);
  }
  for (const { item, holds } of recent) {
    if (
      holds && item.state !== "closed" &&
      !(item.author === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR &&
        followUpOf(item.firstLine, target))
    ) open.add(item.number);
  }
  return open.size >= BASE_REPAIR_OPEN_LIMIT
    ? `open_ceiling=#${Math.max(...open)}`
    : null;
}
