import assert from "node:assert/strict";
import { isHardAutonomyFailure } from "../../ops/hosted-autonomy.ts";
import { upkeepDeferralReason } from "../../ops/hosted-autonomy-queue-output.ts";
import {
  settleUpkeepDeferralStreak,
  type UpkeepDeferralNoticeV1,
  type UpkeepDeferralStreakV1,
} from "../../src/contracts/upkeep-deferral-streak.ts";
import { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";

/**
 * Regression for the 2026-11-03 outage: every supervisor run printed
 * `{"kind":"hosted_autonomy","status":"failed","reason":"historical_quarantine_incomplete"}`
 * and exited 1, so prepare, matrix_plan, repair and finalize never ran.
 */
const NOV3_FAILED_LINE = {
  kind: "hosted_autonomy",
  status: "failed",
  reason: "historical_quarantine_incomplete",
};

async function runCapturing(
  f: Awaited<ReturnType<typeof historicalMalformedRig>>,
): Promise<{ code: number; lines: Record<string, unknown>[] }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value: unknown) => logs.push(String(value));
  console.error = () => {};
  try {
    const code = await f.runMain();
    return {
      code,
      lines: logs.flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      }),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

Deno.test("Nov 3 regression: incomplete historical quarantine defers, exits 0 and feeds the third-deferral notice", async () => {
  const f = await historicalMalformedRig(false, 1);
  const output = `${f.rig.tmp}/github-output`;
  f.mainEnv.GITHUB_OUTPUT = output;
  // Durable fake of the trusted finalize writer and an injected notice port.
  let streak: UpkeepDeferralStreakV1 | null = null;
  let head = 0;
  const store = {
    read: () => Promise.resolve({ head: `h${head}`, streak }),
    write: (next: UpkeepDeferralStreakV1, expected: string) => {
      if (expected !== `h${head}`) return Promise.resolve("conflict" as const);
      streak = next;
      head++;
      return Promise.resolve("applied" as const);
    },
  };
  const sent: UpkeepDeferralNoticeV1[] = [];
  const notice = {
    publish: (row: UpkeepDeferralNoticeV1) => {
      sent.push(row);
      return Promise.resolve(true);
    },
  };
  try {
    // The exact Nov 3 refusal: saved execution custody was unavailable.
    f.historicalMatrix.state = {
      ...f.rig.state,
      readRepair: () =>
        Promise.reject(
          new Error("historical matrix saved execution unavailable"),
        ),
    };
    const before = await f.rig.state.readRepair();
    const releaseBefore = await f.rig.state.readRelease();
    const notified: boolean[] = [];
    for (const runId of [9001, 9002, 9003]) {
      const { code, lines } = await runCapturing(f);
      assert.equal(code, 0);
      const result = lines.find((line) => line.kind === "hosted_autonomy")!;
      assert.notDeepEqual(
        { kind: result.kind, status: result.status, reason: result.reason },
        NOV3_FAILED_LINE,
      );
      assert.deepEqual(result, {
        kind: "hosted_autonomy",
        status: "skipped",
        reason: "deferred_historical_quarantine",
        beforeHead: null,
        appliedHead: null,
        actions: ["historical-matrix:deferred"],
        revisions: [],
      });
      assert.equal(
        isHardAutonomyFailure(
          result.reason as Parameters<typeof isHardAutonomyFailure>[0],
        ),
        false,
      );
      // Writes nothing.
      assert.deepEqual(await f.rig.state.readRepair(), before);
      assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      // The native output finalize consumes names the closed reason.
      const outputLines = (await Deno.readTextFile(output)).trim().split("\n");
      assert.equal(
        outputLines.filter((line) => line.startsWith("upkeepDeferral=")).at(
          -1,
        ),
        "upkeepDeferral=deferred_historical_quarantine",
      );
      const reason = upkeepDeferralReason(
        result as { status: string; reason: string },
      );
      const settled = await settleUpkeepDeferralStreak({
        store,
        notice,
        observation: { runId, reason },
      });
      notified.push(settled.notified);
      assert.equal(sent.length, runId === 9003 ? 1 : 0);
    }
    assert.deepEqual(notified, [false, false, true]);
    assert.deepEqual(sent, [{
      title: "Sentinel upkeep deferred three consecutive runs",
      reason: "deferred_historical_quarantine",
      runId: 9003,
    }]);
    // A healthy pass reports no deferral and resets the streak.
    f.historicalMatrix.state = f.rig.state;
    const healthy = await runCapturing(f);
    assert.equal(healthy.code, 0);
    assert.equal(
      (await Deno.readTextFile(output)).trim().split("\n").filter((line) =>
        line.startsWith("upkeepDeferral=")
      ).at(-1),
      "upkeepDeferral=none",
    );
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("Nov 3 regression: a changed-custody quarantine refusal still fails closed", async () => {
  const f = await historicalMalformedRig(false, 1);
  try {
    f.historicalMatrix.state = {
      ...f.rig.state,
      readRepair: () =>
        Promise.reject(new Error("historical matrix current custody changed")),
    };
    const before = await f.rig.state.readRepair();
    const { code, lines } = await runCapturing(f);
    assert.equal(code, 1);
    const result = lines.find((line) => line.kind === "hosted_autonomy")!;
    assert.deepEqual(
      { kind: result.kind, status: result.status, reason: result.reason },
      NOV3_FAILED_LINE,
    );
    assert.deepEqual(await f.rig.state.readRepair(), before);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});
