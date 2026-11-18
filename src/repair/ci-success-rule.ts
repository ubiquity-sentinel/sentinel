/**
 * The CI integrity rule for a head that changes a CI-executable path (owner
 * directive 2026-11-17, "give sentinel full access"). Such a pull request's
 * own CI runs its own modified workflow, so a workflow whose jobs are all
 * skipped or neutral would otherwise read as green (2026-10-24: skipped and
 * neutral are not red), and an edit could drop or skip the real tests and
 * pass on a trivial new job. Such a head is green only when every job name
 * GitHub Actions ran to `success` on the BASE also ran to `success` on the
 * exact head, and, when the base has none (the first CI workflow is being
 * added), at least one Actions job ran to `success` on the head. Only GitHub
 * Actions check runs count (`isTargetCiSuccessCheck`): never a commit
 * status, another app's check, a skipped or neutral job, or a backup-CI
 * stand-in (it runs the same modified workflow from the merge tree).
 *
 * Whether a head changes such a path is read from one exact `base...head`
 * comparison (`readChangedPaths`). At the review and delivery gates the rule
 * applies only on that positive knowledge: an unreadable or possibly
 * truncated comparison decides exactly as before (`unknown`), and the merge
 * executors (`port-merge.ts`, the launcher's merge gate) hold such a head
 * fail closed on their own reads. An unreadable base listing for a head
 * known to change CI waits.
 */
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { latestChecks } from "./ci-rejection.ts";
import { isTargetCiSuccessCheck } from "./merge-gate-checks.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";
import { ciExecutablePath } from "./workflow-trust.ts";

/** The pre-review park of such a head once its bounded wait ends. */
export const WORKFLOW_CI_SUCCESS_DETAIL =
  "CI-first: the head changes a CI-executable path and its own CI did not " +
  "run every job the base passes to success; owner action required";

/** The job names GitHub Actions ran to success on one commit (latest each). */
export function actionsSuccessNames(
  checks: readonly GitHubCheckV1[],
): Set<string> {
  return new Set(
    latestChecks([...checks]).filter(isTargetCiSuccessCheck).map((check) =>
      check.name
    ),
  );
}

/**
 * The strengthened rule over one head's and its base's checks: every base
 * success name succeeds on the head, or (no base success) at least one
 * Actions job succeeds on the head.
 */
export function ciChangeSatisfied(
  head: readonly GitHubCheckV1[],
  base: readonly GitHubCheckV1[],
): boolean {
  const passed = actionsSuccessNames(head);
  const expected = actionsSuccessNames(base);
  if (expected.size === 0) return passed.size > 0;
  return [...expected].every((name) => passed.has(name));
}

/** What one comparison says about a head's CI-executable change. */
export type HeadCiChangeV1 = "ci" | "none" | "unknown";

/**
 * `ci` when the record's exact `base...head` comparison changes a
 * CI-executable path, `none` when it is read whole and does not, `unknown`
 * when it cannot be read whole (no read, a failed read, a list GitHub may
 * have truncated, or no head).
 */
export async function headCiChange(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: Pick<WorkRecordV1, "target">,
): Promise<HeadCiChangeV1> {
  const { base, head } = record.target;
  const read = deps.github.readChangedPaths;
  if (head === null || base === null || read === undefined) return "unknown";
  try {
    const paths = await read.call(deps.github, base, head);
    if (!paths.ok || paths.value === null) return "unknown";
    return paths.value.some(ciExecutablePath) ? "ci" : "none";
  } catch {
    return "unknown";
  }
}
