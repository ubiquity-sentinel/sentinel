/** Bounded upkeep remains observable even when independent delivery succeeds. */
import assert from "node:assert/strict";
import { runHostedMatrixMaintenance } from "../../ops/hosted-autonomy-maintenance.ts";
import { upkeepDeferralReason } from "../../ops/hosted-autonomy-queue-output.ts";
import {
  type HistoricalMatrixQuarantineDepsV1,
  runHistoricalMatrixQuarantine,
} from "../../src/host/matrix-actions.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  captureHostedAutonomyMain,
  makeRig,
  repairSnapshot,
} from "./hosted-autonomy-rig.ts";
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import {
  LAUNCHER,
  makeRig as supervisorRig,
  requireRun,
  run,
} from "./actions-supervisor-fixture.ts";
import { ENV } from "./hosted-autonomy-fixtures.ts";
import { runFinalizeUpkeepDeferral } from "../../src/host/upkeep-deferral-finalize.ts";
import type {
  UpkeepDeferralNoticeV1,
  UpkeepDeferralStreakV1,
} from "../../src/contracts/upkeep-deferral-streak.ts";
import { gitRun, SHA1, T0, workRecord } from "../state/helpers.ts";

const unused = (): never => {
  throw new Error("deferred upkeep must not write or call an external API");
};

function boundedUpkeep(scenario: "budget" | "repair" | "release") {
  const record = workRecord("bounded-upkeep", {
    intent: {
      kind: "implementation",
      key: "impl:bounded-upkeep",
      requestId: "bounded-upkeep",
      observedBase: SHA1,
      expectedHead: null,
      resultId: null,
      pr: null,
      branch: null,
      startedAt: T0,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
  });
  const deferrals: string[] = [];
  let now = T0;
  const deps: HistoricalMatrixQuarantineDepsV1 = {
    clock: {
      now: () => {
        const observed = now;
        if (scenario === "budget") now += 300_001;
        return observed;
      },
    },
    state: {
      readRepair: () =>
        Promise.resolve(
          scenario === "repair"
            ? portError("unavailable", "synthetic custody unavailable")
            : portOk({
              status: "found" as const,
              head: SHA1,
              ref: null,
              snapshot: repairSnapshot([record], [], [], []),
            }),
        ),
      readRelease: () =>
        Promise.resolve(
          portError("unavailable", "synthetic custody unavailable"),
        ),
      writeRepair: unused,
    },
    budget: { settleModelStart: unused },
    transport: { recover: unused, rejectHistorical: unused },
    readExecution: unused,
    onDeferred: (reason) => deferrals.push(reason),
  };
  return { deps, deferrals };
}

for (const scenario of ["budget", "repair", "release"] as const) {
  Deno.test(`historical upkeep: ${scenario} stop reports deferral without a write`, async () => {
    const { deps, deferrals } = boundedUpkeep(scenario);
    assert.equal(await runHistoricalMatrixQuarantine(deps), 0);
    assert.deepEqual(deferrals, [scenario === "budget" ? "budget" : "custody"]);
  });

  Deno.test(`maintenance upkeep: ${scenario} stop reaches finalize observation`, async () => {
    const { deps, deferrals } = boundedUpkeep(scenario);
    const actions: string[] = [];
    assert.equal(
      await runHostedMatrixMaintenance({
        state: deps.state,
        clock: deps.clock,
        githubFor: unused,
        historicalMatrix: deps,
      }, actions),
      null,
    );
    assert.deepEqual(actions, ["historical-matrix:deferred"]);
    // C63 handles unavailable repair custody before the quarantine pass starts.
    assert.deepEqual(
      deferrals,
      scenario === "repair" ? [] : [
        scenario === "budget" ? "budget" : "custody",
      ],
    );
    for (const status of ["skipped", "applied"]) {
      assert.equal(
        upkeepDeferralReason({ status, reason: "no_change", actions }),
        "deferred_historical_quarantine",
      );
    }
    // An integrity refusal is never downgraded by an earlier bounded stop.
    assert.equal(
      upkeepDeferralReason({
        status: "failed",
        reason: "historical_quarantine_incomplete",
        actions,
      }),
      null,
    );
  });
}

Deno.test("Nov 3 upkeep: native deferral permits prepare and finalize notices once on the third pass", async () => {
  const { rig } = await makeRig("nov3-upkeep", {
    fixtureDir: Deno.cwd(),
    repair: repairSnapshot([], [], [], []),
  });
  const supervisor = await supervisorRig();
  const previous = Deno.cwd();
  let refusal = "historical matrix saved execution unavailable";
  try {
    const checkout = `${rig.tmp}/native-checkout`;
    const cloned = await gitRun(rig.tmp, [
      "clone",
      "--branch",
      "sentinel-state/release",
      `${rig.tmp}/remote.git`,
      checkout,
    ], ENV);
    assert.ok(cloned.ok);
    const head = await gitRun(checkout, ["rev-parse", "HEAD"], ENV);
    assert.ok(head.ok);
    const before = await rig.state.readRepair();
    const releaseBefore = await rig.state.readRelease();
    const historical = boundedUpkeep("release").deps;
    const deps = await withDarkQueueAuthority({
      state: rig.state,
      clock: { now: () => T0 },
      githubFor: rig.githubFor,
      historicalMatrix: {
        ...historical,
        state: {
          ...rig.state,
          readRepair: () => Promise.reject(new Error(refusal)),
        },
      },
    });
    const maintenance = async (runId: number) => {
      Deno.chdir(checkout);
      try {
        return await withHostedProductionPolicy(
          DORMANT_HOSTED_SUPERVISOR_POLICY,
          async (graph) => {
            const { runHostedAutonomyMain } = await graph.maintenanceMain();
            return await captureHostedAutonomyMain(
              deps,
              head.stdout.trim(),
              (input) => {
                assert.ok(input);
                return runHostedAutonomyMain({
                  ...input,
                  env: { ...input.env, GITHUB_RUN_ID: String(runId) },
                });
              },
            );
          },
        );
      } finally {
        Deno.chdir(previous);
      }
    };
    let streak: UpkeepDeferralStreakV1 | null = null;
    let streakHead = 0;
    const notices: UpkeepDeferralNoticeV1[] = [];
    const store = {
      read: () => Promise.resolve({ head: String(streakHead), streak }),
      write: (next: UpkeepDeferralStreakV1, expected: string | null) => {
        assert.equal(expected, String(streakHead));
        streak = next;
        streakHead++;
        return Promise.resolve("applied" as const);
      },
    };
    for (const runId of [900, 901, 902, 903]) {
      const { exit, result } = await maintenance(runId);
      assert.equal(exit, 0);
      assert.deepEqual(result, {
        kind: "hosted_autonomy",
        status: "skipped",
        reason: "deferred_historical_quarantine",
        beforeHead: null,
        appliedHead: null,
        actions: ["historical-matrix:deferred"],
        revisions: [],
      });
      assert.deepEqual(await rig.state.readRepair(), before);
      assert.deepEqual(await rig.state.readRelease(), releaseBefore);
      // The workflow's maintenance gate succeeded; exercise the real next stage.
      if (runId === 900) {
        supervisor.evidence.revisions.add(LAUNCHER);
        const prepared = requireRun(await supervisor.prepare(run(runId)));
        assert.equal(prepared.purpose, "bootstrap");
      }
      await runFinalizeUpkeepDeferral({
        store,
        notice: {
          publish: (notice) => {
            notices.push(notice);
            return Promise.resolve(true);
          },
        },
        log: () => {},
      }, { runId, observation: upkeepDeferralReason(result) ?? "none" });
      assert.equal(notices.length, runId < 902 ? 0 : 1);
    }
    assert.deepEqual(notices, [{
      title: "Sentinel upkeep deferred three consecutive runs",
      reason: "deferred_historical_quarantine",
      runId: 902,
    }]);
    // The exact original Nov 3 report shape remains reserved for integrity faults.
    refusal = "historical matrix current custody changed";
    const failed = await maintenance(904);
    assert.equal(failed.exit, 1);
    const { kind, status, reason } = failed.result;
    assert.deepEqual({ kind, status, reason }, {
      kind: "hosted_autonomy",
      status: "failed",
      reason: "historical_quarantine_incomplete",
    });
    assert.equal(upkeepDeferralReason(failed.result), null);
    assert.equal(rig.writes, 0);
  } finally {
    Deno.chdir(previous);
    await supervisor.cleanup();
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
