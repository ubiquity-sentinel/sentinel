/**
 * Finalize wiring for the consecutive upkeep deferral streak (#327).
 *
 * The maintenance job publishes `upkeepDeferral` (a closed deferral reason or
 * `none`); finalize reads it from `SENTINEL_UPKEEP_DEFERRAL`, advances the
 * streak stored as one small file on the metrics sidecar ref (the same
 * trusted writer and expected-head write as the throughput record, never the
 * strict repair snapshot), and on the third consecutive deferral (then once
 * per three further deferrals) publishes one notice through the injected
 * port. The production port is the owner issue adapter with the log adapter
 * as its fallback (`upkeep-deferral-issue.ts`).
 *
 * Advisory: bounded, never throws and never changes the finalize outcome.
 */
import { createDeadline } from "../github/http.ts";
import {
  isUpkeepDeferralReason,
  settleUpkeepDeferralStreak,
  type UpkeepDeferralReasonV1,
  type UpkeepDeferralSettlementV1,
  type UpkeepDeferralStreakStoreV1,
  type UpkeepNoticePortV1,
} from "../contracts/upkeep-deferral-streak.ts";
import type { ThroughputMetricsLedgerV1 } from "../state/throughput-metrics-ledger.ts";
import type { ThroughputMetricsPortV1 } from "../state/throughput-metrics-store.ts";

export {
  fallbackUpkeepNoticePort,
  issueUpkeepNoticePort,
  logUpkeepNoticePort,
} from "./upkeep-deferral-issue.ts";

export const UPKEEP_DEFERRAL_ENV = "SENTINEL_UPKEEP_DEFERRAL";
export const FINALIZE_UPKEEP_BUDGET_MS = 30_000;

/**
 * The maintenance observation: a closed reason, `null` for a pass that did
 * not defer, or `undefined` when maintenance published nothing usable (the
 * streak is then left untouched rather than reset).
 */
export function parseUpkeepDeferralObservation(
  value: string | undefined,
): UpkeepDeferralReasonV1 | null | undefined {
  if (value === "none") return null;
  return isUpkeepDeferralReason(value) ? value : undefined;
}

/** Streak store over the metrics sidecar; writes keep every other file. */
export function metricsUpkeepStreakStore(
  port: ThroughputMetricsPortV1,
): UpkeepDeferralStreakStoreV1 {
  let held: { head: string | null; ledger: ThroughputMetricsLedgerV1 } | null =
    null;
  return {
    async read() {
      const read = await port.read();
      if (!read.ok) return null;
      held = read.value;
      return {
        head: read.value.head,
        streak: read.value.ledger.upkeepStreak ?? null,
      };
    },
    async write(next, expectedHead) {
      if (held === null || held.head !== expectedHead) return "conflict";
      const written = await port.write({
        expectedHead: held.head as Parameters<
          ThroughputMetricsPortV1["write"]
        >[0]["expectedHead"],
        ledger: { ...held.ledger, upkeepStreak: next },
      });
      held = null;
      if (!written.ok) return "unavailable";
      if (written.value.status === "applied") return "applied";
      // An ambiguous push is never treated as applied: no notice is sent.
      return written.value.status === "conflict" ? "conflict" : "unavailable";
    },
  };
}

export interface FinalizeUpkeepDeferralDepsV1 {
  store: UpkeepDeferralStreakStoreV1;
  notice: UpkeepNoticePortV1;
  log?: (line: string) => void;
}

/** Settle one finalize observation under a bound. Never throws. */
export async function runFinalizeUpkeepDeferral(
  deps: FinalizeUpkeepDeferralDepsV1,
  input: { runId: number; observation: string | undefined; nowMs?: number },
): Promise<
  UpkeepDeferralSettlementV1 | { status: "unobserved"; notified: false }
> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const reason = parseUpkeepDeferralObservation(input.observation);
  let result: Awaited<ReturnType<typeof runFinalizeUpkeepDeferral>>;
  if (reason === undefined) {
    result = { status: "unobserved", notified: false };
  } else {
    const deadline = createDeadline(FINALIZE_UPKEEP_BUDGET_MS);
    try {
      result = await deadline.race(settleUpkeepDeferralStreak({
        store: deps.store,
        notice: deps.notice,
        observation: {
          runId: input.runId,
          reason,
          ...(input.nowMs === undefined ? {} : { atMs: input.nowMs }),
        },
      }));
    } catch {
      result = { status: "unavailable", notified: false };
    } finally {
      deadline.dispose();
    }
  }
  log(JSON.stringify({
    kind: "sentinel_upkeep_deferral_streak",
    runId: input.runId,
    status: result.status,
    notified: result.notified,
    adapter: "adapter" in result && result.adapter !== undefined
      ? result.adapter
      : null,
  }));
  return result;
}
