/** Repair loop internals: replay before. */
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { CHECK_POLL_MS, MAX_OUTPUT_LIMIT_BYTES } from "./loop-bounds.ts";
import { evidenceForRecord, isCausalReplayResult } from "./loop-evidence.ts";
import { configFor } from "./loop-records.ts";
import {
  carryFromSavedReplay,
  resolveFixtureTestIds,
  validateSavedReplay,
} from "./loop-replay-evidence.ts";
import type { CarryV1, RepairCycleDepsV1 } from "./loop-types.ts";
import { markBlocked, setWait } from "./transitions.ts";

/**
 * Before-replay: the same sanitized fixture/digest against the exact original
 * revision must fail for the intended reason before any model budget is spent.
 */
export async function ensureBeforeReplay(
  deps: RepairCycleDepsV1,
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  carry: CarryV1,
): Promise<WorkRecordV1 | null> {
  if (record.source.kind !== "incident") return null;
  const evidence = evidenceForRecord(snapshot, record);
  const config = configFor(deps, record.repository);
  const now = deps.clock.now();
  if (evidence === undefined || evidence === null || evidence.replay === null) {
    return markBlocked(
      record,
      "missing_evidence",
      "incident has no replay fixture",
      now,
    );
  }
  if (config === null) {
    return markBlocked(
      record,
      "unavailable",
      "repository not configured",
      now,
    );
  }

  // A saved replay result for this task's CURRENT head is the exact proof
  // that head may be published. It is validated against the current
  // evidence/config identities BEFORE any replay or model work; an invalid
  // or mismatched record is missing evidence, stays immutable and is never
  // replaced or replayed under the same deterministic id.
  if (record.target.head !== null) {
    const savedForHead = snapshot.replays.find(
      (result) =>
        result.taskId === record.id &&
        result.candidate.revision === record.target.head,
    );
    if (savedForHead !== undefined) {
      const validated = await validateSavedReplay(
        deps,
        record,
        evidence,
        config,
        savedForHead,
      );
      if (validated.kind === "wait") {
        const at = deps.clock.now();
        return setWait(
          record,
          { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
          at,
        );
      }
      if (validated.kind === "invalid") {
        return markBlocked(
          record,
          "missing_evidence",
          "saved replay result does not match current evidence identities",
          now,
        );
      }
      carryFromSavedReplay(carry, savedForHead, validated.testIds);
      return null;
    }
  }

  // General prior original-proof reuse: once a durable causal ReplayResultV1
  // exists for this exact task and original revision, the intended
  // before-failure is proven and never rerun. A correction round has a NEW
  // candidate head, so the current head is NOT part of this reuse, but the
  // repository/fixture/command/test identities still must match the current
  // evidence/config; any mismatch is the same missing-evidence block above.
  const already = snapshot.replays.find(
    (result) => isCausalReplayResult(result, record),
  );
  if (already !== undefined) {
    const validated = await validateSavedReplay(
      deps,
      record,
      evidence,
      config,
      already,
    );
    if (validated.kind === "wait") {
      const at = deps.clock.now();
      return setWait(
        record,
        { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
        at,
      );
    }
    if (validated.kind === "invalid") {
      return markBlocked(
        record,
        "missing_evidence",
        "saved replay result does not match current evidence identities",
        now,
      );
    }
    carryFromSavedReplay(carry, already, validated.testIds);
    return null;
  }

  if (record.failingRevision === null) {
    return markBlocked(
      record,
      "missing_evidence",
      "incident has no failing revision",
      now,
    );
  }
  const replay = evidence.replay;
  const fixtureDigest = replay.fixtureDigest;
  if (fixtureDigest === null) {
    return markBlocked(
      record,
      "missing_evidence",
      "replay fixture digest not retained",
      now,
    );
  }
  const testIds = await resolveFixtureTestIds(
    deps,
    replay.fixtureRef,
    fixtureDigest,
  );
  if (testIds.kind === "wait") {
    const at = deps.clock.now();
    return setWait(
      record,
      { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
      at,
    );
  }
  if (testIds.kind === "invalid") {
    return markBlocked(
      record,
      "missing_evidence",
      "fixture has no trusted test identity",
      now,
    );
  }
  carry.testIds = testIds.value;
  const run = await deps.replay.runReplay({
    taskId: record.id,
    repository: record.repository,
    revision: record.failingRevision,
    commandId: replay.commandId,
    fixtureRef: replay.fixtureRef,
    fixtureDigest,
    testIds: testIds.value,
    outputLimitBytes: MAX_OUTPUT_LIMIT_BYTES,
  });
  if (!run.ok) {
    const at = deps.clock.now();
    return setWait(
      record,
      { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
      at,
    );
  }
  const result = run.value;
  // A before-run carrying limitations is never a clean intended failure:
  // block as missing evidence BEFORE the intended failure is admitted.
  if (result.limitations.length > 0) {
    return markBlocked(
      record,
      "missing_evidence",
      "original replay result carries unresolved limitations",
      now,
    );
  }
  if (
    result.outcome === "failed" && result.failure !== null &&
    result.failure.intended
  ) {
    carry.beforeRun = result;
    carry.fixtureRef = replay.fixtureRef;
    carry.fixtureDigest = fixtureDigest;
    carry.replayCommandId = replay.commandId;
    carry.beforeReason = summaryErrorType(
      snapshot,
      record.fingerprint ?? "",
    );
    return null;
  }
  if (result.outcome === "unavailable") {
    // A bounded re-observation, like every other replay wait here: an
    // unavailable runtime must never park the task indefinitely.
    return setWait(
      record,
      { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
      now,
    );
  }
  return markBlocked(
    record,
    "missing_evidence",
    "original revision did not fail for the intended reason",
    now,
  );
}

export function summaryErrorType(
  snapshot: RepairStateSnapshotV1,
  fingerprint: string,
): string {
  const summary = snapshot.incidents.find(
    (incident) => incident.fingerprint === fingerprint,
  );
  return summary?.errorType || "unreported original failure";
}
