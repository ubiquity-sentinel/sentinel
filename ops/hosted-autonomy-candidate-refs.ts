import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  candidateBranch,
  candidatePreservationRef,
} from "../src/repair/keys.ts";
import { hostedRepositoryKey } from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyRecordV1 } from "./hosted-autonomy-types.ts";

/**
 * The runtime's exact diagnosis that the managed candidate branch ref matched
 * neither the saved candidate head nor the head that record had published. It
 * is the ONLY blocker this maintenance pass revalidates, and it is cleared only
 * against the record's own repository, task and producing operation.
 */
export const CANDIDATE_REF_IDENTITY_MISMATCH =
  "candidate branch ref identity mismatch";

/** The exact identity one record must prove before its blocker is cleared. */
export interface CandidateRefRevalidationV1 {
  readonly id: string;
  readonly repository: RepositoryIdentityV1;
  readonly branch: string;
  readonly head: GitSha;
}

/**
 * The exact blocked shape this maintenance pass may revalidate: the runtime's
 * recorded candidate-ref identity mismatch, on a record whose saved candidate
 * descriptor, published head and canonical preservation ref all bind to the
 * record's OWN repository, task and producing operation, and whose branch is
 * the deterministic managed candidate branch of that same task. Anything else
 * — a different blocker, a foreign or mismatched branch, a missing or
 * incoherent descriptor, an incompatible wait — is refused here and left
 * untouched, with no remote read at all. The caller still has to observe the
 * branch's exact live head before anything is written.
 */
export async function candidateRefRevalidation(
  record: HostedAutonomyRecordV1,
): Promise<CandidateRefRevalidationV1 | null> {
  if (record.nextStep !== "blocked" || record.wait !== null) return null;
  const blocker = record.blocker;
  if (
    blocker === null || blocker.kind !== "other" ||
    blocker.message !== CANDIDATE_REF_IDENTITY_MISMATCH
  ) {
    return null;
  }
  const head = record.target.head;
  const branch = record.target.branch;
  const candidateState = record.target.candidateState;
  if (head === null || branch === null || candidateState === undefined) {
    return null;
  }
  // The managed branch is derived from the task identity: a record pointing at
  // any other branch is not this record's candidate and is never revalidated.
  if (branch !== candidateBranch(record.id)) return null;
  const preserved = candidateState.preserved;
  if (preserved === null) return null;
  // The saved descriptor, the published head and the target must agree on the
  // exact same candidate identity before the live ref is even consulted.
  if (preserved.head !== head || preserved.base !== record.target.base) {
    return null;
  }
  if (candidateState.publishedHead !== head) return null;
  if (
    preserved.ref !== await candidatePreservationRef(
      record.repository,
      record.id,
      preserved.operationKey,
    )
  ) {
    return null;
  }
  return { id: record.id, repository: record.repository, branch, head };
}

/**
 * The exact repository/task identity one candidate-ref revalidation binds. The
 * repository part is the record's own identity, never another repository's.
 */
export function candidateRefKey(record: {
  readonly id: string;
  readonly repository: RepositoryIdentityV1;
}): string {
  return `${hostedRepositoryKey(record.repository)}\u0000${record.id}`;
}

/**
 * The pure transition: exactly these records return to `work` with ONLY the
 * diagnosed blocker cleared. The intent (null or non-null), wait, target,
 * counters, evidence and every other durable field are preserved byte for
 * byte; only the records' `updatedAt` and the snapshot's head and sequence
 * move, exactly as every other maintenance write does.
 */
export function applyCandidateRefRevalidations(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  records: readonly CandidateRefRevalidationV1[],
  now: number,
): RepairStateSnapshotV1 {
  const selected = new Set(records.map(candidateRefKey));
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) =>
      selected.has(candidateRefKey(record))
        ? { ...record, nextStep: "work", blocker: null, updatedAt: now }
        : record
    ),
  });
}
