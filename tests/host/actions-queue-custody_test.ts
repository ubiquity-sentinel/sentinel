/** Actual hosted queue boundary over native API responses and real Git repair CAS. */
import assert from "node:assert/strict";
import { runActionsRepairHost } from "../../src/host/actions-repair-host.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-native-host.ts";
import { parseChildStatus } from "../../src/host/hosted-runtime-status.ts";
import {
  matrixDigestV1,
  parseMatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import { ensureRepairStateSeed } from "../../src/host/actions-host-io.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { portError } from "../../src/contracts/ports.ts";
import { DEFAULT_APP_INSTALLATION_ID } from "../../src/host/actions-target-cycles.ts";
import { response, snapshotWire } from "../github/merge-queue-fixtures.ts";
import { workRecord } from "../state/helpers.ts";
import { rig } from "./matrix-actions-fixtures.ts";

for (const job of ["repair", "matrix_plan"] as const) {
  Deno.test(`host queue: ${job} unavailable native custody stops all ordinary work`, async () => {
    const r = await rig();
    try {
      await ensureRepairStateSeed(r.store, r.clock);
      const before = await r.store.readRepair();
      const deps = await r.job(`queue-unavailable-${job}`, job);
      const events: string[] = [];
      let cycles = 0;
      const result = await runActionsRepairHost({
        ...deps,
        ...(job === "matrix_plan" ? { job } : {}),
        state: r.store,
        http: (request) => {
          events.push(new URL(request.url).pathname);
          return Promise.resolve(response({}, 503));
        },
        preflight: () => {
          events.push("model-preflight");
          return Promise.resolve();
        },
        model: {
          modelId: "synthetic-model",
          runModel: () => {
            throw new Error("unavailable queue must not start a model");
          },
        },
        runTargetCycles: () => {
          cycles++;
          return Promise.resolve({
            outcome: { status: "idle", detail: "unexpected ordinary work" },
            addressed: [],
            skipped: [],
            failed: [],
          });
        },
      });
      assert.equal(cycles, 0, "custody refusal must stop discovery/admission");
      assert.equal(events.includes("model-preflight"), true);
      assert.equal(
        result.startupReady,
        true,
        "actual availability probe owns health",
      );
      assert(
        events.includes("/repos/ubiquity/ai.ubq.fi/rules/branches/development"),
      );
      assert.equal(result.outcome.status, "idle");
      assert.equal(
        parseChildStatus(result, result.execution)?.healthy,
        true,
        "idle custody hold preserves the actual successful availability probe",
      );
      assert.equal(
        result.outcome.status === "idle" && result.outcome.detail,
        "queue custody unavailable",
      );
      assert.deepEqual(
        await r.store.readRepair(),
        before,
        "no admission or charge write",
      );
    } finally {
      await r.cleanup();
    }
  });
}

for (const unavailableReadback of [false, true]) {
  Deno.test(`host queue: hold CAS ${unavailableReadback ? "fresh-read refusal stops cycles" : "is reread before planner cycles"}`, async () => {
    const r = await rig();
    try {
      await ensureRepairStateSeed(r.store, r.clock);
      const seed = await r.store.readRepair();
      assert(seed.ok && seed.value.status === "found");
      const record = workRecord("queue-owned", {
        repository: {
          owner: "ubiquity",
          name: "ai.ubq.fi",
          installationId: DEFAULT_APP_INSTALLATION_ID,
        },
        target: {
          base: r.foreignSha,
          head: r.foreignSha,
          branch: "existing-branch",
          checkpoint: null,
          pr: 7,
        },
        nextStep: "review",
        intent: {
          kind: "merge",
          key: "merge-queue:v1:damaged-owner-intent",
          startedAt: r.clock.now(),
          branch: "existing-branch",
          expectedHead: r.foreignSha,
          observedBase: r.foreignSha,
          pr: 7,
          requestId: null,
          resultId: null,
        },
      });
      const added = await r.store.writeRepair(
        parseRepairStateSnapshotV1({
          ...seed.value.snapshot,
          stateHead: seed.value.head,
          sequence: seed.value.snapshot.sequence + 1,
          work: [record],
        }),
        seed.value.head,
      );
      assert(added.ok && added.value.status === "applied");
      const beforeHead = added.value.head;
      const charges = seed.value.snapshot.reservations;
      const events: string[] = [];
      let writes = 0;
      let readsAfterWrite = 0;
      const state = {
        readRelease: () => r.store.readRelease(),
        readRepair: () => {
          events.push("state-read");
          if (writes > 0) readsAfterWrite++;
          if (unavailableReadback && readsAfterWrite >= 2) {
            return Promise.resolve(
              portError(
                "unavailable",
                "synthetic post-custody read unavailable",
              ),
            );
          }
          return r.store.readRepair();
        },
        writeRepair: async (
          ...args: Parameters<typeof r.store.writeRepair>
        ) => {
          events.push("queue-cas");
          writes++;
          return await r.store.writeRepair(...args);
        },
      };
      const deps = await r.job("queue-cas-plan", "matrix_plan");
      let called = false;
      await runActionsRepairHost({
        ...deps,
        job: "matrix_plan",
        state,
        http: (request) => {
          const path = new URL(request.url).pathname;
          events.push(path);
          return Promise.resolve(
            response(path === "/graphql" ? snapshotWire([]) : []),
          );
        },
        preflight: () => {
          events.push("model-preflight");
          return Promise.resolve();
        },
        runTargetCycles: async (input) => {
          called = true;
          events.push("cycles");
          assert.equal(writes, 1);
          // One is the writer's readback; the second belongs to the host prelude.
          assert(
            readsAfterWrite >= 2,
            "host must reread after the custody CAS/readback",
          );
          const current = await input.state.readRepair();
          assert(current.ok && current.value.status === "found");
          assert.notEqual(current.value.head, beforeHead);
          assert.deepEqual(current.value.snapshot.work[0].wait, {
            reason: "backoff",
            until: null,
            since: r.clock.now(),
          });
          assert.deepEqual(current.value.snapshot.reservations, charges);
          return {
            outcome: { status: "idle", detail: "observed current custody" },
            addressed: [],
            skipped: [],
            failed: [],
          };
        },
      });
      assert.equal(called, !unavailableReadback);
      assert.equal(writes, 1);
      if (!unavailableReadback) {
        assert(events.indexOf("queue-cas") < events.indexOf("cycles"));
      }
      const final = await r.store.readRepair();
      assert(final.ok && final.value.status === "found");
      assert.deepEqual(final.value.snapshot.reservations, charges);
      assert.equal(final.value.snapshot.work[0].wait?.until, null);
    } finally {
      await r.cleanup();
    }
  });
}

Deno.test("host queue: native planner hold emits an honest empty plan without grants", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const before = await r.store.readRepair();
    const deps = await r.job("queue-native-plan", "matrix_plan");
    const result = await runActionsMatrixHost({
      ...deps,
      state: r.store,
      http: () => Promise.resolve(response({}, 503)),
      model: {
        modelId: "synthetic-model",
        runModel: () => {
          throw new Error("no model grant");
        },
      },
    });
    assert("plan" in result);
    assert.deepEqual(result.plan.cells, []);
    assert.deepEqual([
      result.attempted,
      result.prepared,
      result.notReady,
      result.deferred,
      result.memoryRefused,
    ], [0, 0, 0, 0, 0]);
    assert.deepEqual(await r.store.readRepair(), before);
    assert.equal(result.plan.run.launcherSha, r.sha);
    assert.equal(result.plan.waveId, "71:1:repair");
    const saved = parseMatrixPlanV1(
      JSON.parse(
        await Deno.readTextFile(
          deps.workDir + "/../.sentinel-matrix/plan.json",
        ),
      ),
    );
    assert.equal(await matrixDigestV1(saved), result.planDigest);
    assert(
      (await Deno.readTextFile(deps.env.GITHUB_OUTPUT)).includes(
        'matrix={"include":[]}\n',
      ),
    );
    assert(
      (await Deno.readTextFile(deps.env.GITHUB_OUTPUT)).includes(
        "hasCells=false\n",
      ),
    );
    assert(
      [...r.github.values()].every((port) => port.calls.length === 0),
      "no discovery or source admission",
    );
  } finally {
    await r.cleanup();
  }
});

for (const held of [false, true]) {
  Deno.test(`host queue: bootstrap ${held ? "held" : "empty"} observation cannot acquire a writer`, async () => {
    const r = await rig(false, "bootstrap");
    try {
      await ensureRepairStateSeed(r.store, r.clock);
      const before = await r.store.readRepair();
      const deps = await r.job(`queue-bootstrap-${held}`, "repair");
      let writes = 0, cycles = 0, nativeMutations = 0;
      const result = await runActionsRepairHost({
        ...deps,
        state: {
          readRepair: () => r.store.readRepair(),
          readRelease: () => r.store.readRelease(),
          writeRepair: () => {
            writes++;
            return Promise.resolve(
              portError("invalid", "bootstrap has no queue writer"),
            );
          },
        },
        http: (request) => {
          const path = new URL(request.url).pathname;
          if (request.method !== "GET" && path !== "/graphql") {
            nativeMutations++;
          }
          return Promise.resolve(
            response(
              path === "/graphql"
                ? snapshotWire(held ? undefined : null)
                : held
                ? [{ type: "merge_queue" }]
                : [],
            ),
          );
        },
        runTargetCycles: (input) => {
          cycles++;
          assert.equal(input.modelStartsEnabled, false);
          return Promise.resolve({
            outcome: { status: "idle", detail: "deterministic bootstrap" },
            addressed: [],
            skipped: [],
            failed: [],
          });
        },
      });
      assert.equal(cycles, held ? 0 : 1);
      assert.equal(writes, 0);
      assert.equal(nativeMutations, 0);
      assert.equal(result.startupReady, true);
      assert.deepEqual(await r.store.readRepair(), before);
    } finally {
      await r.cleanup();
    }
  });
}

for (const invalidIdentity of [false, true]) {
  Deno.test(`host queue: ${invalidIdentity ? "invalid planner identity" : "failed actual startup probe"} cannot emit an empty manifest`, async () => {
    const r = await rig();
    try {
      const deps = await r.job("queue-invalid-plan", "matrix_plan");
      await assert.rejects(() =>
        runActionsMatrixHost({
          ...deps,
          env: invalidIdentity
            ? { ...deps.env, GITHUB_SHA: "f".repeat(40) }
            : deps.env,
          preflight: () =>
            invalidIdentity
              ? Promise.resolve()
              : Promise.reject(new Error("synthetic failed startup probe")),
          http: () => Promise.resolve(response({}, 503)),
        })
      );
      await assert.rejects(
        () => Deno.stat(deps.workDir + "/../.sentinel-matrix/plan.json"),
        Deno.errors.NotFound,
      );
      await assert.rejects(
        () => Deno.stat(deps.env.GITHUB_OUTPUT),
        Deno.errors.NotFound,
      );
    } finally {
      await r.cleanup();
    }
  });
}

Deno.test("host queue: a matrix cell cannot acquire queue writer authority", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const deps = await r.job("queue-cell", "matrix_cell");
    let writes = 0;
    let requests = 0;
    let called = false;
    await runActionsRepairHost({
      ...deps,
      job: "matrix_cell",
      state: {
        readRelease: () => r.store.readRelease(),
        readRepair: () => r.store.readRepair(),
        writeRepair: () => {
          writes++;
          return Promise.resolve(portError("invalid", "forbidden cell write"));
        },
      },
      http: () => {
        requests++;
        throw new Error("cell cannot run queue prelude");
      },
      runTargetCycles: async (input) => {
        called = true;
        const write = await input.state.writeRepair({} as never, null);
        assert.equal(write.ok, false);
        return {
          outcome: { status: "idle", detail: "cell read-only boundary" },
          addressed: [],
          skipped: [],
          failed: [],
        };
      },
    });
    assert(called);
    assert.equal(writes, 0);
    assert.equal(requests, 0);
  } finally {
    await r.cleanup();
  }
});
