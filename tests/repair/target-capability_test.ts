/**
 * Issue #332: the cached target capability row (contract, codec layout and
 * version tolerance), the pure verdict, and the planner gate that refuses a
 * cached-incapable target before any reservation.
 */
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  isKnownTargetCapabilityV1,
  parseTargetCapabilityV1,
  targetCapabilityIdV1,
} from "../../src/contracts/target-capability.ts";
import { planMatrixWave } from "../../src/host/matrix-planner.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  capabilityRowV1,
  evaluateTargetCapabilityV1,
  targetCapabilityRefusesV1,
} from "../../src/repair/target-capability.ts";
import { recordFiles } from "../../src/state/state-codec.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "../repair/helpers.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const NO_CI = {
  files: ["package.json", "package-lock.json"],
  hasCiWorkflow: false,
  manifestScripts: { package: ["build"] },
};
const WITH_CI = { ...NO_CI, hasCiWorkflow: true };

function snapshot(
  work: unknown[],
  extra: Record<string, unknown> = {},
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
    ...extra,
  });
}

async function incapableRow() {
  return capabilityRowV1({
    repository: { ...REPO },
    defaultBranch: "main",
    tip: SHA2,
    generation: 3,
    verdict: await evaluateTargetCapabilityV1(NO_CI, false),
    ownerIssue: 12,
    ownerIssueDigest: (await evaluateTargetCapabilityV1(NO_CI, false))
      .missingDigest,
    checkedAt: T0,
  });
}

Deno.test("target capability: verdict lists the exact missing set", async () => {
  const none = await evaluateTargetCapabilityV1(NO_CI, true);
  assert.equal(none.capable, false);
  assert.deepEqual(none.missing, [
    "pull_request_ci_workflow",
    "runnable_local_verify_command",
  ]);
  assert.equal(none.backupCovered, true, "backup listing is recorded");
  const ci = await evaluateTargetCapabilityV1(WITH_CI, true);
  assert.equal(ci.capable, true);
  assert.deepEqual(ci.missing, ["runnable_local_verify_command"]);
  assert.notEqual(ci.missingDigest, none.missingDigest);
  const verify = await evaluateTargetCapabilityV1({
    ...NO_CI,
    manifestScripts: { package: ["test"] },
  }, false);
  assert.equal(verify.capable, false, "local verify is not merge evidence");
  assert.deepEqual(verify.missing, ["pull_request_ci_workflow"]);
});

Deno.test("target capability: rows round-trip, keep extras and stay out of the codec when absent", async () => {
  const row = await incapableRow();
  assert.equal(row.id, targetCapabilityIdV1(REPO));
  assert.deepEqual(parseTargetCapabilityV1(row), row);
  const extended = { ...row, futureHint: "kept" };
  assert.equal(
    canonicalStringify(parseTargetCapabilityV1(extended)),
    canonicalStringify(extended),
  );
  const future = { id: row.id, version: 2, anything: [1] };
  const opaque = parseTargetCapabilityV1(future);
  assert.deepEqual(opaque, future);
  assert.equal(isKnownTargetCapabilityV1(opaque), false);
  assert.throws(() => parseTargetCapabilityV1({ ...row, capable: true }));
  assert.throws(() =>
    parseTargetCapabilityV1({ ...row, missing: [...row.missing].reverse() })
  );
  const withRow = snapshot([], { targetCapabilities: [extended] });
  assert.equal(targetCapabilityRefusesV1(withRow, REPO), true);
  assert.equal(
    targetCapabilityRefusesV1(
      snapshot([], { targetCapabilities: [future] }),
      REPO,
    ),
    false,
    "an unsupported version is treated as absent",
  );
  assert.throws(() => snapshot([], { targetCapabilities: [] }));
  const files = await recordFiles(withRow, "repair");
  assert.equal(
    files.filter((file) => file.path.startsWith("targetCapabilities/")).length,
    1,
  );
  const plain = await recordFiles(snapshot([]), "repair");
  assert.equal(
    plain.some((file) => file.path.startsWith("targetCapabilities/")),
    false,
  );
});

async function planOnce(rows: unknown[]) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const config = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  })[0]!;
  const record = workRecord("issue-capability", {
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-capability",
      checkpoint: null,
      head: null,
      pr: null,
    },
  });
  const seeded = await state.writeRepair(
    snapshot([record], rows.length === 0 ? {} : { targetCapabilities: rows }),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  let modelCalls = 0;
  const deps = {
    ciMinutes: INACTIVE_CI_MINUTES,
    clock,
    state,
    configs: [config],
    controllerSha: SHA1,
    github: new FakeGithub({ baseSha: SHA1 }),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
    model: {
      modelId: "gpt-reserve",
      runModel: () => {
        modelCalls++;
        return Promise.reject(new Error("the planner cannot infer"));
      },
    },
    budget: new RollingStartBudget({ clock, state, configs: [config] }),
    externalImplementations: true,
    legacyReviewCutoff: null,
  } satisfies Parameters<typeof planMatrixWave>[0];
  const report = await planMatrixWave(deps, {
    waveId: "wave-capability",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 3,
    deadline: clock.now() + 60 * 60_000,
    runStartedAt: clock.now(),
    plannedAt: clock.now(),
    modelStartsEnabled: true,
  });
  return { report, state, modelCalls: () => modelCalls };
}

Deno.test("matrix planner: a cached incapable target parks uncharged with no reservation", async () => {
  const { report, state, modelCalls } = await planOnce([await incapableRow()]);
  assert.equal(report.prepared, 0);
  assert.deepEqual(report.plan.cells, []);
  const parked = state.repair!.work[0]!;
  assert.equal(parked.nextStep, "blocked");
  assert.ok(parked.blocker?.message.startsWith("no_ci_and_no_local_verify"));
  assert.equal(state.repair!.reservations.length, 0);
  assert.equal(modelCalls(), 0);
  assert.equal(state.repair!.targetCapabilities?.length, 1, "row kept");
});

Deno.test("matrix planner: the same record without a cached verdict is admitted", async () => {
  const { report, state } = await planOnce([]);
  assert.equal(report.prepared, 1);
  assert.equal(state.repair!.reservations.length, 1);
  assert.equal(state.repair!.work[0]!.nextStep, "work");
});
