/**
 * A repository cell keeps its repository's refresh line (issue #328; live
 * 2026-11-13: 33 hand-backs in 7 fan-outs, most of them cascades).
 *
 * When the line front's step needs a trusted effect (its base refresh), the
 * cell hands back only that record. The records behind it still read the
 * front's authoritative row, so the line holds them exactly as it does in the
 * serial pass (a `ci_line` deferral, stamped and kept); they no longer read a
 * line with no front, attempt their own refresh and get handed back too.
 *
 * The REAL step loop over in-memory state and a fake repository; no network,
 * no model call.
 */
import assert from "node:assert/strict";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { applyRepairDeltas } from "../../src/repair/repair-delta-apply.ts";
import {
  delegatedRecordsV1,
  planRepairFanoutV1,
  repairFanoutBindingV1,
} from "../../src/repair/repair-fanout-plan.ts";
import { runRepositoryRepairPass } from "../../src/repair/repository-pass.ts";
import { STEP_LINE_KIND } from "../../src/repair/step-line.ts";
import { queueRig } from "./delivery-queue-rig.ts";
import { captured, OLD_STAMP } from "./repository-pass-rig.ts";
import { MINUTE, sha } from "./review-round-cap-rig.ts";

/** Three published heads on a moved base, each with a settled stamp. */
function line() {
  return queueRig(3, {
    tip: sha(0x777),
    shape: (records) =>
      records.map((record) => ({ ...record, stepInputs: OLD_STAMP })),
  });
}

Deno.test("repository pass: only the line front is handed back; the records it holds are kept", async () => {
  const rig = await line();
  const fanout = await planRepairFanoutV1({
    snapshot: await rig.snapshot(),
    head: rig.state.repairHead!,
    configs: rig.deps.configs,
    runId: 41,
    runAttempt: 1,
  });
  assert.equal(fanout.cells.length, 1);
  const cell = fanout.cells[0];
  assert.deepEqual(cell.records, ["issue-1", "issue-2", "issue-3"]);
  const { value: result } = await captured(async () =>
    runRepositoryRepairPass(rig.deps, {
      repository: cell.repository,
      binding: await repairFanoutBindingV1(fanout),
      records: cell.records,
      deadline: rig.clock.now() + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
    })
  );
  assert.equal(result.status, "sealed", JSON.stringify(result));
  if (result.status !== "sealed") return;
  const delta = result.envelope.delta;
  assert.equal(rig.github.refreshes, 0, "no refresh reached GitHub");
  // The front's refresh is the trusted writer's; the two heads behind it are
  // held by the line and keep the deferral the serial pass would settle.
  assert.deepEqual(delta.deferredToTrusted, ["issue-1"]);
  // The front's first step (its refresh intent) is kept speculatively, its
  // next (the refresh itself) is the effect that hands it back.
  assert.deepEqual(
    (delta.steps ?? []).map((step) => [step.record, step.disposition]),
    [
      ["issue-1", "kept"],
      ["issue-1", "deferred"],
      ["issue-2", "kept"],
      ["issue-3", "kept"],
    ],
  );
  assert.equal(
    delta.transitions.some((row) => row.after.intent !== null),
    false,
    "no refresh intent of the handed-back front leaves the cell",
  );
  // Applied, only the front returns to the trusted path; the next plan still
  // delegates the two heads the line holds.
  const { value: applied } = await captured(() =>
    applyRepairDeltas(rig.deps, {
      plan: fanout,
      artifacts: [{ cellId: cell.cellId, envelope: result.envelope }],
      deadline: rig.clock.now() + 10 * MINUTE,
    })
  );
  assert.equal(applied.status, "applied", JSON.stringify(applied.rejected));
  const next = await planRepairFanoutV1({
    snapshot: await rig.snapshot(),
    head: rig.state.repairHead!,
    configs: rig.deps.configs,
    runId: 42,
    runAttempt: 1,
  });
  assert.deepEqual([...delegatedRecordsV1(next)].sort(), [
    "issue-2",
    "issue-3",
  ]);
});

Deno.test("repository pass: the serial pass on the same state refreshes the front and holds the rest", async () => {
  const rig = await line();
  const { lines } = await captured(() =>
    runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
    })
  );
  const steps = lines.filter((entry) => entry.kind === STEP_LINE_KIND)
    .map((entry) => [entry.recordId, entry.outcome, entry.reason ?? null]);
  assert.equal(rig.github.refreshes, 1, "exactly one refresh per pass");
  assert.deepEqual(steps.filter(([id]) => id !== "issue-1"), [
    ["issue-2", "deferred", "ci_line"],
    ["issue-3", "deferred", "ci_line"],
  ]);
});
