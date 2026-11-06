/**
 * Throughput watchdog guardrail planner (pure): from the verdicts, the
 * stored watchdog state, one complete open-item listing and the runtime this
 * cycle ran on, decide which issues to create and which to edit.
 *
 * Guardrails, each per threshold unless stated:
 * - one issue per missed threshold, all in the same cycle when allowed;
 * - none while that threshold's watchdog issue is open or an open pull
 *   request references it (another threshold may still be filed);
 * - outcome check after its issue closes: the measurement and runtime at
 *   close are recorded, and the threshold is re-filed only once
 *   `THROUGHPUT_WATCHDOG_OUTCOME_CYCLES` cycles ran on a runtime newer than
 *   the one at close and it is still missed, or at once when the
 *   measurement is more than 10% worse than at close;
 * - an open issue is edited only after its text is 10 cycles old;
 * - at most `THROUGHPUT_WATCHDOG_DAILY_BOUND` creates per UTC day in total.
 */
import {
  EMPTY_THROUGHPUT_WATCHDOG_STATE,
  THROUGHPUT_WATCHDOG_COUNTER_CAP,
  type ThroughputWatchdogRuntimeV2,
  type ThroughputWatchdogStateV2,
} from "../contracts/throughput-watchdog-state.ts";
import {
  type ThroughputCycleIdV1,
  throughputDateV1,
} from "../contracts/throughput-metrics.ts";
import {
  measuredMilliV1,
  type ThroughputVerdictV1,
} from "./throughput-watchdog.ts";
import type { ThroughputThresholdV1 } from "./throughput-watchdog-thresholds.ts";
import {
  THROUGHPUT_WATCHDOG_LABELS,
  THROUGHPUT_WATCHDOG_OUTCOME_CYCLES,
  THROUGHPUT_WATCHDOG_TITLE_PREFIX,
  throughputWatchdogBodyV1,
  type ThroughputWatchdogListingV1,
  throughputWatchdogTitleV1,
} from "./throughput-watchdog-issue.ts";

/** Cycles an open issue's text must age before it is edited. */
export const THROUGHPUT_WATCHDOG_EDIT_CYCLES = 10;
/** Watchdog issues created per UTC day, all thresholds together. */
export const THROUGHPUT_WATCHDOG_DAILY_BOUND = 3;

export type ThroughputWatchdogActionV1 =
  | {
    kind: "create";
    thresholdId: string;
    title: string;
    body: string;
    labels: readonly string[];
    measuredMilli: number;
  }
  | {
    kind: "edit";
    thresholdId: string;
    number: number;
    title: string;
    body: string;
    measuredMilli: number;
  };

export type ThroughputWatchdogBlockV1 =
  | "open_watchdog_issue"
  | "open_pull_request"
  | "outcome_pending"
  | "daily_bound";

export interface ThroughputWatchdogPlanV1 {
  /** The state to record once the actions settle (filings applied later). */
  state: ThroughputWatchdogStateV2;
  actions: ThroughputWatchdogActionV1[];
  /** Why each missed, unfiled threshold was not filed. */
  blocked: Record<string, ThroughputWatchdogBlockV1>;
  /**
   * Summary: `nothing_missed`; else `daily_bound` when that bound refused
   * any threshold; else the first refusal in table order; null when every
   * missed threshold was filed.
   */
  createBlocked: ThroughputWatchdogBlockV1 | "nothing_missed" | null;
}

/** More than 10% higher (worse: every limit is measured <= limit). */
export function measuredWorseV1(atClose: number, next: number): boolean {
  if (atClose === 0) return next > 0;
  return (next - atClose) * 10 > atClose;
}

/** A strictly later generation on a different SHA. */
export function runtimeNewerV1(
  current: ThroughputWatchdogRuntimeV2,
  atClose: ThroughputWatchdogRuntimeV2,
): boolean {
  return current.generation > atClose.generation && current.sha !== atClose.sha;
}

const bump = (value: number) =>
  Math.min(value + 1, THROUGHPUT_WATCHDOG_COUNTER_CAP);

/** Decide this cycle's watchdog actions. Pure. */
export function planThroughputWatchdogV1(input: {
  verdicts: readonly ThroughputVerdictV1[];
  thresholds: readonly ThroughputThresholdV1[];
  state: ThroughputWatchdogStateV2 | null;
  listing: ThroughputWatchdogListingV1;
  cycle: ThroughputCycleIdV1;
  /** The runtime this cycle ran on; null when unknown. */
  runtime: ThroughputWatchdogRuntimeV2 | null;
  nowMs: number;
}): ThroughputWatchdogPlanV1 {
  const prior = input.state ?? EMPTY_THROUGHPUT_WATCHDOG_STATE;
  const table = new Map(input.thresholds.map((row) => [row.id, row]));
  const byId = new Map(input.verdicts.map((verdict) => [verdict.id, verdict]));
  const thresholds = structuredClone(prior.thresholds);
  // Only ids in the table are remembered, which bounds the stored state.
  for (const id of Object.keys(thresholds)) {
    if (!table.has(id)) delete thresholds[id];
  }
  const openNumbers = new Set(input.listing.issues.map((row) => row.number));
  // The lowest open issue per threshold is the one edited and remembered.
  const openById = new Map<string, (typeof input.listing.issues)[number]>();
  for (
    const row of [...input.listing.issues].sort((a, b) => a.number - b.number)
  ) {
    if (!openById.has(row.thresholdId)) openById.set(row.thresholdId, row);
  }
  const verdictMilli = (id: string) => {
    const verdict = byId.get(id);
    return verdict === undefined ? null : measuredMilliV1(verdict);
  };
  for (const [id, entry] of Object.entries(thresholds)) {
    if (entry.closed !== null) {
      // Outcome progress: a baseline once the runtime is known, then count.
      const closed = entry.closed;
      if (input.runtime !== null) {
        if (closed.runtime === null) closed.runtime = input.runtime;
        else if (runtimeNewerV1(input.runtime, closed.runtime)) {
          closed.newerCycles = bump(closed.newerCycles);
        }
      }
    } else if (!openNumbers.has(entry.issue)) {
      entry.closed = {
        atMs: input.nowMs,
        measuredMilli: verdictMilli(id) ?? entry.measuredMilli,
        runtime: input.runtime,
        newerCycles: 0,
      };
    } else {
      entry.cyclesSinceText = bump(entry.cyclesSinceText);
    }
  }
  for (const [id, row] of openById) {
    if (!table.has(id)) continue;
    const entry = thresholds[id];
    if (entry === undefined || entry.issue !== row.number) {
      // Adopted: a filing whose state write was lost, or a reopened issue;
      // its text is unknown, so it is refreshed once.
      thresholds[id] = {
        issue: row.number,
        measuredMilli: null,
        filedAtMs: input.nowMs,
        cyclesSinceText: 0,
        closed: null,
      };
    } else if (entry.closed !== null) {
      thresholds[id] = { ...entry, closed: null, cyclesSinceText: 0 };
    }
  }
  const actions: ThroughputWatchdogActionV1[] = [];
  const missed = (verdict: ThroughputVerdictV1 | undefined) =>
    verdict !== undefined && !verdict.informational &&
    verdict.verdict === "missed" && measuredMilliV1(verdict) !== null;
  for (const [id, row] of openById) {
    const verdict = byId.get(id);
    const threshold = table.get(id);
    const entry = thresholds[id];
    if (
      !row.appAuthored || threshold === undefined || entry === undefined ||
      !missed(verdict) ||
      (entry.measuredMilli !== null &&
        entry.cyclesSinceText < THROUGHPUT_WATCHDOG_EDIT_CYCLES)
    ) continue;
    actions.push({
      kind: "edit",
      thresholdId: id,
      number: row.number,
      title: throughputWatchdogTitleV1(verdict!),
      body: throughputWatchdogBodyV1(verdict!, threshold, input.cycle),
      measuredMilli: measuredMilliV1(verdict!)!,
    });
  }
  const today = throughputDateV1(input.nowMs);
  const daily = prior.daily !== null && prior.daily.date === today
    ? { ...prior.daily }
    : { date: today, filed: 0 };
  const blocked: Record<string, ThroughputWatchdogBlockV1> = {};
  const candidates = input.thresholds.filter((threshold) =>
    missed(byId.get(threshold.id))
  );
  for (const threshold of candidates) {
    const id = threshold.id;
    const verdict = byId.get(id)!;
    const measured = measuredMilliV1(verdict)!;
    const entry = thresholds[id];
    const known = new Set<number>(
      [entry?.issue, openById.get(id)?.number].filter((n) =>
        n !== undefined
      ) as number[],
    );
    const ownTitle = `${THROUGHPUT_WATCHDOG_TITLE_PREFIX}${threshold.name} `;
    if (openById.has(id)) {
      blocked[id] = "open_watchdog_issue";
    } else if (
      input.listing.pulls.some((pull) =>
        pull.title.startsWith(ownTitle) ||
        pull.references.some((number) => known.has(number))
      )
    ) {
      blocked[id] = "open_pull_request";
    } else if (
      entry?.closed != null &&
      entry.closed.newerCycles < THROUGHPUT_WATCHDOG_OUTCOME_CYCLES &&
      !(entry.closed.measuredMilli !== null &&
        measuredWorseV1(entry.closed.measuredMilli, measured))
    ) {
      blocked[id] = "outcome_pending";
    } else if (daily.filed >= THROUGHPUT_WATCHDOG_DAILY_BOUND) {
      blocked[id] = "daily_bound";
    } else {
      // Counted when attempted: an unproven create may still have landed.
      daily.filed++;
      actions.push({
        kind: "create",
        thresholdId: id,
        title: throughputWatchdogTitleV1(verdict),
        body: throughputWatchdogBodyV1(verdict, threshold, input.cycle),
        labels: THROUGHPUT_WATCHDOG_LABELS,
        measuredMilli: measured,
      });
    }
  }
  const reasons = candidates.flatMap((threshold) =>
    blocked[threshold.id] === undefined ? [] : [blocked[threshold.id]]
  );
  const createBlocked: ThroughputWatchdogPlanV1["createBlocked"] =
    candidates.length === 0
      ? "nothing_missed"
      : reasons.includes("daily_bound")
      ? "daily_bound"
      : reasons[0] ?? null;
  return {
    state: {
      version: 2,
      lastCycle: { runId: input.cycle.runId, attempt: input.cycle.attempt },
      daily,
      thresholds,
    },
    actions,
    blocked,
    createBlocked,
  };
}
