/** Strict cell identity and result-ingestion safeguards. */
import assert from "node:assert/strict";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { resetCellTimeouts } from "../../src/host/matrix-ingest-state.ts";
import { createRunBounds } from "../../src/repair/loop.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { T0 } from "../state/helpers.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { decompositionChildId } from "../../src/repair/transitions.ts";
import {
  activeIntent,
  ACTUAL,
  freshIssue,
  issueRow,
  makeRig,
  parkedNonReady,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

/** Part 1 of 2 of a decomposed issue carrying one consecutive timeout. */
function timedOutPart(issue: WorkRecordV1): WorkRecordV1 {
  const id = asWorkItemId(decompositionChildId(issue.id, 1, 2));
  return {
    ...issue,
    id,
    target: { ...issue.target, branch: candidateBranch(id) },
    counters: { ...issue.counters, timeouts: 1 },
  };
}

Deno.test("matrix ingestion: missing, stale and foreign grants preserve exact admission without a write", async () => {
  const rig = await makeRig([990001], 1);
  try {
    const seeded = await rig.store.writeRepair(
      seedSnapshot([freshIssue(990001, rig.base)]),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const planned = await planMatrixWave(rig.deps, rig.planOptions());
    assert.equal(planned.prepared, 1);
    const cell = planned.plan.cells[0];
    const before = await snapshot(rig);
    let writes = 0;
    const deps = {
      ...rig.deps,
      state: {
        ...rig.store,
        readRepair: () => rig.store.readRepair(),
        readRelease: () => rig.store.readRelease(),
        writeRepair: (...args: Parameters<typeof rig.store.writeRepair>) => {
          writes++;
          return rig.store.writeRepair(...args);
        },
      },
    };
    for (
      const selected of [
        cell,
        { ...cell, reservationId: "stale-reservation" },
        { ...cell, repository: { ...cell.repository, name: "foreign" } },
      ]
    ) {
      const plan = { ...planned.plan, cells: [selected] };
      for (let scan = 0; scan < 2; scan++) {
        const report = await ingestMatrixResults(
          deps,
          plan,
          [],
          rig.ingestOptions(),
        );
        assert.equal(report.ingested, 0);
        assert.equal(report.entries[0].disposition, "missing");
        assert.equal(
          report.entries[0].detail,
          "no result artifact; durable charge stays unreconciled",
        );
        assert.deepEqual(await snapshot(rig), before);
      }
    }
    assert.equal(
      writes,
      0,
      "absence cannot establish terminal producer evidence",
    );
    assert.equal(rig.model.requests.length, 0);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix ingestion: settled exact candidate resets its timeout streak through real Git CAS", async () => {
  const rig = await makeRig([990002], 1);
  try {
    // A whole issue with any time-bound exhaustion is decomposed instead of
    // planned again, so the streak that resets is a decomposition part's.
    const issue = timedOutPart(freshIssue(990002, rig.base));
    const seeded = await rig.store.writeRepair(
      seedSnapshot([issue]),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const planned = await planMatrixWave(rig.deps, rig.planOptions());
    assert.equal(planned.prepared, 1);
    const cell = planned.plan.cells[0];
    const ctx = await rig.claimCell(cell);
    const result = await runMatrixCell(
      ctx.deps,
      { waveId: WAVE, run: RUN, cell },
      ACTUAL,
      T0,
    );
    assert.equal(result.status, "completed");
    await rig.transfer([result], [ctx]);
    const report = await ingestMatrixResults(
      rig.deps,
      planned.plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(report.ingested, 1);
    const after = await snapshot(rig);
    assert.equal(
      after.work[0].counters.timeouts,
      undefined,
      "a completed settled candidate breaks the timeout streak",
    );
    assert.equal(after.work[0].intent?.kind, "candidate_preservation");
    assert.equal(after.work[0].intent?.requestId, cell.reservationId);
    assert.equal(after.reservations[0].outcome, "submitted");
    assert.notEqual(after.reservations[0].settledAt, null);
    const replay = await ingestMatrixResults(
      rig.deps,
      planned.plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(replay.ingested, 0);
    assert.deepEqual(
      await snapshot(rig),
      after,
      "replay never resets, settles or admits again",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix ingestion: timeout reset refuses unbound admission and incomplete CAS proof", async (t) => {
  const rig = await makeRig([990004], 1);
  try {
    // A whole issue with any time-bound exhaustion is decomposed instead of
    // planned again, so the streak that resets is a decomposition part's.
    const issue = timedOutPart(freshIssue(990004, rig.base));
    const seeded = await rig.store.writeRepair(
      seedSnapshot([issue]),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const planned = await planMatrixWave(rig.deps, rig.planOptions());
    assert.equal(planned.prepared, 1);
    const cell = planned.plan.cells[0];
    const bounds = createRunBounds(rig.deps, {
      deadline: rig.ingestOptions().deadline,
    });
    const reserved = await snapshot(rig);
    assert.equal(await resetCellTimeouts(rig.deps, bounds, cell), false);
    assert.deepEqual(
      await snapshot(rig),
      reserved,
      "an unsettled live admission is not reset",
    );
    const ctx = await rig.claimCell(cell);
    const result = await runMatrixCell(
      ctx.deps,
      { waveId: WAVE, run: RUN, cell },
      ACTUAL,
      T0,
    );
    await rig.transfer([result], [ctx]);
    assert.equal(
      (await ingestMatrixResults(
        rig.deps,
        planned.plan,
        [result],
        rig.ingestOptions(),
      )).ingested,
      1,
    );
    const current = await rig.store.readRepair();
    assert.ok(current.ok && current.value.status === "found");
    if (!current.ok || current.value.status !== "found") {
      throw new Error("settled state missing");
    }
    const retained = await rig.store.writeRepair({
      ...current.value.snapshot,
      stateHead: current.value.head,
      sequence: current.value.snapshot.sequence + 1,
      work: current.value.snapshot.work.map((work) => ({
        ...work,
        counters: { ...work.counters, timeouts: 1 },
      })),
    }, current.value.head);
    assert.ok(retained.ok && retained.value.status === "applied");
    const before = await snapshot(rig);
    for (
      const unbound of [{ ...cell, reservationId: "foreign" }, {
        ...cell,
        requestDigest: "0".repeat(64),
      }, { ...cell, repository: { ...cell.repository, name: "foreign" } }]
    ) {
      assert.equal(await resetCellTimeouts(rig.deps, bounds, unbound), false);
      assert.deepEqual(await snapshot(rig), before);
    }
    for (const mode of ["conflict", "ambiguous", "unavailable"] as const) {
      await t.step(mode, async () => {
        let writes = 0;
        const deps = {
          ...rig.deps,
          state: {
            ...rig.store,
            readRepair: () => rig.store.readRepair(),
            readRelease: () => rig.store.readRelease(),
            writeRepair: async (
              ...[next, expectedHead]: Parameters<typeof rig.store.writeRepair>
            ) => {
              writes++;
              const actual = await rig.store.readRepair();
              assert.ok(actual.ok && actual.value.status === "found");
              if (!actual.ok || actual.value.status !== "found") {
                throw new Error("CAS state missing");
              }
              assert.equal(
                expectedHead,
                actual.value.head,
                "CAS uses actual current commit, not manifest parent",
              );
              assert.equal(next.stateHead, actual.value.head);
              assert.deepEqual(
                next.reservations,
                actual.value.snapshot.reservations,
              );
              assert.deepEqual(
                next.work[0].intent,
                before.work[0].intent,
                "timeout reset cannot clear candidate custody",
              );
              return mode === "unavailable"
                ? portError("unavailable", "injected state write unavailable")
                : portOk({ status: mode, currentHead: actual.value.head });
            },
          },
        };
        assert.equal(await resetCellTimeouts(deps, bounds, cell), false);
        assert.equal(writes, 1);
        assert.deepEqual(
          await snapshot(rig),
          before,
          "unapplied writes preserve the exact candidate and charge",
        );
      });
    }
    await t.step("applied write with unavailable readback", async () => {
      let wrote = false;
      const deps = {
        ...rig.deps,
        state: {
          ...rig.store,
          readRepair: () =>
            wrote
              ? Promise.resolve(
                portError("unavailable", "injected readback unavailable"),
              )
              : rig.store.readRepair(),
          readRelease: () => rig.store.readRelease(),
          writeRepair: async (
            ...args: Parameters<typeof rig.store.writeRepair>
          ) => {
            const applied = await rig.store.writeRepair(...args);
            assert.ok(applied.ok && applied.value.status === "applied");
            wrote = true;
            return applied;
          },
        },
      };
      assert.equal(
        await resetCellTimeouts(deps, bounds, cell),
        false,
        "unreadable completion cannot establish a successful reset",
      );
      const after = await snapshot(rig);
      assert.equal(after.work[0].counters.timeouts, undefined);
      assert.deepEqual(after.work[0].intent, before.work[0].intent);
      assert.deepEqual(after.reservations, before.reservations);
    });
  } finally {
    await rig.cleanup();
  }
});

Deno.test(
  "matrix runtime: review, delivery and already-intended records get no grant or charge",
  async () => {
    const rig = await makeRig([501, 502, 503, 504], 1);
    try {
      const existing = "res-existing";
      const written = await rig.store.writeRepair(
        seedSnapshot([
          freshIssue(501, rig.base),
          parkedNonReady(502, "review", rig.base),
          parkedNonReady(503, "delivery", rig.base),
          activeIntent(504, existing, rig.base),
        ]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const report = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(
        report.plan.cells.length,
        1,
        "only the ready issue is planned",
      );
      assert.equal(
        report.notReady,
        0,
        "nonready records are filtered before consideration",
      );
      assert.equal(report.deferred, 0);
      assert.equal(report.plan.cells[0].taskId, "issue-501");

      const after = await snapshot(rig);
      assert.equal(
        after.reservations.length,
        1,
        "one charge for the ready issue",
      );
      const intended = after.work.find((record) =>
        record.intent?.requestId === existing
      );
      assert.ok(intended, "the in-flight implementation record survives");
      assert.equal(
        after.reservations.some((entry) => entry.taskId === "issue-504"),
        false,
        "no second charge for the in-flight record",
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "matrix runtime: changed, closed or opted-out source refuses before any model call",
  async () => {
    const rig = await makeRig([401], 1);
    try {
      const written = await rig.store.writeRepair(
        seedSnapshot([freshIssue(401, rig.base)]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const report = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(report.plan.cells.length, 1);
      const ctx = await rig.claimCell(report.plan.cells[0]);
      const grant = { waveId: WAVE, run: RUN, cell: report.plan.cells[0] };
      const before = await snapshot(rig);

      rig.github.latest.set(401, {
        ...issueRow(401),
        title: "renamed after planning",
      });
      assert.equal(
        (await runMatrixCell(ctx.deps, grant, ACTUAL, T0)).status,
        "not_started",
      );
      rig.github.latest.set(401, {
        ...issueRow(401),
        state: "closed",
        closedAt: T0,
      });
      assert.equal(
        (await runMatrixCell(ctx.deps, grant, ACTUAL, T0)).status,
        "not_started",
      );
      rig.github.latest.set(401, {
        ...issueRow(401),
        labels: ["sentinel:skip"],
      });
      assert.equal(
        (await runMatrixCell(ctx.deps, grant, ACTUAL, T0)).status,
        "not_started",
      );
      assert.equal(
        rig.model.requests.length,
        0,
        "no inference for a stale plan",
      );

      const after = await snapshot(rig);
      assert.equal(after.sequence, before.sequence, "no state write occurred");
      assert.equal(after.reservations[0].outcome, "reserved");
      assert.equal(
        after.work[0].intent?.requestId,
        before.work[0].intent?.requestId,
      );
    } finally {
      await rig.cleanup();
    }
  },
);
