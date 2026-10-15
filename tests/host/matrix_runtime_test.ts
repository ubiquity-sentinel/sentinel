import { SHA1 as ATTEMPT_RUNTIME } from "../state/helpers.ts";
/** Trusted provider routes and charged interrupted-output refusal. */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { ModelRunReceiptV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
  verifyMatrixReceiptV1,
} from "../../src/host/matrix.ts";
import { SHA2, T0 } from "../state/helpers.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  PROVIDER,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

Deno.test("matrix runtime: the trusted provider allowlist accepts documented routes only", () => {
  const request = {
    model: "fixture-model",
    reasoning: "max",
    maxDurationMs: 1_000,
    maxOutputChars: 100,
  };
  const receipt: ModelRunReceiptV1 = {
    invocationId: "provider-allowlist",
    outcome: "interrupted",
    actual: {
      evidenceKind: "request-runtime",
      provider: "deepseek",
      threadId: "fixture-thread",
      turnId: "fixture-turn",
      terminalOrigin: "runtime",
      observedTerminalStatus: "interrupted",
      observedModel: request.model,
      observedReasoning: request.reasoning,
      durationMs: 10,
      outputChars: 10,
    },
    candidate: null,
    error: null,
  };
  assert.equal(
    verifyMatrixReceiptV1(receipt, request, [PROVIDER, "deepseek"]),
    true,
    "the documented fallback provider stays acceptable",
  );
  assert.equal(
    verifyMatrixReceiptV1(receipt, request, PROVIDER),
    false,
    "a single mismatched provider still refuses",
  );
  assert.equal(
    verifyMatrixReceiptV1(receipt, request, [PROVIDER, "deepseek", ""]),
    true,
  );
});
Deno.test("matrix runtime: authenticated interrupted output overage stays charged and blocked with strict guards", async () => {
  const rig = await makeRig([754, 755], 1, {
    maxDurationMs: 1_800_000,
    maxOutputChars: 4_000_000,
  });
  try {
    const seeded = await rig.store.writeRepair(
      seedSnapshot([freshIssue(754, rig.base), freshIssue(755, rig.base)]),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const plan = (await planMatrixWave(rig.deps, rig.planOptions())).plan;
    const cell = plan.cells.find((row) => row.request.issue?.number === 754)!;
    const sibling = plan.cells.find((row) =>
      row.request.issue?.number === 755
    )!;
    const ctx = await rig.claimCell(cell);
    const receipt: ModelRunReceiptV1 = {
      invocationId: "interrupted-output-bound",
      outcome: "interrupted",
      actual: {
        evidenceKind: "request-runtime",
        provider: PROVIDER,
        threadId: "fixture-thread",
        turnId: "fixture-turn",
        terminalOrigin: "runtime",
        observedTerminalStatus: "interrupted",
        observedModel: cell.request.model,
        observedReasoning: cell.request.reasoning,
        durationMs: 480_793,
        outputChars: 5_081_256,
      },
      candidate: null,
      error: null,
    };
    const originalReceipt = canonicalStringify(receipt);
    ctx.deps.model.runModel = () => Promise.resolve(portOk(receipt));
    const result = await runMatrixCell(
      ctx.deps,
      { waveId: WAVE, run: RUN, cell },
      ACTUAL,
      T0,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.bundle, null);
    assert.equal(
      verifyMatrixReceiptV1(receipt, cell.request, PROVIDER),
      false,
      "exported verifier must continue refusing over-limit receipts",
    );
    const before = await snapshot(rig);
    const negativeReceipts: ModelRunReceiptV1[] = [
      {
        ...receipt,
        outcome: "completed",
        actual: { ...receipt.actual, observedTerminalStatus: "completed" },
      },
      {
        ...receipt,
        candidate: {
          head: SHA2,
          checkpointSha: null,
          changedPaths: ["candidate.txt"],
        },
      },
      ...["provider", "observedModel", "observedReasoning", "evidenceKind"].map(
        (
          field,
        ) => ({
          ...receipt,
          actual: { ...receipt.actual, [field]: "wrong" },
        } as ModelRunReceiptV1),
      ),
      {
        ...receipt,
        actual: { ...receipt.actual, terminalOrigin: "host-timeout" },
      },
      {
        ...receipt,
        actual: { ...receipt.actual, observedTerminalStatus: "completed" },
      },
      { ...receipt, actual: { ...receipt.actual, durationMs: 1_800_001 } },
      { ...receipt, actual: { ...receipt.actual, durationMs: NaN } },
      { ...receipt, actual: { ...receipt.actual, outputChars: Infinity } },
      { ...receipt, actual: { ...receipt.actual, threadId: "" } },
      { ...receipt, actual: { ...receipt.actual, turnId: "" } },
    ];
    const options = {
      ...rig.ingestOptions(),
      bundleImporter: {
        import: () => {
          throw Error(
            "negative interrupted attempt must not import candidates",
          );
        },
      },
    };
    for (const wrong of negativeReceipts) {
      const rejected = await ingestMatrixResults(rig.deps, plan, [{
        ...result,
        receipt: wrong,
      }], options);
      assert.equal(
        rejected.entries.find((entry) => entry.cellId === cell.cellId)
          ?.disposition,
        "receipt_rejected",
      );
      assert.deepEqual(await snapshot(rig), before);
    }
    const bundled = await ingestMatrixResults(rig.deps, plan, [{
      ...result,
      bundle: {
        file: cell.cellId + ".bundle",
        digest: "a".repeat(64),
        head: SHA2,
        checkpointSha: null,
      },
    }], options);
    assert.equal(
      bundled.entries.find((entry) => entry.cellId === cell.cellId)
        ?.disposition,
      "receipt_rejected",
    );
    const ingested = await ingestMatrixResults(
      rig.deps,
      plan,
      [result],
      options,
    );
    assert.equal(
      ingested.ingested,
      1,
      "authenticated terminal noncandidate failure must reach existing failure accounting",
    );
    const after = await snapshot(rig);
    // Durable attempt memory carries the trusted stage/class diagnostics for
    // the same settlement: the run was invoked (stage model) and the failure
    // is infrastructure-shaped, so it consumes the transient allowance.
    const memory = after.attemptMemory.find((row) =>
      row.taskId === cell.taskId
    )!;
    const memoryEntry = memory.entries.find((row) =>
      row.detail ===
        "model run did not complete with a trusted candidate: interrupted output bound exceeded"
    )!;
    assert.equal(memoryEntry.stage, "model");
    assert.equal(memoryEntry.failureClass, "transient_infrastructure");
    assert.equal(memoryEntry.count, 1);
    const charge = after.reservations.find((row) =>
      row.id === cell.reservationId
    )!;
    const work = after.work.find((row) => row.id === cell.taskId)!;
    assert.equal(charge.outcome, "ambiguous");
    assert.equal(charge.proofRef, null);
    assert.notEqual(charge.settledAt, null);
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.intent?.requestId, cell.reservationId);
    assert.equal(work.target.head, null);
    assert.equal(work.target.checkpoint, null);
    assert.equal(
      after.reservations.find((row) => row.id === sibling.reservationId)!
        .outcome,
      "reserved",
    );
    assert.equal(
      canonicalStringify(result.receipt),
      originalReceipt,
      "observed metrics and original evidence remain unchanged",
    );
    rig.clock.advance(1000);
    const replay = await ingestMatrixResults(rig.deps, plan, [result], options);
    assert.equal(replay.ingested, 0);
    assert.equal(
      replay.entries.find((entry) => entry.cellId === cell.cellId)?.disposition,
      "duplicate",
    );
    assert.deepEqual(
      await snapshot(rig),
      after,
      "replay preserves settlement and blocker timestamps without writes",
    );
    const read = await rig.store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const retries = planHostedRetries(
      read.value.snapshot,
      rig.clock.now(),
      ATTEMPT_RUNTIME,
    );
    assert.equal(retries.length, 1);
    const retried = await rig.store.writeRepair(
      applyHostedRetries(
        read.value.snapshot,
        read.value.head,
        retries,
        rig.clock.now(),
      ),
      read.value.head,
    );
    assert.ok(retried.ok && retried.value.status === "applied");
    const next = await planMatrixWave(rig.deps, {
      ...rig.planOptions(),
      waveId: "next-wave",
      run: { ...RUN, runId: 42 },
      plannedAt: rig.clock.now(),
    });
    const nextCell = next.plan.cells.find((row) => row.taskId === cell.taskId)!;
    assert.ok(nextCell && nextCell.reservationId !== cell.reservationId);
    const beforeStale = await snapshot(rig);
    const stale = await ingestMatrixResults(rig.deps, plan, [result], options);
    assert.equal(stale.ingested, 0);
    assert.deepEqual(
      await snapshot(rig),
      beforeStale,
      "original artifact cannot consume the new retry operation",
    );
    assert.deepEqual(
      beforeStale.reservations.find((row) => row.id === cell.reservationId),
      charge,
    );
    assert.equal(rig.model.requests.length, 0);
  } finally {
    await rig.cleanup();
  }
});
