/**
 * Base-repair pass (2026-10-24 throughput redesign, stage 1; reworked
 * 2026-10-25 after its review; see `src/repair/base-repair.ts`).
 *
 * Filing is enabled per target, for the targets listed in
 * `BASE_REPAIR_FILING_TARGETS` only (owner decision 2026-11-15: ai.ubq.fi).
 * Every other target is skipped before any read, exactly as every target
 * was while filing was off (027ecbbea0 until that decision). Filing also
 * needs the INSTALLED runtime to carry the CI-fix cap of the task it files
 * (`hosted-autonomy-base-repair-runtime.ts`, 2026-11-16): the cap runs in
 * that runtime, this pass in the launcher, and the two differ during an
 * install and after a rollback.
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
 * on its first line, only while no existing issue holds it
 * (`hosted-autonomy-base-repair-bounds.ts`): the complete, bounded listing
 * of every issue the App created shows no issue for this tip, no open
 * base-repair issue (one at a time per target). GitHub's independent
 * created-since listing must show no filing that UTC day (the daily brake, across
 * runs; within one, one create attempt per target and day) and fewer open
 * issues this pass may have filed than the open ceiling. Before any filing
 * the App listing must be proven live for the target (`listingProof`: it
 * answers the held records' own App pull requests). The pass writes no
 * state and never edits, closes or comments on an issue; the runtime admits
 * the issue like any other, and its fix merges through the ordinary review
 * and CI gates (its pull request closes the issue). The self scope has no
 * base-repair lane.
 *
 * Any unreadable tip, check listing or issue listing, an unproven listing,
 * and a default branch that is not a plain ref name, files nothing. The
 * reason is the action's fixed suffix (`base-repair:<owner>/<name>:<code>`,
 * printed only in the run's result line); a permanent condition has its own
 * code apart from the transient read faults (2026-11-16):
 * `held_pull_foreign`, `issues_over_bound`, `checks_over_bound` and
 * `head_checks_over_bound`.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { baseRepairMarker } from "../src/repair/base-repair.ts";
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
import { baseRepairRuntimeHold } from "./hosted-autonomy-base-repair-runtime.ts";
import {
  listingHold,
  recentHold,
} from "./hosted-autonomy-base-repair-bounds.ts";
import type {
  HostedAppIssueV1,
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
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
 * Per run (one `githubFor`, as the hosted main builds it once per run): the
 * `owner/name@utcDay` of every create attempted, whatever GitHub answered
 * (filed, refused, unproven, thrown or answered under another author). Keyed
 * by repository only: records held under two installation ids of one
 * repository filed two issues in one pass when the key held the id.
 */
const attemptedThisRun = new WeakMap<object, Set<string>>();
const DAY_MS = 24 * 60 * 60_000;

/**
 * The branch names an issue may name: a plain ref name, with no markup,
 * space, backtick or `@`. Any other default branch files nothing.
 */
const FILING_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

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
 * Why the App listing is not proven live for this target, as the action
 * suffix, or null when it is: it must list, as the App's own pull requests,
 * every pull request of the records held on the tip (the runtime opened each
 * one with the App token, so a working `creator` filter answers them), and
 * there is at least one. An empty or short answer, a filter that matched
 * nothing, proves nothing (`listing_unproven`). A missing pull request that
 * GitHub names another author for can never be answered while its record is
 * held, so that permanent condition has its own code (`held_pull_foreign`,
 * 2026-11-16); at most `BASE_REPAIR_HEAD_READS` missing pull requests are
 * read, only when the proof fails, and an unreadable one proves nothing.
 */
async function listingProof(
  surface: HostedAutonomyGitHubV1,
  issues: readonly HostedAppIssueV1[],
  held: readonly WorkRecordV1[],
): Promise<string | null> {
  const pulls = new Set(
    held.flatMap((record) =>
      record.target.pr === null ? [] : [record.target.pr]
    ),
  );
  const listed = new Set(
    issues.filter((issue) => issue.pullRequest).map((issue) => issue.number),
  );
  const missing = [...pulls].filter((pull) => !listed.has(pull));
  if (pulls.size > 0 && missing.length === 0) return null;
  for (const number of missing.slice(0, BASE_REPAIR_HEAD_READS)) {
    let author: string | null = null;
    try {
      author = (await surface.readPull(number, null))?.author ?? null;
    } catch {
      author = null;
    }
    if (author !== null && author !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR) {
      return "held_pull_foreign";
    }
  }
  return "listing_unproven";
}

/**
 * One strict filing read of `commit` (`FILING_READ`): its failing check
 * names, null when it cannot be read or judged, or `"over_bound"` when it
 * has more failed Actions jobs than the read judges (a condition of the
 * commit, not a read fault, with its own code since 2026-11-16).
 */
async function filingRead(
  surface: HostedAutonomyGitHubV1,
  commit: string,
  conclusions: readonly string[],
): Promise<string[] | "over_bound" | null> {
  let overBound = false;
  const failed = await surface.failedChecks!(commit, conclusions, {
    ...FILING_READ,
    onOverBound: () => {
      overBound = true;
    },
  });
  return failed === null && overBound ? "over_bound" : failed;
}

/**
 * Run the base-repair pass and return its actions without changing repair
 * state.
 */
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
  // The installed-runtime gate's verdict, read at most once per pass.
  let runtime: string | null | undefined;
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
      const tipFailed = await filingRead(surface, tip, RED_BASE_CONCLUSIONS);
      if (tipFailed === null || tipFailed === "over_bound") {
        actions.push(
          `${tag}:${
            tipFailed === null ? "checks_unreadable" : "checks_over_bound"
          }`,
        );
        continue;
      }
      if (tipFailed.length === 0) continue;
      const holding = new Set<string>();
      let headsRefused: "unreadable" | "over_bound" | null = null;
      for (const head of heads) {
        if (!inBudget()) break;
        const failed = await filingRead(surface, head, CANDIDATE_CONCLUSIONS);
        if (failed === null || failed === "over_bound") {
          headsRefused = failed === null ? "unreadable" : "over_bound";
          break;
        }
        for (const name of failed) holding.add(name);
      }
      if (!inBudget()) {
        actions.push(`${tag}:deadline`);
        break;
      }
      if (headsRefused !== null) {
        actions.push(`${tag}:head_checks_${headsRefused}`);
        continue;
      }
      // Only a check red on the tip AND on a held head holds a repair.
      const listed = tipFailed.filter((name) => holding.has(name));
      if (listed.length === 0) {
        actions.push(`${tag}:no_held_check`);
        continue;
      }
      const filed = await issues.listAppAuthored();
      if (filed === null || filed === "over_bound") {
        actions.push(
          `${tag}:${
            filed === null ? "issues_unreadable" : "issues_over_bound"
          }`,
        );
        continue;
      }
      // An empty or short answer proves nothing: the listing must answer
      // the held records' own App pull requests first.
      const unproven = await listingProof(surface, filed, onTip);
      if (unproven !== null) {
        actions.push(`${tag}:${unproven}`);
        continue;
      }
      const hold = listingHold(filed, branch, tip);
      if (hold !== null) {
        actions.push(`${tag}:${hold}`);
        continue;
      }
      // The cross-run daily brake and the open ceiling, from GitHub's
      // record without the filter.
      const recent = await recentHold(issues, repository, filed, started);
      if (recent !== null) {
        actions.push(`${tag}:${recent}`);
        continue;
      }
      // Last, once per pass: the installed runtime must carry the CI-fix cap
      // that bounds the task this issue becomes (2026-11-16).
      if (runtime === undefined) runtime = await baseRepairRuntimeHold(deps);
      if (runtime !== null) {
        actions.push(`${tag}:${runtime}`);
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
