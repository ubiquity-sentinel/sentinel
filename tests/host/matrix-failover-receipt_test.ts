/**
 * A matrix receipt produced by the model port's HTTP 429 failover truthfully
 * records the route's failover model, not the planned primary. The real
 * ingester accepts exactly that trusted failover id (supplied by the trusted
 * host options, never by the artifact) and settles it like a primary receipt;
 * every other model, provider or reasoning is still refused with no write, and
 * every written shape parses with the generation-76 parsers.
 */
import assert from "node:assert/strict";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import type {
  MatrixCellPlanV1,
  MatrixCellResultV1,
  MatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import {
  type ModelRunReceiptV1,
  type ModelRunRequestV1,
  portError,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { resolveModelRoute } from "../../src/host/model-route.ts";
import {
  ATTEMPT_DETAIL_INCOMPLETE,
  ATTEMPT_DETAIL_INTERRUPTED_BOUND,
  ATTEMPT_DETAIL_PROVIDER_THROTTLED,
} from "../../src/repair/attempt-policy.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  PROVIDER,
  type RigV1,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";
import {
  assertGeneration76Accepts,
  generation76Present,
  withGeneration76Parsers,
} from "./generation-76-contracts.ts";

/** The trusted route failover, resolved exactly as the hosted runtime does. */
const FAILOVER = resolveModelRoute({}).failoverModel;
const PRIMARY = "gpt-reserve";
const RATE_LIMITED = "exceeded retry limit, last status: 429 Too Many Requests";

type RunModel = (
  request: ModelRunRequestV1,
) => Promise<PortResultV1<ModelRunReceiptV1>>;

function failedReceipt(
  observedModel: string,
  error: string,
): ModelRunReceiptV1 {
  return {
    invocationId: "codex-failover-1",
    outcome: "failed",
    actual: {
      evidenceKind: "request-runtime",
      provider: PROVIDER,
      threadId: "thread-failover",
      turnId: "turn-failover",
      terminalOrigin: "runtime",
      observedTerminalStatus: "failed",
      observedModel,
      observedReasoning: "max",
      durationMs: 450,
      outputChars: 9_455,
    },
    candidate: null,
    error,
  };
}

/** One seeded fresh issue planned into a one-cell wave. */
async function planned(
  rig: RigV1,
  issue: number,
): Promise<{ plan: MatrixPlanV1; cell: MatrixCellPlanV1 }> {
  const seeded = await rig.store.writeRepair(
    seedSnapshot([freshIssue(issue, rig.base)]),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  const report = await planMatrixWave(rig.deps, rig.planOptions());
  assert.equal(report.prepared, 1, JSON.stringify(report));
  assert.equal(report.plan.cells[0].request.model, PRIMARY);
  return { plan: report.plan, cell: report.plan.cells[0] };
}

/** One real isolated cell run of `runModel` (the cell itself writes nothing). */
async function runCell(
  rig: RigV1,
  cell: MatrixCellPlanV1,
  runModel: RunModel,
): Promise<MatrixCellResultV1> {
  const ctx = await rig.claimCell(cell);
  // deno-lint-ignore no-explicit-any
  (ctx.deps as any).model = { modelId: PRIMARY, runModel };
  const result = await runMatrixCell(
    ctx.deps,
    { waveId: WAVE, run: RUN, cell },
    ACTUAL,
    rig.clock.now(),
  );
  await rig.transfer([result], [ctx]);
  return result;
}

/**
 * The installed generation-76 cell's export of one port receipt: it has no
 * throttled refusal, so every receipt leaves the cell as `completed` with the
 * runtime error text replaced by the fixed classification.
 */
function generation76Export(
  binding: MatrixCellResultV1,
  receipt: ModelRunReceiptV1,
): MatrixCellResultV1 {
  return {
    ...binding,
    status: "completed",
    receipt: {
      ...receipt,
      error: receipt.error === null || receipt.error === "failed_command_loop"
        ? receipt.error
        : "runtime_error",
    },
    bundle: null,
    detail: null,
  };
}

/** The hosted runtime's trusted ingestion options for this route. */
function trusted(rig: RigV1) {
  return { ...rig.ingestOptions(), failoverModel: FAILOVER };
}

/** Rig-independent settlement facts of the one seeded record. */
function settlement(state: RepairStateSnapshotV1) {
  const work = state.work[0];
  return {
    nextStep: work.nextStep,
    blocker: work.blocker === null
      ? null
      : { kind: work.blocker.kind, message: work.blocker.message },
    intent: work.intent === null ? null : work.intent.kind,
    workKeys: Object.keys(work).sort(),
    reservations: state.reservations.map((row) => ({
      keys: Object.keys(row).sort(),
      outcome: row.outcome,
      purpose: row.purpose,
      proofRef: row.proofRef,
      settled: row.settledAt !== null,
    })),
    memory: state.attemptMemory.flatMap((memory) =>
      memory.entries.map((entry) => ({
        detail: entry.detail,
        stage: entry.stage,
        failureClass: entry.failureClass,
        count: entry.count,
      }))
    ),
  };
}

/** The settlement charged nothing new and refunded nothing. */
function assertChargedOnce(
  state: RepairStateSnapshotV1,
  cell: MatrixCellPlanV1,
  outcome: "ambiguous" | "submitted",
) {
  assert.equal(state.reservations.length, 1, "no new charge");
  const charge = state.reservations[0];
  assert.equal(charge.id, cell.reservationId);
  assert.equal(charge.outcome, outcome, "never refunded");
  assert.equal(charge.proofRef, null);
  assert.notEqual(charge.settledAt, null);
}

/** A generation-76 failover export of a throttled run, ingested. */
async function generation76FailoverFlow(issue: number, observedModel: string) {
  const rig = await makeRig([issue], 1);
  try {
    const { plan, cell } = await planned(rig, issue);
    const receipt = failedReceipt(observedModel, RATE_LIMITED);
    const refused = await runCell(
      rig,
      cell,
      () => Promise.resolve(portOk(receipt)),
    );
    const exported = generation76Export(refused, receipt);
    const report = await ingestMatrixResults(
      rig.deps,
      plan,
      [exported],
      trusted(rig),
    );
    return { cell, refused, exported, report, state: await snapshot(rig) };
  } finally {
    await rig.cleanup();
  }
}

/** A completed candidate whose receipt records `observedModel`, ingested. */
async function candidateFlow(issue: number, observedModel: string) {
  const rig = await makeRig([issue], 1);
  try {
    const { plan, cell } = await planned(rig, issue);
    const result = await runCell(rig, cell, async (request) => {
      const ran = await rig.model.runModel(request);
      return ran.ok
        ? portOk({
          ...ran.value,
          actual: { ...ran.value.actual, observedModel },
        })
        : ran;
    });
    assert.equal(result.status, "completed");
    assert.equal(result.receipt?.actual.observedModel, observedModel);
    const head = result.receipt?.candidate?.head ?? null;
    assert.ok(head !== null && result.bundle !== null);
    const before = await rig.store.readRepair();
    const untrusted = await ingestMatrixResults(
      rig.deps,
      plan,
      [result],
      rig.ingestOptions(),
    );
    const afterUntrusted = await rig.store.readRepair();
    const report = await ingestMatrixResults(
      rig.deps,
      plan,
      [result],
      trusted(rig),
    );
    const state = await snapshot(rig);
    // A replay of the consumed artifact (the saved-preservation path also
    // re-verifies the receipt) never settles or charges again.
    const replay = await ingestMatrixResults(
      rig.deps,
      plan,
      [result],
      trusted(rig),
    );
    return {
      cell,
      head,
      result,
      untrusted,
      unchanged: JSON.stringify(before) === JSON.stringify(afterUntrusted),
      report,
      state,
      replay: replay.entries.map((entry) => entry.disposition),
      replayState: await snapshot(rig),
      imported: await rig.objectPresent(head),
    };
  } finally {
    await rig.cleanup();
  }
}

Deno.test("failover receipt: the trusted runtime route failover is the documented default", () => {
  assert.equal(FAILOVER, "gpt-6-luna");
  assert.notEqual(FAILOVER, PRIMARY);
});

Deno.test(
  "failover receipt: a throttled failover run settles as transient throttling through the 429 lane",
  async () => {
    const rig = await makeRig([990501], 1);
    try {
      const { plan, cell } = await planned(rig, 990501);
      const result = await runCell(
        rig,
        cell,
        () => Promise.resolve(portOk(failedReceipt(FAILOVER, RATE_LIMITED))),
      );
      assert.equal(result.status, "failed");
      assert.equal(result.detail, ATTEMPT_DETAIL_PROVIDER_THROTTLED);
      assert.equal(result.receipt, null);
      const report = await ingestMatrixResults(
        rig.deps,
        plan,
        [result],
        trusted(rig),
      );
      assert.equal(report.ingested, 1, JSON.stringify(report.entries));
      const state = await snapshot(rig);
      assert.equal(state.work[0].nextStep, "blocked");
      assert.equal(
        state.work[0].blocker?.message,
        ATTEMPT_DETAIL_PROVIDER_THROTTLED,
      );
      assert.equal(
        state.attemptMemory[0].entries[0].failureClass,
        "transient_infrastructure",
      );
      assertChargedOnce(state, cell, "ambiguous");
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "failover receipt: a generation-76 failed failover export settles exactly like a primary failed receipt",
  async () => {
    const failover = await generation76FailoverFlow(990502, FAILOVER);
    assert.equal(failover.exported.status, "completed");
    assert.equal(failover.exported.receipt?.outcome, "failed");
    assert.equal(failover.exported.receipt?.actual.observedModel, FAILOVER);
    assert.equal(failover.exported.receipt?.error, "runtime_error");
    assert.deepEqual(
      failover.report.entries.map((entry) => entry.disposition),
      ["ingested"],
      JSON.stringify(failover.report.entries),
    );
    assert.equal(failover.state.work[0].nextStep, "blocked");
    assert.equal(
      failover.state.work[0].blocker?.message,
      ATTEMPT_DETAIL_INCOMPLETE,
    );
    assertChargedOnce(failover.state, failover.cell, "ambiguous");
    const primary = await generation76FailoverFlow(990503, PRIMARY);
    assert.equal(primary.report.ingested, 1);
    assert.deepEqual(
      settlement(failover.state),
      settlement(primary.state),
      "the failover receipt takes the unchanged normal failed path",
    );
  },
);

Deno.test(
  "failover receipt: a completed failover candidate is accepted and noted exactly like a primary candidate",
  async () => {
    const failover = await candidateFlow(990504, FAILOVER);
    assert.deepEqual(
      failover.untrusted.entries.map((entry) => entry.disposition),
      ["receipt_rejected"],
      "without the trusted host failover id the receipt never verifies",
    );
    assert.ok(failover.unchanged, "a rejected receipt writes nothing");
    assert.deepEqual(
      failover.report.entries.map((entry) => entry.disposition),
      ["ingested"],
      JSON.stringify(failover.report.entries),
    );
    const work = failover.state.work[0];
    assert.equal(work.target.head, failover.head);
    assert.equal(work.intent?.kind, "candidate_preservation");
    assert.ok(failover.imported, "candidate objects reached the mirror");
    assertChargedOnce(failover.state, failover.cell, "submitted");
    const primary = await candidateFlow(990505, PRIMARY);
    assert.deepEqual(
      primary.untrusted.entries.map((entry) => entry.disposition),
      ["ingested"],
    );
    assert.deepEqual(settlement(failover.state), settlement(primary.state));
    assert.deepEqual(failover.replay, ["duplicate"]);
    assert.deepEqual(
      failover.replayState.reservations,
      failover.state.reservations,
      "a replay charges and refunds nothing",
    );
  },
);

Deno.test(
  "failover receipt: a third model, a wrong provider or non-max reasoning is still receipt_rejected",
  async () => {
    const rig = await makeRig([990506], 1);
    try {
      const { plan, cell } = await planned(rig, 990506);
      const binding = await runCell(
        rig,
        cell,
        () => Promise.resolve(portError("unavailable", "inert binding port")),
      );
      const base = failedReceipt(FAILOVER, "boom");
      const variants: [string, ModelRunReceiptV1, string | undefined][] = [
        [
          "arbitrary third model",
          {
            ...base,
            actual: { ...base.actual, observedModel: "gpt-arbitrary" },
          },
          FAILOVER,
        ],
        [
          "failover on a wrong provider",
          { ...base, actual: { ...base.actual, provider: "deepseek" } },
          FAILOVER,
        ],
        [
          "failover with non-max reasoning",
          { ...base, actual: { ...base.actual, observedReasoning: "high" } },
          FAILOVER,
        ],
        ["failover with no trusted failover option", base, undefined],
        ["failover with an empty trusted failover option", base, ""],
      ];
      const before = await rig.store.readRepair();
      for (const [label, receipt, failoverModel] of variants) {
        const report = await ingestMatrixResults(
          rig.deps,
          plan,
          [generation76Export(binding, receipt)],
          {
            ...rig.ingestOptions(),
            ...(failoverModel === undefined ? {} : { failoverModel }),
          },
        );
        assert.deepEqual(
          report.entries.map((entry) => entry.disposition),
          ["receipt_rejected"],
          label,
        );
        assert.deepEqual(await rig.store.readRepair(), before, label);
      }
      const state = await snapshot(rig);
      assert.equal(state.work[0].nextStep, "work");
      assert.equal(state.work[0].intent?.kind, "implementation");
      assert.equal(state.reservations[0].outcome, "reserved");
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "failover receipt: an interrupted failover output-bound receipt settles as the interrupted bound",
  async () => {
    const rig = await makeRig([990507], 1);
    try {
      const { plan, cell } = await planned(rig, 990507);
      const binding = await runCell(
        rig,
        cell,
        () => Promise.resolve(portError("unavailable", "inert binding port")),
      );
      const receipt: ModelRunReceiptV1 = {
        ...failedReceipt(FAILOVER, "output bound"),
        outcome: "interrupted",
        actual: {
          ...failedReceipt(FAILOVER, "output bound").actual,
          observedTerminalStatus: "interrupted",
          durationMs: 1_000,
          outputChars: cell.request.maxOutputChars + 1,
        },
      };
      const report = await ingestMatrixResults(
        rig.deps,
        plan,
        [generation76Export(binding, receipt)],
        trusted(rig),
      );
      assert.equal(report.ingested, 1, JSON.stringify(report.entries));
      const state = await snapshot(rig);
      assert.equal(
        state.work[0].blocker?.message,
        ATTEMPT_DETAIL_INTERRUPTED_BOUND,
      );
      assertChargedOnce(state, cell, "ambiguous");
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test({
  name:
    "failover receipt: generation-76 parsers accept every failover export and settlement",
  ignore: !generation76Present(),
  fn: async () => {
    const failed = await generation76FailoverFlow(990508, FAILOVER);
    const candidate = await candidateFlow(990509, FAILOVER);
    assert.equal(failed.report.ingested, 1);
    assert.equal(candidate.report.ingested, 1);
    await withGeneration76Parsers((gen76) => {
      assertGeneration76Accepts(
        gen76.parseCellResult,
        failed.exported,
        "generation-76 failover export",
      );
      assertGeneration76Accepts(
        gen76.parseCellResult,
        candidate.result,
        "completed failover candidate artifact",
      );
      assertGeneration76Accepts(
        gen76.parseRepairState,
        failed.state,
        "failed failover settlement",
      );
      assertGeneration76Accepts(
        gen76.parseRepairState,
        candidate.state,
        "noted failover candidate",
      );
      return Promise.resolve();
    });
  },
});
