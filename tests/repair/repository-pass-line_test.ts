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
import { portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import { createNativeQueueGuard } from "../../src/github/native-queue-guard.ts";
import { createQueueDeliveryReader } from "../../src/github/queue-delivery-reader.ts";
import { QUEUE_PROOF_POLICY } from "../../src/github/queue-runtime-policy.ts";
import { DELIVERY_QUEUE_STALL_LIMIT } from "../../src/repair/delivery-queue.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { applyRepairDeltas } from "../../src/repair/repair-delta-apply.ts";
import {
  delegatedRecordsV1,
  planRepairFanoutV1,
  repairFanoutBindingV1,
} from "../../src/repair/repair-fanout-plan.ts";
import { runRepositoryRepairPass } from "../../src/repair/repository-pass.ts";
import { STEP_LINE_KIND } from "../../src/repair/step-line.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { T0 } from "../state/helpers.ts";
import { queueRig } from "./delivery-queue-rig.ts";
import { captured, OLD_STAMP } from "./repository-pass-rig.ts";
import { MINUTE, sha } from "./review-round-cap-rig.ts";

const HOUR = 60 * MINUTE;

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

/** A wait whose two-minute poll window ended at `since` + 2 minutes. */
function due(reason: "ci_pending" | "unavailable", since: number) {
  return { reason, since, until: since + 2 * MINUTE };
}

/** Line shapes whose front is the oldest head, issue-1. */
const FRONTS: Record<string, (records: WorkRecordV1[]) => WorkRecordV1[]> = {
  // Held on its old tip by a red base for six and a half hours (12 re-arms),
  // the hold due a minute ago; the base was repaired since.
  stalled: ([first, ...rest]) => [{
    ...first!,
    counters: { ...first!.counters, stalled: DELIVERY_QUEUE_STALL_LIMIT },
    wait: { reason: "backoff", since: T0 - 31 * MINUTE, until: T0 - MINUTE },
    updatedAt: T0 - 31 * MINUTE,
  }, ...rest],
  // Every wait fell due long ago (397's CI poll 13 hours back, then 398's
  // `unavailable` and a younger head's poll), whatever their kinds.
  due: ([first, second, third]) => [
    {
      ...first!,
      wait: due("ci_pending", T0 - 13 * HOUR),
      updatedAt: T0 - 13 * HOUR,
    },
    {
      ...second!,
      wait: due("unavailable", T0 - 12 * HOUR),
      updatedAt: T0 - 11 * HOUR,
    },
    {
      ...third!,
      wait: due("ci_pending", T0 - 2 * HOUR),
      updatedAt: T0 - 2 * HOUR,
    },
  ],
};

/**
 * Three stamped heads on a moved base, a month old, in `shape`, with the
 * production queue guard over the shared store (mode off, an authenticated
 * empty rule set): the serial pass decides on that store, a cell on its own
 * fork (`withQueueDecisionView`). A refreshed head's CI is still running.
 */
async function frontLine(shape: (records: WorkRecordV1[]) => WorkRecordV1[]) {
  const rig = await queueRig(3, {
    tip: sha(0x777),
    shape: (records) =>
      shape(records.map((record, index) => ({
        ...record,
        stepInputs: OLD_STAMP,
        firstSeenAt: T0 - 31 * 24 * HOUR,
        createdAt: T0 - 30 * 24 * HOUR + index,
      }))),
  });
  const repository = rig.records[0].repository;
  const client = new GitHubQueueDeliveryClient({
    repository,
    clock: rig.clock,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    http: () => Promise.reject(new Error("No network is authorized")),
  }, null);
  client.readBranchRules = () => Promise.resolve(portOk([]));
  rig.github.nativeQueue = createNativeQueueGuard({
    repository,
    state: rig.state,
    clock: rig.clock,
    client,
    reader: createQueueDeliveryReader({
      repository,
      clock: rig.clock,
      client,
      policy: QUEUE_PROOF_POLICY,
    }),
    policy: QUEUE_PROOF_POLICY,
    mode: "off",
    proofActivated: false,
  });
  rig.github.checksByHead.set(sha(0x5001), [{
    name: "validate",
    status: "in_progress",
    conclusion: null,
    head: sha(0x5001),
    startedAt: T0,
    completedAt: null,
  }]);
  return rig;
}

/** Every deferral of the captured step lines, with its reason code. */
function deferrals(lines: Record<string, unknown>[]): unknown[][] {
  return lines.filter((entry) =>
    entry.kind === STEP_LINE_KIND && entry.outcome === "deferred"
  ).map((entry) => [entry.recordId, entry.reason ?? null]);
}

Deno.test("repository pass: a cell and the serial pass agree on the line front for stalled and due shapes", async () => {
  for (const [name, shape] of Object.entries(FRONTS)) {
    const cellRig = await frontLine(shape);
    const fanout = await planRepairFanoutV1({
      snapshot: await cellRig.snapshot(),
      head: cellRig.state.repairHead!,
      configs: cellRig.deps.configs,
      runId: 41,
      runAttempt: 1,
    });
    const cell = fanout.cells[0];
    assert.deepEqual(cell.records, ["issue-1", "issue-2", "issue-3"], name);
    const { value: result, lines: cellLines } = await captured(async () =>
      runRepositoryRepairPass(cellRig.deps, {
        repository: cell.repository,
        binding: await repairFanoutBindingV1(fanout),
        records: cell.records,
        deadline: cellRig.clock.now() + 90 * MINUTE,
        stepLimit: 1_000,
        modelStartsEnabled: true,
      })
    );
    assert.equal(result.status, "sealed", `${name}: ${JSON.stringify(result)}`);
    if (result.status !== "sealed") return;
    // The cell hands back only the front, for the refresh only the trusted
    // writer makes, and keeps the line's deferral of the two behind it.
    assert.deepEqual(result.envelope.delta.deferredToTrusted, ["issue-1"]);
    assert.equal(cellRig.github.refreshes, 0, name);
    const serialRig = await frontLine(shape);
    const { lines: serialLines } = await captured(() =>
      runRepairCycle(serialRig.deps, {
        deadline: serialRig.clock.now() + 90 * MINUTE,
        stepLimit: 1_000,
        modelStartsEnabled: true,
      })
    );
    // The serial pass refreshes that same front and holds the same two.
    assert.deepEqual(
      serialRig.github.preparedKeys.map((key) => key.split(":")[0]),
      ["101"],
      name,
    );
    const behind = (lines: Record<string, unknown>[]) =>
      deferrals(lines).filter(([id]) => id !== "issue-1");
    const held = [["issue-2", "ci_line"], ["issue-3", "ci_line"]];
    assert.deepEqual(behind(serialLines), held, `${name}: serial`);
    assert.deepEqual(behind(cellLines), held, `${name}: cell`);
  }
});
