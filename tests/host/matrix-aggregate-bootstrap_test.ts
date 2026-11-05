/** Bootstrap is read-only health: no recovery, intake, or record operations. */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedExecutionIntentV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ActionsTargetCyclesInputV1 } from "../../src/host/actions-target-cycles.ts";
import { runActionsCiApproval } from "../../src/host/actions-ci.ts";
import { runActionsTargetCycles } from "../../src/host/actions-target-cycles.ts";
import { runActionsHostedCycles } from "../../src/host/actions.ts";
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
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";

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
    work: Array.from({ length: 700 }, (_, i) => workRecord(`bootstrap:${i}`)),
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

for (
  const [name, run] of [
    ["hosted entrypoint", runActionsHostedCycles],
    ["matrix aggregate", runActionsMatrixAggregateCycles],
    ["serial target flow", runActionsTargetCycles],
    [
      "matrix aggregate with CI postlude",
      async (input: ActionsTargetCyclesInputV1) => {
        const result = await runActionsMatrixAggregateCycles(input);
        const approval = await runActionsCiApproval({
          state: input.state,
          clock: input.clock,
          deadline: input.deadline,
          gate: input.githubCooldown!,
          token: "test-only-token",
          http: () => {
            throw new Error("bootstrap must not call CI APIs");
          },
        });
        assert.deepEqual(approval, { approved: 0, pending: 0, unavailable: 0 });
        return result;
      },
    ],
  ] as const
) {
  for (
    const scenario of [
      "healthy",
      "explicit flag",
      "missing release",
      "invalid contract",
      "invalid manifest",
      "moved generation",
      "different execution",
      "deadline",
    ] as const
  ) {
    if (
      name === "matrix aggregate with CI postlude" &&
      scenario !== "healthy" && scenario !== "explicit flag"
    ) continue;
    Deno.test(`${name} bootstrap: 700 records, ${scenario}, no record stepping`, async () => {
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
      state.release = {
        head: SHA1,
        snapshot: parseReleaseStateSnapshotV1({
          version: "v1",
          kind: "release_state_snapshot",
          stateHead: null,
          sequence: 1,
          updatedAt: T0,
          releases: [],
          hostedRuntimes: [{
            version: "v1",
            kind: "hosted_runtime",
            id: HOSTED_RUNTIME_ID,
            activeRevision: SHA1,
            generation: 1,
            lastHealthyProof: null,
            lastExecutionProof: null,
            nextOrdinaryAt: T0,
            execution,
            createdAt: T0,
            updatedAt: T0,
          }],
          hostedReleases: [],
          githubCooldowns: [],
        }),
      };
      if (scenario === "missing release") state.release = null;
      if (scenario === "invalid contract") {
        (state.release!.snapshot as Record<string, unknown>).version = "v2";
      }
      if (scenario === "invalid manifest") {
        Object.assign(configs[0], { version: "v2" });
      }
      let repairReads = 0;
      const before = structuredClone(state.repair);
      state.readRepair = () => {
        repairReads++;
        throw new Error("bootstrap must not read the record store");
      };
      const readRelease = state.readRelease.bind(state);
      let releaseReads = 0;
      state.readRelease = () => {
        releaseReads++;
        clock.advance(25);
        return readRelease();
      };
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
        result = await run({
          clock,
          state,
          configs,
          controllerSha: SHA1,
          githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
          incidents: new FakeIncidents({ summaries: [], evidence: null }),
          replay: new FakeReplay(),
          model: new FakeModel({ head: SHA2, changedPaths: ["src/app.ts"] }),
          budget: new RollingStartBudget({ clock, state, configs }),
          deadline: scenario === "deadline" ? T0 + 10 : T0 + 30 * 60_000,
          stepLimit: 32,
          modelStartsEnabled: false,
          runOrigin: T0,
          // Only the installed entrypoint infers health-only from the intent;
          // lower-level callers opt in so legacy matrix recovery still drains.
          bootstrap: name === "hosted entrypoint"
            ? scenario === "explicit flag"
            : true,
          host: scenario === "explicit flag" ? undefined : {
            execution: scenario === "moved generation"
              ? { ...execution, generation: 2 }
              : scenario === "different execution"
              ? { ...execution, id: "1:2:repair", runAttempt: 2 }
              : execution,
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
      const status = scenario === "healthy" || scenario === "explicit flag"
        ? "idle"
        : scenario === "deadline"
        ? "margin"
        : "state_error";
      const reads = scenario === "invalid manifest"
        ? 0
        : name === "matrix aggregate with CI postlude"
        ? 2
        : 1;
      assert.equal(result.outcome.status, status, JSON.stringify(result));
      assert.equal(prepared, 0, "bootstrap never prepares target mirrors");
      assert.equal(premerged, 0, "bootstrap never dispatches pre-merge CI");
      assert.equal(
        transports,
        0,
        "artifact recovery belongs to the ordinary pass",
      );
      assert.deepEqual(github.calls, []);
      assert.equal(repairReads, 0);
      assert.equal(releaseReads, reads);
      assert.deepEqual(state.repair, before);
      assert.equal(state.repair?.work.length, 700);
      assert.deepEqual(lines, []);
      assert.equal(state.repairWrites, 0);
    });
  }
}
