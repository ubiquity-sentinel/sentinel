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
 * marker; one issue is ever filed per red tip. While any App issue with a
 * base-repair marker is open in the repository (any tip or branch, whatever
 * its records), nothing else is filed there: one open base-repair issue per
 * target at a time (2026-11-15). The pass writes no state and never edits,
 * closes or comments on an issue; the runtime admits the issue like any
 * other, and its fix merges through the ordinary review and CI gates (its
 * pull request closes the issue). The self scope has no base-repair lane.
 *
 * Any unreadable tip, check listing or issue listing, and a default branch
 * that is not a plain ref name, files nothing.
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
import { isHostedSelf } from "./hosted-autonomy-policy.ts";
import { createHostedAutonomyScopes } from "./hosted-autonomy-scopes.ts";
import { readRepairSafely } from "./hosted-autonomy-state.ts";
import type {
  HostedAppIssueV1,
  HostedAutonomyDepsV1,
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
 * The lowest open App issue of the listing whose first line is a
 * base-repair marker (any branch or tip, the first tip-less form included),
 * or null. While one is open nothing else is filed in its repository, even
 * when its repair is parked or done: one open base-repair issue per target
 * at a time (2026-11-15). The merge of its own fix closes it.
 */
function openBaseRepairIssue(
  issues: readonly HostedAppIssueV1[],
): number | null {
  let lowest: number | null = null;
  for (const issue of issues) {
    if (issue.pullRequest || issue.state !== "open") continue;
    if (parseBaseRepairMarker(issue.firstLine) === null) continue;
    if (lowest === null || issue.number < lowest) lowest = issue.number;
  }
  return lowest;
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
  for (const { repository, held } of heldForeignRecords(work, started)) {
    const tag = `base-repair:${repository.owner}/${repository.name}`;
    if (!inBudget()) {
      actions.push(`${tag}:deadline`);
      break;
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
      const heads = [
        ...new Set(
          held.filter((record) => record.target.base === tip)
            .map((record) => record.target.head!),
        ),
      ].slice(0, BASE_REPAIR_HEAD_READS);
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
      const marker = baseRepairMarker(branch, tip);
      const same = filed.find((issue) =>
        !issue.pullRequest && issue.firstLine === marker
      );
      if (same !== undefined) {
        actions.push(`${tag}:filed_before=#${same.number}`);
        continue;
      }
      const open = openBaseRepairIssue(filed);
      if (open !== null) {
        actions.push(`${tag}:open=#${open}`);
        continue;
      }
      if (!inBudget()) {
        actions.push(`${tag}:deadline`);
        break;
      }
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
