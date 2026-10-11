/** Strict cell identity and result-ingestion safeguards. */
import assert from "node:assert/strict";
import { planMatrixWave, runMatrixCell } from "../../src/host/matrix.ts";
import { T0 } from "../state/helpers.ts";
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
