/** Retained records outside the current target scope must not break planning. */
import assert from "node:assert/strict";
import { runActionsMatrixHost } from "../../src/host/matrix-actions.ts";
import { MemoryState } from "../repair/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import { T0, workRecord } from "../state/helpers.ts";
import { rig } from "./matrix-actions-fixtures.ts";

Deno.test("matrix actions: retained out-of-scope issues do not abort native planning", async () => {
  const r = await rig();
  try {
    const memory = new MemoryState();
    const release = await r.store.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    memory.setRelease(release.value.snapshot);
    const retained = [
      workRecord("removed-target", {
        repository: { owner: "ubiquity", name: "removed", installationId: 7 },
        source: { kind: "issue", id: "91", revision: r.sha },
        controller: { sha: r.sha },
        failingRevision: null,
        target: {
          base: r.sha,
          branch: "sentinel/removed-target",
          checkpoint: null,
          head: null,
          pr: null,
        },
      }),
      workRecord("old-installation-hold", {
        repository: {
          owner: "ubiquity-sentinel",
          name: "sentinel",
          installationId: 7,
        },
        source: { kind: "issue", id: "92", revision: r.sha },
        nextStep: "blocked",
        blocker: {
          kind: "other",
          message: "existing PR hold: foreign_repository",
          since: T0,
        },
      }),
      workRecord("unavailable-target-preflight", {
        repository: {
          owner: "ubiquity",
          name: "ai.ubq.fi",
          installationId: 155687488,
        },
        source: { kind: "issue", id: "93", revision: r.foreignSha },
        nextStep: "blocked",
        blocker: {
          kind: "other",
          message:
            "existing PR preflight: native queue observation unavailable",
          since: T0,
        },
        wait: { reason: "backoff", until: null, since: T0 },
      }),
    ];
    const seeded = await memory.writeRepair(seededSnapshot(retained), null);
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const job = await r.job("repository-scope-plan", "matrix_plan");
    let modelCalls = 0;
    const planned = await runActionsMatrixHost({
      ...job,
      state: memory,
      resolveDefaultBranch: (target) =>
        Promise.resolve(target.name === "sentinel" ? "development" : null),
      model: {
        modelId: "gpt-6.1-sol",
        runModel: () => {
          modelCalls++;
          return Promise.reject(new Error("planner must not run a model"));
        },
      },
    });
    assert.ok("plan" in planned);
    assert.equal(planned.prepared, 1);
    assert.deepEqual(
      planned.plan.cells.map((cell) => cell.repository),
      [{ owner: "ubiquity-sentinel", name: "sentinel", installationId: 0 }],
    );
    assert.equal(modelCalls, 0);
    const after = await memory.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    for (const record of retained) {
      assert.deepEqual(
        after.value.snapshot.work.find((row) => row.id === record.id),
        record,
        "out-of-scope records retain their original custody and state",
      );
    }
    assert.equal(after.value.snapshot.reservations.length, 1);
    const output = await Deno.readTextFile(job.env.GITHUB_OUTPUT);
    assert.ok(output.includes("hasCells=true\n"));
    assert.ok(output.includes("planDigest=" + planned.planDigest + "\n"));
  } finally {
    await r.cleanup();
  }
});
