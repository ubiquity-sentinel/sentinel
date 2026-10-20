/** Recover immutable predecessor custody, never a candidate from a mutable PR head. */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import type { StateReadView } from "../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { blockedImplementationBinding } from "../src/host/matrix-blocked-candidate.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../src/repair/keys.ts";

const same = (a: unknown, b: unknown) =>
  a === undefined || b === undefined
    ? a === b
    : canonicalStringify(a) === canonicalStringify(b);
const BLOCKER = "candidate touches a protected path";
export const ORIGINAL_CANDIDATE_HISTORY_LIMIT = 256;
export const ORIGINAL_CANDIDATE_DEADLINE_MS = 120_000;

export function protectedOriginalCandidateShape(record: WorkRecordV1): boolean {
  const { target } = record;
  return record.source.kind === "issue" &&
    record.related.issueNumber !== null &&
    record.source.id === String(record.related.issueNumber) &&
    record.nextStep === "blocked" && record.blocker?.kind === "other" &&
    record.blocker.message === BLOCKER && record.intent === null &&
    record.wait === null &&
    record.counters.reviewRounds === 0 && record.evidence.length === 0 &&
    target.pr !== null && target.base !== null && target.head !== null &&
    target.branch === candidateBranch(record.id) &&
    target.candidateState?.preserved === null &&
    target.candidateState.publishedHead !== null &&
    target.candidateState.publishedHead !== target.head &&
    target.candidateState.publishedHead !== target.base;
}

export interface ProtectedOriginalCandidateV1 {
  current: WorkRecordV1;
  original: WorkRecordV1;
  /** The authoritative rejected record remains reachable through the recovery's parent. */
  rejectedStateHead: GitSha;
  originalStateHead: GitSha;
}

async function matchTransition(
  current: WorkRecordV1,
  rejected: WorkRecordV1,
  prior: WorkRecordV1,
  snapshot: RepairStateSnapshotV1,
  historical: RepairStateSnapshotV1,
): Promise<boolean> {
  const preserved = prior.target.candidateState?.preserved;
  const intent = prior.intent;
  if (
    !same(current, rejected) || !preserved || intent?.kind !== "implementation"
  ) return false;
  if (
    !same(current.repository, prior.repository) ||
    !same(current.source, prior.source) ||
    !same(current.related, prior.related) ||
    !same(current.controller, prior.controller) ||
    current.id !== prior.id || current.target.pr !== prior.target.pr ||
    current.target.base !== prior.target.base ||
    current.target.branch !== prior.target.branch ||
    !same(current.counters, prior.counters) ||
    !same(current.evidence, prior.evidence) ||
    (prior.nextStep !== "work" &&
      blockedImplementationBinding(prior) === null) ||
    prior.target.head !== current.target.candidateState!.publishedHead ||
    prior.target.candidateState!.publishedHead !== prior.target.head ||
    preserved.head !== prior.target.head ||
    preserved.base !== prior.target.base ||
    intent.requestId === null ||
    intent.key !== implementationIntentKey(intent.requestId) ||
    intent.branch !== current.target.branch ||
    intent.observedBase !== current.target.base ||
    intent.expectedHead !== null || intent.pr !== null ||
    intent.resultId !== null ||
    !preserved.operationKey.startsWith("impl:") ||
    preserved.operationKey === intent.key ||
    preserved.ref !==
      await candidatePreservationRef(
        current.repository,
        current.id,
        preserved.operationKey,
      )
  ) return false;
  const originalId = preserved.operationKey.slice("impl:".length);
  const rejectedCharge = snapshot.reservations.find((r) =>
    r.id === intent.requestId
  );
  const originalCharge = snapshot.reservations.find((r) => r.id === originalId);
  return [originalCharge, rejectedCharge].every((charge) =>
    charge !== undefined &&
    charge.taskId === current.id &&
    same(charge.repository, current.repository) &&
    charge.head === current.target.base && charge.outcome === "submitted" &&
    same(historical.reservations.find((r) => r.id === charge.id), charge)
  ) &&
    rejectedCharge!.purpose === "retry" &&
    rejectedCharge!.attempt === current.counters.attempts &&
    ["implementation", "retry"].includes(originalCharge!.purpose) &&
    originalCharge!.attempt < rejectedCharge!.attempt;
}

/** One shared bounded walk; every ancestor read is anchored to the same live head. */
export async function readProtectedOriginalCandidates(input: {
  state: Pick<StateReadView, "readRepairAt">;
  snapshot: RepairStateSnapshotV1;
  expectedHead: GitSha;
  records: readonly WorkRecordV1[];
  clock: { now(): number };
  deadlineAt: number;
}): Promise<ProtectedOriginalCandidateV1[]> {
  const readAt = input.state.readRepairAt?.bind(input.state);
  if (!readAt) return [];
  const pending = new Map(
    input.records.filter(protectedOriginalCandidateShape).map((r) => [r.id, r]),
  );
  const found: ProtectedOriginalCandidateV1[] = [];
  const seen = new Set<GitSha>();
  let snapshot = input.snapshot;
  let commit = input.expectedHead;
  const startedAt = input.clock.now();
  for (
    let count = 0;
    count < ORIGINAL_CANDIDATE_HISTORY_LIMIT && pending.size > 0;
    count++
  ) {
    const now = input.clock.now();
    if (
      !Number.isSafeInteger(now) || now < startedAt || now >= input.deadlineAt
    ) return [];
    if (seen.has(commit)) return [];
    seen.add(commit);
    const parent = snapshot.stateHead;
    if (parent === null || parent === commit) break;
    let read;
    try {
      read = await readAt({ commit: parent, expectedHead: input.expectedHead });
    } catch {
      return [];
    }
    if (
      !read.ok || read.value.status !== "found" || read.value.head !== parent ||
      read.value.snapshot.sequence >= snapshot.sequence
    ) return [];
    const previous = read.value.snapshot;
    for (const [id, current] of pending) {
      const rejected = snapshot.work.find((r) => r.id === id);
      const prior = previous.work.find((r) => r.id === id);
      if (!rejected || !prior || !same(rejected, current)) {
        pending.delete(id);
        continue;
      }
      if (same(prior, current)) continue;
      pending.delete(id);
      if (
        await matchTransition(
          current,
          rejected,
          prior,
          input.snapshot,
          previous,
        )
      ) {
        found.push({
          current,
          original: prior,
          rejectedStateHead: commit,
          originalStateHead: parent,
        });
      }
    }
    snapshot = previous;
    commit = parent;
  }
  return found;
}
