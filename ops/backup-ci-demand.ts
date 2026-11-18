/**
 * Stand-in demand of the trusted pass (review MUST 3, 2026-11-17). Before,
 * every enrolled target was read every pass (repository, default-branch tip
 * and up to twelve commits' observations, about 200 reads per pass for 29
 * idle targets) and every scanned commit got a timestamp-only store row.
 * Now a target is read only when the repair state already shows a live
 * record whose published head waits on CI that has not finished:
 *
 * - a pending CI wait (`wait.reason` `ci_pending`), or
 * - a park of the pre-review CI gate that names a never-started check
 *   (`… <check>(not_started…)`).
 *
 * The planner then confirms the never-started check and its billing
 * annotation with target reads, as before; a target with no such record
 * costs nothing. Demand targets are planned first, the longest-waiting
 * first, so a target with many parked records is not starved by rotation.
 */
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { backupCiRecords } from "./backup-ci-plan.ts";

type Work = RepairStateSnapshotV1["work"][number];

const NOT_STARTED = /\bnot_started\b/;

/** The live records of `repository` whose head may need a stand-in. */
export function backupCiDemandRecords(
  snapshot: RepairStateSnapshotV1,
  repository: string,
): Work[] {
  return backupCiRecords(snapshot, repository).filter((record) =>
    record.wait?.reason === "ci_pending" ||
    (record.nextStep === "blocked" && record.blocker !== null &&
      NOT_STARTED.test(record.blocker.message))
  );
}

/**
 * The planning order of targets with demand: oldest waiting record first
 * (its wait or park start), then more waiting records, then name.
 */
export function backupCiDemandOrder(
  demand: ReadonlyMap<string, readonly Work[]>,
): string[] {
  const since = (records: readonly Work[]) =>
    Math.min(
      ...records.map((r) => r.wait?.since ?? r.blocker?.since ?? r.updatedAt),
    );
  return [...demand.entries()].filter(([, records]) => records.length > 0)
    .sort(([a, ra], [b, rb]) =>
      since(ra) - since(rb) || rb.length - ra.length || (a < b ? -1 : 1)
    ).map(([name]) => name);
}
