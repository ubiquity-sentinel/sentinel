/**
 * Base-repair pass (2026-10-24 throughput redesign, stage 1; reworked
 * 2026-10-25 after its review; see `src/repair/base-repair.ts`).
 *
 * Once per maintenance pass, for each foreign target with records the
 * CI-first gate holds on a red base (at `work` in a running red-base hold,
 * `isRedBaseHold`), the launcher reads the base branch's tip. Only held
 * records whose base IS that tip count (any other refreshes onto it first).
 * It reads the tip's failed checks (`RED_BASE_CONCLUSIONS`, the runtime's
 * red-base set) and those of the first `BASE_REPAIR_HEAD_READS` held heads
 * (`CANDIDATE_CONCLUSIONS`, the only head failures a red base holds), both
 * with the latest run of each name and without runs whose job never started.
 * Only a check failing on both holds anything, so only those are listed, and
 * nothing is filed when none does: a red check no pull request runs (a
 * dispatch-only deploy job) files nothing.
 *
 * The issue is filed without a label, with `baseRepairMarker(branch, tip)`
 * on its first line, after a complete, bounded listing of every issue the
 * App created (open or closed) shows that no App issue already carries that
 * marker; one issue is ever filed per red tip. While an App issue marked for
 * an older tip of the branch is open, a new one is filed only once each of
 * its records is parked or done. The pass writes no state and never edits,
 * closes or comments on an issue; the runtime admits the issue like any
 * other, and its fix merges through the ordinary review and CI gates (its
 * pull request closes the issue). The self scope has no base-repair lane.
 *
 * Any unreadable tip, check listing or issue listing files nothing.
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
 * Filing switch: on since every upheld review finding of 2026-10-25 is fixed
 * (only checks that hold records' heads, a tip-bound marker over a complete
 * App-created listing, no label dependency). Off, the pass reads and files
 * nothing.
 */
export const BASE_REPAIR_FILING_ENABLED = false;

/** Wall-clock budget of the pass inside the maintenance pass. */
export const BASE_REPAIR_PASS_BUDGET_MS = 60_000;

/** Held heads one repository's pass reads the failed checks of. */
export const BASE_REPAIR_HEAD_READS = 3;

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
 * Foreign records the CI-first gate holds on a red base at `now` (at `work`
 * with a published head, in a running red-base hold), by repository, each
 * group in record-id order and the groups by repository name.
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
      !isRedBaseHold(record.wait, now) || isHostedSelf(record.repository)
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
 * The open App issue marked for an older tip of `branch` that still owns a
 * live repair (a record of its issue neither parked nor done, or none yet),
 * or null when there is none.
 */
function liveOlderIssue(
  issues: readonly HostedAppIssueV1[],
  work: readonly WorkRecordV1[],
  repository: RepositoryIdentityV1,
  branch: string,
): number | null {
  const key = repositoryKey(repository);
  for (const issue of issues) {
    if (issue.pullRequest || issue.state !== "open") continue;
    if (parseBaseRepairMarker(issue.firstLine)?.branch !== branch) continue;
    const records = work.filter((record) =>
      repositoryKey(record.repository) === key &&
      record.source.kind === "issue" &&
      record.related.issueNumber === issue.number
    );
    if (
      records.length === 0 ||
      records.some((record) =>
        record.nextStep !== "blocked" && record.nextStep !== "done"
      )
    ) return issue.number;
  }
  return null;
}

/** Run the base-repair pass; its actions only, never a state change. */
export async function runHostedBaseRepairPass(
  deps: HostedAutonomyDepsV1,
  passDeadline: number = Number.POSITIVE_INFINITY,
  /** Tests exercise the pass with filing off. */
  options: { filing?: boolean } = {},
): Promise<string[]> {
  const actions: string[] = [];
  if (!(options.filing ?? BASE_REPAIR_FILING_ENABLED)) return actions;
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
      const tipFailed = await surface.failedChecks(tip, RED_BASE_CONCLUSIONS);
      if (tipFailed === null) {
        actions.push(`${tag}:checks_unreadable`);
        continue;
      }
      if (tipFailed.length === 0) continue;
      const holding = new Set<string>();
      let headsRead = true;
      for (const head of heads) {
        if (!inBudget()) break;
        const failed = await surface.failedChecks(head, CANDIDATE_CONCLUSIONS);
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
      const older = liveOlderIssue(filed, work, repository, branch);
      if (older !== null) {
        actions.push(`${tag}:open=#${older}`);
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
