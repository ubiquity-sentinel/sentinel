/**
 * Base-repair pass (2026-10-24 throughput redesign, stage 1; see
 * `src/repair/base-repair.ts`).
 *
 * Once per maintenance pass, for each foreign target with a record held in a
 * timed `backoff` at `work` (the CI-first `base_red` hold), the launcher reads
 * the target base branch's tip and the check runs on that exact commit. When a completed check failed there, every repair in the
 * repository is held behind it (`base_red`), so the pass makes sure one open
 * base-repair issue names the failing checks: it files one, labelled P0 with
 * the marker on its first line, unless an open issue already carries the
 * marker for that branch. It writes no state and never edits, closes or
 * comments on an existing issue; the runtime admits the issue like any other,
 * and its fix merges through the ordinary review and CI gates (its pull
 * request closes the issue). The self scope is left to self-observation.
 *
 * Only completed failures count (`failure`, `timed_out`, `startup_failure`):
 * a pending, cancelled, absent or unreadable listing files nothing.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { baseRepairMarker } from "../src/repair/base-repair.ts";
import { isHostedSelf } from "./hosted-autonomy-policy.ts";
import { createHostedAutonomyScopes } from "./hosted-autonomy-scopes.ts";
import { readRepairSafely } from "./hosted-autonomy-state.ts";
import type { HostedAutonomyDepsV1 } from "./hosted-autonomy-types.ts";

/** Wall-clock budget of the pass inside the maintenance pass. */
export const BASE_REPAIR_PASS_BUDGET_MS = 60_000;

/** At most this many failing check names are listed in an issue. */
const MAX_LISTED_CHECKS = 20;

/** A check name as it may appear in an issue: printable, bounded. */
function safeCheckName(name: string): string {
  const printable = name.replace(/[^\x20-\x7e]/g, "?").replace(/`/g, "'");
  return printable.length > 120 ? `${printable.slice(0, 117)}...` : printable;
}

/** The plain-language base-repair issue for `branch` at `tip`. */
export function baseRepairIssue(
  branch: string,
  tip: string,
  failed: readonly string[],
): { title: string; body: string; labels: string[] } {
  const names = [...new Set(failed.map(safeCheckName))].sort();
  const listed = names.slice(0, MAX_LISTED_CHECKS);
  const more = names.length - listed.length;
  return {
    title: `CI is failing on ${branch}`,
    labels: ["P0"],
    body: [
      baseRepairMarker(branch),
      "",
      `CI is failing on \`${branch}\` at ${tip}. Sentinel cannot merge any other repair in this repository until these checks pass again.`,
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

/**
 * Foreign repositories with a record the CI-first gate may be holding on a
 * red base: at `work` in a timed `backoff` (the `base_red` hold re-arms a
 * 30-minute one on every poll). Only those pay for a tip read; any other
 * timed backoff there costs one read and files nothing on a green tip.
 */
function heldForeignRepositories(
  work: readonly {
    repository: RepositoryIdentityV1;
    nextStep: string;
    wait: { reason: string; until: number | null } | null;
  }[],
): RepositoryIdentityV1[] {
  const seen = new Map<string, RepositoryIdentityV1>();
  for (const record of work) {
    if (
      record.nextStep !== "work" || record.wait?.reason !== "backoff" ||
      record.wait.until === null
    ) continue;
    if (isHostedSelf(record.repository)) continue;
    const key =
      `${record.repository.installationId}/${record.repository.owner}/${record.repository.name}`;
    if (!seen.has(key)) seen.set(key, record.repository);
  }
  return [...seen.values()].sort((a, b) =>
    `${a.owner}/${a.name}` < `${b.owner}/${b.name}` ? -1 : 1
  );
}

/** Run the base-repair pass; its actions only, never a state change. */
export async function runHostedBaseRepairPass(
  deps: HostedAutonomyDepsV1,
  passDeadline: number = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const actions: string[] = [];
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
  const { scopeFor } = createHostedAutonomyScopes(deps);
  for (const repository of heldForeignRepositories(read.value.snapshot.work)) {
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
        capable.selfObservation === undefined
      ) continue;
      const scope = await scopeFor(repository);
      const surface = scope.surface;
      const issues = surface?.selfObservation;
      if (
        surface === null || scope.baseBranch === null ||
        surface.failedChecks === undefined || issues === undefined
      ) continue;
      const tip = await surface.readBaseTip(scope.baseBranch);
      if (tip === null) {
        actions.push(`${tag}:tip_unreadable`);
        continue;
      }
      const failed = await surface.failedChecks(tip);
      if (failed === null) {
        actions.push(`${tag}:checks_unreadable`);
        continue;
      }
      if (failed.length === 0) continue;
      if (!inBudget()) {
        actions.push(`${tag}:deadline`);
        break;
      }
      const marker = baseRepairMarker(scope.baseBranch);
      const bodies = await issues.listOpenIssueBodies();
      if (bodies === null) {
        actions.push(`${tag}:issues_unreadable`);
        continue;
      }
      if (bodies.some((body) => body.split(/\r?\n/, 1)[0] === marker)) {
        actions.push(`${tag}:open`);
        continue;
      }
      if (!inBudget()) {
        actions.push(`${tag}:deadline`);
        break;
      }
      const number = await issues.fileIssue(
        baseRepairIssue(scope.baseBranch, tip, failed),
      );
      actions.push(
        number === null ? `${tag}:file_failed` : `${tag}:filed=#${number}`,
      );
    } catch {
      actions.push(`${tag}:unexpected_error`);
    }
  }
  return actions;
}
