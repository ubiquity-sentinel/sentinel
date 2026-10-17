/**
 * The launcher-to-runtime hand-over of the one-time legacy review class's
 * cutoff (`review-round-cap.ts`, owner decision 2026-10-16). The runtime
 * revision cannot carry its own activation instant, so the launcher that
 * pinned that revision for installation (`LEGACY_REVIEW_CUTOFF_RUNTIMES`, the
 * instant of its pin commit, no later than the activation) hands it to every
 * run of exactly that revision through one child environment key. No key, a
 * malformed value or a revision without a pinned row: no record is legacy.
 */
import type {
  HostedExecutionIntentV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import {
  legacyReviewCutoffFor,
  type LegacyReviewCutoffV1,
  validLegacyCutoff,
} from "../repair/review-round-cap.ts";

/** The one child environment key carrying the cutoff (decimal epoch ms). */
export const LEGACY_REVIEW_CUTOFF_ENV = "SENTINEL_LEGACY_REVIEW_CUTOFF";

/** The cutoff a run of `execution` receives, or null. */
export function legacyReviewCutoffForExecution(
  execution: Pick<HostedExecutionIntentV1, "revision" | "createdAt">,
  pinned?: readonly LegacyReviewCutoffV1[],
): number | null {
  return legacyReviewCutoffFor(
    execution.revision,
    [execution.createdAt],
    pinned,
  );
}

/** Strict decimal parse of the handed-over cutoff; anything else is null. */
export function parseLegacyReviewCutoffEnv(
  value: string | undefined,
): number | null {
  if (value === undefined || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const cutoff = Number(value);
  return validLegacyCutoff(cutoff) ? cutoff : null;
}

/**
 * The cutoff of the INSTALLED runtime (the launcher's own round counts): its
 * pinned row, checked against every execution of that revision the runtime
 * record still holds (the current intent and the two retained proofs). Null
 * when none is pinned or the bound is later than any of them.
 */
export function legacyReviewCutoffForRuntime(
  runtime: HostedRuntimeRecordV1 | null | undefined,
  pinned?: readonly LegacyReviewCutoffV1[],
): number | null {
  if (runtime === null || runtime === undefined) return null;
  const revision = runtime.activeRevision;
  const executions: number[] = [];
  for (
    const execution of [
      runtime.execution,
      runtime.lastHealthyProof?.execution ?? null,
      runtime.lastExecutionProof?.execution ?? null,
    ]
  ) {
    if (execution !== null && execution.revision === revision) {
      executions.push(execution.createdAt);
    }
  }
  return legacyReviewCutoffFor(revision, executions, pinned);
}
