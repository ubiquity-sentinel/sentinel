/**
 * Throughput watchdog finalize fakes: a metrics sidecar with the store's CAS
 * semantics, a self-repository issue tracker, and a one-cycle runner.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { ThroughputMetricsRecordV1 } from "../../src/contracts/throughput-metrics.ts";
import type { ThroughputWatchdogRuntimeV2 } from "../../src/contracts/throughput-watchdog-state.ts";
import {
  parseThroughputWatchdogMarkerV1,
  referencedIssueNumbersV1,
  type ThroughputWatchdogIssuesV1,
} from "../../src/host/throughput-watchdog-issue.ts";
import { runFinalizeThroughputWatchdogV1 } from "../../src/host/throughput-watchdog-finalize.ts";
import {
  decodeThroughputLedgerV1,
  encodeThroughputLedgerV1,
  type ThroughputMetricsLedgerV1,
} from "../../src/state/throughput-metrics-ledger.ts";
import type { ThroughputMetricsPortV1 } from "../../src/state/throughput-metrics-store.ts";
import { cycles, NOW } from "./throughput-watchdog-helpers.ts";

export const DAY = 86_400_000;
export const APP = "ubiquity-sentinel[bot]";

export function fakeMetrics(records: ThroughputMetricsRecordV1[]) {
  let head: GitSha | null = "f".repeat(40) as GitSha;
  const port = {
    ledger: { records, daily: [] } as ThroughputMetricsLedgerV1,
    writes: 0,
    failRead: false,
    read() {
      if (port.failRead) return Promise.resolve(portError("unavailable", "x"));
      return Promise.resolve(portOk({ head, ledger: port.ledger }));
    },
    write(
      input: { expectedHead: GitSha | null; ledger: ThroughputMetricsLedgerV1 },
    ) {
      if (input.expectedHead !== head) {
        return Promise.resolve(portOk({ status: "conflict" as const, head }));
      }
      // The real store re-decodes what it commits.
      decodeThroughputLedgerV1(encodeThroughputLedgerV1(input.ledger));
      port.writes++;
      port.ledger = input.ledger;
      head = `${port.writes}`.padStart(40, "0") as GitSha;
      return Promise.resolve(portOk({ status: "applied" as const, head }));
    },
  };
  return port satisfies ThroughputMetricsPortV1;
}

export interface Item {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
  state: "open" | "closed";
  author: string;
  pull: boolean;
}

export function fakeTracker(items: Item[] = []) {
  const tracker = {
    items,
    lists: 0,
    creates: [] as Item[],
    updates: [] as Array<{ number: number; title: string; body: string }>,
    createResult: "ok" as "ok" | "null",
    throwOnList: false,
    hangList: false,
    next: 100,
    listOpen() {
      tracker.lists++;
      if (tracker.throwOnList) throw new Error("boom");
      if (tracker.hangList) return new Promise<never>(() => {});
      const open = tracker.items.filter((item) => item.state === "open");
      return Promise.resolve({
        issues: open.flatMap((item) => {
          const id = item.pull
            ? null
            : parseThroughputWatchdogMarkerV1(item.body);
          return id === null ? [] : [{
            number: item.number,
            thresholdId: id,
            appAuthored: item.author === APP,
          }];
        }),
        pulls: open.filter((item) => item.pull).map((item) => ({
          number: item.number,
          title: item.title,
          references: referencedIssueNumbersV1(`${item.title}\n${item.body}`),
        })),
      });
    },
    create(input: { title: string; body: string; labels: readonly string[] }) {
      const item: Item = {
        number: tracker.next++,
        ...input,
        state: "open",
        author: APP,
        pull: false,
      };
      tracker.items.push(item);
      tracker.creates.push(item);
      return Promise.resolve(
        tracker.createResult === "ok" ? item.number : null,
      );
    },
    update(number: number, input: { title: string; body: string }) {
      const item = tracker.items.find((row) => row.number === number);
      if (item === undefined) return Promise.resolve(false);
      item.title = input.title;
      item.body = input.body;
      tracker.updates.push({ number, ...input });
      return Promise.resolve(true);
    },
  };
  return tracker satisfies ThroughputWatchdogIssuesV1;
}

/** 30 cycles whose maintenance+repair median is `minutes`. */
export const slow = (minutes: number, base = 1000) =>
  cycles(
    30,
    () => ({ maintenanceMin: minutes - 2, repairMin: 2 }),
    NOW,
    5 * 60_000,
    base,
  );

/** The same 30 cycles, each also planning nothing while work is ready. */
export function slowAndUnplanned(minutes: number, base = 1000) {
  const records = slow(minutes, base);
  for (const record of records) {
    record.counts.cellsPlanned = 0;
    record.counts.readyRecordsNotPlanned = 4;
  }
  return records;
}

/** A runtime identity: generation `g` on a SHA derived from it. */
export const runtime = (g: number): ThroughputWatchdogRuntimeV2 => ({
  generation: g,
  sha: g.toString(16).padStart(40, "a"),
});

export function run(
  metrics: ReturnType<typeof fakeMetrics>,
  issues: ReturnType<typeof fakeTracker>,
  runId: number,
  nowMs = NOW,
  enabled = true,
  at: ThroughputWatchdogRuntimeV2 | null = null,
) {
  const lines: string[] = [];
  return runFinalizeThroughputWatchdogV1(
    { metrics, issues, log: (line) => lines.push(line) },
    { cycle: { runId, attempt: 1 }, record: null, runtime: at, nowMs, enabled },
  ).then((result) => ({ result, lines }));
}
