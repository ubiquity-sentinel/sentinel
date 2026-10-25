/**
 * C5.5 (2026-10-25 redesign): the finalize run summary carries a wedge report
 * v0 from one bounded repair-state read, and a run whose jobs were healthy
 * while a record sat wedged is `degraded`.
 */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  aggregateRunSummary,
  type ChildRuntimeSummaryV1,
  emitRunSummary,
  type RunJobSummaryV1,
} from "../../src/host/run-summary.ts";
import { detectWedgesV0 } from "../../src/host/run-summary-wedges.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const NOW = T0 + 10_000;
const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 7,
} as const;

function published(
  id: string,
  pr: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(id, {
    target: {
      base: SHA1,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: SHA2,
      pr,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

const UNREVIEWED = { attempts: 1, retries: 0, reviewRounds: 0 };

const until = (reason: string, at: number | null) => ({
  wait: { reason, since: T0, until: at },
});

function liveShapes() {
  const work = [
    // Passport 13: holds the line from a backoff it cannot leave this run.
    published("p-13", 13, {
      repository: PASSPORT,
      ...until("backoff", NOW + 1_800_000),
    }),
    // Passport 14 and 15 also hold, but can move now (no wait; CI running).
    published("p-14", 14, { repository: PASSPORT, nextStep: "delivery" }),
    published("p-15", 15, {
      repository: PASSPORT,
      ...until("ci_pending", NOW + 300_000),
    }),
    // Open-ended waits on rows that hold no line (no review round spent).
    workRecord("a-manual", until("manual", null)),
    published("a-queue-hold", 20, {
      nextStep: "delivery",
      counters: UNREVIEWED,
      ...until("backoff", null),
    }),
    published("a-release-deferred", 21, {
      nextStep: "delivery",
      counters: UNREVIEWED,
      ...until("unavailable", null),
    }),
    published("a-receipt", 22, {
      nextStep: "delivery",
      counters: UNREVIEWED,
      ...until("review_pending", null),
    }),
    workRecord("a-stalled", {
      counters: { attempts: 1, retries: 0, reviewRounds: 0, stalled: 24 },
    }),
    // The 33 live ai.ubq.fi shape: booked, release requested, queue-held.
    published("a-released", 23, {
      nextStep: "delivery",
      counters: { attempts: 1, retries: 0, reviewRounds: 1, stalled: 182 },
      ...until("backoff", null),
    }),
    workRecord("a-blocked", {
      nextStep: "blocked",
      blocker: { kind: "other", message: "parked", since: T0 },
      counters: { attempts: 1, retries: 0, reviewRounds: 0, stalled: 99 },
    }),
    workRecord("a-under", {
      counters: { attempts: 1, retries: 0, reviewRounds: 0, stalled: 23 },
    }),
  ];
  const released = work.find((record) => record.id.endsWith("a-released"))!;
  // Only the fields the release-request match reads; the report is pure.
  const releaseRequests = [{
    source: {
      pullRequest: released.target.pr,
      head: released.target.head,
      base: released.target.base,
    },
    target: { environment: "production", repository: released.repository },
  }];
  return { ...seededSnapshot(work), releaseRequests } as never;
}

Deno.test("wedge report: each v0 class names only the records that cannot progress", () => {
  const report = detectWedgesV0(liveShapes(), NOW);
  assert.equal(report.version, "v0");
  assert.equal(report.classes.holder_not_runnable.count, 1);
  assert.ok(report.classes.holder_not_runnable.samples[0].endsWith("p-13"));
  assert.deepEqual(report.classes.open_ended_wait.count, 2);
  assert.ok(
    report.classes.open_ended_wait.samples.every((id) =>
      id.endsWith("a-manual") || id.endsWith("a-receipt")
    ),
    JSON.stringify(report.classes.open_ended_wait.samples),
  );
  assert.equal(report.classes.stalled.count, 1);
  assert.ok(report.classes.stalled.samples[0].endsWith("a-stalled"));
  assert.equal(report.total, 4);
});

Deno.test("wedge report: a lone holder, an expired wait and an empty snapshot are no wedge", () => {
  const lone = seededSnapshot([
    published("p-13", 13, {
      repository: PASSPORT,
      ...until("backoff", NOW + 1_800_000),
    }),
  ]);
  assert.equal(detectWedgesV0(lone, NOW).total, 0, "it holds nobody");
  const expired = seededSnapshot([
    published("p-13", 13, { repository: PASSPORT, ...until("backoff", NOW) }),
    published("p-14", 14, { repository: PASSPORT, nextStep: "delivery" }),
  ]);
  assert.equal(detectWedgesV0(expired, NOW).total, 0, "an expired wait moves");
  assert.equal(detectWedgesV0(seededSnapshot([]), NOW).total, 0);
});

function healthyJob(): RunJobSummaryV1 {
  const summary: ChildRuntimeSummaryV1 = {
    launcherSha: SHA1,
    runtimeSha: SHA1,
    generation: 102,
    purpose: "ordinary",
    targets: [],
    admittedWorkCount: 0,
    modelStarts: 0,
    prsTouched: [],
    outcome: "healthy",
    reasonCode: "healthy",
  };
  return { name: "repair", conclusion: "success", summary };
}

Deno.test("wedge report: healthy jobs with a wedge make the run degraded, and failure still wins", () => {
  const run = { runId: 1, runAttempt: 1 };
  const wedges = detectWedgesV0(liveShapes(), NOW);
  const degraded = aggregateRunSummary(run, [healthyJob()], wedges);
  assert.equal(degraded.outcome, "degraded");
  assert.deepEqual(degraded.wedges, wedges);
  assert.equal(
    degraded.nextAction,
    "Inspect the wedge report: 4 records cannot progress (1 holder not runnable, 2 open ended wait, 1 stalled).",
  );
  assert.match(degraded.explanation, /; degraded\.$/);
  const clean = aggregateRunSummary(
    run,
    [healthyJob()],
    detectWedgesV0(seededSnapshot([]), NOW),
  );
  assert.equal(clean.outcome, "healthy");
  assert.equal(aggregateRunSummary(run, [healthyJob()]).wedges, null);
  const failed = aggregateRunSummary(run, [
    { ...healthyJob(), conclusion: "failure" },
  ], wedges);
  assert.equal(failed.outcome, "failed");
});

Deno.test("wedge report: finalize reads state once, prints the report, and an unreadable read stays advisory", async () => {
  const lines: string[] = [];
  const appended: string[] = [];
  let reads = 0;
  const summary = await emitRunSummary({
    readJobs: () => Promise.resolve(portOk([healthyJob()])),
    readRepair: () => {
      reads++;
      return Promise.resolve(
        portOk({
          status: "found" as const,
          head: SHA1,
          ref: null,
          snapshot: liveShapes(),
        }),
      );
    },
    now: () => NOW,
    log: (line) => lines.push(line),
    stepSummaryPath: "summary.md",
    appendFile: (_path, text) => {
      appended.push(text);
      return Promise.resolve();
    },
  }, { runId: 2, runAttempt: 1 });
  assert.equal(reads, 1);
  assert.equal(summary?.outcome, "degraded");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).wedges.total, 4);
  assert.ok(appended[0].includes("| holder_not_runnable | 1 |"));

  const unreadable = await emitRunSummary({
    readJobs: () => Promise.resolve(portOk([healthyJob()])),
    readRepair: () => Promise.reject(new Error("fetch failed")),
    log: () => {},
  }, { runId: 3, runAttempt: 1 });
  assert.equal(unreadable?.outcome, "healthy");
  assert.equal(unreadable?.wedges, null);
});
