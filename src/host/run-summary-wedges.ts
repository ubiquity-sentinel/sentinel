/**
 * Wedge report v0 for the finalize run summary (2026-10-25 redesign, C5.5).
 *
 * Report-only: it reads the repair snapshot and names the records that can
 * hold or loop without an executor, so a run that "succeeded" while work sat
 * wedged says so (`degraded`). Three classes:
 * - `holder_not_runnable`: a record holding its repository's delivery line
 *   (`holdsDeliveryLine`) that cannot itself move now (an unexpired wait other
 *   than CI actually running, or an implementation in flight) while another
 *   published record of that repository waits;
 * - `open_ended_wait`: `until: null` on a row that is neither blocked nor done,
 *   outside the allowlisted marker shapes (a `backoff` hold: the queue hold,
 *   the base-satisfaction markers, the takeover hold; an `unavailable` wait at
 *   `delivery`: the deferred release);
 * - `stalled`: `counters.stalled >= WEDGE_STALLED_THRESHOLD` on a live row,
 *   except a delivered row whose release request is recorded (it waits on the
 *   disabled release path, a park with a named external exit).
 * It decides nothing, writes nothing and grants no authority.
 */
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { holdsDeliveryLine } from "../repair/delivery-queue.ts";
import { releaseRequestMatchesDelivery } from "../repair/loop-records.ts";

/** No-progress executions from which a live row is reported as stalled. */
export const WEDGE_STALLED_THRESHOLD = 24;

/** Record ids listed per class at most. */
export const WEDGE_SAMPLE_LIMIT = 5;

export type WedgeClassV0 =
  | "holder_not_runnable"
  | "open_ended_wait"
  | "stalled";

export const WEDGE_CLASSES: readonly WedgeClassV0[] = [
  "holder_not_runnable",
  "open_ended_wait",
  "stalled",
];

export interface WedgeReportV0 {
  version: "v0";
  /** Distinct records in at least one class. */
  total: number;
  classes: Record<WedgeClassV0, { count: number; samples: string[] }>;
}

type WedgeSnapshot = Pick<
  RepairStateSnapshotV1,
  "work" | "reservations" | "releaseRequests" | "reviews"
>;

const live = (record: WorkRecordV1) =>
  record.nextStep === "work" || record.nextStep === "review" ||
  record.nextStep === "delivery";

/**
 * True when the record can move in this run: no wait, an expired one, or CI
 * actually running (`ci_pending`), and no implementation in flight. Reasons
 * and intents only, never how long a wait lasts.
 */
export function runnableNow(record: WorkRecordV1, now: number): boolean {
  if (!live(record) || record.intent?.kind === "implementation") return false;
  const wait = record.wait;
  return wait === null || wait.reason === "ci_pending" ||
    (wait.until !== null && wait.until <= now);
}

/** The allowlisted `until: null` marker shapes (see the module). */
export function allowlistedOpenEndedWait(record: WorkRecordV1): boolean {
  const wait = record.wait;
  if (wait === null || wait.until !== null) return true;
  return wait.reason === "backoff" ||
    (wait.reason === "unavailable" && record.nextStep === "delivery");
}

function releaseDeferred(snapshot: WedgeSnapshot, record: WorkRecordV1) {
  return snapshot.releaseRequests.some((request) =>
    releaseRequestMatchesDelivery(request, record)
  );
}

const slugOf = (record: WorkRecordV1) =>
  `${record.repository.owner}/${record.repository.name}`;

/** The wedge report of one repair snapshot at `now` (pure). */
export function detectWedgesV0(
  snapshot: WedgeSnapshot,
  now: number,
): WedgeReportV0 {
  const members: Record<WedgeClassV0, string[]> = {
    holder_not_runnable: [],
    open_ended_wait: [],
    stalled: [],
  };
  const published = new Map<string, number>();
  for (const record of snapshot.work) {
    if (live(record) && record.target.pr !== null) {
      published.set(slugOf(record), (published.get(slugOf(record)) ?? 0) + 1);
    }
  }
  for (const record of snapshot.work) {
    if (!live(record)) continue;
    if (
      holdsDeliveryLine(snapshot, record, now) && !runnableNow(record, now) &&
      (published.get(slugOf(record)) ?? 0) > 1
    ) members.holder_not_runnable.push(record.id);
    if (!allowlistedOpenEndedWait(record)) {
      members.open_ended_wait.push(record.id);
    }
    if (
      (record.counters.stalled ?? 0) >= WEDGE_STALLED_THRESHOLD &&
      !releaseDeferred(snapshot, record)
    ) members.stalled.push(record.id);
  }
  const distinct = new Set(WEDGE_CLASSES.flatMap((name) => members[name]));
  const classes = {} as WedgeReportV0["classes"];
  for (const name of WEDGE_CLASSES) {
    classes[name] = {
      count: members[name].length,
      samples: [...members[name]].sort().slice(0, WEDGE_SAMPLE_LIMIT),
    };
  }
  return { version: "v0", total: distinct.size, classes };
}

/** One plain sentence naming the wedge counts, for the summary's next action. */
export function wedgeSentence(report: WedgeReportV0): string {
  const parts = WEDGE_CLASSES.filter((name) => report.classes[name].count > 0)
    .map((name) =>
      `${report.classes[name].count} ${name.replaceAll("_", " ")}`
    );
  return `${report.total} record${
    report.total === 1 ? "" : "s"
  } cannot progress (${parts.join(", ")})`;
}
