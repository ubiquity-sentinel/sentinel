import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { ownerSuccessorReviewTransition } from "../contracts/owner-successor-review.ts";
import {
  cooldownTransitionMessage,
  sameCanonical,
  sameRepository,
} from "./state-transition.ts";

export function validateRepairTransition(
  prior: RepairStateSnapshotV1,
  next: RepairStateSnapshotV1,
): string | null {
  // Every prior record must survive; existing records must not rewrite their
  // immutable identity or reset terminal state.
  for (const priorRecord of prior.work) {
    const nextRecord = next.work.find((record) => record.id === priorRecord.id);
    if (nextRecord === undefined) {
      return "existing work record cannot be dropped";
    }
    if (priorRecord.nextStep === "done") {
      if (!sameCanonical(priorRecord, nextRecord)) {
        return "a done work record cannot restart or mutate";
      }
      continue;
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.source.kind !== nextRecord.source.kind ||
      priorRecord.source.id !== nextRecord.source.id ||
      priorRecord.source.revision !== nextRecord.source.revision ||
      priorRecord.controller.sha !== nextRecord.controller.sha ||
      priorRecord.failingRevision !== nextRecord.failingRevision ||
      priorRecord.sourceSnapshotDigest !== nextRecord.sourceSnapshotDigest
    ) {
      return "existing work record immutable identity changed";
    }
  }
  for (const priorRecord of prior.reservations) {
    const nextRecord = next.reservations.find(
      (record) => record.id === priorRecord.id,
    );
    if (nextRecord === undefined) {
      return "existing reservation cannot disappear";
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.taskId !== nextRecord.taskId ||
      priorRecord.attempt !== nextRecord.attempt ||
      priorRecord.head !== nextRecord.head ||
      priorRecord.purpose !== nextRecord.purpose ||
      priorRecord.createdAt !== nextRecord.createdAt
    ) {
      return "existing reservation identity or time changed";
    }
    if (priorRecord.outcome === "ambiguous") {
      // A settled ambiguous reservation stays charged; it may be reconciled
      // as submitted (charged) or proven never submitted (the only uncharged
      // terminal, whose proof ref the parser already requires). The recorded
      // settlement time may advance on resolution, never move backward, and
      // an equal repeated settlement stays idempotent.
      const priorSettledAt = priorRecord.settledAt;
      if (
        priorSettledAt === null || nextRecord.settledAt === null ||
        nextRecord.settledAt < priorSettledAt
      ) {
        return "settled reservation cannot clear or move settlement time backward";
      }
      if (nextRecord.outcome === "reserved") {
        return "settled reservation cannot revert to reserved";
      }
    } else if (priorRecord.outcome !== "reserved") {
      if (!sameCanonical(priorRecord, nextRecord)) {
        return "settled reservation cannot revert or mutate";
      }
    }
  }
  for (const priorRecord of prior.releaseRequests) {
    const nextRecord = next.releaseRequests.find(
      (record) => record.id === priorRecord.id,
    );
    if (nextRecord === undefined) {
      return "existing release request cannot disappear";
    }
    if (
      !sameRepository(
        priorRecord.target.repository,
        nextRecord.target.repository,
      ) ||
      priorRecord.target.environment !== nextRecord.target.environment ||
      priorRecord.revision !== nextRecord.revision ||
      priorRecord.source.pullRequest !== nextRecord.source.pullRequest ||
      priorRecord.source.reviewRequestId !==
        nextRecord.source.reviewRequestId ||
      priorRecord.source.reviewReceiptId !==
        nextRecord.source.reviewReceiptId ||
      priorRecord.source.head !== nextRecord.source.head ||
      priorRecord.source.base !== nextRecord.source.base ||
      priorRecord.createdAt !== nextRecord.createdAt
    ) {
      return "existing release request identity changed";
    }
    if (
      priorRecord.status !== "open" && !sameCanonical(priorRecord, nextRecord)
    ) {
      return "terminal release request cannot restart or mutate";
    }
  }
  // Attempt memory is append/merge-only: a record can never disappear, its
  // identity is fixed, per-fingerprint counts cannot decrease and the window
  // can never move backward. Folding at the entry cap preserves this because
  // merged counts carry forward into the successor entry.
  for (const priorRecord of prior.attemptMemory) {
    const nextRecord = next.attemptMemory.find((record) =>
      record.id === priorRecord.id
    );
    if (nextRecord === undefined) {
      return "existing attempt memory record cannot be dropped";
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.taskId !== nextRecord.taskId ||
      priorRecord.base !== nextRecord.base ||
      priorRecord.purpose !== nextRecord.purpose
    ) {
      return "existing attempt memory identity changed";
    }
    let priorTotal = 0;
    for (const entry of priorRecord.entries) priorTotal += entry.count;
    let nextTotal = 0;
    for (const entry of nextRecord.entries) nextTotal += entry.count;
    if (nextTotal < priorTotal) {
      return "attempt memory counts cannot decrease";
    }
    const priorSuccesses = priorRecord.successes ?? 0;
    const nextSuccesses = nextRecord.successes ?? 0;
    const priorSuccessAt = priorRecord.lastSuccessAtMs ?? null;
    const nextSuccessAt = nextRecord.lastSuccessAtMs ?? null;
    const priorSuccessRevision = priorRecord.lastSuccessRevision ?? null;
    const nextSuccessRevision = nextRecord.lastSuccessRevision ?? null;
    if (
      priorSuccesses > nextSuccesses ||
      (priorSuccessAt !== null &&
        (nextSuccessAt === null || nextSuccessAt < priorSuccessAt)) ||
      (priorSuccessRevision !== null && nextSuccessRevision === null)
    ) {
      return "attempt memory success history cannot move backward";
    }
    // Once known, success identity stays fixed until another success is
    // recorded. Legacy absent/null provenance may still be filled once.
    if (
      priorSuccesses === nextSuccesses &&
      ((priorSuccessAt !== null && nextSuccessAt !== priorSuccessAt) ||
        (priorSuccessRevision !== null &&
          nextSuccessRevision !== priorSuccessRevision))
    ) {
      return "attempt memory success provenance cannot change without a new success";
    }
    for (const priorEntry of priorRecord.entries) {
      const nextEntry = nextRecord.entries.find((entry) =>
        entry.fingerprint === priorEntry.fingerprint
      );
      // An absent fingerprint was folded into a successor at the entry cap;
      // its count is carried by the total check above.
      if (nextEntry === undefined) continue;
      if (nextEntry.count < priorEntry.count) {
        return "attempt memory fingerprint count cannot decrease";
      }
      if (nextEntry.firstAtMs > priorEntry.firstAtMs) {
        return "attempt memory firstAtMs cannot move forward";
      }
      if (nextEntry.lastAtMs < priorEntry.lastAtMs) {
        return "attempt memory lastAtMs cannot move backward";
      }
    }
  }
  // Replay results are terminal proof: exactly immutable, never regenerated.
  for (const priorRecord of prior.replays) {
    const nextRecord = next.replays.find((record) =>
      record.id === priorRecord.id
    );
    if (nextRecord === undefined) {
      return "existing replay result cannot be dropped";
    }
    if (!sameCanonical(priorRecord, nextRecord)) {
      return "existing replay result cannot be rewritten";
    }
  }
  for (const priorRecord of prior.incidents) {
    const nextRecord = next.incidents.find((record) =>
      record.id === priorRecord.id
    );
    if (nextRecord === undefined) {
      return "existing incident summary cannot be dropped";
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.fingerprint !== nextRecord.fingerprint ||
      priorRecord.firstSeenAt !== nextRecord.firstSeenAt ||
      priorRecord.failingRevision !== nextRecord.failingRevision
    ) {
      return "existing incident summary identity changed";
    }
    if (nextRecord.count < priorRecord.count) {
      return "incident count cannot decrease";
    }
    if (nextRecord.lastSeenAt < priorRecord.lastSeenAt) {
      return "incident lastSeenAt cannot move backward";
    }
    if (
      priorRecord.provenance.source !== nextRecord.provenance.source ||
      priorRecord.provenance.endpoint !== nextRecord.provenance.endpoint ||
      nextRecord.provenance.capturedAt < priorRecord.provenance.capturedAt
    ) {
      return "incident provenance changed";
    }
    // severity/errorType/context/coverage/evidenceRef stay updateable so
    // repeated discovery and evidence retention work.
  }
  for (const priorRecord of prior.evidence) {
    const nextRecord = next.evidence.find((record) =>
      record.id === priorRecord.id
    );
    if (nextRecord === undefined) {
      return "existing incident evidence cannot be dropped";
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.incidentId !== nextRecord.incidentId ||
      priorRecord.fingerprint !== nextRecord.fingerprint ||
      priorRecord.failingRevision !== nextRecord.failingRevision ||
      !sameCanonical(priorRecord.provenance, nextRecord.provenance)
    ) {
      return "existing incident evidence identity or provenance changed";
    }
    for (const artifact of priorRecord.artifacts) {
      if (
        !nextRecord.artifacts.some((next) => sameCanonical(next, artifact))
      ) {
        return "existing evidence artifact cannot be removed or altered";
      }
    }
    if (priorRecord.replay !== null) {
      const nextReplay = nextRecord.replay;
      if (nextReplay === null) {
        return "existing replay metadata cannot be removed";
      }
      // Replay metadata identity: the fixture ref and command stay fixed.
      // upstreamCaptured is derived (the parser ties it to fixtureDigest
      // nullness), so the fill-once rules below govern it completely.
      if (
        nextReplay.fixtureRef !== priorRecord.replay.fixtureRef ||
        nextReplay.commandId !== priorRecord.replay.commandId
      ) {
        return "existing replay metadata identity changed";
      }
      // A null fixtureDigest/reproducedAt may fill once; a non-null identity
      // may never be replaced.
      if (
        priorRecord.replay.fixtureDigest !== null &&
        nextReplay.fixtureDigest !== priorRecord.replay.fixtureDigest
      ) {
        return "replay fixture digest cannot be replaced";
      }
      if (
        priorRecord.replay.reproducedAt !== null &&
        nextReplay.reproducedAt !== priorRecord.replay.reproducedAt
      ) {
        return "replay reproducedAt cannot be replaced";
      }
    }
    // coverage stays updateable.
  }
  // Duplicate artifact refs are never valid, including on newly appended
  // evidence records; refs are exact storage pointers, not multiply-claimable.
  for (const [index, record] of next.evidence.entries()) {
    const seen = new Set<string>();
    for (const artifact of record.artifacts) {
      if (seen.has(artifact.ref)) {
        return `ev${index}: duplicate artifact refs are invalid`;
      }
      seen.add(artifact.ref);
    }
  }
  for (const priorRecord of prior.reviews) {
    const nextRecord = next.reviews.find((record) =>
      record.id === priorRecord.id
    );
    if (nextRecord === undefined) {
      return "existing review receipt cannot be dropped";
    }
    if (
      priorRecord.requestId !== nextRecord.requestId ||
      priorRecord.expectedReviewer !== nextRecord.expectedReviewer ||
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      !sameCanonical(priorRecord.pullRequest, nextRecord.pullRequest) ||
      priorRecord.submittedAt !== nextRecord.submittedAt
    ) {
      return "existing review receipt identity changed";
    }
    if (nextRecord.observedAt < priorRecord.observedAt) {
      return "review observedAt cannot move backward";
    }
    if (
      priorRecord.outcome === "completed" &&
      !sameCanonical(priorRecord, nextRecord)
    ) {
      return "completed review receipt cannot mutate";
    }
    // pending/unavailable observations may update observed reviewer, result,
    // findings and outcome — including becoming completed.
  }
  for (const operation of prior.ownerSuccessorReviews ?? []) {
    const current = next.ownerSuccessorReviews?.find((r) =>
      r.id === operation.id
    );
    if (!current || !ownerSuccessorReviewTransition(operation, current)) {
      return "owner successor review identity or monotonic custody changed";
    }
  }
  for (const operation of next.ownerSuccessorReviews ?? []) {
    if (
      !(prior.ownerSuccessorReviews ?? []).some((r) => r.id === operation.id) &&
      (operation.phase !== "intent" ||
        operation.binding.expectedRepairHead !== next.stateHead ||
        !prior.reservations.some((r) =>
          r.outcome === "reserved" && sameCanonical(r, operation.reservation)
        ))
    ) {
      return "a new owner review must start from its exact durable charged intent";
    }
    if (
      (operation.phase === "completed" || operation.phase === "failed") &&
      !next.reservations.some((r) => sameCanonical(r, operation.reservation))
    ) {
      return "terminal owner review must bind its unchanged settled reservation";
    }
  }
  // Durable GitHub cooldowns are fail-closed preservation state; the same
  // guard protects both refs.
  return cooldownTransitionMessage(
    prior.githubCooldowns,
    next.githubCooldowns,
  );
}
