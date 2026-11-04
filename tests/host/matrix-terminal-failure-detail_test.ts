/** Closed failure causes survive the cell → trusted park boundary, not diagnostics. */
import assert from "node:assert/strict";
import { repeatFailureStreak } from "../../ops/hosted-autonomy-repeat-failure.ts";
import { parseMatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import { type ModelRunReceiptV1, portOk } from "../../src/contracts/ports.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { ATTEMPT_DETAIL_INCOMPLETE } from "../../src/repair/attempt-policy.ts";
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

const cases = [
  // The ordinary failed receipt from the 429 regression must also expose its
  // cause on current cells, without becoming a provider-throttled outcome.
  {
    kind: "failed",
    outcome: "failed",
    origin: "runtime",
    error: "boom",
  },
  {
    kind: "failed",
    outcome: "failed",
    origin: "runtime",
    error: "private runtime diagnostic",
  },
  {
    kind: "interrupted",
    outcome: "interrupted",
    origin: "runtime",
    error: null,
  },
  {
    kind: "host-timeout",
    outcome: "failed",
    origin: "host-timeout",
    error: "private timeout diagnostic",
  },
  {
    kind: "dirty-tree",
    outcome: "failed",
    origin: "runtime",
    error: "dirty-tree",
  },
  {
    kind: "failed",
    outcome: "failed",
    origin: "runtime",
    error: "private runtime diagnostic",
    carrierDetail: null,
  },
  {
    kind: "failed",
    outcome: "failed",
    origin: "runtime",
    error: "private runtime diagnostic",
    carrierDetail: "untrusted private diagnostic",
  },
  {
    kind: "failed_command_loop",
    outcome: "interrupted",
    origin: "runtime",
    error: "failed_command_loop",
    carrierDetail: `${ATTEMPT_DETAIL_INCOMPLETE} (failed)`,
  },
] as const;

for (const [index, testCase] of cases.entries()) {
  Deno.test(`matrix terminal detail: ${testCase.kind} parks without raw diagnostics or policy changes (${index})`, async () => {
    const rig = await makeRig([990285], 1);
    try {
      const seeded = await rig.store.writeRepair(
        seedSnapshot([freshIssue(990285, rig.base)]),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      const planned = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(planned.prepared, 1);
      const cell = planned.plan.cells[0];
      const ctx = await rig.claimCell(cell);
      const receipt: ModelRunReceiptV1 = {
        invocationId: "terminal-detail-invocation",
        outcome: testCase.outcome,
        actual: {
          evidenceKind: "request-runtime",
          provider: PROVIDER,
          threadId: "terminal-detail-thread",
          turnId: "terminal-detail-turn",
          terminalOrigin: testCase.origin,
          observedTerminalStatus: testCase.origin === "host-timeout"
            ? null
            : testCase.outcome,
          observedModel: cell.request.model,
          observedReasoning: cell.request.reasoning,
          durationMs: 1000,
          outputChars: 100,
        },
        candidate: null,
        error: testCase.error,
      };
      const result = await runMatrixCell(
        {
          ...ctx.deps,
          model: {
            modelId: cell.request.model,
            runModel: () => Promise.resolve(portOk(receipt)),
          },
        },
        { waveId: WAVE, run: RUN, cell },
        ACTUAL,
        rig.clock.now(),
      );
      assert.equal(result.status, "completed");
      const special = testCase.kind === "failed_command_loop";
      const expected = special
        ? "failed_command_loop"
        : `${ATTEMPT_DETAIL_INCOMPLETE} (${testCase.kind})`;
      assert.equal(
        result.detail,
        special ? null : expected,
      );
      assert.ok(!JSON.stringify(result).includes("private"));
      const carrier = parseMatrixCellResultV1(
        JSON.parse(JSON.stringify(result)),
      );
      if ("carrierDetail" in testCase) carrier.detail = testCase.carrierDetail;
      const before = await snapshot(rig);
      const report = await ingestMatrixResults(
        rig.deps,
        planned.plan,
        [carrier],
        rig.ingestOptions(),
      );
      assert.equal(report.ingested, 1, JSON.stringify(report.entries));
      const after = await snapshot(rig);
      assert.equal(after.work[0].nextStep, "blocked");
      assert.equal(
        after.work[0].blocker?.message,
        "carrierDetail" in testCase && !special
          ? ATTEMPT_DETAIL_INCOMPLETE
          : expected,
      );
      const genericRecord = {
        ...after.work[0],
        blocker: {
          ...after.work[0].blocker!,
          message: special ? "failed_command_loop" : ATTEMPT_DETAIL_INCOMPLETE,
        },
      };
      assert.deepEqual(
        repeatFailureStreak(after, after.work[0]),
        repeatFailureStreak(after, genericRecord),
        "the diagnostic must not change the repeat-failure gate or signature",
      );
      assert.equal(after.reservations.length, before.reservations.length);
      assert.equal(after.reservations[0].outcome, "ambiguous");
      assert.notEqual(after.reservations[0].settledAt, null);
      assert.equal(
        after.attemptMemory[0].entries[0].detail,
        special ? "failed_command_loop" : ATTEMPT_DETAIL_INCOMPLETE,
      );
      assert.equal(
        after.attemptMemory[0].entries[0].failureClass,
        "semantic_no_progress",
      );
    } finally {
      await rig.cleanup();
    }
  });
}
