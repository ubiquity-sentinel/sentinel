/**
 * Identical-attempt refusal (#334): refuse, BEFORE reservation, an
 * implementation attempt whose inputs — base tip, candidate patch, latest
 * review findings and runtime revision — equal those of an attempt of the
 * same task that already ran and produced an outcome. Re-running it can only
 * reproduce the same diff against the same base for the same findings, and
 * every such replay is a charged model start.
 *
 * - Recorded inputs: only attempts that PROVED what their inputs produce are
 *   recorded: a completed session judged without progress
 *   (`JUDGED_ATTEMPT_DETAILS`: no change at all, or only generated/cache
 *   artifacts), or an accepted candidate that reproduced the exact head it
 *   started from. A NEW accepted candidate is not recorded: if it later goes
 *   missing or is dropped, the record returns to the same inputs and its
 *   fresh attempt is legitimate. An incomplete, interrupted, looped,
 *   transient or unknown run proves nothing about its inputs and keeps the
 *   existing bounded equivalence/decay allowance.
 * - Refusal: the first identical replay is refused with
 *   `identical_attempt_refused` naming the exact prior attempt (reservation)
 *   id; the prior row's refusal count grows in the SAME state commit. The
 *   prior charge is never refunded or rewritten.
 * - Changed base tip, findings, candidate head or runtime revision is a
 *   distinct attempt and is admitted as before; its prompt carries the
 *   newest unacknowledged refusal as a verified prior-attempt fact naming the
 *   prior attempt id and which inputs were identical.
 *
 * Pure and synchronous; the single admission call site lives in
 * `prepareImplementationStart`, and recording rides the existing attempt
 * memory settlement/success mutations.
 */
import {
  appendAttemptInputV1,
  attemptFindingsDigestV1,
  attemptInputFingerprintV1,
  attemptPatchDigestV1,
  IDENTICAL_ATTEMPT_FACT_PREFIX,
  IDENTICAL_ATTEMPT_REFUSED,
} from "../contracts/attempt-input.ts";
import type { AttemptInputV1 } from "../contracts/attempt-input.ts";
import type { AttemptMemoryRecordV1 } from "../contracts/attempt-memory.ts";
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type { PriorAttemptFactV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  conflictResolutionInFlight,
  pendingConflictResolution,
} from "./conflict-resolution.ts";
import { correctionFindings } from "./loop-review-records.ts";
import { isPassportWorkTrial } from "./passport-work-trial.ts";

export interface AttemptInputsV1 {
  fingerprint: string;
  controllerSha: GitSha;
  baseTip: GitSha;
  patchDigest: string;
  findingsDigest: string;
}

function sameRepository(
  left: RepositoryIdentityV1,
  right: RepositoryIdentityV1,
): boolean {
  return left.owner === right.owner && left.name === right.name &&
    left.installationId === right.installationId;
}

/** The inputs the next attempt of `record` would start from. */
export function attemptInputsForRecordV1(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  runtimeSha: GitSha,
): AttemptInputsV1 {
  // A conflict resolution runs against its marked merge base, not the old
  // `target.base` it stays on until publication: a moved tip is a distinct
  // attempt (pending refresh intent before admission, in-flight marker on
  // the admitted implementation intent when its inputs are recorded).
  const baseTip = pendingConflictResolution(record.intent) ??
    conflictResolutionInFlight(record.intent) ?? record.target.base;
  // The candidate patch stays the candidate head over its own base.
  const patchDigest = attemptPatchDigestV1({
    base: record.target.base,
    head: record.target.head,
  });
  const findingsDigest = attemptFindingsDigestV1(
    correctionFindings(snapshot, record),
  );
  return {
    fingerprint: attemptInputFingerprintV1({
      taskId: record.id,
      purpose: "implementation",
      controllerSha: runtimeSha,
      baseTip,
      patchDigest,
      findingsDigest,
    }),
    controllerSha: runtimeSha,
    baseTip,
    patchDigest,
    findingsDigest,
  };
}

function taskInputRows(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): { memory: AttemptMemoryRecordV1; row: AttemptInputV1 }[] {
  const rows: { memory: AttemptMemoryRecordV1; row: AttemptInputV1 }[] = [];
  for (const memory of snapshot.attemptMemory) {
    if (
      memory.taskId !== record.id || memory.purpose !== "implementation" ||
      !sameRepository(memory.repository, record.repository)
    ) continue;
    for (const row of memory.inputs ?? []) rows.push({ memory, row });
  }
  return rows;
}

export interface IdenticalAttemptRefusalV1 {
  memoryId: string;
  prior: AttemptInputV1;
  inputs: AttemptInputsV1;
}

/**
 * The refusal of the next attempt of `record`, or null when its inputs are
 * distinct from every recorded attempt (or only legacy memory exists).
 */
export function identicalAttemptRefusalV1(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  runtimeSha: GitSha,
): IdenticalAttemptRefusalV1 | null {
  if (isPassportWorkTrial(record.repository)) return null;
  const inputs = attemptInputsForRecordV1(snapshot, record, runtimeSha);
  const match = taskInputRows(snapshot, record).find(({ row }) =>
    row.fingerprint === inputs.fingerprint
  );
  return match === undefined
    ? null
    : { memoryId: match.memory.id, prior: match.row, inputs };
}

/** The bounded blocker message naming the exact prior attempt. */
export function identicalAttemptRefusalMessage(
  refusal: IdenticalAttemptRefusalV1,
): string {
  return `${IDENTICAL_ATTEMPT_REFUSED}: prior attempt ${refusal.prior.attemptId} ran with the identical base tip, candidate patch, review findings and runtime revision`;
}

/** Count one refusal on the prior row (pure draft mutation). */
export function identicalAttemptRefusalMutationV1(
  refusal: IdenticalAttemptRefusalV1,
  now: number,
): (draft: RepairStateSnapshotV1) => void {
  return (draft) => {
    const index = draft.attemptMemory.findIndex((memory) =>
      memory.id === refusal.memoryId
    );
    if (index === -1) return;
    const memory = draft.attemptMemory[index];
    draft.attemptMemory[index] = {
      ...memory,
      inputs: (memory.inputs ?? []).map((row) =>
        row.fingerprint === refusal.prior.fingerprint
          ? {
            ...row,
            refusals: row.refusals + 1,
            lastRefusedAtMs: Math.max(now, row.lastRefusedAtMs ?? 0),
          }
          : row
      ),
    };
  };
}

/**
 * Record the inputs of the attempt `record` just settled onto its family
 * record (pure). `record` is the ADMITTED record (its implementation intent
 * names the reservation); without one nothing is recorded.
 */
export function recordAttemptInputs(
  family: AttemptMemoryRecordV1,
  draft: RepairStateSnapshotV1,
  record: WorkRecordV1,
  runtimeSha: GitSha,
  now: number,
): AttemptMemoryRecordV1 {
  const attemptId = record.intent?.kind === "implementation"
    ? record.intent.requestId
    : null;
  if (
    attemptId === null || attemptId === undefined ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(attemptId)
  ) return family;
  const inputs = attemptInputsForRecordV1(draft, record, runtimeSha);
  return {
    ...family,
    inputs: appendAttemptInputV1(family.inputs, {
      ...inputs,
      attemptId,
      atMs: now,
    }),
  };
}

/**
 * The newest refusal not yet followed by a recorded attempt, as a verified
 * prior-attempt fact for the next distinct attempt's prompt; null otherwise.
 */
export function identicalAttemptRefusalFactV1(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  runtimeSha: GitSha,
): PriorAttemptFactV1 | null {
  const rows = taskInputRows(snapshot, record).map(({ row }) => row);
  let refused: AttemptInputV1 | null = null;
  for (const row of rows) {
    if (row.lastRefusedAtMs === null) continue;
    if (refused === null || row.lastRefusedAtMs > refused.lastRefusedAtMs!) {
      refused = row;
    }
  }
  if (refused === null) return null;
  const refusedAt = refused.lastRefusedAtMs!;
  if (rows.some((row) => row.atMs > refusedAt)) return null;
  const current = attemptInputsForRecordV1(snapshot, record, runtimeSha);
  const parts: [string, boolean][] = [
    ["base tip", current.baseTip === refused.baseTip],
    ["candidate patch", current.patchDigest === refused.patchDigest],
    ["review findings", current.findingsDigest === refused.findingsDigest],
    ["runtime revision", current.controllerSha === refused.controllerSha],
  ];
  const identical = parts.filter(([, same]) => same).map(([name]) => name);
  const changed = parts.filter(([, same]) => !same).map(([name]) => name);
  return {
    detail:
      `${IDENTICAL_ATTEMPT_FACT_PREFIX}prior attempt ${refused.attemptId}; identical inputs: ${
        identical.length === 0 ? "none" : identical.join(", ")
      }; changed: ${changed.length === 0 ? "none" : changed.join(", ")}`,
    stage: "reservation",
    failureClass: "semantic_no_progress",
    count: refused.refusals,
    lastAtMs: refusedAt,
  };
}

/** Retry-table prefix of a record refused for an identical replay. */
export const IDENTICAL_ATTEMPT_REFUSED_PREFIX =
  `${IDENTICAL_ATTEMPT_REFUSED}:` as const;

/**
 * The launcher re-grant verdict for a record blocked by this refusal (pure).
 * The record is evaluated as the granted attempt would start: a base tip that
 * moved past `target.base` is the base it runs against (the runtime refreshes
 * to it), so a moved base, changed findings, a new candidate head or a new
 * runtime revision re-grants; an unchanged fingerprint never does. Any other
 * blocker is `not_refused`.
 */
export function identicalAttemptRegrantVerdictV1(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  runtimeSha: GitSha,
  /** The observed base tip; anything but an exact Git SHA is no move. */
  baseTip: string | null,
): "not_refused" | "regrant" | "unchanged" {
  const blocker = record.blocker;
  if (
    record.nextStep !== "blocked" || blocker === null ||
    !blocker.message.startsWith(IDENTICAL_ATTEMPT_REFUSED_PREFIX)
  ) return "not_refused";
  const probe = baseTip !== null && isGitSha(baseTip) &&
      baseTip !== record.target.base
    ? { ...record, target: { ...record.target, base: baseTip } }
    : record;
  return identicalAttemptRefusalV1(snapshot, probe, runtimeSha) === null
    ? "regrant"
    : "unchanged";
}
