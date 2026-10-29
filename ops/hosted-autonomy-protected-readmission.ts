/**
 * The owner's fact exit for a protected-path park (redesign 2026-10-25, C6).
 *
 * The runtime parks a candidate that touches a configured protected path as
 * blocked "candidate touches a protected path": the submitted charge is kept,
 * nothing is pushed and the candidate head stays only in its artifact. No
 * retry rule re-admits that blocker, so before this exit the record had none.
 *
 * The exit is one label. For a record blocked with EXACTLY that message whose
 * source issue is open and carries `sentinel:retry`:
 *   1. the label is removed first (a GitHub write over the record's OWN
 *      repository surface);
 *   2. only if GitHub confirms the removal is the record re-admitted to
 *      `work` in the retry pass's one batch write, with existing shapes: an
 *      ordinary work plan (grant 0, so no charged attempt history is lowered)
 *      over the runtime's own proven-absence target (base and branch kept, no
 *      head, checkpoint or candidate state, as `disposePreservation` writes);
 *   3. nothing is charged here; the runtime's next start reserves and is
 *      charged normally, from the current base.
 * A failed or unproven removal re-admits nothing, and a closed issue (or one
 * the open-issue listing does not name) re-admits nothing. When the state
 * write then fails, the label is already gone and the owner applies it
 * again, so one label is at most one re-admission and never a double charge.
 *
 * Only the fresh park shape is re-admitted: no pull request and no published
 * head, so the protected candidate never reaches a branch and dropping it
 * loses no publication. A park over a published pull request needs its
 * predecessor's custody restored first (the original-candidate pass) and is
 * left untouched, label included.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { candidateBranch } from "../src/repair/keys.ts";
import { hostedIssueKey, sameRepository } from "./hosted-autonomy-policy.ts";
import type { RetryPlanV1 } from "./hosted-autonomy-retries.ts";
import type { HostedAutonomyScopeV1 } from "./hosted-autonomy-scopes.ts";

/** The runtime's exact protected-path park message (`loop-implementation-result.ts`). */
export const PROTECTED_PATH_BLOCKER = "candidate touches a protected path";

/** Detail of the work plan an owner-labelled protected park returns with. */
export const PROTECTED_READMISSION_DETAIL = "other:protected_path:owner_retry";

/** One record whose owner label was removed; applied in the same batch. */
export interface ProtectedReadmissionV1 {
  id: string;
  repository: RepositoryIdentityV1;
  issueNumber: number;
}

/** The fresh protected park the runtime writes: no PR, no published head. */
export function protectedReadmissionShape(record: WorkRecordV1): boolean {
  const { target } = record;
  const issueNumber = record.related.issueNumber;
  return record.nextStep === "blocked" && record.blocker?.kind === "other" &&
    record.blocker.message === PROTECTED_PATH_BLOCKER &&
    record.intent === null && record.wait === null &&
    record.source.kind === "issue" && issueNumber !== null &&
    record.source.id === String(issueNumber) &&
    record.counters.reviewRounds === 0 && record.evidence.length === 0 &&
    target.pr === null && target.checkpoint === null &&
    target.head !== null && target.branch === candidateBranch(record.id) &&
    target.candidateState !== undefined &&
    target.candidateState.preserved === null &&
    target.candidateState.publishedHead === null &&
    target.selfMerge === undefined;
}

/**
 * Pure local gate. `skip` names records another rule of this pass owns (or an
 * earlier write touched). An unusable clock plans nothing, so no label is
 * removed for a batch whose write would refuse.
 */
export function planProtectedReadmissions(
  snapshot: RepairStateSnapshotV1,
  closedIssues: ReadonlySet<string>,
  skip: (id: string) => boolean,
  now: number,
): ProtectedReadmissionV1[] {
  if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) return [];
  const planned: ProtectedReadmissionV1[] = [];
  for (const record of snapshot.work) {
    if (skip(record.id) || !protectedReadmissionShape(record)) continue;
    const issueNumber = record.related.issueNumber!;
    if (closedIssues.has(hostedIssueKey(record.repository, issueNumber))) {
      continue;
    }
    planned.push({ id: record.id, repository: record.repository, issueNumber });
  }
  return planned;
}

/**
 * Read each repository's open `sentinel:retry` issues once and remove the
 * label of every planned record it names; only a confirmed removal returns a
 * re-admission. A repository without the label capability is silent (no
 * exit exists there); an unreadable listing is reported once per repository.
 */
export async function takeProtectedReadmissions(
  planned: readonly ProtectedReadmissionV1[],
  scopeFor: (
    repository: RepositoryIdentityV1,
  ) => Promise<HostedAutonomyScopeV1>,
  actions: string[],
): Promise<ProtectedReadmissionV1[]> {
  const labelled = new Map<string, ReadonlySet<number> | null>();
  const taken: ProtectedReadmissionV1[] = [];
  for (const candidate of planned) {
    const scope = await scopeFor(candidate.repository);
    const retryLabel = scope.surface?.retryLabel;
    if (retryLabel === undefined) continue;
    if (!labelled.has(scope.key)) {
      let listed: ReadonlySet<number> | null;
      try {
        listed = await retryLabel.listOpenRetryLabeled();
      } catch {
        listed = null;
      }
      labelled.set(scope.key, listed);
      if (listed === null) {
        actions.push(`retry_label:${scope.key}:unreadable`);
      }
    }
    if (labelled.get(scope.key)?.has(candidate.issueNumber) !== true) continue;
    let removed = false;
    try {
      removed = await retryLabel.removeRetryLabel(candidate.issueNumber);
    } catch {
      removed = false;
    }
    if (!removed) {
      actions.push(`retry:${candidate.id}:skipped:retry_label_not_removed`);
      continue;
    }
    taken.push(candidate);
  }
  return taken;
}

/** The ordinary uncharged work plan each taken re-admission returns with. */
export function protectedReadmissionPlan(
  readmission: ProtectedReadmissionV1,
): RetryPlanV1 {
  return {
    id: readmission.id,
    repository: readmission.repository,
    grant: 0,
    nextStep: "work",
    reviewRounds: null,
    advanceBase: false,
    observedBase: null,
    detail: PROTECTED_READMISSION_DETAIL,
  };
}

/**
 * Drop the parked protected candidate of every taken re-admission (pure,
 * strict-parsed): the target keeps its base and branch with no head,
 * checkpoint or candidate state. Every other field and record is unchanged;
 * the work plan (`applyHostedRetries`) then moves the step in the same write.
 * A taken re-admission whose record no longer has the park shape throws, so
 * the caller writes nothing rather than return a protected head to `work`.
 */
export function dropProtectedCandidates(
  snapshot: RepairStateSnapshotV1,
  readmissions: readonly ProtectedReadmissionV1[],
): RepairStateSnapshotV1 {
  if (readmissions.length === 0) return snapshot;
  let dropped = 0;
  const next = parseRepairStateSnapshotV1({
    ...snapshot,
    work: snapshot.work.map((record) => {
      const taken = readmissions.some((entry) =>
        entry.id === record.id &&
        sameRepository(entry.repository, record.repository)
      );
      if (!taken) return record;
      if (!protectedReadmissionShape(record)) {
        throw new TypeError("protected re-admission lost its park shape");
      }
      dropped++;
      return {
        ...record,
        target: {
          base: record.target.base,
          branch: record.target.branch,
          checkpoint: null,
          head: null,
          pr: null,
        },
      };
    }),
  });
  if (dropped !== readmissions.length) {
    throw new TypeError("protected re-admission names no parked record");
  }
  return next;
}
