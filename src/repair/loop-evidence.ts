/** Repair loop internals: evidence. */
import type { IncidentEvidenceV1 } from "../contracts/incident.ts";
import type { ReplayResultV1 } from "../contracts/replay-result.ts";
import type {
  EvidenceRefV1,
  RepositoryIdentityV1,
} from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { CHECK_POLL_MS } from "./loop-bounds.ts";
import { mergeEvidence, sameRepositoryIdentity } from "./loop-records.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";
import { markBlocked, setWait } from "./transitions.ts";

export function isCausalReplayResult(
  result: ReplayResultV1,
  record: WorkRecordV1,
): boolean {
  return result.taskId === record.id &&
    sameRepositoryIdentity(result.repository, record.repository) &&
    result.original.revision === record.failingRevision &&
    result.limitations.length === 0 &&
    result.original.outcome === "failed" &&
    result.original.failure?.intended === true &&
    result.candidate.outcome === "passed";
}

/**
 * Deterministic evidence-to-task identity match: the evidence record belongs
 * to the exact incident id AND the exact repository identity. The evidence
 * record id is an immutable record identity (`evidence:<incidentId>` from the
 * gateway producer) and is never a lookup key; the incidentId field is.
 */
export function evidenceMatches(
  evidence: IncidentEvidenceV1,
  incidentId: string,
  repository: RepositoryIdentityV1,
): boolean {
  return evidence.incidentId === incidentId &&
    sameRepositoryIdentity(evidence.repository, repository);
}

/**
 * The persisted evidence record matching one work task, or undefined when
 * none exists. Every consumer resolves evidence by incidentId + repository
 * identity (never by evidence record id), so a foreign record can never be
 * mistaken for this task's evidence.
 */
export function evidenceForRecord(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): IncidentEvidenceV1 | undefined {
  const incidentId = record.related.incidentId;
  if (incidentId === null) return undefined;
  return snapshot.evidence.find(
    (item) => evidenceMatches(item, incidentId, record.repository),
  );
}

/**
 * Deterministic evidence/expiry handling. Returns either a record transition
 * (with the persisted IncidentEvidenceV1, when one was fetched) or a null
 * record meaning evidence is ready.
 */
export async function ensureEvidence(
  deps: RepairCycleDepsV1,
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): Promise<
  { record: WorkRecordV1 | null; evidence: IncidentEvidenceV1 | null }
> {
  if (record.source.kind !== "incident") {
    return { record: null, evidence: null };
  }
  const incidentId = record.related.incidentId;
  if (incidentId === null) {
    return {
      record: markBlocked(
        record,
        "missing_evidence",
        "incident task without an incident id",
        deps.clock.now(),
      ),
      evidence: null,
    };
  }
  const existing = evidenceForRecord(snapshot, record);
  if (existing !== undefined) {
    const now = deps.clock.now();
    const hasDurableReplay = snapshot.replays.some(
      (result) => isCausalReplayResult(result, record),
    );
    if (
      !hasDurableReplay &&
      existing.artifacts.some((artifact) => artifact.expiresAt <= now)
    ) {
      return {
        record: markBlocked(
          record,
          "evidence_expired",
          "incident artifact expired",
          now,
        ),
        evidence: null,
      };
    }
    return { record: null, evidence: null };
  }
  const read = await deps.incidents.readIncident(incidentId);
  if (!read.ok) {
    const at = deps.clock.now();
    return {
      record: setWait(
        record,
        { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
        at,
      ),
      evidence: null,
    };
  }
  if (read.value === null) {
    return {
      record: markBlocked(
        record,
        "missing_evidence",
        "incident evidence missing",
        deps.clock.now(),
      ),
      evidence: null,
    };
  }
  const evidence = read.value;
  const now = deps.clock.now();
  // A freshly returned record is validated against the exact requested
  // identity before it is persisted OR used: the same incident id must belong
  // to the same repository (owner/name/installationId). A foreign record fails
  // closed with a typed blocker and is never merged into this task.
  if (!evidenceMatches(evidence, incidentId, record.repository)) {
    return {
      record: markBlocked(
        record,
        "other",
        "incident evidence belongs to a different incident or repository",
        now,
      ),
      evidence: null,
    };
  }
  // A global evidence id collision with an already-persisted record for a
  // different incident/repository is never overwritten, silently reused or
  // rewritten as a no-progress transition: fail closed with a typed blocker.
  // (The same-identity lookup above guarantees a colliding record here is
  // always foreign.)
  const colliding = snapshot.evidence.find((item) => item.id === evidence.id);
  if (colliding !== undefined) {
    return {
      record: markBlocked(
        record,
        "other",
        "evidence id collides with an existing record for a different incident or repository",
        now,
      ),
      evidence: null,
    };
  }
  if (evidence.artifacts.some((artifact) => artifact.expiresAt <= now)) {
    return {
      record: markBlocked(
        record,
        "evidence_expired",
        "incident artifact expired",
        now,
      ),
      evidence: null,
    };
  }
  if (
    evidence.replay !== null &&
    (evidence.replay.fixtureRef === null ||
      evidence.replay.fixtureDigest === null)
  ) {
    return {
      record: markBlocked(
        record,
        "missing_evidence",
        "replay fixture not retained",
        now,
      ),
      evidence: null,
    };
  }
  const refs: EvidenceRefV1[] = evidence.artifacts.map((artifact) => ({
    kind: "incident_evidence",
    ref: artifact.ref,
    digest: artifact.digest,
  }));
  return {
    record: {
      ...record,
      evidence: mergeEvidence(record.evidence, refs),
      updatedAt: now,
    },
    evidence,
  };
}
