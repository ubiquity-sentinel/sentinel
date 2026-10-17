/**
 * The launcher-to-runtime hand-over of the one-time legacy review class's
 * cutoff (`review-round-cap.ts`, owner decision 2026-10-16). The runtime
 * revision cannot carry its own activation instant, so the launcher hands the
 * ONE pinned cutoff (`LEGACY_REVIEW_CUTOFF`: the instant of the commit that
 * pins generation 80's install, reused unchanged by every later CI-first
 * runtime) to every run of exactly the pinned CI-first revisions through one
 * child environment key. The instant is checked against every execution of
 * those revisions that release custody still records, so an instant moved
 * past an earlier CI-first activation is refused. No key, a malformed value
 * or a revision outside the pin: no record is legacy.
 */
import type {
  HostedExecutionIntentV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  type LegacyCutoffExecutionV1,
  legacyReviewCutoffFor,
  type LegacyReviewCutoffPinV1,
  validLegacyCutoff,
} from "../repair/review-round-cap.ts";

/** The one child environment key carrying the cutoff (decimal epoch ms). */
export const LEGACY_REVIEW_CUTOFF_ENV = "SENTINEL_LEGACY_REVIEW_CUTOFF";

type ExecutionRow = { execution: LegacyCutoffExecutionV1 } | null | undefined;

/**
 * Every execution release custody records: each hosted release's prior,
 * candidate and rollback proofs (immutable once written) and each hosted
 * runtime's current intent and retained proofs.
 */
export function custodyExecutions(
  release: ReleaseStateSnapshotV1 | null | undefined,
): LegacyCutoffExecutionV1[] {
  if (release === null || release === undefined) return [];
  const rows: ExecutionRow[] = [];
  for (const row of release.hostedReleases) {
    rows.push(row.priorProof, row.candidateProof, row.rollbackProof);
  }
  for (const runtime of release.hostedRuntimes) {
    rows.push(...runtimeExecutions(runtime));
  }
  return rows.flatMap((row) =>
    row === null || row === undefined ? [] : [row.execution]
  );
}

function runtimeExecutions(runtime: HostedRuntimeRecordV1): ExecutionRow[] {
  return [
    runtime.execution === null ? null : { execution: runtime.execution },
    runtime.lastHealthyProof,
    runtime.lastExecutionProof,
  ];
}

/** The cutoff a run of `execution` receives (custody checked), or null. */
export function legacyReviewCutoffForExecution(
  execution: Pick<HostedExecutionIntentV1, "revision" | "createdAt">,
  release?: ReleaseStateSnapshotV1 | null,
  pin?: LegacyReviewCutoffPinV1,
): number | null {
  return legacyReviewCutoffFor(
    execution.revision,
    [execution, ...custodyExecutions(release)],
    pin,
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
 * The cutoff of the INSTALLED runtime (the launcher's own round counts),
 * checked against every execution the runtime record and release custody
 * still hold. Null when its revision is not pinned or the instant is later
 * than any of them.
 */
export function legacyReviewCutoffForRuntime(
  runtime: HostedRuntimeRecordV1 | null | undefined,
  release?: ReleaseStateSnapshotV1 | null,
  pin?: LegacyReviewCutoffPinV1,
): number | null {
  if (runtime === null || runtime === undefined) return null;
  const executions = runtimeExecutions(runtime).flatMap((row) =>
    row === null || row === undefined ? [] : [row.execution]
  );
  return legacyReviewCutoffFor(
    runtime.activeRevision,
    [...executions, ...custodyExecutions(release)],
    pin,
  );
}
