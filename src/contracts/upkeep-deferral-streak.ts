/**
 * Consecutive deferred upkeep passes, counted by the trusted finalize stage.
 *
 * A bounded self-upkeep pass that defers keeps the run green, so a deferral
 * that never clears would otherwise be silent. On the third consecutive
 * deferral one non-sensitive notice (counts, closed reason codes, run ids and
 * the streak start; never a URL or body) is claimed, and a further notice
 * only after the streak grew by three more, until a pass that did not defer
 * resets the streak. The streak value is small and bounded; it is written
 * only by the injected trusted writer with an expected-head compare-and-swap,
 * and a notice is published only after that write applied, so a retried or
 * concurrent finalize never claims the same notice twice.
 */

/** The closed upkeep deferral reasons a skipped maintenance result reports. */
export const UPKEEP_DEFERRAL_REASONS = [
  "deferred_historical_quarantine",
  "deferred_matrix_history_budget",
  "deferred_unexpected_error",
] as const;
export type UpkeepDeferralReasonV1 = typeof UPKEEP_DEFERRAL_REASONS[number];

export const UPKEEP_DEFERRAL_NOTICE_THRESHOLD = 3;
/** A further notice (an issue edit) only after the streak grew this much. */
export const UPKEEP_DEFERRAL_NOTICE_STEP = 3;
/** Bound on the stored count; a longer streak stays at the bound. */
export const UPKEEP_DEFERRAL_STREAK_MAX = 1_000;
/** Bound on the run ids kept for a streak; the most recent are kept. */
export const UPKEEP_DEFERRAL_RUN_IDS_MAX = 30;

/** The notice title for a streak of `count` consecutive deferrals. */
export function upkeepDeferralNoticeTitle(count: number): string {
  return `Upkeep deferred for ${count} consecutive supervisor cycles`;
}

/**
 * The stored streak. Version 2 adds the streak's run ids, reasons and start
 * instant, the count at which its last notice was claimed (`noticeCount`)
 * and the owner issue number, which survives a reset so the next streak
 * reuses that issue while it is open. A version 1 file is lifted on read.
 */
export interface UpkeepDeferralStreakV1 {
  version: 2;
  /** Consecutive deferred passes, at most UPKEEP_DEFERRAL_STREAK_MAX. */
  count: number;
  /** The last run counted, so a rerun of the same run never double-counts. */
  lastRunId: number | null;
  /** The count at which this streak's last notice was claimed, if any. */
  noticeCount: number | null;
  /** The streak's most recent run ids, oldest first. */
  runIds: number[];
  /** The distinct closed reasons seen in this streak, first seen first. */
  reasons: UpkeepDeferralReasonV1[];
  /** The finalize instant of the streak's first deferral, when recorded. */
  startedAtMs: number | null;
  /** The owner issue a notice last reached; kept across resets. */
  issueNumber: number | null;
}

export interface UpkeepDeferralObservationV1 {
  runId: number;
  /** The maintenance pass's closed deferral reason, or null when it did not defer. */
  reason: UpkeepDeferralReasonV1 | null;
  /** The finalize instant; absent leaves the streak start unrecorded. */
  atMs?: number;
}

/** Non-sensitive: counts, closed reason codes, run ids and one instant. */
export interface UpkeepDeferralNoticeV1 {
  title: string;
  reason: UpkeepDeferralReasonV1;
  runId: number;
  count: number;
  reasons: UpkeepDeferralReasonV1[];
  runIds: number[];
  startedAtMs: number | null;
  /** The issue recorded for reuse; the adapter re-checks that it is open. */
  issueNumber: number | null;
}

/** Trusted expected-head store for the streak; never a model worker. */
export interface UpkeepDeferralStreakStoreV1 {
  /** `head` is null while the surface does not exist yet. */
  read(): Promise<
    { head: string | null; streak: UpkeepDeferralStreakV1 | null } | null
  >;
  write(
    next: UpkeepDeferralStreakV1,
    expectedHead: string | null,
  ): Promise<"applied" | "conflict" | "unavailable">;
}

/** Which adapter delivered a notice, and the owner issue it reached. */
export interface UpkeepNoticeDeliveryV1 {
  adapter: "issue" | "log";
  issueNumber: number | null;
}

/** Non-sensitive notice sink injected by the host; null is undelivered. */
export interface UpkeepNoticePortV1 {
  publish(
    notice: UpkeepDeferralNoticeV1,
  ): Promise<UpkeepNoticeDeliveryV1 | null>;
}

export function isUpkeepDeferralReason(
  value: unknown,
): value is UpkeepDeferralReasonV1 {
  return typeof value === "string" &&
    (UPKEEP_DEFERRAL_REASONS as readonly string[]).includes(value);
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= UPKEEP_DEFERRAL_STREAK_MAX;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The exact version 1 shape, lifted to version 2 (no issue recorded). */
function liftVersion1(
  row: Record<string, unknown>,
): UpkeepDeferralStreakV1 | null {
  if (
    Object.keys(row).sort().join(",") !== "count,lastRunId,notified,version"
  ) {
    return null;
  }
  const { count, lastRunId, notified } = row;
  if (
    typeof notified !== "boolean" || !isCount(count) ||
    (lastRunId !== null && !isPositiveId(lastRunId))
  ) return null;
  return {
    version: 2,
    count,
    lastRunId,
    noticeCount: notified && count > 0 ? count : null,
    runIds: count > 0 && lastRunId !== null ? [lastRunId] : [],
    reasons: [],
    startedAtMs: null,
    issueNumber: null,
  };
}

const V2_KEYS =
  "count,issueNumber,lastRunId,noticeCount,reasons,runIds,startedAtMs,version";

/**
 * Strict reader: an exact bounded version 2 streak, or an exact version 1
 * streak lifted to version 2; anything else reads as absent.
 */
export function parseUpkeepDeferralStreakV1(
  value: unknown,
): UpkeepDeferralStreakV1 | null {
  const row = record(value);
  if (row === null) return null;
  if (row.version === 1) return liftVersion1(row);
  if (row.version !== 2 || Object.keys(row).sort().join(",") !== V2_KEYS) {
    return null;
  }
  const { count, lastRunId, noticeCount, runIds, reasons, startedAtMs } = row;
  const issueNumber = row.issueNumber;
  if (
    !isCount(count) || (lastRunId !== null && !isPositiveId(lastRunId)) ||
    (issueNumber !== null && !isPositiveId(issueNumber)) ||
    (noticeCount !== null &&
      (!isCount(noticeCount) ||
        noticeCount < UPKEEP_DEFERRAL_NOTICE_THRESHOLD ||
        noticeCount > count)) ||
    (startedAtMs !== null &&
      (typeof startedAtMs !== "number" || !Number.isSafeInteger(startedAtMs) ||
        startedAtMs < 0)) ||
    !Array.isArray(runIds) || runIds.length > UPKEEP_DEFERRAL_RUN_IDS_MAX ||
    runIds.length > count || !runIds.every(isPositiveId) ||
    new Set(runIds).size !== runIds.length ||
    !Array.isArray(reasons) || !reasons.every(isUpkeepDeferralReason) ||
    new Set(reasons).size !== reasons.length ||
    (count === 0 &&
      (runIds.length > 0 || reasons.length > 0 || startedAtMs !== null))
  ) return null;
  return {
    version: 2,
    count,
    lastRunId,
    noticeCount,
    runIds: [...runIds],
    reasons: [...reasons],
    startedAtMs,
    issueNumber,
  };
}

const EMPTY: UpkeepDeferralStreakV1 = {
  version: 2,
  count: 0,
  lastRunId: null,
  noticeCount: null,
  runIds: [],
  reasons: [],
  startedAtMs: null,
  issueNumber: null,
};

function noticeDue(count: number, noticeCount: number | null): boolean {
  if (count < UPKEEP_DEFERRAL_NOTICE_THRESHOLD) return false;
  return noticeCount === null ||
    count - noticeCount >= UPKEEP_DEFERRAL_NOTICE_STEP;
}

/** Pure transition: the next streak and the one notice it claims, if any. */
export function advanceUpkeepDeferralStreak(
  prior: UpkeepDeferralStreakV1 | null,
  observation: UpkeepDeferralObservationV1,
): { next: UpkeepDeferralStreakV1; notice: UpkeepDeferralNoticeV1 | null } {
  const current = prior ?? EMPTY;
  if (current.lastRunId === observation.runId) {
    return { next: current, notice: null };
  }
  if (observation.reason === null) {
    return {
      next: {
        ...EMPTY,
        lastRunId: observation.runId,
        issueNumber: current.issueNumber,
      },
      notice: null,
    };
  }
  const count = Math.min(current.count + 1, UPKEEP_DEFERRAL_STREAK_MAX);
  const claim = noticeDue(count, current.noticeCount);
  const atMs = observation.atMs;
  const startedAtMs = current.count === 0
    ? (Number.isSafeInteger(atMs) && (atMs as number) >= 0
      ? atMs as number
      : null)
    : current.startedAtMs;
  const runIds = [
    ...current.runIds.filter((id) => id !== observation.runId),
    observation.runId,
  ].slice(-UPKEEP_DEFERRAL_RUN_IDS_MAX);
  const reasons = current.reasons.includes(observation.reason)
    ? current.reasons
    : [...current.reasons, observation.reason];
  const next: UpkeepDeferralStreakV1 = {
    version: 2,
    count,
    lastRunId: observation.runId,
    noticeCount: claim ? count : current.noticeCount,
    runIds,
    reasons,
    startedAtMs,
    issueNumber: current.issueNumber,
  };
  return {
    next,
    notice: claim
      ? {
        title: upkeepDeferralNoticeTitle(count),
        reason: observation.reason,
        runId: observation.runId,
        count,
        reasons: [...reasons],
        runIds: [...runIds],
        startedAtMs,
        issueNumber: current.issueNumber,
      }
      : null,
  };
}

export type UpkeepDeferralSettlementV1 =
  | {
    status: "unchanged" | "recorded";
    notified: boolean;
    adapter?: UpkeepNoticeDeliveryV1["adapter"];
  }
  | { status: "invalid" | "unavailable" | "conflict"; notified: false };

/**
 * Record the delivered issue number on the streak this run wrote, under a
 * fresh read. A refusal leaves it unrecorded; the adapter re-finds the issue
 * by its marker on the next notice.
 */
async function recordIssueNumber(
  store: UpkeepDeferralStreakStoreV1,
  runId: number,
  issueNumber: number,
): Promise<void> {
  try {
    const read = await store.read();
    if (read === null || read.streak === null) return;
    const streak = parseUpkeepDeferralStreakV1(read.streak);
    if (streak === null || streak.lastRunId !== runId) return;
    if (streak.issueNumber === issueNumber) return;
    await store.write({ ...streak, issueNumber }, read.head);
  } catch {
    // Advisory: the marker lookup is the durable fallback.
  }
}

/**
 * Finalize hook: read the streak, write the next value under the read head,
 * then publish the claimed notice. A refused write publishes nothing; a
 * failed publish is not retried (each notice is claimed at most once).
 */
export async function settleUpkeepDeferralStreak(input: {
  store: UpkeepDeferralStreakStoreV1;
  notice: UpkeepNoticePortV1;
  observation: UpkeepDeferralObservationV1;
}): Promise<UpkeepDeferralSettlementV1> {
  const { runId, reason } = input.observation;
  if (
    !Number.isSafeInteger(runId) || runId <= 0 ||
    (reason !== null && !isUpkeepDeferralReason(reason))
  ) return { status: "invalid", notified: false };
  let read: Awaited<ReturnType<UpkeepDeferralStreakStoreV1["read"]>>;
  try {
    read = await input.store.read();
  } catch {
    read = null;
  }
  if (read === null) return { status: "unavailable", notified: false };
  const prior = read.streak === null
    ? null
    : parseUpkeepDeferralStreakV1(read.streak);
  const { next, notice } = advanceUpkeepDeferralStreak(
    prior,
    input.observation,
  );
  if (prior !== null && next === prior) {
    return { status: "unchanged", notified: false };
  }
  let written: "applied" | "conflict" | "unavailable";
  try {
    written = await input.store.write(next, read.head);
  } catch {
    written = "unavailable";
  }
  if (written !== "applied") return { status: written, notified: false };
  if (notice === null) return { status: "recorded", notified: false };
  let delivery: UpkeepNoticeDeliveryV1 | null = null;
  try {
    delivery = await input.notice.publish(notice);
  } catch {
    delivery = null;
  }
  if (delivery === null) return { status: "recorded", notified: false };
  if (
    delivery.issueNumber !== null && delivery.issueNumber !== next.issueNumber
  ) {
    await recordIssueNumber(input.store, runId, delivery.issueNumber);
  }
  return { status: "recorded", notified: true, adapter: delivery.adapter };
}
