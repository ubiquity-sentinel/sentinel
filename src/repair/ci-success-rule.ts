/**
 * The CI integrity rule for a head that changes a CI-executable path (owner
 * directive 2026-11-17, "give sentinel full access"). Such a pull request's
 * own CI runs its own modified workflow, so a workflow whose jobs are all
 * skipped or neutral would otherwise read as green (2026-10-24: skipped and
 * neutral are not red) and nothing would have been tested. Its head is green
 * only with at least one job the target's own CI ran and passed on that exact
 * head (`decideCiGate(..., { requireSuccess: true })`); a backup-CI stand-in
 * never counts, because it runs the same modified workflow from the merge
 * tree. Every other head is judged exactly as before.
 *
 * The changed paths are read only when the head's checks hold no such job
 * (one exact `base...head` comparison); a head with a passing job needs no
 * read and passes either way. An unreadable comparison, a port without the
 * read or a head without a base fails closed: the rule applies.
 */
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { latestChecks } from "./ci-rejection.ts";
import { isTargetCiSuccessCheck } from "./merge-gate-checks.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";
import { ciExecutablePath } from "./workflow-trust.ts";

/** The pre-review park of such a head once its bounded wait ends. */
export const WORKFLOW_CI_SUCCESS_DETAIL =
  "CI-first: the head changes a CI-executable path and no CI job ran to " +
  "success on it; owner action required";

/** Whether the gating checks already hold a job the target's CI passed. */
export function hasTargetCiSuccess(checks: readonly GitHubCheckV1[]): boolean {
  return latestChecks([...checks]).some(isTargetCiSuccessCheck);
}

/**
 * Whether the success rule applies to `record`'s head: its `base...head`
 * comparison changes a CI-executable path, or cannot be read (fail closed).
 * Call it only when `hasTargetCiSuccess` is false.
 */
export async function workflowSuccessRequired(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: Pick<WorkRecordV1, "target">,
): Promise<boolean> {
  const { base, head } = record.target;
  const read = deps.github.readChangedPaths;
  if (head === null || base === null || read === undefined) return true;
  try {
    const paths = await read.call(deps.github, base, head);
    if (!paths.ok || paths.value === null) return true;
    return paths.value.some(ciExecutablePath);
  } catch {
    return true;
  }
}
