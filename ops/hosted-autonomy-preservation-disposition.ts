/**
 * Evidence-bound disposition of parked candidate preservation that can never
 * complete. Exactly two closed shapes, both still blocked on an open issue with
 * no pull request and no published head:
 *
 *  - PARKED: historical matrix custody parked the exact candidate with its
 *    pending preservation intent and consumed (`submitted`) admission
 *    (MATRIX_PRESERVATION_UNCERTAINTY_DETAIL). It carries no producer binding,
 *    so no artifact pass can ever read it, and the existing-ref pass restores
 *    it whenever its deterministic preservation ref holds the exact head. It is
 *    disposed here only when the record's OWN repository proves the candidate
 *    gone: that preservation ref and the managed candidate branch are exact
 *    404s, no pull request was ever opened from the branch, the exact head
 *    commit is an exact 404 while the record's base commit reads back (a
 *    positive control against a blind surface), and the producing artifact is
 *    necessarily past retention (its result was ingested when the intent
 *    started; supervisor.yml keeps artifacts seven days). Age is one fact of
 *    five, never the reason.
 *  - REFUSED: the runtime's own "candidate preservation validation refused"
 *    block — the trusted validator's deterministic content refusal of that
 *    immutable head, which no retry of the same operation can change. Each
 *    re-entry buys a fresh charged model run, so it is disposed only once the
 *    repository base has advanced past the refused candidate's base (changed
 *    evidence, the same exemption the retry pass's attempt-memory gate
 *    grants), at least a day after the refusal, and while the task holds
 *    fewer than PRESERVATION_REFUSED_MAX_RESERVATIONS durable charges: a
 *    refusal re-enters at most once per base and day, and a task the
 *    validator keeps refusing stops after a few runs instead of at the retry
 *    pass's far larger HOSTED_AUTONOMY_MAX_RETRIES.
 *
 * The write is the runtime's own proven-absence transition (the `not_found`
 * branch of executeCandidatePreservation): the intent and the V1 candidate
 * descriptor are dropped, the target keeps its base and branch with no head,
 * and the blocker becomes the PRESERVATION_UNRECOVERABLE class the ordinary
 * retry pass owns. The consumed charge is left byte-identical: nothing is
 * refunded, re-settled, started, pushed or published here, and the retry pass
 * still applies its closed-issue, retry-budget, attempt-memory and
 * review-round gates before any fresh admission. A record whose charge a
 * dedicated matrix recovery owns is left to that recovery, exactly as the
 * existing-ref restore leaves it.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type {
  PortResultV1,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import {
  candidateBranch,
  candidatePreservationRef,
} from "../src/repair/keys.ts";
import {
  isParkedPreservation,
  PRESERVATION_VALIDATION_REFUSED,
} from "./hosted-autonomy-blocked-candidate.ts";
import { taskReservationCount } from "./hosted-autonomy-retries.ts";
import {
  HOSTED_AUTONOMY_EVIDENCE_EXPIRY_MS,
  hostedIssueKey,
  PRESERVATION_UNRECOVERABLE_PREFIX,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import { failed, readRepairSafely, skipped } from "./hosted-autonomy-state.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";

export { PRESERVATION_VALIDATION_REFUSED };

export const PRESERVATION_ABSENT_BLOCKER =
  `${PRESERVATION_UNRECOVERABLE_PREFIX}: exact candidate absent from the repository past artifact retention; submitted admission retained`;

export const PRESERVATION_REFUSED_BLOCKER =
  `${PRESERVATION_UNRECOVERABLE_PREFIX}: trusted validation refused the exact candidate; submitted admission retained`;

/** One maintenance run dispositions at most this many records. */
export const PRESERVATION_DISPOSITION_MAX_PER_RUN = 12;

/** A refused candidate re-enters at most once per this interval. */
export const PRESERVATION_REFUSED_PACING_MS = 24 * 60 * 60 * 1000;

/**
 * A refused candidate re-enters only while its task holds fewer durable
 * charges than this (every purpose and outcome, the retry budget's unit).
 */
export const PRESERVATION_REFUSED_MAX_RESERVATIONS = 6;

type Charge = RepairStateSnapshotV1["reservations"][number];

/** The one consumed implementation charge that produced this exact candidate. */
function consumedCharge(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  requestId: string | null,
): Charge | null {
  const rows = snapshot.reservations.filter((row) =>
    row.taskId === record.id &&
    sameRepository(row.repository, record.repository) &&
    (row.purpose === "implementation" || row.purpose === "retry") &&
    (requestId === null
      ? row.attempt === record.counters.attempts
      : row.id === requestId)
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return row.outcome === "submitted" && row.settledAt !== null &&
      row.head === record.target.base &&
      row.attempt === record.counters.attempts
    ? row
    : null;
}

/** Shared unpublished-candidate shape both classes must hold. */
function unpublished(record: WorkRecordV1): boolean {
  const state = record.target.candidateState;
  return record.nextStep === "blocked" && record.wait === null &&
    record.source.kind === "issue" && record.related.issueNumber !== null &&
    record.target.pr === null && record.target.head !== null &&
    record.target.head !== record.target.base &&
    record.target.branch === candidateBranch(record.id) &&
    state !== undefined && state.preserved === null &&
    state.publishedHead === null;
}

type Verdict =
  | { kind: "dispose"; message: string }
  | { kind: "retain"; reason: string }
  | null;

async function judge(
  context: HostedAutonomyPassContextV1,
  record: WorkRecordV1,
  now: number,
): Promise<Verdict> {
  const parked = isParkedPreservation(record);
  const blocker = record.blocker;
  const refused = blocker?.kind === "other" &&
    blocker.message === PRESERVATION_VALIDATION_REFUSED &&
    record.intent === null;
  if (!parked && !refused) return null;
  const dedicated = context.dedicatedReservations;
  if (dedicated.has(record.intent?.requestId ?? "")) return null;
  // A closed issue's record needs nothing: the retry pass never re-admits it.
  const issue = record.related.issueNumber;
  if (
    issue !== null &&
    context.closedIssues.has(hostedIssueKey(record.repository, issue))
  ) return null;
  if (!unpublished(record)) return { kind: "retain", reason: "shape" };
  if (refused) {
    const charge = consumedCharge(context.snapshot, record, null);
    if (charge === null) return { kind: "retain", reason: "charge" };
    if (dedicated.has(charge.id)) return null;
    if (now - blocker.since < PRESERVATION_REFUSED_PACING_MS) {
      return { kind: "retain", reason: "pacing" };
    }
    if (
      taskReservationCount(context.snapshot, record.id) >=
        PRESERVATION_REFUSED_MAX_RESERVATIONS
    ) return { kind: "retain", reason: "reservation_cap" };
    const tip = await context.readTip(
      await context.scopeFor(record.repository),
    );
    if (tip === null) return { kind: "retain", reason: "base_unreadable" };
    if (tip === record.target.base) {
      return { kind: "retain", reason: "base_unchanged" };
    }
    return { kind: "dispose", message: PRESERVATION_REFUSED_BLOCKER };
  }
  const intent = record.intent!;
  if (
    intent.branch !== await candidatePreservationRef(
        record.repository,
        record.id,
        intent.key,
      ) ||
    consumedCharge(context.snapshot, record, intent.requestId) === null
  ) return { kind: "retain", reason: "binding" };
  if (now - intent.startedAt < HOSTED_AUTONOMY_EVIDENCE_EXPIRY_MS) {
    return { kind: "retain", reason: "artifact_retention" };
  }
  const scope = await context.scopeFor(record.repository);
  const observe = scope.surface?.mismatchDisposition;
  const commitAbsent = observe?.readCommitAbsent?.bind(observe);
  if (!observe || !commitAbsent) {
    return { kind: "retain", reason: "capability_absent" };
  }
  const facts: [string, () => Promise<unknown>, unknown][] = [
    ["preservation_ref", () => observe.readRefAbsent(intent.branch!), true],
    [
      "candidate_branch",
      () => observe.readRefAbsent(`refs/heads/${record.target.branch}`),
      true,
    ],
    ["base_commit", () => commitAbsent(record.target.base), false],
    ["candidate_commit", () => commitAbsent(record.target.head!), true],
  ];
  for (const [name, read, proven] of facts) {
    let value: unknown = null;
    try {
      value = await read();
    } catch {
      value = null;
    }
    if (value !== proven) return { kind: "retain", reason: name };
  }
  let pulls: readonly unknown[] | null = null;
  try {
    pulls = await observe.listPullsByHead(record.target.branch!);
  } catch {
    pulls = null;
  }
  if (pulls === null || pulls.length !== 0) {
    return { kind: "retain", reason: "pulls" };
  }
  return { kind: "dispose", message: PRESERVATION_ABSENT_BLOCKER };
}

/** The runtime's proven-absence transition, blocked on the retryable class. */
export function disposePreservation(
  record: WorkRecordV1,
  message: string,
  now: number,
): WorkRecordV1 {
  return {
    ...record,
    intent: null,
    wait: null,
    blocker: { kind: "other", message, since: now },
    target: {
      base: record.target.base,
      branch: record.target.branch,
      checkpoint: null,
      head: record.target.candidateState?.publishedHead ?? null,
      pr: record.target.pr,
    },
    updatedAt: now,
  };
}

export async function runHostedPreservationDispositionPass(
  context: HostedAutonomyPassContextV1,
): Promise<HostedAutonomyResultV1 | null> {
  const { deps, snapshot, observedHead, actions, revisions } = context;
  const now = deps.clock.now();
  const disposed = new Map<string, string>();
  for (const record of snapshot.work) {
    if (disposed.size >= PRESERVATION_DISPOSITION_MAX_PER_RUN) break;
    const verdict = await judge(context, record, now);
    if (verdict === null) continue;
    if (verdict.kind === "retain") {
      actions.push(`preservation:${record.id}:retained:${verdict.reason}`);
      continue;
    }
    disposed.set(record.id, verdict.message);
  }
  if (disposed.size === 0) return null;
  if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
    return skipped("clock_invalid", observedHead, actions);
  }
  let next: RepairStateSnapshotV1;
  try {
    next = parseRepairStateSnapshotV1({
      ...snapshot,
      stateHead: observedHead,
      sequence: snapshot.sequence + 1,
      updatedAt: now,
      work: snapshot.work.map((record) => {
        const message = disposed.get(record.id);
        return message === undefined
          ? record
          : disposePreservation(record, message, now);
      }),
    });
  } catch {
    return skipped("snapshot_invalid", observedHead, actions);
  }
  let write: PortResultV1<StateWriteResultV1> | null;
  try {
    write = await deps.state.writeRepair(next, observedHead as GitSha);
  } catch {
    return failed("write_unavailable", observedHead, actions);
  }
  if (write === null || !write.ok) {
    return failed("write_unavailable", observedHead, actions);
  }
  if (write.value.status === "conflict") {
    return skipped("write_conflict", observedHead, actions);
  }
  if (write.value.status === "ambiguous") {
    return failed("write_ambiguous", observedHead, actions);
  }
  const readback = await readRepairSafely(deps.state);
  if (
    readback === null || !readback.ok ||
    readback.value.status !== "found" ||
    readback.value.head !== write.value.head ||
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) {
    return failed("readback_unverified", observedHead, actions);
  }
  for (const [id, message] of disposed) {
    actions.push(
      `preservation:${id}:unrecoverable:${
        message === PRESERVATION_REFUSED_BLOCKER ? "refused" : "absent"
      }`,
    );
  }
  return {
    kind: "hosted_autonomy",
    status: "applied",
    reason: "dispositioned",
    beforeHead: context.initialHead,
    appliedHead: write.value.head,
    actions,
    revisions,
  };
}
