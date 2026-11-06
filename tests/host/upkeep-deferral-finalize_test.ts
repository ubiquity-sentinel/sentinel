import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { runHostedSupervisorHost } from "../../src/host/actions-supervisor-host.ts";
import {
  logUpkeepNoticePort,
  metricsUpkeepStreakStore,
  parseUpkeepDeferralObservation,
  UPKEEP_DEFERRAL_ENV,
} from "../../src/host/upkeep-deferral-finalize.ts";
import {
  decodeThroughputLedgerV1,
  EMPTY_THROUGHPUT_LEDGER,
  encodeThroughputLedgerV1,
  THROUGHPUT_UPKEEP_STREAK_PATH,
  type ThroughputMetricsLedgerV1,
} from "../../src/state/throughput-metrics-ledger.ts";
import type { ThroughputMetricsPortV1 } from "../../src/state/throughput-metrics-store.ts";
import { LAUNCHER, makeRig, ROOT } from "./actions-supervisor-fixture.ts";
import { exited, hostedEnv } from "./hosted-runtime-fixture.ts";

/**
 * Fake of the metrics sidecar with the store's expected-head semantics; every
 * write round-trips through the strict file encoding the Git store commits.
 */
function fakeMetricsPort(): ThroughputMetricsPortV1 & {
  ledger: ThroughputMetricsLedgerV1;
  writes: number;
} {
  let head: GitSha | null = null;
  const port = {
    ledger: EMPTY_THROUGHPUT_LEDGER as ThroughputMetricsLedgerV1,
    writes: 0,
    read: () => Promise.resolve(portOk({ head, ledger: port.ledger })),
    write: ({ expectedHead, ledger }: {
      expectedHead: GitSha | null;
      ledger: ThroughputMetricsLedgerV1;
    }) => {
      if (expectedHead !== head) {
        return Promise.resolve(portOk({ status: "conflict" as const, head }));
      }
      port.writes++;
      port.ledger = decodeThroughputLedgerV1(encodeThroughputLedgerV1(ledger));
      head = `${port.writes}`.padStart(40, "0") as GitSha;
      return Promise.resolve(portOk({ status: "applied" as const, head }));
    },
  };
  return port;
}

Deno.test("finalize host: third consecutive deferral claims one notice; a non-deferred pass resets", async () => {
  const rig = await makeRig();
  const port = fakeMetricsPort();
  const logs: string[] = [];
  const summary: string[] = [];
  const log = (line: string) => logs.push(line);
  try {
    const finalize = async (runId: number, observation: string | undefined) => {
      const env: Record<string, string> = {
        ...hostedEnv(LAUNCHER),
        GITHUB_RUN_ID: String(runId),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: "finalize",
        GITHUB_TOKEN: "synthetic-native-token-for-test",
      };
      if (observation !== undefined) env[UPKEEP_DEFERRAL_ENV] = observation;
      return await runHostedSupervisorHost({
        env,
        sourceDir: ROOT,
        clock: rig.clock,
        state: rig.release,
        http: () => Promise.reject(new Error("finalize test needs no API")),
        process: {
          run: (command) =>
            Promise.resolve(
              exited(command.args.includes("status") ? "" : LAUNCHER),
            ),
        },
        throughputMetrics: { port, log },
        upkeepDeferral: {
          store: metricsUpkeepStreakStore(port),
          notice: logUpkeepNoticePort({
            log,
            appendSummary: (line) => {
              summary.push(line);
              return Promise.resolve();
            },
          }),
          log,
        },
      });
    };
    const notices = () =>
      logs.map((line) => JSON.parse(line)).filter((line) =>
        line.kind === "sentinel_upkeep_deferral_notice"
      );
    const recorded = (runId: number) =>
      port.ledger.records.find((row) => row.cycle.runId === runId)!;

    for (const runId of [701, 702]) {
      await finalize(runId, "deferred_historical_quarantine");
      assert.equal(notices().length, 0);
      assert.equal(recorded(runId).counts.ownerNoticesSent, null);
    }
    await finalize(703, "deferred_historical_quarantine");
    assert.deepEqual(notices(), [{
      kind: "sentinel_upkeep_deferral_notice",
      title: "Upkeep deferred for 3 consecutive supervisor cycles",
      reason: "deferred_historical_quarantine",
      runId: 703,
    }]);
    assert.equal(summary.length, 1);
    assert.doesNotMatch(summary[0], /https?:/);
    assert.equal(recorded(703).counts.ownerNoticesSent, 1);
    assert.deepEqual(port.ledger.upkeepStreak, {
      version: 2,
      count: 3,
      lastRunId: 703,
      noticeCount: 3,
      runIds: [701, 702, 703],
      reasons: ["deferred_historical_quarantine"],
      startedAtMs: rig.clock.now(),
      issueNumber: null,
    });
    // A rerun of run 703's finalize never claims a second notice.
    await finalize(703, "deferred_historical_quarantine");
    assert.equal(notices().length, 1);

    // Run 704: maintenance did not defer, so the streak resets.
    await finalize(704, "none");
    assert.deepEqual(port.ledger.upkeepStreak, {
      version: 2,
      count: 0,
      lastRunId: 704,
      noticeCount: null,
      runIds: [],
      reasons: [],
      startedAtMs: null,
      issueNumber: null,
    });
    assert.equal(recorded(704).counts.ownerNoticesSent, null);
    // A missing maintenance output is unobserved and leaves the streak alone.
    await finalize(705, undefined);
    const after: ThroughputMetricsLedgerV1 = port.ledger;
    assert.equal(after.upkeepStreak?.lastRunId, 704);
    // A new streak needs three fresh deferrals before its own single notice.
    for (const runId of [706, 707]) {
      await finalize(runId, "deferred_matrix_history_budget");
    }
    assert.equal(notices().length, 1);
    await finalize(708, "deferred_matrix_history_budget");
    assert.deepEqual(
      notices().map((line) => [line.runId, line.reason]),
      [[703, "deferred_historical_quarantine"], [
        708,
        "deferred_matrix_history_budget",
      ]],
    );
    // The streak lives on the metrics sidecar as one canonical file.
    const files = encodeThroughputLedgerV1(port.ledger);
    assert.equal(
      files.get(THROUGHPUT_UPKEEP_STREAK_PATH),
      `{"count":3,"issueNumber":null,"lastRunId":708,"noticeCount":3,"reasons":["deferred_matrix_history_budget"],"runIds":[706,707,708],"startedAtMs":${rig.clock.now()},"version":2}\n`,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("finalize upkeep observation: only closed reasons and none are observed", () => {
  assert.equal(parseUpkeepDeferralObservation("none"), null);
  assert.equal(
    parseUpkeepDeferralObservation("deferred_unexpected_error"),
    "deferred_unexpected_error",
  );
  for (
    const value of [undefined, "", "historical_quarantine_incomplete", "x"]
  ) {
    assert.equal(parseUpkeepDeferralObservation(value), undefined);
  }
  assert.throws(() =>
    decodeThroughputLedgerV1(
      new Map([[THROUGHPUT_UPKEEP_STREAK_PATH, '{"count":1}\n']]),
    )
  );
});
