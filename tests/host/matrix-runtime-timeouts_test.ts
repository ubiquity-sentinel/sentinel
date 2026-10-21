/** Timeout accounting, decomposition and retained start-window boundaries. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseMatrixModelRequestV1 } from "../../src/contracts/matrix.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { portError } from "../../src/contracts/ports.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { createRunBounds, loadRepairContext } from "../../src/repair/loop.ts";
import { handleImplementationUncertainty } from "../../src/repair/loop-implementation-result.ts";
import { T0 } from "../state/helpers.ts";
import {
  attemptFingerprintV1,
  attemptMemoryIdV1,
  parseAttemptMemoryRecordV1,
} from "../../src/contracts/attempt-memory.ts";
import {
  ATTEMPT_DETAIL_INCOMPLETE,
  ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
  attemptMemorySettlementMutationV1,
} from "../../src/repair/attempt-policy.ts";
import { tryParse } from "../../src/contracts/validation.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  seedSnapshot,
} from "./matrix-runtime-fixtures.ts";

Deno.test(
  "matrix runtime: durable attempt memory refuses an equivalent planner admission until evidence changes",
  async () => {
    const rig = await makeRig([754], 1);
    try {
      const seeded = seedSnapshot([freshIssue(754, rig.base)]);
      const record = seeded.work[0];
      // Two recorded semantic no-progress outcomes at this exact base and
      // runtime revision, built with the production identity derivation.
      const id = await attemptMemoryIdV1({
        repository: record.repository,
        taskId: record.id,
        base: record.target.base,
        purpose: "implementation",
      });
      const fingerprint = await attemptFingerprintV1({
        taskId: record.id,
        base: record.target.base,
        purpose: "implementation",
        controllerSha: record.controller.sha,
        detail: ATTEMPT_DETAIL_INCOMPLETE,
      });
      const memory = parseAttemptMemoryRecordV1({
        version: "v1",
        kind: "attempt_memory",
        id,
        repository: record.repository,
        taskId: record.id,
        base: record.target.base,
        purpose: "implementation",
        entries: [
          {
            fingerprint,
            stage: "model",
            failureClass: "semantic_no_progress",
            detail: ATTEMPT_DETAIL_INCOMPLETE,
            controllerSha: record.controller.sha,
            count: 2,
            firstAtMs: T0,
            lastAtMs: T0 + 1000,
          },
        ],
      });
      const written = await rig.store.writeRepair(
        parseRepairStateSnapshotV1({ ...seeded, attemptMemory: [memory] }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // Equivalent attempt at the same base and revision: refused, nothing
      // charged, and the refusal is visible in the report.
      const activeDeps = { ...rig.deps, controllerSha: record.controller.sha };
      const activeOptions = {
        ...rig.planOptions(),
        runtimeSha: record.controller.sha,
      };
      const refused = await planMatrixWave(activeDeps, activeOptions);
      assert.equal(refused.memoryRefused, 1);
      assert.equal(refused.plan.cells.length, 0);
      assert.equal(refused.attempted, 1);

      // Changed evidence: the repository's default branch genuinely moves,
      // so the record's target base follows it. The durable memory stays
      // bound to the OLD base (append-only) and no longer applies, so this
      // admission proceeds.
      const otherBase = "0123456789abcdef0123456789abcdef01234567" as GitSha;
      (rig.github as unknown as { options: { baseSha?: GitSha } }).options
        .baseSha = otherBase;
      const movedRecord = {
        ...record,
        target: { ...record.target, base: otherBase },
        updatedAt: T0,
      };
      const rewritten = await rig.store.writeRepair(
        parseRepairStateSnapshotV1({
          ...seeded,
          stateHead: written.value.status === "applied"
            ? written.value.head
            : null,
          sequence: seeded.sequence + 1,
          updatedAt: T0,
          work: [movedRecord],
          attemptMemory: [memory],
          lessons: [],
        }),
        written.value.status === "applied" ? written.value.head : null,
      );
      assert.ok(rewritten.ok && rewritten.value.status === "applied");
      const admitted = await planMatrixWave(activeDeps, activeOptions);
      assert.equal(admitted.memoryRefused, 0);
      assert.equal(admitted.plan.cells.length, 1);
      assert.equal(admitted.plan.cells[0].taskId, record.id);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "matrix runtime: versioned regression facts round-trip through the strict request parser",
  () => {
    const base = "1ad85317e2e681b9deb5a2f4c7b653df34a691b7" as GitSha;
    const prior = "ee5e6518a4333c20d8bc6a4c3c577a2536ec6b9b" as GitSha;
    const request = {
      taskId: "issue-parser-1",
      repository: {
        owner: "Ubiquity-Sentinel",
        name: "sentinel",
        installationId: 0,
      },
      base,
      issue: null,
      evidence: [],
      regressions: [
        {
          detail: "model run did not complete with a trusted candidate",
          priorSuccessRevision: prior,
          priorSuccessAtMs: T0,
          failuresAtCurrentRevision: 3,
          lastFailureAtMs: T0 + 1000,
        },
      ],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 1000,
      maxOutputChars: 1000,
    };
    const parsed = parseMatrixModelRequestV1(request, "$");
    assert.equal(parsed.regressions?.length, 1);
    assert.equal(parsed.regressions?.[0].priorSuccessRevision, prior);

    const malformed = {
      ...request,
      regressions: [{ ...request.regressions[0], extra: true }],
    };
    const rejected = tryParse(
      (value) => parseMatrixModelRequestV1(value, "$"),
      malformed,
    );
    assert.equal(rejected.ok, false);
  },
);

Deno.test("matrix runtime: authenticated runtime change admits immutable-origin work without erasing memory", async () => {
  const rig = await makeRig([755], 1);
  try {
    const seeded = seedSnapshot([freshIssue(755, rig.base)]);
    const record = seeded.work[0];
    const origin = record.controller.sha;
    const runtime = "b".repeat(40) as GitSha;
    const memory = parseAttemptMemoryRecordV1({
      version: "v1",
      kind: "attempt_memory",
      id: await attemptMemoryIdV1({
        repository: record.repository,
        taskId: record.id,
        base: record.target.base,
        purpose: "implementation",
      }),
      repository: record.repository,
      taskId: record.id,
      base: record.target.base,
      purpose: "implementation",
      entries: [{
        fingerprint: await attemptFingerprintV1({
          taskId: record.id,
          base: record.target.base,
          purpose: "implementation",
          controllerSha: origin,
          detail: ATTEMPT_DETAIL_INCOMPLETE,
        }),
        stage: "model",
        failureClass: "semantic_no_progress",
        detail: ATTEMPT_DETAIL_INCOMPLETE,
        controllerSha: origin,
        count: 2,
        firstAtMs: T0,
        lastAtMs: T0 + 1000,
      }],
    });
    const written = await rig.store.writeRepair(
      parseRepairStateSnapshotV1({ ...seeded, attemptMemory: [memory] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");
    const refused = await planMatrixWave(
      { ...rig.deps, controllerSha: origin },
      { ...rig.planOptions(), runtimeSha: origin },
    );
    assert.equal(refused.memoryRefused, 1);
    const admitted = await planMatrixWave({
      ...rig.deps,
      controllerSha: runtime,
    }, { ...rig.planOptions(), runtimeSha: runtime });
    assert.equal(
      admitted.plan.cells.length,
      1,
      "new authenticated runtime is changed evidence at the same base",
    );
    assert.equal(admitted.memoryRefused, 0);
    const after = await rig.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(after.value.snapshot.work[0].controller.sha, origin);
    assert.equal(after.value.snapshot.work[0].target.base, record.target.base);
    assert.deepEqual(after.value.snapshot.attemptMemory, [memory]);
    assert.equal(after.value.snapshot.reservations.length, 1);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("matrix runtime: real Git runtime changes preserve producer memory, charges and custody", async () => {
  const rig = await makeRig([756, 757], 1);
  try {
    const record = freshIssue(756, rig.base), origin = record.controller.sha;
    const runtimeB = "b".repeat(40) as GitSha;
    const seeded = await rig.store.writeRepair(seedSnapshot([record]), null);
    assert.ok(seeded.ok && seeded.value.status === "applied");
    let fakeCalls = 0;
    for (
      const runtime of [
        origin,
        origin,
        origin,
        origin,
        runtimeB,
        runtimeB,
        runtimeB,
        runtimeB,
      ]
    ) {
      const before = await rig.store.readRepair();
      assert.ok(before.ok && before.value.status === "found");
      if (before.value.snapshot.work[0].nextStep === "blocked") {
        if (runtime === runtimeB && fakeCalls === 4) {
          assert.equal(
            planHostedRetries(before.value.snapshot, rig.clock.now(), origin)
              .length,
            0,
          );
        }
        const plans = planHostedRetries(
          before.value.snapshot,
          rig.clock.now(),
          runtime,
        );
        assert.equal(plans.length, 1);
        const reopened = applyHostedRetries(
          before.value.snapshot,
          before.value.head,
          plans,
          rig.clock.now(),
        );
        const written = await rig.store.writeRepair(
          reopened,
          before.value.head,
        );
        assert.ok(written.ok && written.value.status === "applied");
      }
      const deps = { ...rig.deps, controllerSha: runtime };
      const planned = await planMatrixWave(deps, {
        ...rig.planOptions(),
        runtimeSha: runtime,
      });
      assert.equal(planned.plan.cells.length, 1);
      const cell = planned.plan.cells[0], claimed = await rig.claimCell(cell);
      const cellDeps: Parameters<typeof runMatrixCell>[0] = {
        ...claimed.deps,
        model: {
          runModel: async (request) => {
            const reserved = await rig.store.readRepair();
            assert.ok(reserved.ok && reserved.value.status === "found");
            assert.equal(
              reserved.value.snapshot.reservations.find((r) =>
                r.id === cell.reservationId
              )?.outcome,
              "reserved",
            );
            assert.equal(
              reserved.value.snapshot.reservations.find((r) =>
                r.id === cell.reservationId
              )?.attempt,
              fakeCalls + 1,
            );
            assert.equal(request.base, record.target.base);
            fakeCalls++;
            return portError("unavailable", "offline fixture model failure");
          },
        },
      };
      const result = await runMatrixCell(
        cellDeps,
        { waveId: planned.plan.waveId, run: planned.plan.run, cell },
        { ...ACTUAL, runtimeSha: runtime },
        T0,
      );
      // A newer importing host must retain the authenticated producing runtime.
      const ingested = await ingestMatrixResults(
        { ...rig.deps, controllerSha: runtimeB },
        planned.plan,
        [result],
        rig.ingestOptions(),
      );
      assert.equal(ingested.ingested, 1, JSON.stringify(ingested));
      const after = await rig.store.readRepair();
      assert.ok(after.ok && after.value.status === "found");
      assert.equal(after.value.snapshot.work[0].controller.sha, origin);
      assert.equal(
        after.value.snapshot.attemptMemory[0].entries.at(-1)?.controllerSha,
        runtime,
      );
      assert.equal(after.value.snapshot.reservations.length, fakeCalls);
      assert.ok(
        after.value.snapshot.reservations.every((r) =>
          r.outcome === "ambiguous"
        ),
      );
    }
    const exhausted = await rig.store.readRepair();
    assert.ok(exhausted.ok && exhausted.value.status === "found");
    const charges = structuredClone(exhausted.value.snapshot.reservations);
    const entries = exhausted.value.snapshot.attemptMemory[0].entries;
    assert.deepEqual(entries.map((e) => [e.controllerSha, e.count]), [[
      origin,
      4,
    ], [runtimeB, 4]]);
    const duplicate = await rig.deps.budget.reserveModelStart({
      repository: record.repository,
      taskId: record.id,
      head: record.target.base!,
      attempt: 5,
      purpose: "retry",
    });
    assert.notEqual(
      duplicate.status,
      "reserved",
      "the fifth identity cannot be charged twice",
    );
    // Replay a newly observed old-runtime outcome after B's exhausted entry.
    rig.clock.advance(1);
    const late = await attemptMemorySettlementMutationV1({
      record: exhausted.value.snapshot.work[0],
      runtimeSha: origin,
      detail: ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
      now: rig.clock.now(),
    });
    const draft = structuredClone(exhausted.value.snapshot);
    late(draft);
    draft.stateHead = exhausted.value.head;
    draft.sequence++;
    draft.updatedAt = rig.clock.now();
    const written = await rig.store.writeRepair(draft, exhausted.value.head);
    assert.ok(
      written.ok && written.value.status === "applied",
      JSON.stringify(written),
    );
    const denials: string[] = [];
    assert.equal(
      planHostedRetries(
        draft,
        rig.clock.now(),
        runtimeB,
        new Map(),
        new Set(),
        (d) => denials.push(d.reason),
      ).length,
      0,
    );
    assert.match(denials[0], /^equivalent_attempt_refused:/);
    assert.deepEqual(draft.reservations, charges);
    assert.equal(
      draft.attemptMemory[0].entries.find((e) => e.controllerSha === runtimeB)
        ?.count,
      4,
    );
    assert.equal(
      draft.attemptMemory[0].entries.find((e) =>
        e.controllerSha === origin &&
        e.detail === "model run failed (unavailable)"
      )?.count,
      4,
    );
    // Unknown saved-intent custody cannot invent a B outcome or become eligible.
    const bounds = createRunBounds({ ...rig.deps, controllerSha: runtimeB }, {
      deadline: rig.planOptions().deadline,
    });
    const context = await loadRepairContext(rig.deps, bounds);
    assert.ok(context);
    const uncertainty = await handleImplementationUncertainty(
      { ...rig.deps, controllerSha: runtimeB },
      context,
      context.snapshot.work[0],
    );
    assert.equal(uncertainty.kind, "progress");
    const blocked = await rig.store.readRepair();
    assert.ok(blocked.ok && blocked.value.status === "found");
    assert.deepEqual(blocked.value.snapshot.attemptMemory, draft.attemptMemory);
    assert.deepEqual(blocked.value.snapshot.reservations, charges);
    assert.equal(blocked.value.snapshot.work[0].nextStep, "blocked");
    assert.equal(
      planHostedRetries(
        blocked.value.snapshot,
        rig.clock.now(),
        "c".repeat(40) as GitSha,
      ).length,
      0,
    );
    // A separate ordinary eligible task records successful B execution under A origin.
    const next = {
      ...blocked.value.snapshot,
      stateHead: blocked.value.head,
      work: [...blocked.value.snapshot.work, freshIssue(757, rig.base)],
      sequence: blocked.value.snapshot.sequence + 1,
      updatedAt: rig.clock.now(),
    };
    const added = await rig.store.writeRepair(next, blocked.value.head);
    assert.ok(added.ok && added.value.status === "applied");
    const successPlan = await planMatrixWave({
      ...rig.deps,
      controllerSha: runtimeB,
    }, { ...rig.planOptions(), runtimeSha: runtimeB });
    assert.equal(successPlan.plan.cells.length, 1);
    const successCell = successPlan.plan.cells[0],
      claimed = await rig.claimCell(successCell);
    const success = await runMatrixCell(
      claimed.deps,
      {
        waveId: successPlan.plan.waveId,
        run: successPlan.plan.run,
        cell: successCell,
      },
      { ...ACTUAL, runtimeSha: runtimeB },
      T0,
    );
    await rig.transfer([success], [claimed]);
    assert.equal(
      (await ingestMatrixResults(
        { ...rig.deps, controllerSha: runtimeB },
        successPlan.plan,
        [success],
        rig.ingestOptions(),
      )).ingested,
      1,
    );
    const final = await rig.store.readRepair();
    assert.ok(final.ok && final.value.status === "found");
    assert.equal(
      final.value.snapshot.attemptMemory.find((m) =>
        m.taskId === successCell.taskId
      )?.lastSuccessRevision,
      runtimeB,
    );
    assert.equal(
      final.value.snapshot.work.find((w) => w.id === successCell.taskId)
        ?.controller.sha,
      origin,
    );
    assert.deepEqual(
      final.value.snapshot.reservations.filter((r) => r.taskId === record.id),
      charges,
    );
  } finally {
    await rig.cleanup();
  }
});
