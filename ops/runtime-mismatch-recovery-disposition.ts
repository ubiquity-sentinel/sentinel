/**
 * Runtime-mismatch disposition pass.
 *
 * Protected maintenance owns this pass. For a record blocked as an
 * authenticated historical matrix runtime mismatch it gathers the exact
 * effect evidence from the record's OWN repository surface — no unpublished
 * repair ref, no pull request on that branch, no preserved candidate in the
 * durable record and a terminal producer run — and, only when every fact is
 * proven, converts the terminal mismatch block into the ordinary retryable
 * "model run did not complete with a trusted candidate" class:
 *
 *  - the accepted admission charge is settled `ambiguous` (charged, never
 *    refunded from absence), and
 *  - the blocker is replaced with the exact class the retry pass owns, so the
 *    next maintenance run re-admits the issue under a fresh reservation.
 *
 * Nothing is guessed: an unreadable ref, an unreadable pull listing, a
 * non-terminal producer, a present candidate or any malformed input retains
 * the record untouched with a bounded reason. The plan is applied in one
 * expected-head compare-and-swap write with a canonical readback; a conflict,
 * ambiguity or drifted readback reports failed and changes no further state.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../src/contracts/canonical.ts";
import type { BudgetReservationV1 } from "../src/contracts/budget-reservation.ts";
import type { PortResultV1 } from "../src/contracts/ports.ts";
import type {
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { parseRepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import {
  planRuntimeMismatchRecovery,
  type RuntimeMismatchBindingV1,
  type RuntimeMismatchPlanV1,
  type RuntimeMismatchProofV1,
} from "./runtime-mismatch-recovery-plan.ts";

/** The exact terminal blocker class this pass may disposition. */
export const MISMATCH_DISPOSITION_BLOCKER_PREFIX =
  "authenticated historical matrix runtime mismatch";

/** One maintenance run dispositions at most this many records. */
export const MISMATCH_DISPOSITION_MAX_PER_RUN = 36;

/** The replacement blocker the maintenance retry pass owns. */
export const MISMATCH_DISPOSITION_RETRYABLE_BLOCKER =
  "model run did not complete with a trusted candidate";

/** Read-only effect evidence for one record, from its own repository. */
export interface MismatchDispositionObservationsV1 {
  /** true only when the exact ref is PROVEN absent; null when unreadable. */
  readRefAbsent(ref: string): Promise<boolean | null>;
  /** Every pull on one head branch, or null when the listing is unreadable. */
  listPullsByHead(
    branch: string,
  ): Promise<
    readonly { number: number; state: string; head: string | null }[] | null
  >;
  /** true only when the producer workflow run is PROVEN terminal. */
  readRunTerminal(runId: number): Promise<boolean | null>;
  /**
   * true only when the exact commit object is PROVEN absent from the
   * repository (exact 404), false when it is present, null when unreadable.
   * Optional: a surface without it never proves a candidate lost.
   */
  readCommitAbsent?(sha: string): Promise<boolean | null>;
}

export interface MismatchDispositionRetainedV1 {
  readonly id: string;
  readonly reason: string;
}

export interface MismatchDispositionCandidatesV1 {
  readonly bindings: readonly RuntimeMismatchBindingV1[];
  readonly proofs: Readonly<Record<string, RuntimeMismatchProofV1>>;
  readonly retained: readonly MismatchDispositionRetainedV1[];
}

/**
 * Collect the exact planner bindings and no-effect proofs for every eligible
 * mismatch record. A record is eligible only when every fact is proven now;
 * anything else is retained with one bounded reason and never planned.
 */
export async function collectMismatchDispositionCandidatesV1(input: {
  readonly snapshot: RepairStateSnapshotV1;
  readonly observationsFor: (
    record: WorkRecordV1,
  ) => MismatchDispositionObservationsV1 | null;
  /**
   * Producer workflow runs live in the self (sentinel) repository, not in the
   * target repository whose refs and pulls the record surface proves. The
   * caller supplies the self surface's terminal read; a missing capability
   * retains the record untouched.
   */
  readonly producerTerminal: (runId: number) => Promise<boolean | null>;
  readonly limit?: number;
}): Promise<MismatchDispositionCandidatesV1> {
  const limit = Math.max(
    1,
    Math.min(input.limit ?? MISMATCH_DISPOSITION_MAX_PER_RUN, 36),
  );
  const bindings: RuntimeMismatchBindingV1[] = [];
  const proofs: Record<string, RuntimeMismatchProofV1> = {};
  const retained: MismatchDispositionRetainedV1[] = [];

  for (const record of input.snapshot.work) {
    if (bindings.length >= limit) break;
    if (record.nextStep !== "blocked") continue;
    const blocker = record.blocker;
    if (
      blocker === null ||
      !blocker.message.startsWith(MISMATCH_DISPOSITION_BLOCKER_PREFIX)
    ) {
      continue;
    }
    const retain = (reason: string) => {
      retained.push({ id: record.id, reason });
    };
    const intent = record.intent;
    if (intent === null || intent.kind !== "implementation") {
      retain("intent is not an implementation start");
      continue;
    }
    if (!intent.key.startsWith("impl:")) {
      retain("intent key is not an implementation identity");
      continue;
    }
    if (intent.requestId === null || intent.requestId.length === 0) {
      retain("intent request id missing");
      continue;
    }
    const reservationId = intent.key.slice("impl:".length);
    const reservation = input.snapshot.reservations.find((row) =>
      row.id === reservationId
    );
    if (reservation === undefined) {
      retain("missing reservation");
      continue;
    }
    if (reservation.outcome !== "reserved") {
      retain("reservation already settled");
      continue;
    }
    if (
      reservation.purpose !== "implementation" &&
      reservation.purpose !== "retry"
    ) {
      retain("reservation purpose is not an implementation start");
      continue;
    }
    if (record.target.head !== null) {
      retain("candidate head present");
      continue;
    }
    if (record.target.base === null || record.target.branch === null) {
      retain("record base or branch missing");
      continue;
    }
    const preserved = record.target.candidateState?.preserved ?? null;
    if (preserved !== null) {
      retain("preserved candidate ref present");
      continue;
    }
    const producer = /producer=(\d+):(\d+)/.exec(blocker.message);
    if (producer === null) {
      retain("producer binding missing");
      continue;
    }
    const producerRun = Number(producer[1]);
    const producerAttempt = Number(producer[2]);
    if (!Number.isSafeInteger(producerRun) || producerRun <= 0) {
      retain("producer run identity malformed");
      continue;
    }
    if (!Number.isSafeInteger(producerAttempt) || producerAttempt <= 0) {
      retain("producer attempt identity malformed");
      continue;
    }
    const observations = input.observationsFor(record);
    if (observations === null) {
      retain("observation capability absent");
      continue;
    }
    const refAbsent = await observations.readRefAbsent(
      `refs/heads/${record.target.branch}`,
    );
    if (refAbsent === null) {
      retain("repair ref unreadable");
      continue;
    }
    if (!refAbsent) {
      retain("repair ref present");
      continue;
    }
    const pulls = await observations.listPullsByHead(record.target.branch);
    if (pulls === null) {
      retain("pull listing unreadable");
      continue;
    }
    if (pulls.length > 0) {
      retain("pull observations present");
      continue;
    }
    const terminal = await input.producerTerminal(producerRun);
    if (terminal === null) {
      retain("producer run unreadable");
      continue;
    }
    if (!terminal) {
      retain("producer run not terminal");
      continue;
    }
    bindings.push({
      id: record.id,
      reservationId,
      repository: record.repository,
      base: record.target.base,
      branch: record.target.branch,
      requestId: intent.requestId,
      intentKey: intent.key,
      purpose: reservation.purpose,
      recordDigest: await canonicalStringifySha256(record),
      reservationDigest: await canonicalStringifySha256(reservation),
      producerRun: String(producerRun),
      producerAttempt,
      producerTerminal: true,
    });
    proofs[record.id] = {
      publicationRefs: [],
      preservationRefs: [],
      headRefs: [],
      prObservations: [],
      effectDisposition: {
        operation: "runtime-mismatch-disposition",
        evidence:
          `producer=${producerRun}:${producerAttempt}; repair-ref=absent; pulls=0`,
      },
      exclusiveCustody: true,
    };
  }

  return { bindings, proofs, retained };
}

/** Apply a validated plan to the snapshot in memory; never writes. */
export function applyMismatchDispositionPlanV1(input: {
  readonly snapshot: RepairStateSnapshotV1;
  readonly plan: RuntimeMismatchPlanV1;
  readonly head: GitSha;
  readonly now: number;
}):
  | { ok: true; snapshot: RepairStateSnapshotV1; applied: readonly string[] }
  | {
    ok: false;
    reason: string;
  } {
  if (!input.plan.ok) return { ok: false, reason: "plan refused" };
  if (input.plan.proposals.length === 0) {
    return { ok: false, reason: "plan is empty" };
  }
  if (
    !Number.isSafeInteger(input.now) || input.now < input.snapshot.updatedAt
  ) {
    return { ok: false, reason: "clock invalid" };
  }
  const work: WorkRecordV1[] = [...input.snapshot.work];
  const reservations: BudgetReservationV1[] = [
    ...input.snapshot.reservations,
  ];
  const applied: string[] = [];
  for (const proposal of input.plan.proposals) {
    const recordIndex = work.findIndex((row) => row.id === proposal.id);
    if (recordIndex === -1) return { ok: false, reason: "record missing" };
    const record = work[recordIndex]!;
    if (record.nextStep !== "blocked") {
      return { ok: false, reason: "record not blocked" };
    }
    if (
      record.blocker === null ||
      !record.blocker.message.startsWith(MISMATCH_DISPOSITION_BLOCKER_PREFIX)
    ) {
      return { ok: false, reason: "record blocker changed" };
    }
    if (
      record.intent === null ||
      record.intent.kind !== "implementation" ||
      record.intent.key !== `impl:${proposal.settleReservation.reservationId}`
    ) {
      return { ok: false, reason: "record intent changed" };
    }
    const reservationIndex = reservations.findIndex((row) =>
      row.id === proposal.settleReservation.reservationId
    );
    if (reservationIndex === -1) {
      return { ok: false, reason: "reservation missing" };
    }
    const reservation = reservations[reservationIndex]!;
    if (reservation.outcome !== "reserved") {
      return { ok: false, reason: "reservation already settled" };
    }
    if (proposal.settleReservation.outcome !== "ambiguous") {
      return { ok: false, reason: "unsupported settlement outcome" };
    }
    work[recordIndex] = {
      ...record,
      blocker: {
        kind: "other",
        message: proposal.replacementBlocker.message,
        since: input.now,
      },
    };
    reservations[reservationIndex] = {
      ...reservation,
      outcome: "ambiguous",
      settledAt: input.now,
      proofRef: null,
    };
    applied.push(record.id);
  }
  // The durable manifest binds the new commit's parent: the snapshot's
  // stateHead must equal the expected remote head, exactly like every other
  // maintenance writer.
  let next: RepairStateSnapshotV1;
  try {
    next = parseRepairStateSnapshotV1({
      ...input.snapshot,
      stateHead: input.head,
      sequence: input.snapshot.sequence + 1,
      updatedAt: input.now,
      work,
      reservations,
    });
  } catch {
    return { ok: false, reason: "snapshot invalid" };
  }
  return { ok: true, applied, snapshot: next };
}

export type MismatchDispositionPassResultV1 =
  | {
    kind: "applied";
    head: GitSha;
    applied: readonly string[];
    retained: readonly MismatchDispositionRetainedV1[];
  }
  | {
    kind: "none";
    reason: "no_candidates" | "plan_refused" | "release_absent";
    retained: readonly MismatchDispositionRetainedV1[];
  }
  | { kind: "skipped"; reason: "clock_invalid" | "snapshot_invalid" }
  | {
    kind: "failed";
    reason:
      | "write_unavailable"
      | "write_conflict"
      | "write_ambiguous"
      | "readback_unverified";
  };

/**
 * One bounded disposition pass: collect proven no-effect candidates, plan the
 * settlement, apply it in a single expected-head write and verify the exact
 * readback. The caller owns the surrounding custody and deadline checks.
 */
export async function runMismatchDispositionPassV1(input: {
  readonly snapshot: RepairStateSnapshotV1;
  readonly head: GitSha;
  readonly release: unknown;
  readonly expectedReleaseHead: GitSha | null;
  readonly observationsFor: (
    record: WorkRecordV1,
  ) => MismatchDispositionObservationsV1 | null;
  readonly producerTerminal: (runId: number) => Promise<boolean | null>;
  readonly now: number;
  readonly state: Pick<StateReadView, "readRepair"> & RepairStateWriter;
  readonly limit?: number;
}): Promise<MismatchDispositionPassResultV1> {
  if (input.release === null || input.release === undefined) {
    return { kind: "none", reason: "release_absent", retained: [] };
  }
  if (
    !Number.isSafeInteger(input.now) || input.now < input.snapshot.updatedAt
  ) {
    return { kind: "skipped", reason: "clock_invalid" };
  }
  const candidates = await collectMismatchDispositionCandidatesV1({
    snapshot: input.snapshot,
    observationsFor: input.observationsFor,
    producerTerminal: input.producerTerminal,
    limit: input.limit,
  });
  if (candidates.bindings.length === 0) {
    return {
      kind: "none",
      reason: "no_candidates",
      retained: candidates.retained,
    };
  }
  const plan = await planRuntimeMismatchRecovery({
    repair: input.snapshot,
    release: input.release,
    bindings: candidates.bindings,
    proofs: candidates.proofs,
    expectedRepairHead: input.head,
    expectedReleaseHead: input.expectedReleaseHead,
    expectedSequence: input.snapshot.sequence,
    now: input.now,
  });
  if (!plan.ok) {
    return {
      kind: "none",
      reason: "plan_refused",
      retained: [
        ...candidates.retained,
        ...plan.rows.map((row) => ({ id: row.id, reason: row.reason })),
      ],
    };
  }
  const applied = applyMismatchDispositionPlanV1({
    snapshot: input.snapshot,
    plan,
    head: input.head,
    now: input.now,
  });
  if (!applied.ok) return { kind: "skipped", reason: "snapshot_invalid" };
  const next = { ...applied.snapshot, stateHead: input.head };
  let write: PortResultV1<StateWriteResultV1>;
  try {
    write = await input.state.writeRepair(next, input.head);
  } catch {
    return { kind: "failed", reason: "write_unavailable" };
  }
  if (!write.ok) return { kind: "failed", reason: "write_unavailable" };
  if (write.value.status === "conflict") {
    return { kind: "failed", reason: "write_conflict" };
  }
  if (write.value.status === "ambiguous") {
    return { kind: "failed", reason: "write_ambiguous" };
  }
  let readback: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>;
  try {
    readback = await input.state.readRepair();
  } catch {
    return { kind: "failed", reason: "readback_unverified" };
  }
  if (
    !readback.ok || readback.value.status !== "found" ||
    readback.value.head !== write.value.head ||
    canonicalStringify(readback.value.snapshot) !==
      canonicalStringify(next)
  ) {
    return { kind: "failed", reason: "readback_unverified" };
  }
  return {
    kind: "applied",
    head: write.value.head,
    applied: applied.applied,
    retained: candidates.retained,
  };
}
