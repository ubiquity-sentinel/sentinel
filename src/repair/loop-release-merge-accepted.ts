/** Repair loop internals: a merged delivery deferred, or completed at the merge while the release path is disabled. */
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { checkGithubCooldown, RELEASE_POLL_MS } from "./loop-bounds.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { appendEvidence, markDone, setWait } from "./transitions.ts";
import {
  mergeAcceptedReleaseDisabledRef,
  observeMergeAcceptedDelivery,
  releasePathDisabled,
} from "./vps-delivery.ts";

/**
 * Merged, deferred while the release path is enabled (JAM B12): the record
 * waits at `delivery` beside its open request until VPS acceptance.
 */
export function deferRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  now: number,
): Promise<StepResultV1> {
  return persistWork(
    deps,
    context,
    setWait(record, { reason: "unavailable", since: now, until: null }, now),
  );
}

/** One bounded release wait, retried on the next runtime run. */
function waitRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  now: number,
): Promise<StepResultV1> {
  return persistWork(
    deps,
    context,
    setWait(
      record,
      { reason: "unavailable", since: now, until: now + RELEASE_POLL_MS },
      now,
    ),
  );
}

/**
 * Owner directive 2026-10-31: for an issue-repair target whose release path is
 * disabled (`sentinel-release` stays disabled), acceptance ends at the merge.
 * A PR positively read as merged at the request's exact recorded merge
 * revision completes the record to `done` with merge-accepted evidence instead
 * of parking it forever. Returns null when the release path is enabled (VPS
 * acceptance keeps deciding there) or the observed PR contradicts that exact
 * identity, so the caller keeps the deferral; an unobservable read or cooldown
 * retries on the bounded release wait.
 */
export async function completeMergeAccepted(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
  release: Pick<ReleaseStateSnapshotV1, "vpsReleases">,
  now: number,
): Promise<StepResultV1 | null> {
  if (!releasePathDisabled(release)) return null;
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind !== "ok") return waitRelease(deps, context, record, now);
  const merge = await observeMergeAcceptedDelivery(
    deps.github,
    record,
    request,
  );
  if (merge.kind === "accepted") {
    return persistWork(
      deps,
      context,
      markDone({
        ...record,
        evidence: appendEvidence(record.evidence, [
          mergeAcceptedReleaseDisabledRef(record.target.pr!, merge.mergeSha),
        ]),
      }, now),
    );
  }
  if (merge.kind === "unavailable") {
    return waitRelease(deps, context, record, now);
  }
  return null;
}
