/** Fresh matrix intake, planner guards and native handoff margin. */
import assert from "node:assert/strict";
import type { ImplementationPort } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-actions.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import { OPERATION_MARGIN_MS } from "../../src/repair/loop.ts";
import { MemoryState } from "../repair/helpers.ts";
import { reservation, T0, workRecord } from "../state/helpers.ts";
import { issue, rig } from "./matrix-actions-fixtures.ts";

for (const mode of [false, true, "expensive_reads", "fresh_drift"] as const) {
  const unassigned = mode === true;
  const expensiveReads = mode === "expensive_reads";
  const freshDrift = mode === "fresh_drift";
  Deno.test(
    "matrix actions planner window: " +
      (freshDrift
        ? "fresh state eligibility is reread per selected candidate"
        : expensiveReads
        ? "ready mixed backlog avoids repeated full snapshots"
        : unassigned
        ? "fresh intake assigns branches before unrelated backlog"
        : "ready work precedes unrelated deterministic backlog"),
    async () => {
      const r = await rig();
      try {
        const memory = new MemoryState();
        const release = await r.store.readRelease();
        assert.ok(release.ok && release.value.status === "found");
        memory.setRelease(release.value.snapshot);
        const repository = {
          owner: "Ubiquity-Sentinel",
          name: "sentinel",
          installationId: 0,
        };
        const background = Array.from(
          { length: 160 },
          (_, index) => {
            const liveIntent = expensiveReads && index % 3 === 2;
            const requestId = (index + 1).toString(16).padStart(64, "0");
            const branch = "sentinel/background-" + index;
            return workRecord("background-review-" + index, {
              repository: expensiveReads && index === 159
                ? { ...repository, name: "unconfigured" }
                : repository,
              source: {
                kind: "issue",
                id: String(index + 1000),
                revision: r.sha,
              },
              related: { incidentId: null, issueNumber: index + 1000 },
              controller: { sha: r.sha },
              failingRevision: null,
              nextStep: liveIntent
                ? "work"
                : expensiveReads && index % 3 === 1
                ? "delivery"
                : "review",
              counters: { attempts: 1, retries: 0, reviewRounds: 1 },
              target: {
                base: r.sha,
                branch,
                checkpoint: null,
                head: liveIntent ? null : r.sha,
                pr: liveIntent ? null : index + 1000,
              },
              intent: liveIntent
                ? {
                  kind: "implementation",
                  key: implementationIntentKey(requestId),
                  startedAt: T0,
                  branch,
                  expectedHead: null,
                  observedBase: r.sha,
                  pr: null,
                  requestId,
                  resultId: null,
                }
                : null,
            });
          },
        );
        const fresh = workRecord("issue-ubiquity-sentinel-1", {
          repository,
          source: { kind: "issue", id: "1", revision: r.sha },
          controller: { sha: r.sha },
          failingRevision: null,
          target: {
            base: r.sha,
            branch: "sentinel/repair/issue-ubiquity-sentinel-1",
            checkpoint: null,
            head: null,
            pr: null,
          },
        });
        const historical = reservation("historical-background-review", {
          repository,
          taskId: background[0]!.id,
          head: r.sha,
          purpose: "review_request",
          outcome: "submitted",
          settledAt: T0 + 1,
          proofRef: null,
        });
        const second = workRecord("issue-ubiquity-sentinel-2", {
          ...fresh,
          id: "issue-ubiquity-sentinel-2",
          source: { ...fresh.source, id: "2" },
          related: { incidentId: null, issueNumber: 2 },
          target: {
            ...fresh.target,
            branch: "sentinel/repair/issue-ubiquity-sentinel-2",
          },
        });
        const expectedCells = expensiveReads ? 2 : 1;
        const seeded = await memory.writeRepair(
          parseRepairStateSnapshotV1({
            version: "v1",
            kind: "repair_state_snapshot",
            stateHead: null,
            sequence: 1,
            updatedAt: r.clock.now(),
            incidents: [],
            evidence: [],
            work: unassigned
              ? background
              : expensiveReads || freshDrift
              ? [fresh, second, ...background]
              : [fresh, ...background],
            reservations: [historical],
            reviews: [],
            replays: [],
            releaseRequests: [],
            githubCooldowns: [],
            attemptMemory: [],
            lessons: [],
          }),
          null,
        );
        assert.ok(seeded.ok && seeded.value.status === "applied");
        const source = r.github.get("Ubiquity-Sentinel/sentinel")!;
        let fullReads = 0, measureReads = expensiveReads;
        if (freshDrift) {
          const write = memory.writeRepair.bind(memory);
          let changed = false;
          memory.writeRepair = (snapshot, expected) => {
            if (
              !changed &&
              snapshot.work.some((row) =>
                row.id === fresh.id && row.intent?.kind === "implementation"
              )
            ) {
              changed = true;
              snapshot = structuredClone(snapshot);
              snapshot.work = snapshot.work.map((row) =>
                row.id === second.id
                  ? {
                    ...row,
                    nextStep: "blocked",
                    blocker: {
                      kind: "other",
                      message: "current eligibility changed",
                      since: r.clock.now(),
                    },
                    wait: null,
                  }
                  : row
              );
            }
            return write(snapshot, expected);
          };
        }
        if (expensiveReads || freshDrift) {
          const read = memory.readRepair.bind(memory);
          memory.readRepair = () => {
            if (measureReads) {
              fullReads++;
              r.clock.advance(45000);
            }
            return read();
          };
          const rows = [issue(1), issue(2)];
          source.listOpenIssues = () => Promise.resolve(portOk(rows));
          source.readIssue = (number) => {
            assert.ok(
              number === 1 || (!freshDrift && number === 2),
              "only currently eligible tasks may reach preparation",
            );
            return Promise.resolve(portOk(rows[number - 1] ?? null));
          };
        }
        r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
          Promise.resolve(portOk([]));
        let backgroundReads = 0, modelCalls = 0;
        source.readPullRequest = async () => {
          await Promise.resolve();
          backgroundReads++;
          r.clock.advance(29000);
          return portOk(null);
        };
        const model: ImplementationPort = {
          modelId: "gpt-reserve",
          runModel: () => {
            modelCalls++;
            return Promise.resolve(
              portError("unavailable", "bounded fake model outcome"),
            );
          },
        };
        const planned = await runActionsMatrixHost({
          ...await r.job("window-plan", "matrix_plan"),
          state: memory,
          model,
        });
        measureReads = false;
        if (expensiveReads) {
          console.log(
            JSON.stringify({
              kind: "planner_snapshot_cost",
              fullReads,
              simulatedElapsedMs: fullReads * 45000,
            }),
          );
        }
        assert.ok("plan" in planned);
        assert.equal(
          planned.prepared,
          expectedCells,
          "fresh work must reach native admission before unrelated deterministic work consumes the session window",
        );
        assert.equal(modelCalls, 0);
        if (expensiveReads) {
          assert.ok(
            fullReads < 50,
            "ineligible ranked rows must not each cause another full authoritative snapshot",
          );
        }
        if (freshDrift) {
          assert.equal(
            memory.repair!.work.find((row) => row.id === second.id)!.nextStep,
            "blocked",
          );
        }
        assert.equal(
          backgroundReads,
          0,
          "unrelated review reconciliation belongs to the aggregate",
        );
        assert.ok(
          r.clock.now() + 1_800_000 + OPERATION_MARGIN_MS <=
            T0 + 10000 + 110 * 60_000,
        );
        assert.deepEqual(
          memory.repair!.work.filter((row) =>
            row.id.startsWith("background-review-")
          ),
          background,
        );
        assert.equal(memory.repair!.reservations.length, expectedCells + 1);
        assert.deepEqual(
          memory.repair!.reservations.find((row) => row.id === historical.id),
          historical,
        );
        assert.equal(
          memory.repair!.work.find((row) => row.related.issueNumber === 1)!
            .intent?.kind,
          "implementation",
        );
        const cell = planned.plan.cells[0]!;
        const deps = await r.job("window-cell", "matrix_cell");
        const artifactRoot = r.root + "/window-cell/.sentinel-matrix";
        await Deno.mkdir(artifactRoot);
        await Deno.writeTextFile(
          artifactRoot + "/plan.json",
          JSON.stringify(planned.plan),
        );
        const result = await runActionsMatrixHost({
          ...deps,
          state: memory,
          model,
          carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
        });
        assert.ok("cellId" in result);
        assert.equal(modelCalls, 1);
        assert.equal(
          memory.repair!.reservations.length,
          expectedCells + 1,
          "cell does not add another charge",
        );
        assert.deepEqual(
          memory.repair!.work.filter((row) =>
            row.id.startsWith("background-review-")
          ),
          background,
        );
        const again = await runActionsMatrixHost({
          ...await r.job("window-repeat", "matrix_plan"),
          state: memory,
          model,
        });
        assert.ok("plan" in again);
        assert.equal(
          again.prepared,
          0,
          "a current implementation intent cannot be readmitted",
        );
        assert.equal(memory.repair!.reservations.length, expectedCells + 1);
        assert.deepEqual(
          memory.repair!.reservations.find((row) => row.id === historical.id),
          historical,
        );
        assert.equal(modelCalls, 1);
      } finally {
        await r.cleanup();
      }
    },
  );
}

for (
  const scenario of [
    "late_origin",
    "changed_source",
    "opt_out",
    "open_dependency",
    "wrong_owner",
    "cas_conflict",
  ] as const
) {
  Deno.test("matrix actions planner guard: " + scenario, async () => {
    const r = await rig();
    try {
      const memory = new MemoryState();
      const release = await r.store.readRelease();
      assert.ok(release.ok && release.value.status === "found");
      memory.setRelease(release.value.snapshot);
      r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
        Promise.resolve(portOk([]));
      const source = r.github.get("Ubiquity-Sentinel/sentinel")!;
      const row = source.row;
      if (scenario === "cas_conflict") {
        source.listOpenIssues = () => {
          memory.conflictRepairNext = true;
          return Promise.resolve(portOk([row]));
        };
      }
      source.readIssue = () =>
        Promise.resolve(portOk({
          ...row,
          ...(scenario === "changed_source"
            ? { body: "changed after intake" }
            : {}),
          ...(scenario === "opt_out" ? { labels: ["sentinel:skip"] } : {}),
          ...(scenario === "open_dependency"
            ? {
              relations: {
                subIssueCount: 0,
                openBlockers: [{
                  owner: "Ubiquity-Sentinel",
                  name: "sentinel",
                  number: 2,
                }],
              },
            }
            : {}),
        }));
      if (scenario === "late_origin") r.clock.advance(76 * 60_000);
      const deps = await r.job("planner-guard", "matrix_plan");
      let modelCalls = 0;
      let rejected = false;
      try {
        const result = await runActionsMatrixHost({
          ...deps,
          state: memory,
          env: scenario === "wrong_owner"
            ? { ...deps.env, GITHUB_RUN_ID: "999" }
            : deps.env,
          model: {
            modelId: "gpt-reserve",
            runModel: () => {
              modelCalls++;
              return Promise.resolve(portError("unavailable", "fake model"));
            },
          },
        });
        assert.ok("plan" in result);
        assert.equal(result.prepared, scenario === "changed_source" ? 1 : 0);
        if (scenario === "changed_source") {
          const cell = result.plan.cells[0]!;
          assert.equal(
            cell.request.issue?.body,
            "changed after intake",
            "the grant uses the latest authoritative source",
          );
          source.readIssue = () =>
            Promise.resolve(portOk({ ...row, body: "changed after planning" }));
          const beforeCell = structuredClone(memory.repair);
          const cellDeps = await r.job("source-change-cell", "matrix_cell");
          const artifactRoot = r.root + "/source-change-cell/.sentinel-matrix";
          await Deno.mkdir(artifactRoot);
          await Deno.writeTextFile(
            artifactRoot + "/plan.json",
            JSON.stringify(result.plan),
          );
          const refused = await runActionsMatrixHost({
            ...cellDeps,
            state: memory,
            carrier: { planDigest: result.planDigest, cellId: cell.cellId },
            model: {
              modelId: "gpt-reserve",
              runModel: () => {
                modelCalls++;
                return Promise.resolve(portError("unavailable", "fake model"));
              },
            },
          });
          assert.ok("cellId" in refused);
          assert.equal(refused.status, "not_started");
          assert.deepEqual(memory.repair, beforeCell);
        }
      } catch (error) {
        if (scenario !== "wrong_owner" && scenario !== "cas_conflict") {
          throw error;
        }
        rejected = true;
        assert.match(String(error), /execution|identity|intake|state/);
      }
      assert.equal(
        rejected,
        scenario === "wrong_owner" || scenario === "cas_conflict",
      );
      assert.equal(modelCalls, 0);
      const charges = scenario === "changed_source" ? 1 : 0;
      assert.equal(memory.repair?.reservations.length ?? 0, charges);
      assert.equal(
        memory.repair?.work.filter((record) =>
          record.intent?.kind === "implementation"
        ).length ?? 0,
        charges,
      );
    } finally {
      await r.cleanup();
    }
  });
}

Deno.test("matrix actions: planner preserves native handoff time for prepared cells", async () => {
  const r = await rig();
  try {
    const rows = Array.from({ length: 3 }, (_, index) => issue(index + 1));
    const source = r.github.get("Ubiquity-Sentinel/sentinel")!;
    source.listOpenIssues = () => Promise.resolve(portOk(rows));
    let sourceReads = 0;
    source.readIssue = async (number) => {
      await Promise.resolve();
      sourceReads++;
      r.clock.advance(number === 3 ? OPERATION_MARGIN_MS : 60_000);
      return portOk(rows[number - 1] ?? null);
    };
    r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
      Promise.resolve(portOk([]));
    const startedAt = r.clock.now();
    r.clock.advance(68 * 60_000);
    const planned = await runActionsMatrixHost({
      ...await r.job("handoff-plan", "matrix_plan"),
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("planner cannot infer")),
      },
    });
    assert.ok("plan" in planned);
    assert.ok(planned.prepared > 0, "real intake must prepare fresh grants");
    const cell = planned.plan.cells[0]!;
    const sourceReadsAtPublication = sourceReads;
    source.readIssue = (number) =>
      Promise.resolve(portOk(rows[number - 1] ?? null));
    const deps = await r.job("handoff-cell", "matrix_cell");
    const artifactRoot = r.root + "/handoff-cell/.sentinel-matrix";
    await Deno.mkdir(artifactRoot);
    await Deno.writeTextFile(
      artifactRoot + "/plan.json",
      JSON.stringify(planned.plan),
    );
    r.clock.advance(60_000);
    let modelCalls = 0;
    const result = await runActionsMatrixHost({
      ...deps,
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          modelCalls++;
          return Promise.resolve(
            portError("unavailable", "bounded fake model outcome"),
          );
        },
      },
      carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
    });
    assert.ok("cellId" in result);
    console.log(JSON.stringify({
      kind: "planner_native_handoff",
      prepared: planned.prepared,
      sourceReads: sourceReadsAtPublication,
      plannedElapsedMs: planned.plan.plannedAt - startedAt,
      status: result.status,
      modelCalls,
    }));
    assert.equal(
      modelCalls,
      1,
      "native handoff must retain a full configured session and margin",
    );
    assert.ok(
      planned.plan.plannedAt + cell.request.maxDurationMs +
          2 * OPERATION_MARGIN_MS <=
        startedAt + 110 * 60_000,
      "publication must leave the existing additional handoff reserve",
    );
    assert.ok(
      sourceReadsAtPublication < rows.length,
      "stop reading unstartable grants before the handoff reserve",
    );
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(after.value.snapshot.reservations.length, planned.prepared);
    assert.ok(
      after.value.snapshot.reservations.every((entry) =>
        entry.outcome === "reserved"
      ),
    );
  } finally {
    await r.cleanup();
  }
});
