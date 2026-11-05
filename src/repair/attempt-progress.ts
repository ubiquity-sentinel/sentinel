/** Candidate progress memory, independent of historical failure/review ceilings. */
import { attemptFingerprintV1 } from "../contracts/attempt-memory.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import type { ModelRunRequestV1 } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { MaxItems } from "../contracts/validation.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { persistWork } from "./loop-state.ts";
import { latestCompletedReview } from "./review-round-cap.ts";
import { markBlocked } from "./transitions.ts";

export const IDENTICAL_ATTEMPT_REFUSED = "identical_attempt_refused";

/** Read-only Git proof: commit ids and review receipt ids are not progress. */
export async function prepareCandidateAttemptV1(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  ciFinding: NonNullable<ModelRunRequestV1["reviewFindings"]>[number] | null,
): Promise<{ kind: "fingerprint"; fingerprint: string | null } | StepResultV1> {
  const head = record.target.head;
  // There is no candidate patch before the first candidate. Startup/provider
  // retries keep their existing outcome policy rather than becoming semantic failures.
  if (head === null) return { kind: "fingerprint", fingerprint: null };
  if (deps.github.proveCarriedPatch === undefined) {
    return {
      kind: "deferred",
      detail: "candidate patch fingerprint unavailable",
    };
  }
  const base = record.target.base;
  const proof = await deps.github.proveCarriedPatch({
    reviewedBase: base,
    reviewedHead: head,
    base,
    head,
  });
  if (
    !proof.ok || !/^[0-9a-f]{64}$/.test(proof.value.refreshedPatch) ||
    proof.value.reviewedPatch !== proof.value.refreshedPatch
  ) {
    return {
      kind: "deferred",
      detail: "candidate patch fingerprint unavailable",
    };
  }
  const review = latestCompletedReview(context.snapshot, record);
  // Findings are content, not per-round identities/timestamps. Normalize their
  // order and duplicate rows, but keep resolution and omitted-findings evidence.
  const findings = [
    ...new Set((review?.findings ?? []).map((finding) =>
      canonicalStringify({
        severity: finding.severity,
        path: finding.path,
        message: finding.message,
        resolved: finding.resolved,
        fingerprint: finding.fingerprint,
        resolutionEvidence: finding.resolutionEvidence,
      })
    )),
  ].sort();
  const reviewFindingsDigest = await canonicalStringifySha256({
    domain: "sentinel.memory.review-findings.v1",
    findings,
    findingsUncounted: review?.findingsUncounted ?? 0,
    ciFinding,
  });
  const fingerprint = await attemptFingerprintV1({
    taskId: record.id,
    base,
    purpose: "implementation",
    controllerSha: deps.controllerSha,
    detail: "candidate_progress",
    candidatePatchDigest: proof.value.refreshedPatch,
    reviewFindingsDigest,
  });
  const prior = record.target.attemptFingerprints?.find((entry) =>
    entry.fingerprint === fingerprint &&
    ![
      ...context.snapshot.reservations,
      ...(context.snapshot.reservationArchive ?? []),
    ]
      .some((reservation) =>
        reservation.id === entry.attemptId &&
        reservation.outcome === "confirmed_not_submitted"
      )
  );
  if (prior === undefined) return { kind: "fingerprint", fingerprint };
  const refused = {
    ...record,
    target: {
      ...record.target,
      attemptFingerprints: record.target.attemptFingerprints!.map((entry) =>
        entry === prior ? { ...entry, refusedAtMs: deps.clock.now() } : entry
      ),
    },
  };
  return await persistWork(
    deps,
    context,
    markBlocked(
      refused,
      "other",
      `${IDENTICAL_ATTEMPT_REFUSED}: prior_attempt_id=${prior.attemptId}`,
      deps.clock.now(),
    ),
  );
}

/** Called only after an exact reservation and counted intent have been verified. */
export function rememberCandidateAttemptV1(
  record: WorkRecordV1,
  fingerprint: string,
  attemptId: string,
): WorkRecordV1 {
  return {
    ...record,
    target: {
      ...record.target,
      attemptFingerprints: [
        ...(record.target.attemptFingerprints ?? []).filter((entry) =>
          entry.fingerprint !== fingerprint
        ),
        { fingerprint, attemptId },
      ].slice(-MaxItems.attemptEntries),
    },
  };
}
