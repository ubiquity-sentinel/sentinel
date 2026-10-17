/**
 * Known positive (a): `planHostedRetirements` exactly as it stood before
 * 01f482529 ("fix(ops): never re-plan an already retired record"), copied
 * verbatim from `01f482529^:ops/hosted-autonomy-closures.ts` with only its
 * imports re-pointed. The checker's retirement fairness harness must flag
 * it (an already retired row is planned again on every pass, and the closure
 * pass's five retirement slots go to those rows). The test pins that this
 * body is the current function minus exactly the fix's block.
 */
import { MATRIX_PRESERVATION_UNCERTAINTY_DETAIL } from "../../../src/host/matrix-uncertainty-maintenance.ts";
import type { RepairStateSnapshotV1 } from "../../../src/contracts/state-snapshots.ts";
import type { HostedClosurePlanV1 } from "../../../ops/hosted-autonomy-closures.ts";
import { intentClosable } from "../../../ops/hosted-autonomy-retries.ts";
import { hostedIssueKey } from "../../../ops/hosted-autonomy-policy.ts";

export function planHostedRetirements(
  snapshot: RepairStateSnapshotV1,
  closedIssues: ReadonlySet<string>,
  closedUnmerged: ReadonlySet<string> = new Set(),
): HostedClosurePlanV1[] {
  const plans: HostedClosurePlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    if (
      record.nextStep === "blocked" &&
      record.intent?.kind === "candidate_preservation" &&
      record.blocker?.kind === "other" &&
      record.blocker.message === MATRIX_PRESERVATION_UNCERTAINTY_DETAIL
    ) continue;
    const issueNumber = record.related.issueNumber;
    if (
      issueNumber === null ||
      !closedIssues.has(hostedIssueKey(record.repository, issueNumber))
    ) {
      continue;
    }
    if (record.target.pr === null) {
      // Existing behavior: only a non-blocked record that produced nothing is
      // parked; an already blocked record keeps its own blocker.
      if (record.nextStep === "blocked") continue;
      plans.push({ id: record.id, issueNumber, repository: record.repository });
      continue;
    }
    // Only a definitively closed-unmerged pull proves the task can never
    // deliver; anything else leaves the record alone.
    if (!closedUnmerged.has(record.id)) continue;
    // Retirement clears the intent, so it must never take an unsettled
    // implementation intent away from the runtime's own uncertainty handler.
    // `intentClosable` is that same settled-intent rule; it is consulted only
    // for implementation intents, so non-implementation and null intents stay
    // retirable exactly as before.
    if (
      record.intent !== null && record.intent.kind === "implementation" &&
      !intentClosable(record, snapshot.reservations)
    ) continue;
    plans.push({ id: record.id, issueNumber, repository: record.repository });
  }
  return plans;
}
