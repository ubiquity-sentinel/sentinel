/**
 * Bootstrap aggregate pass (owner throughput, 2026-11-01, issue #297; review
 * t22c). A model-disabled bootstrap never runs closed-wave recovery and never
 * walks the work queue, but it keeps the ordinary source intake: every target
 * is prepared, pre-merge CI is dispatched, and the initial authenticated
 * artifact scan still ingests what it recovers (a no-op here because no
 * producer is charged). The cycle's maintenance, health and preservation work
 * run as usual. The state here needs closed-wave recovery, so any recovery
 * attempt would show up as a line and a state write.
 */
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { runActionsMatrixAggregateCycles } from "../../src/host/matrix-aggregate.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "../repair/helpers.ts";
import { REPO, reservation, SHA1, SHA2, T0 } from "../state/helpers.ts";

const cell = CLOSED_C_WAVE.cells[0]!;

function seeded(): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [
      reservation(cell.reservationId, {
        repository: REPO,
        taskId: cell.taskId,
        head: cell.base as GitSha,
        purpose: "implementation",
      }),
    ],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
}

Deno.test("matrix aggregate bootstrap: closed-wave recovery and the work walk skipped; intake and initial scan only", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  state.repair = seeded();
  state.repairHead = SHA1;
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const github = new FakeGithub({ baseSha: SHA1, openIssues: [] });
  const execution = parseHostedExecutionIntentV1({
    id: "1:1:repair",
    runId: 1,
    runAttempt: 1,
    launcherSha: SHA1,
    purpose: "bootstrap",
    revision: SHA1,
    generation: 1,
    releaseId: null,
    createdAt: T0,
  });
  let prepared = 0;
  let premerged = 0;
  let transports = 0;
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  let result;
  try {
    result = await runActionsMatrixAggregateCycles({
      ciMinutes: INACTIVE_CI_MINUTES,
      clock,
      state,
      configs,
      controllerSha: SHA1,
      githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
      incidents: new FakeIncidents({ summaries: [], evidence: null }),
      replay: new FakeReplay(),
      model: new FakeModel({ head: SHA2, changedPaths: ["src/app.ts"] }),
      budget: new RollingStartBudget({ clock, state, configs }),
      deadline: T0 + 30 * 60_000,
      stepLimit: 32,
      modelStartsEnabled: false,
      bootstrap: true,
      host: {
        execution,
        run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
        artifactRoot: "/unused-bootstrap-artifacts",
        sourcePathFor: () => "/unused-bootstrap-source",
        expectedProvider: "uos",
        createArtifactTransport: () => {
          transports++;
          return Promise.resolve({ recover: () => Promise.resolve([]) });
        },
      },
      composeGithub: () => github,
      prepareTarget: () => {
        prepared++;
        return Promise.resolve();
      },
      premergeCi: () => {
        premerged++;
        return Promise.resolve();
      },
    });
  } finally {
    console.log = original;
  }
  assert.ok(result.outcome !== null, JSON.stringify(result));
  assert.equal(result.outcome.status, "idle", JSON.stringify(result));
  assert.equal(prepared, 1, "bootstrap still prepares every target");
  assert.equal(premerged, 1, "bootstrap still dispatches pre-merge CI");
  assert.equal(transports, 1, "the initial scan transport is created once");
  assert.ok(github.calls.includes("listOpenIssues"));
  assert.deepEqual(
    lines.filter((line) => line.includes("sentinel_closed_c_recovery")),
    [],
  );
  assert.equal(state.repairWrites, 0);
});
