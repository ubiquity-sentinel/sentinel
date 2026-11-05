/**
 * Per-record backoff of the launcher maintenance passes that read a record's
 * bound pull request every pass (the retired-pull pass and the stale-step
 * human-merge re-admission).
 *
 * A read that settles nothing (an open pull request, an unreadable listing,
 * issue or surface, a refused close) records `pullProbe: { pr, at }` on the
 * record. A pass then skips that record for the same pull request until
 * `PULL_PROBE_BACKOFF_MS` elapsed, and reads the least recently probed record
 * first, so a record that never settles costs at most one read per backoff
 * window and never starves the records behind it. The stamp is bookkeeping:
 * it changes no step, wait, blocker, intent, counter, charge or `updatedAt`.
 */
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { sameRepository } from "./hosted-autonomy-policy.ts";

/** How long a record whose pull read settled nothing is skipped. */
export const PULL_PROBE_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** When the record's bound pull request was last probed; -Infinity if never. */
export function pullProbedAt(
  record: Pick<WorkRecordV1, "target" | "pullProbe">,
) {
  const probe = record.pullProbe;
  return probe !== undefined && probe.pr === record.target.pr
    ? probe.at
    : Number.NEGATIVE_INFINITY;
}

/** True when the record's bound pull request may be read again at `now`. */
export function pullProbeDue(
  record: Pick<WorkRecordV1, "target" | "pullProbe">,
  now: number,
): boolean {
  const at = pullProbedAt(record);
  return !Number.isFinite(at) || now < at || now - at >= PULL_PROBE_BACKOFF_MS;
}

/** One unsettled pull read to stamp. */
export interface PullProbeStampV1 {
  id: string;
  repository: WorkRecordV1["repository"];
  pr: number;
}

/**
 * Stamp the probes on their records (pure, strict-parsed): only `pullProbe`
 * changes, and only on a record that still binds the probed pull request.
 */
export function applyPullProbes(
  snapshot: RepairStateSnapshotV1,
  probes: readonly PullProbeStampV1[],
  now: number,
): RepairStateSnapshotV1 {
  if (probes.length === 0) return snapshot;
  return parseRepairStateSnapshotV1({
    ...snapshot,
    work: snapshot.work.map((record) => {
      const probe = probes.find((item) =>
        item.id === record.id &&
        sameRepository(item.repository, record.repository) &&
        item.pr === record.target.pr
      );
      return probe === undefined
        ? record
        : { ...record, pullProbe: { pr: probe.pr, at: now } };
    }),
  });
}
