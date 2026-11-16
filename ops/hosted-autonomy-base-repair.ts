/**
 * Base-repair pass (2026-10-24 throughput redesign, stage 1; reworked
 * 2026-10-25 after its review; see `src/repair/base-repair.ts`).
 *
 * Filing is enabled per target, for the targets listed in
 * `BASE_REPAIR_FILING_TARGETS` only (owner decision 2026-11-15: ai.ubq.fi).
 * Every other target is skipped before any read, exactly as every target
 * was while filing was off (027ecbbea0 until that decision).
 *
 * Once per maintenance pass, for each listed foreign target with records the
 * CI-first gate holds on a red base (at `work` in a running red-base hold,
 * `isRedBaseHold`), the launcher reads the base branch's tip. Only held
 * records whose base IS that tip count (any other refreshes onto it first).
 * It reads the tip's failed checks (`RED_BASE_CONCLUSIONS`, the runtime's
 * red-base set) and those of the first `BASE_REPAIR_HEAD_READS` held heads
 * (`CANDIDATE_CONCLUSIONS`, the only head failures a red base holds), both
 * with the latest run of each name and without runs whose job never started;
 * a failed job either read could not judge makes it unreadable
 * (`FILING_READ`). Only a check failing on both holds anything, so only
 * those are listed, and nothing is filed when none does: a red check no pull
 * request runs (a dispatch-only deploy job) files nothing.
 *
 * The issue is filed without a label, with `baseRepairMarker(branch, tip)`
 * on its first line, after a complete, bounded listing of every issue the
 * App created (open or closed) shows that no App issue already carries that
 * marker; one issue is ever filed per red tip. While any base-repair issue
 * (`isBaseRepairListed`: marker or exact title) is open in the repository
 * (any tip or branch, whatever its records), nothing else is filed there:
 * one open base-repair issue per target at a time (2026-11-15). The hard
 * bound files nothing while the listing holds `BASE_REPAIR_ISSUE_LIMIT`
 * issues the App opened there, open or closed, created within
 * `BASE_REPAIR_ISSUE_WINDOW_MS`, whatever their title or body (2026-11-16).
 * Before any filing the listing must be proven live for the target
 * (`listingProven`: it answers the held records' own App pull requests),
 * and a daily brake independent of it (`BASE_REPAIR_DAY_SKEW_MS`), which
 * also counts issues by who opened them, files at most one issue per target
 * per UTC day, across runs and within one. The pass writes no state and
 * never edits, closes or comments on an issue; the runtime admits the issue
 * like any other, and its fix merges through the ordinary review and CI
 * gates (its pull request closes the issue). The self scope has no
 * base-repair lane.
 *
 * Any unreadable tip, check listing or issue listing, an unproven listing,
 * and a default branch that is not a plain ref name, files nothing.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import {
  baseRepairMarker,
  parseBaseRepairMarker,
} from "../src/repair/base-repair.ts";
import { isRedBaseHold } from "../src/repair/ci-first-policy.ts";
import {
  CANDIDATE_CONCLUSIONS,
  RED_BASE_CONCLUSIONS,
  trustedCheckName,
} from "../src/repair/ci-rejection.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  isHostedSelf,
} from "./hosted-autonomy-policy.ts";
import { createHostedAutonomyScopes } from "./hosted-autonomy-scopes.ts";
import { readRepairSafely } from "./hosted-autonomy-state.ts";
import type {
  HostedAppIssueV1,
  HostedAutonomyDepsV1,
  HostedBaseRepairIssuesV1,
} from "./hosted-autonomy-types.ts";

/**
 * Filing allowlist, by exact `owner/name`: the pass reads and files for
 * these targets only. Owner decision 2026-11-15 enabled `ubiquity/ai.ubq.fi`
 * and no other target; filing had been off for every target since
 * 027ecbbea0 (the former `BASE_REPAIR_FILING_ENABLED = false`), and the
 * runtime's CI-fix cap of a base-repair task (`BASE_REPAIR_CI_FIX_CAP`)
 * landed ahead of it (2026-11-16). Adding a target needs its own owner
 * decision (docs/DECISIONS.md).
 */
export const BASE_REPAIR_FILING_TARGETS: readonly string[] = Object.freeze([
  "ubiquity/ai.ubq.fi",
]);

/** Whether base-repair filing is enabled for `repository`. */
export function baseRepairFilingEnabled(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
): boolean {
  return BASE_REPAIR_FILING_TARGETS.includes(
    `${repository.owner}/${repository.name}`,
  );
}

/**
 * Hard filing bound per target (2026-11-16, after the review of the
 * 2026-11-15 enablement): nothing is filed while the complete listing of the
 * App's issues in the target holds `BASE_REPAIR_ISSUE_LIMIT` issues the App
 * opened there (never a pull request), open or closed, created within the
 * last `BASE_REPAIR_ISSUE_WINDOW_MS`, WHATEVER their title or body. The
 * second review rewrote both the marker line and the title of the filed
 * issue, and a bound that recognised it by either (`isBaseRepairListed`)
 * filed again at the next pass: 288 issues in a day. A person closing the
 * issue, retitling it or rewriting its body therefore never lets the next
 * red tip file another within the window, and a flaky check that re-reds
 * the base after a merged fix waits it out: at most one issue per target per
 * 14 days. The cost: any other issue the App opened in the target (a review
 * follow-up, an outage notice) holds filing for the window too. K = 2
 * overall was not chosen: it still re-files once right after a person closes
 * the first issue, and after its second issue the target could never be
 * repaired again without a code change.
 */
export const BASE_REPAIR_ISSUE_LIMIT = 1;
export const BASE_REPAIR_ISSUE_WINDOW_MS = 14 * 24 * 60 * 60_000;

/**
 * Daily brake (2026-11-16): at most one filing per target per UTC day,
 * whatever the App listing says and whatever any issue says. Across runs it
 * reads GitHub's own record through the created-since listing, which has no
 * `creator` filter and is the one the follow-up pass already reads live:
 * since the start of the current UTC day, less `BASE_REPAIR_DAY_SKEW_MS` of
 * clock skew, ANY issue the App opened in the target (any title or body, so
 * rewriting both cannot lift it), and any author's issue that looks like a
 * base-repair issue (`isBaseRepairListed`; a create GitHub answered under
 * another author: 24 issues in two hours before), holds every new filing.
 * A listing that cannot be read or lists nothing older than that instant
 * (so cannot show it reached back that far) files nothing. Within a run, a
 * repository and UTC day get one create attempt at most. No state
 * Sentinel already persists records a filing: this pass writes none, and
 * the persisted shapes it could extend (the maintenance index, the metrics
 * ledger) have exact-key readers an older runtime would reject.
 */
export const BASE_REPAIR_DAY_SKEW_MS = 10 * 60_000;
/** Pages of the created-since listing one daily brake may read. */
export const BASE_REPAIR_DAY_LISTING_PAGES = 5;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Per run (one `githubFor`, as the hosted main builds it once per run): the
 * `owner/name@utcDay` of every create attempted, whatever GitHub answered
 * (filed, refused, unproven, thrown or answered under another author). Keyed
 * by repository only: records held under two installation ids of one
 * repository filed two issues in one pass when the key held the id.
 */
const attemptedThisRun = new WeakMap<object, Set<string>>();

/**
 * The branch names an issue may name: a plain ref name, with no markup,
 * space, backtick or `@`. Any other default branch files nothing.
 */
const FILING_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** The exact title shape every base-repair issue is filed with. */
const BASE_REPAIR_TITLE = /^CI is failing on [A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** Wall-clock budget of the pass inside the maintenance pass. */
export const BASE_REPAIR_PASS_BUDGET_MS = 60_000;

/** Held heads one repository's pass reads the failed checks of. */
export const BASE_REPAIR_HEAD_READS = 3;

/**
 * Both failed-check reads are strict (2026-11-16): a failed Actions job the
 * read did not judge (past the job-read bound, or its read refused or
 * mismatched) makes the commit unreadable, which files nothing, so a check
 * whose job may never have started is never named red.
 */
const FILING_READ = Object.freeze({ strict: true });

/** At most this many failing check names are listed in an issue. */
const MAX_LISTED_CHECKS = 20;

/**
 * The plain-language base-repair issue for `branch` at `tip`, listing the
 * failing checks by the runtime's trusted name shape (`trustedCheckName`).
 */
export function baseRepairIssue(
  branch: string,
  tip: string,
  failed: readonly string[],
): { title: string; body: string } {
  const names = [...new Set(failed.map(trustedCheckName))].sort();
  const listed = names.slice(0, MAX_LISTED_CHECKS);
  const more = names.length - listed.length;
  return {
    title: `CI is failing on ${branch}`,
    body: [
      baseRepairMarker(branch, tip),
      "",
      `CI is failing on \`${branch}\` at ${tip}. Sentinel's open repairs in this repository fail the same checks, so none of them can merge until these checks pass on \`${branch}\` again.`,
      "",
      "Failing checks:",
      ...listed.map((name) => `- \`${name}\``),
      ...(more > 0 ? [`- and ${more} more`] : []),
      "",
      `Fix the code so these checks pass on \`${branch}\`. Change only what the failure requires.`,
      "",
      "Filed automatically by Sentinel from the check results of that exact commit.",
    ].join("\n"),
  };
}

const repositoryKey = (repository: RepositoryIdentityV1) =>
  `${repository.installationId}/${repository.owner}/${repository.name}`;

/**
 * Foreign records of a target with filing enabled that the CI-first gate
 * holds on a red base at `now` (at `work` with a published head, in a
 * running red-base hold), by repository, each group in record-id order and
 * the groups by repository name.
 */
function heldForeignRecords(
  work: readonly WorkRecordV1[],
  now: number,
): { repository: RepositoryIdentityV1; held: WorkRecordV1[] }[] {
  const groups = new Map<
    string,
    { repository: RepositoryIdentityV1; held: WorkRecordV1[] }
  >();
  for (const record of work) {
    if (
      record.nextStep !== "work" || record.target.head === null ||
      !isRedBaseHold(record.wait, now) || isHostedSelf(record.repository) ||
      !baseRepairFilingEnabled(record.repository)
    ) continue;
    const key = repositoryKey(record.repository);
    const group = groups.get(key) ??
      { repository: record.repository, held: [] };
    group.held.push(record);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.held.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  return [...groups.values()].sort((a, b) =>
    `${a.repository.owner}/${a.repository.name}` <
        `${b.repository.owner}/${b.repository.name}`
      ? -1
      : 1
  );
}

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
 * Whether the App listing is proven live for this target: it lists, as the
 * App's own pull requests, every pull request of the records held on the
 * tip (the runtime opened each one with the App token, so a working
 * `creator` filter answers them), and there is at least one. An empty or
 * short answer, a filter that matched nothing, proves nothing.
 */
function listingProven(
  issues: readonly HostedAppIssueV1[],
  held: readonly WorkRecordV1[],
): boolean {
  const pulls = new Set(
    held.flatMap((record) =>
      record.target.pr === null ? [] : [record.target.pr]
    ),
  );
  const listed = new Set(
    issues.filter((issue) => issue.pullRequest).map((issue) => issue.number),
  );
  return pulls.size > 0 && [...pulls].every((pull) => listed.has(pull));
}

/**
 * The daily brake's verdict from GitHub's own record (see
 * `BASE_REPAIR_DAY_SKEW_MS`), as the action suffix, or null when this UTC
 * day holds no filing: `day_unproven` for a listing that cannot be read or
 * does not reach back past the day's start, `filed_today=#n` for an issue
 * the App opened since then (whatever its title or body) or any author's
 * base-repair issue since then.
 */
async function dayHold(
  issues: HostedBaseRepairIssuesV1,
  now: number,
): Promise<string | null> {
  const since = Math.floor(now / DAY_MS) * DAY_MS - BASE_REPAIR_DAY_SKEW_MS;
  const listing = await issues.listCreatedSince({
    sinceMs: since,
    maxPages: BASE_REPAIR_DAY_LISTING_PAGES,
  });
  if (listing === null || !listing.some((item) => item.createdAt < since)) {
    return "day_unproven";
  }
  const today = listing.find((item) =>
    item.createdAt >= since && !item.pullRequest &&
    (item.author === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
      isBaseRepairListed(item))
  );
  return today === undefined ? null : `filed_today=#${today.number}`;
}

/**
 * Why the complete App listing holds a new issue for `branch` at `tip`, as
 * the action suffix, or null when it holds none. In order: an issue marked
 * for this very tip, open or closed (one issue per red tip); the lowest open
 * base-repair issue (one open at a time per target, 2026-11-15, even when
 * its repair is parked or done; the merge of its own fix closes it); the
 * newest issue the App opened within the hard bound's window
 * (`BASE_REPAIR_ISSUE_LIMIT` within `BASE_REPAIR_ISSUE_WINDOW_MS` of `now`,
 * open or closed, whatever its title or body; an issue dated after `now`
 * counts). The first two recognise base-repair issues by their content and
 * only ever add holds; the hard bound needs no recognition.
 */
function listingHold(
  issues: readonly HostedAppIssueV1[],
  branch: string,
  tip: string,
  now: number,
): string | null {
  const marker = baseRepairMarker(branch, tip);
  const same = issues.find((issue) =>
    !issue.pullRequest && issue.firstLine === marker
  );
  if (same !== undefined) return `filed_before=#${same.number}`;
  const repairs = issues.filter(isBaseRepairListed)
    .sort((a, b) => a.number - b.number);
  const open = repairs.find((issue) => issue.state === "open");
  if (open !== undefined) return `open=#${open.number}`;
  const recent = issues.filter((issue) =>
    !issue.pullRequest && issue.createdAt >= now - BASE_REPAIR_ISSUE_WINDOW_MS
  ).sort((a, b) => a.number - b.number);
  return recent.length >= BASE_REPAIR_ISSUE_LIMIT
    ? `recent=#${recent[recent.length - 1].number}`
    : null;
}

/** Run the base-repair pass; its actions only, never a state change. */
export async function runHostedBaseRepairPass(
  deps: HostedAutonomyDepsV1,
  passDeadline: number = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const actions: string[] = [];
  if (BASE_REPAIR_FILING_TARGETS.length === 0) return actions;
  const started = deps.clock.now();
  if (!Number.isSafeInteger(started)) return actions;
  const deadline = Math.min(started + BASE_REPAIR_PASS_BUDGET_MS, passDeadline);
  const inBudget = () => {
    const now = deps.clock.now();
    return Number.isSafeInteger(now) && now < deadline;
  };
  if (!inBudget()) return actions;
  const read = await readRepairSafely(deps.state);
  if (read === null || !read.ok || read.value.status !== "found") {
    return actions;
  }
  const work = read.value.snapshot.work;
  const { scopeFor } = createHostedAutonomyScopes(deps);
  const attempted = attemptedThisRun.get(deps.githubFor) ?? new Set<string>();
  attemptedThisRun.set(deps.githubFor, attempted);
  const day = Math.floor(started / DAY_MS);
  for (const { repository, held } of heldForeignRecords(work, started)) {
    const tag = `base-repair:${repository.owner}/${repository.name}`;
    if (!inBudget()) {
      actions.push(`${tag}:deadline`);
      break;
    }
    // The in-run brake: one create attempt per repository and UTC day,
    // whatever GitHub answered and under whichever installation id, before
    // any read.
    const dayKey = `${repository.owner}/${repository.name}@${day}`;
    if (attempted.has(dayKey)) {
      actions.push(`${tag}:attempted_this_run`);
      continue;
    }
    try {
      // A surface that cannot read failed checks or file issues costs nothing.
      const capable = deps.githubFor(repository);
      if (
        capable?.failedChecks === undefined ||
        capable.baseRepairIssues === undefined
      ) continue;
      const scope = await scopeFor(repository);
      const surface = scope.surface;
      const branch = scope.baseBranch;
      const issues = surface?.baseRepairIssues;
      if (
        surface === null || branch === null ||
        surface.failedChecks === undefined || issues === undefined
      ) continue;
      // The branch is written into the issue: only a plain ref name is.
      if (!FILING_BRANCH.test(branch)) {
        actions.push(`${tag}:branch_unsupported`);
        continue;
      }
      // Only held records on exactly this tip count below, so a tip that is
      // not a commit SHA files nothing.
      const tip = await surface.readBaseTip(branch);
      if (tip === null) {
        actions.push(`${tag}:tip_unreadable`);
        continue;
      }
      // A record on an older base refreshes onto the tip before it is held.
      const onTip = held.filter((record) => record.target.base === tip);
      const heads = [...new Set(onTip.map((record) => record.target.head!))]
        .slice(0, BASE_REPAIR_HEAD_READS);
      if (heads.length === 0) continue;
      const tipFailed = await surface.failedChecks(
        tip,
        RED_BASE_CONCLUSIONS,
        FILING_READ,
      );
      if (tipFailed === null) {
        actions.push(`${tag}:checks_unreadable`);
        continue;
      }
      if (tipFailed.length === 0) continue;
      const holding = new Set<string>();
      let headsRead = true;
      for (const head of heads) {
        if (!inBudget()) break;
        const failed = await surface.failedChecks(
          head,
          CANDIDATE_CONCLUSIONS,
          FILING_READ,
        );
        if (failed === null) {
          headsRead = false;
          break;
        }
        for (const name of failed) holding.add(name);
      }
      if (!inBudget()) {
        actions.push(`${tag}:deadline`);
        break;
      }
      if (!headsRead) {
        actions.push(`${tag}:head_checks_unreadable`);
        continue;
      }
      // Only a check red on the tip AND on a held head holds a repair.
      const listed = tipFailed.filter((name) => holding.has(name));
      if (listed.length === 0) {
        actions.push(`${tag}:no_held_check`);
        continue;
      }
      const filed = await issues.listAppAuthored();
      if (filed === null) {
        actions.push(`${tag}:issues_unreadable`);
        continue;
      }
      // An empty or short answer proves nothing: the listing must answer
      // the held records' own App pull requests first.
      if (!listingProven(filed, onTip)) {
        actions.push(`${tag}:listing_unproven`);
        continue;
      }
      const hold = listingHold(filed, branch, tip, started);
      if (hold !== null) {
        actions.push(`${tag}:${hold}`);
        continue;
      }
      // The cross-run daily brake, from GitHub's record without the filter.
      const today = await dayHold(issues, started);
      if (today !== null) {
        actions.push(`${tag}:${today}`);
        continue;
      }
      if (!inBudget()) {
        actions.push(`${tag}:deadline`);
        break;
      }
      attempted.add(dayKey);
      const number = await issues.create(baseRepairIssue(branch, tip, listed));
      actions.push(
        number === null ? `${tag}:file_failed` : `${tag}:filed=#${number}`,
      );
    } catch {
      actions.push(`${tag}:unexpected_error`);
    }
  }
  return actions;
}
