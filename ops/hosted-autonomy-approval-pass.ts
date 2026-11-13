import { ciFirstApprovalEligible } from "./hosted-autonomy-ci-first.ts";
import { HOSTED_AUTONOMY_RETIRED } from "./hosted-autonomy-policy.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import {
  type HostedAutonomyPassContextV1,
  hostedPassDeadlineReached,
} from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyRecordV1 } from "./hosted-autonomy-types.ts";

const APPROVAL_READ_CONCURRENCY = 4;

/**
 * Overlap independent parked-run listings, never approval writes. Settle the
 * first record before fan-out so a deadline-consuming initial read or approval
 * defers the remaining records. Every admitted batch settles before returning.
 * Returns false when the existing maintenance cutoff prevents further work.
 */
export async function runHostedApprovalPass(
  context: HostedAutonomyPassContextV1,
  eligible: (record: HostedAutonomyRecordV1) => boolean,
): Promise<boolean> {
  const { snapshot, deps, actions, scopeFor } = context;
  const candidates = snapshot.work.filter((record) => {
    if (queueRecordProtected(record, deps.queueCustody)) return false;
    // Retired tasks and rejected unpublished candidates cannot gain approval
    // authority. Preserve the existing treatment of uncertain preservation.
    const candidate = record.target.candidateState;
    if (
      record.nextStep === "blocked" && record.intent === null &&
      record.blocker?.kind === "other" &&
      (record.blocker.message === HOSTED_AUTONOMY_RETIRED ||
        (record.blocker.message === "candidate touches a protected path" &&
          candidate?.preserved === null &&
          record.target.head !== candidate.publishedHead))
    ) return false;
    return (eligible(record) ||
      (ciFirstApprovalEligible(snapshot, record) &&
        context.settled?.has(record.id) !== true)) &&
      record.target.head !== null && record.target.pr !== null;
  });
  const read = async (record: HostedAutonomyRecordV1) => {
    if (hostedPassDeadlineReached(context)) return null;
    const scope = await scopeFor(record.repository);
    if (hostedPassDeadlineReached(context)) return null;
    let parked: number[] = [];
    if (scope.surface !== null) {
      try {
        parked = await scope.surface.listParkedRuns(record.target.head!);
      } catch { /* An unavailable listing never authorizes an approval. */ }
    }
    return { record, scope, parked };
  };
  for (let offset = 0; offset < candidates.length;) {
    if (hostedPassDeadlineReached(context)) return false;
    const batch = candidates.slice(
      offset,
      offset + (offset === 0 ? 1 : APPROVAL_READ_CONCURRENCY),
    );
    const listings = await Promise.all(batch.map(read));
    offset += batch.length;
    for (const listing of listings) {
      if (hostedPassDeadlineReached(context) || listing === null) return false;
      const { record, scope, parked } = listing;
      if (scope.surface === null) {
        actions.push(`approve:${record.id}:surface_unreadable`);
        continue;
      }
      for (const id of parked.slice(0, 3)) {
        if (hostedPassDeadlineReached(context)) return false;
        let approved = false;
        try {
          approved = await scope.surface.approveRun(id);
        } catch { /* Preserve the ordinary refused-approval outcome. */ }
        actions.push(
          `approve:${record.id}:run=${id}:${approved ? "approved" : "refused"}`,
        );
      }
    }
  }
  return true;
}
