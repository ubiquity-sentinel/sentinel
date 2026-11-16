/**
 * At most one green deferral in a row (src/host/targets-deferral-bound.ts),
 * through the actual hosted composition and the real native job-log reader:
 * an ordinary serial pass whose every target read failed transiently defers
 * only when its previous execution's settled repair-job log (the release
 * record's `lastExecutionProof`, read through GitHub's 302 to a signed blob
 * and bound to the settled digest) carries no deferral line. A second
 * unavailable pass in a row, and any previous pass that cannot be proven
 * quiet, fails red with `targets_unavailable`; nothing is persisted.
 */
import assert from "node:assert/strict";
import { ensureRepairStateSeed } from "../../src/host/actions-host-io.ts";
import { runActionsRepairHost } from "../../src/host/actions-repair-host.ts";
import {
  STATIC_TARGETS_DEFERRED,
  STATIC_TARGETS_UNAVAILABLE,
} from "../../src/host/targets.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { TARGETS_DEFERRAL_KIND } from "../../src/repair/targets-deferral-line.ts";
import { rig } from "./matrix-actions-fixtures.ts";
import {
  advanceWithLog,
  deferralLines,
  type DeferralRig,
  EXPECTED_LINE,
  JOB_LOGS,
  jobLog,
  launcherJobLog,
  LISTED,
  NO_MODEL,
  observed,
  previousSettlement,
  PRODUCTION,
  QUIET_LOG,
  quietly,
  reply,
  servingJobLogs,
  TARGET_READS,
  UNAVAILABLE_503,
  unreadable,
} from "./targets-deferral-fixtures.ts";

type Logs = (http: HttpTransportV1) => HttpTransportV1;

const serving = (logs: ReadonlyMap<number, string>): Logs => (http) =>
  servingJobLogs(http, logs);

const logReads = (jobId: number) => [
  `GET ${JOB_LOGS}${jobId}/logs`,
  `GET /actions-results/${jobId}`,
];

/** One serial pass of the rig's current run, every target read a 503. */
async function serialPass(r: DeferralRig, name: string, logs: Logs) {
  const deps = await r.job(name, "repair");
  await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
  const http = observed(unreadable(logs(deps.http), UNAVAILABLE_503));
  let probes = 0;
  let outcome: unknown;
  let error: unknown;
  const { lines } = await quietly(async () => {
    try {
      outcome = (await runActionsRepairHost({
        ...deps,
        ...PRODUCTION,
        state: r.store,
        http: http.http,
        model: NO_MODEL,
        preflight: () => {
          probes++;
          return Promise.resolve();
        },
        runTargetCycles: () => {
          throw new Error("a deferred pass runs no target cycle");
        },
      })).outcome;
    } catch (caught) {
      error = caught;
    }
  });
  return { outcome, error, lines, probes, requests: http.requests };
}

const DEFERRED = { status: "idle", detail: STATIC_TARGETS_DEFERRED };

function assertRed(
  pass: Awaited<ReturnType<typeof serialPass>>,
  label: string,
) {
  assert.deepEqual(pass.error, new Error(STATIC_TARGETS_UNAVAILABLE), label);
  assert.equal(pass.probes, 0, label);
  // Still says why: the launcher re-emits the line for the red job too.
  assert.deepEqual(deferralLines(pass.lines), [EXPECTED_LINE], label);
}

Deno.test("deferral bound: a second unavailable serial pass in a row fails red until a pass reads its targets", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const repairBefore = await r.store.readRepair();
    const logs = new Map([[7101, QUIET_LOG]]);
    // Run 71 read its targets; run 72 finds every read unavailable and
    // defers.
    await advanceWithLog(r, 72, QUIET_LOG, 7101);
    const first = await serialPass(r, "bound-72", serving(logs));
    assert.deepEqual(first.outcome, DEFERRED);
    assert.deepEqual(first.requests, [...TARGET_READS, ...logReads(7101)]);
    // The supervisor settles run 72 from its job log, where the launcher
    // re-emitted the line: run 73 may not defer again.
    const log72 = launcherJobLog(first.lines);
    assert.ok(log72.includes(TARGETS_DEFERRAL_KIND));
    logs.set(7201, log72);
    await advanceWithLog(r, 73, log72, 7201);
    const second = await serialPass(r, "bound-73", serving(logs));
    assertRed(second, "run 73");
    assert.deepEqual(second.requests, [...TARGET_READS, ...logReads(7201)]);
    // The red pass's log carries the line too: the streak stays red.
    const log73 = launcherJobLog(second.lines);
    logs.set(7301, log73);
    await advanceWithLog(r, 74, log73, 7301);
    assertRed(await serialPass(r, "bound-74", serving(logs)), "run 74");
    // A pass that read its targets ends the streak.
    logs.set(7401, QUIET_LOG);
    await advanceWithLog(r, 75, QUIET_LOG, 7401);
    const fifth = await serialPass(r, "bound-75", serving(logs));
    assert.deepEqual(fifth.outcome, DEFERRED);
    // Deferrals and red passes alike leave the repair state as it was.
    assert.deepEqual(await r.store.readRepair(), repairBefore);
  } finally {
    await r.cleanup();
  }
});

Deno.test("deferral bound: a previous pass that cannot be proven quiet keeps the serial pass red", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const garbled = jobLog([
      '{"kind":"sentinel_targets_deferral","reasonCode":"targets_unava',
    ]);
    const quiet = serving(new Map([[101, QUIET_LOG]]));
    // Each case settles the current run its own way and starts the next.
    const cases: [string, () => Promise<void>, Logs, string[]][] = [
      [
        "a not_started previous execution",
        () =>
          r.advanceRun(72, (settlement) => ({
            execution: settlement.execution,
            workflowId: settlement.workflowId,
            workflowPath: settlement.workflowPath,
            repository: settlement.repository,
            ref: settlement.ref,
            jobId: 101,
            finishedAt: settlement.finishedAt,
            observedAt: settlement.observedAt,
            outcome: "not_started",
            evidenceDigest: "c".repeat(64),
          })),
        quiet,
        TARGET_READS,
      ],
      [
        "an unreadable log",
        () => advanceWithLog(r, 73, QUIET_LOG, 101),
        serving(new Map()),
        [...TARGET_READS, `GET ${JOB_LOGS}101/logs`],
      ],
      [
        "a log that is not the settled one",
        () => advanceWithLog(r, 74, QUIET_LOG, 101),
        serving(new Map([[101, `${QUIET_LOG}${jobLog(["more"])}`]])),
        [...TARGET_READS, ...logReads(101)],
      ],
      [
        "a garbled line naming the deferral kind",
        () => advanceWithLog(r, 75, garbled, 101),
        serving(new Map([[101, garbled]])),
        [...TARGET_READS, ...logReads(101)],
      ],
      [
        "a rate-limited log read",
        () => advanceWithLog(r, 76, QUIET_LOG, 101),
        (http) => (request) =>
          new URL(request.url).pathname === `${JOB_LOGS}101/logs`
            ? reply(403, { "x-ratelimit-remaining": "0" })()
            : http(request),
        [...TARGET_READS, `GET ${JOB_LOGS}101/logs`],
      ],
    ];
    for (const [index, [label, settle, logs, requests]] of cases.entries()) {
      await settle();
      const repairBefore = await r.store.readRepair();
      const releaseBefore = await r.release.readRelease();
      const pass = await serialPass(r, `bound-red-${index}`, logs);
      assertRed(pass, label);
      assert.deepEqual(pass.requests, requests, label);
      // A read-only check: not even a rate limit is recorded.
      assert.deepEqual(await r.store.readRepair(), repairBefore, label);
      assert.deepEqual(await r.release.readRelease(), releaseBefore, label);
    }
  } finally {
    await r.cleanup();
  }
});

Deno.test("deferral bound: a runtime that never settled an execution keeps the serial pass red", async () => {
  // The rig's runtime without a healthy proof: run 71 is its first execution.
  const r = await rig(false);
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    assert.equal(await previousSettlement(r), null);
    const pass = await serialPass(
      r,
      "bound-first-execution",
      serving(new Map([[101, QUIET_LOG]])),
    );
    assertRed(pass, "no settled previous execution");
    assert.deepEqual(pass.requests, TARGET_READS);
  } finally {
    await r.cleanup();
  }
});
