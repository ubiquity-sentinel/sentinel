/**
 * Consecutive deferred upkeep passes, counted by the trusted finalize stage.
 *
 * A bounded self-upkeep pass that defers keeps the run green, so a deferral
 * that never clears would otherwise be silent. On the third consecutive
 * deferral exactly one non-sensitive notice (title, closed reason code, run
 * id; never a URL or body) is published, and none again until a pass that did
 * not defer resets the streak. The streak value is small and bounded; it is
 * written only by the injected trusted writer with an expected-head
 * compare-and-swap, and the notice is published only after that write
 * applied, so a retried or concurrent finalize never notifies twice.
 */

/** The closed upkeep deferral reasons a skipped maintenance result reports. */
export const UPKEEP_DEFERRAL_REASONS = [
  "deferred_historical_quarantine",
  "deferred_matrix_history_budget",
  "deferred_unexpected_error",
] as const;
export type UpkeepDeferralReasonV1 = typeof UPKEEP_DEFERRAL_REASONS[number];

export const UPKEEP_DEFERRAL_NOTICE_THRESHOLD = 3;
/** Bound on the stored count; a longer streak stays at the bound. */
export const UPKEEP_DEFERRAL_STREAK_MAX = 1_000;
export const UPKEEP_DEFERRAL_NOTICE_TITLE =
  "Sentinel upkeep deferred three consecutive runs";

export interface UpkeepDeferralStreakV1 {
  version: 1;
  /** Consecutive deferred passes, at most UPKEEP_DEFERRAL_STREAK_MAX. */
  count: number;
  /** True once this streak's single notice was claimed. */
  notified: boolean;
  /** The last run counted, so a rerun of the same run never double-counts. */
  lastRunId: number | null;
}

export interface UpkeepDeferralObservationV1 {
  runId: number;
  /** The maintenance pass's closed deferral reason, or null when it did not defer. */
  reason: UpkeepDeferralReasonV1 | null;
}

export interface UpkeepDeferralNoticeV1 {
  title: string;
  reason: UpkeepDeferralReasonV1;
  runId: number;
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

/** Non-sensitive notice sink (for example ntfy), injected by the host. */
export interface UpkeepNoticePortV1 {
  publish(notice: UpkeepDeferralNoticeV1): Promise<boolean>;
}

export function isUpkeepDeferralReason(
  value: unknown,
): value is UpkeepDeferralReasonV1 {
  return typeof value === "string" &&
    (UPKEEP_DEFERRAL_REASONS as readonly string[]).includes(value);
}

/** Strict reader: anything but an exact bounded streak reads as absent. */
export function parseUpkeepDeferralStreakV1(
  value: unknown,
): UpkeepDeferralStreakV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.join(",") !== "count,lastRunId,notified,version") return null;
  if (row.version !== 1 || typeof row.notified !== "boolean") return null;
  const count = row.count;
  if (
    typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 ||
    count > UPKEEP_DEFERRAL_STREAK_MAX
  ) return null;
  const lastRunId = row.lastRunId;
  if (
    lastRunId !== null &&
    (typeof lastRunId !== "number" || !Number.isSafeInteger(lastRunId) ||
      lastRunId <= 0)
  ) return null;
  return { version: 1, count, notified: row.notified, lastRunId };
}

const EMPTY: UpkeepDeferralStreakV1 = {
  version: 1,
  count: 0,
  notified: false,
  lastRunId: null,
};

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
        version: 1,
        count: 0,
        notified: false,
        lastRunId: observation.runId,
      },
      notice: null,
    };
  }
  const count = Math.min(current.count + 1, UPKEEP_DEFERRAL_STREAK_MAX);
  const claim = !current.notified && count >= UPKEEP_DEFERRAL_NOTICE_THRESHOLD;
  return {
    next: {
      version: 1,
      count,
      notified: current.notified || claim,
      lastRunId: observation.runId,
    },
    notice: claim
      ? {
        title: UPKEEP_DEFERRAL_NOTICE_TITLE,
        reason: observation.reason,
        runId: observation.runId,
      }
      : null,
  };
}

export type UpkeepDeferralSettlementV1 =
  | { status: "unchanged" | "recorded"; notified: boolean }
  | { status: "invalid" | "unavailable" | "conflict"; notified: false };

/**
 * Finalize hook: read the streak, write the next value under the read head,
 * then publish the claimed notice. A refused write publishes nothing; a
 * failed publish is not retried (the notice is at most once per streak).
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
  const { next, notice } = advanceUpkeepDeferralStreak(prior, {
    runId,
    reason,
  });
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
  let published = false;
  try {
    published = await input.notice.publish(notice);
  } catch {
    published = false;
  }
  return { status: "recorded", notified: published === true };
}
