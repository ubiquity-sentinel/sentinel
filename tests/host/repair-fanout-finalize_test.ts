/**
 * Finalize authenticates repository repair deltas exactly like matrix-cell
 * artifacts and applies them in one trusted write (issue #328).
 *
 * The ACTUAL repository passes produce three sealed deltas from one shared
 * in-memory state; a fake Actions API (`repair-fanout-actions-rig.ts`)
 * serves the run attempt, its jobs and signed logs, and real ZIP artifacts
 * through the production bounded transport (302 to blob storage, GitHub's
 * archive digest). No network.
 */
import assert from "node:assert/strict";
import {
  encodeRepairDeltaArtifactV1,
  type RepairDeltaEnvelopeV1,
} from "../../src/contracts/repair-delta.ts";
import { runRepairFanoutFinalize } from "../../src/host/repair-fanout-finalize.ts";
import { repairFanoutPlanDigestV1 } from "../../src/repair/repair-fanout-plan.ts";
import { runRepositoryRepairPass } from "../../src/repair/repository-pass.ts";
import { SHA1 } from "../state/helpers.ts";
import {
  actionsRun,
  RUN,
  RUNTIME,
  TOKEN,
} from "./repair-fanout-actions-rig.ts";
import {
  captured,
  makeRig,
  MINUTE,
  plan,
  REPOS,
  reviewing,
  type Rig,
} from "../repair/repository-pass-rig.ts";

async function fanOut(rig: Rig) {
  const { plan: fanout, binding } = await plan(rig);
  const { value: results } = await captured(() =>
    Promise.all(
      fanout.cells.map((cell) =>
        runRepositoryRepairPass(rig.deps, {
          repository: cell.repository,
          binding,
          records: cell.records,
          deadline: rig.clock.now() + 90 * MINUTE,
          stepLimit: 1_000,
          modelStartsEnabled: true,
        })
      ),
    )
  );
  const envelopes = new Map<string, unknown>();
  for (const result of results) {
    assert.equal(result.status, "sealed");
    if (result.status === "sealed") {
      envelopes.set(
        result.envelope.delta.repository.name,
        JSON.parse(
          new TextDecoder().decode(
            encodeRepairDeltaArtifactV1(result.envelope),
          ),
        ),
      );
    }
  }
  return { fanout, envelopes };
}

Deno.test("finalize applies two authenticated repair deltas in one write and rejects a tampered one", async () => {
  const [ALPHA, BETA, GAMMA] = REPOS;
  const rig = makeRig([
    reviewing(ALPHA, 0),
    reviewing(ALPHA, 1),
    reviewing(BETA, 100),
    reviewing(GAMMA, 200),
  ]);
  const { fanout, envelopes } = await fanOut(rig);
  assert.equal(fanout.cells.length, 3);
  assert.equal(rig.state.repairWrites, 0, "the cells wrote nothing");
  // The gamma artifact's body was edited after sealing (its archive digest is
  // GitHub's own for the edited bytes; its marker names the original seal).
  const gamma = structuredClone(
    envelopes.get("gamma"),
  ) as RepairDeltaEnvelopeV1;
  gamma.delta.transitions[0].after.nextStep = "delivery";
  envelopes.set("gamma", gamma);
  const run = await actionsRun(rig, fanout, envelopes);
  const before = structuredClone(rig.state.repair!);
  const planDigest = await repairFanoutPlanDigestV1(fanout);
  const applied = await captured(() =>
    runRepairFanoutFinalize({
      token: TOKEN,
      http: run.http,
      clock: rig.clock,
      state: rig.state,
      run: RUN,
      runtime: RUNTIME,
      planDigest,
      deadline: rig.clock.now() + 60 * MINUTE,
    })
  );
  const outcome = applied.value;
  assert.ok(outcome !== null);
  assert.equal(outcome.status, "applied");
  assert.deepEqual(
    outcome.applied.map((entry) => entry.repository.name).sort(),
    ["alpha", "beta"],
  );
  assert.deepEqual(outcome.rejected, [
    { repository: GAMMA, reason: "unauthenticated" },
  ]);
  assert.equal(rig.state.repairWrites, 1, "one expected-head write");
  // The tampered delta contributed nothing: its record is only handed back
  // to the trusted serial pass (its advisory stamp removed).
  const { stepInputs: _stamp, ...gammaBefore } = before.work.find((row) =>
    row.id === "issue-gamma-200"
  )!;
  assert.deepEqual(
    rig.state.repair!.work.find((row) => row.id === "issue-gamma-200"),
    gammaBefore,
    "the tampered delta contributed nothing",
  );
  assert.equal(outcome.handedBack, 1);
  for (const id of ["issue-alpha-0", "issue-alpha-1", "issue-beta-100"]) {
    assert.equal(
      rig.state.repair!.work.find((row) => row.id === id)?.wait?.reason,
      "review_pending",
    );
  }
  assert.ok(
    applied.lines.some((line) =>
      line.kind === "sentinel_repair_fanout" && line.deltasApplied === 2
    ),
  );
});

Deno.test("finalize authenticates nothing for a foreign plan digest or a foreign producer", async () => {
  const [ALPHA] = REPOS;
  const rig = makeRig([reviewing(ALPHA, 0)]);
  const { fanout, envelopes } = await fanOut(rig);
  const run = await actionsRun(rig, fanout, envelopes);
  const input = {
    token: TOKEN,
    http: run.http,
    clock: rig.clock,
    state: rig.state,
    run: RUN,
    runtime: RUNTIME,
    planDigest: "f".repeat(64),
    deadline: rig.clock.now() + 60 * MINUTE,
  };
  const foreignPlan = await captured(() => runRepairFanoutFinalize(input));
  assert.equal(foreignPlan.value, null);
  // A marker bound to another runtime revision is not this run's producer.
  const producer = await captured(async () =>
    runRepairFanoutFinalize({
      ...input,
      planDigest: await repairFanoutPlanDigestV1(fanout),
      runtime: { revision: SHA1, generation: RUNTIME.generation },
    })
  );
  assert.deepEqual(producer.value?.applied, []);
  assert.deepEqual(producer.value?.rejected.map((entry) => entry.reason), [
    "unauthenticated",
  ]);
  assert.equal(producer.value?.handedBack, 1, "only the stamp hand-back");
});

Deno.test("finalize counts a refused and a missing repository cell, hands their records back and never fails", async () => {
  const [ALPHA, BETA, GAMMA] = REPOS;
  const rig = makeRig([
    reviewing(ALPHA, 0),
    reviewing(BETA, 100),
    reviewing(GAMMA, 200),
  ]);
  const { fanout, envelopes } = await fanOut(rig);
  const cellOf = (name: string) =>
    fanout.cells.find((cell) => cell.repository.name === name)!.cellId;
  // beta's setup failed: the workflow uploaded its bounded refusal record;
  // gamma's producer never uploaded anything.
  envelopes.set("beta", {
    cellId: cellOf("beta"),
    kind: "repair_cell_refusal",
    reason: "cell_unavailable",
    version: "v1",
  });
  envelopes.delete("gamma");
  const run = await actionsRun(rig, fanout, envelopes);
  const { value: outcome } = await captured(async () =>
    runRepairFanoutFinalize({
      token: TOKEN,
      http: run.http,
      clock: rig.clock,
      state: rig.state,
      run: RUN,
      runtime: RUNTIME,
      planDigest: await repairFanoutPlanDigestV1(fanout),
      deadline: rig.clock.now() + 60 * MINUTE,
    })
  );
  assert.ok(outcome !== null);
  assert.equal(outcome.status, "applied");
  assert.deepEqual(outcome.applied.map((entry) => entry.repository.name), [
    "alpha",
  ]);
  assert.deepEqual(
    outcome.rejected.map((entry) => [entry.repository.name, entry.reason])
      .sort(),
    [["beta", "refused"], ["gamma", "missing"]],
  );
  assert.equal(outcome.handedBack, 2);
  for (const id of ["issue-beta-100", "issue-gamma-200"]) {
    const row = rig.state.repair!.work.find((record) => record.id === id)!;
    assert.equal(row.stepInputs, undefined, id);
    assert.equal(row.nextStep, "review", id);
  }
  assert.equal(rig.state.repairWrites, 1);
});
