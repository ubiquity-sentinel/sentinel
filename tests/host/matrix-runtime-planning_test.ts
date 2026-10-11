/** Real planner/cell/ingester overlap, readiness and transfer lifecycle. */
import assert from "node:assert/strict";
import {
  MATRIX_PLAN_VERSION,
  type MatrixCellResultV1,
  matrixDigestV1,
} from "../../src/contracts/matrix.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { gitRun, T0 } from "../state/helpers.ts";
import {
  ACTUAL,
  completedReceipt,
  DEADLINE,
  freshIssue,
  LAUNCHER,
  makeRig,
  parkedNonReady,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

Deno.test(
  "matrix runtime: two admitted tasks overlap, transfer real objects, ingest and publish",
  async () => {
    const rig = await makeRig([201, 202], 2);
    try {
      const written = await rig.store.writeRepair(
        seedSnapshot([freshIssue(201, rig.base), freshIssue(202, rig.base)]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const report = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(report.plan.version, MATRIX_PLAN_VERSION);
      assert.equal(report.plan.cells.length, 2);
      assert.equal(report.prepared, 2);
      assert.equal(report.notReady, 0);
      const reservations = (await snapshot(rig)).reservations;
      assert.equal(reservations.length, 2, "one durable admission per cell");
      assert.equal(new Set(reservations.map((r) => r.id)).size, 2);
      for (const cell of report.plan.cells) {
        assert.equal(cell.expectedBase, rig.base);
        assert.match(cell.cellId, /^[0-9a-f]{64}$/, "opaque safe cell id");
        assert.equal(cell.requestDigest, await matrixDigestV1(cell.request));
      }

      const ctxs = await Promise.all(
        report.plan.cells.map((cell) => rig.claimCell(cell)),
      );
      const results = await Promise.all(
        ctxs.map((ctx) =>
          runMatrixCell(
            ctx.deps,
            { waveId: WAVE, run: RUN, cell: ctx.cell },
            ACTUAL,
            T0,
          )
        ),
      );
      assert.equal(rig.model.maxActive, 2, "two model sessions overlapped");
      assert.ok(results.every((result) => result.status === "completed"));
      for (const result of results) {
        assert.ok(result.bundle, "completed results carry a real bundle");
      }
      const heads = results.map((result) =>
        completedReceipt(result).candidate!.head!
      );
      for (const head of heads) {
        assert.equal(await rig.objectPresent(head), false, "absent before");
      }
      await rig.transfer(results, ctxs);
      const ingest = await ingestMatrixResults(
        rig.deps,
        report.plan,
        results,
        rig.ingestOptions(),
      );
      assert.equal(ingest.ingested, 2);
      for (const head of heads) {
        assert.equal(await rig.objectPresent(head), true, "present after");
        assert.ok(
          (await gitRun(
            rig.mirrorRepo,
            ["merge-base", "--is-ancestor", rig.base, head],
            rig.env,
          )).ok,
          "imported candidate descends from the base",
        );
      }

      const outcome = await runRepairCycle(rig.deps, {
        deadline: DEADLINE,
        stepLimit: 32,
      });
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const records = (await snapshot(rig)).work.map((record) => ({
        id: record.id,
        nextStep: record.nextStep,
        wait: record.wait?.reason ?? null,
        blocker: record.blocker?.message ?? null,
      }));
      assert.equal(
        rig.github.pushes.length,
        2,
        `one candidate push per task (${JSON.stringify(outcome)}): ${
          JSON.stringify(records)
        }`,
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        2,
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "matrix runtime: identity, receipt, bundle and duplicate gates isolate siblings",
  async () => {
    const rig = await makeRig([301, 302, 303], 1);
    try {
      const written = await rig.store.writeRepair(
        seedSnapshot([
          freshIssue(301, rig.base),
          freshIssue(302, rig.base),
          parkedNonReady(303, "review", rig.base),
        ]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const report = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(
        report.plan.cells.length,
        2,
        "only ready records are granted",
      );
      assert.equal(
        report.notReady,
        0,
        "nonready records are filtered before consideration",
      );
      const [first, second] = report.plan.cells;

      const badRun = await runMatrixCell(
        (await rig.claimCell(first)).deps,
        { waveId: WAVE, run: RUN, cell: first },
        { run: { ...RUN, runAttempt: 2 }, runtimeSha: LAUNCHER, generation: 1 },
        T0,
      );
      assert.equal(badRun.status, "failed");
      const badGeneration = await runMatrixCell(
        (await rig.claimCell(first)).deps,
        { waveId: WAVE, run: RUN, cell: first },
        { run: RUN, runtimeSha: LAUNCHER, generation: 2 },
        T0,
      );
      assert.equal(badGeneration.status, "failed");
      assert.equal(
        rig.model.requests.length,
        0,
        "no model for mismatched runs",
      );

      const substitutedRequest = {
        ...first.request,
        issue: second.request.issue,
      };
      const wrongSourceCell = {
        ...first,
        request: substitutedRequest,
        requestDigest: await matrixDigestV1(substitutedRequest),
      };
      assert.equal(
        (await runMatrixCell(
          (await rig.claimCell(first)).deps,
          { waveId: WAVE, run: RUN, cell: wrongSourceCell },
          ACTUAL,
          T0,
        )).status,
        "not_started",
        "another real issue cannot substitute for the authoritative task source",
      );
      const foreignRepository = {
        ...first.repository,
        installationId: first.repository.installationId + 1,
      };
      const foreignRequest = {
        ...first.request,
        repository: foreignRepository,
      };
      const wrongRepositoryCell = {
        ...first,
        repository: foreignRepository,
        request: foreignRequest,
        requestDigest: await matrixDigestV1(foreignRequest),
      };
      assert.equal(
        (await runMatrixCell(
          (await rig.claimCell(first)).deps,
          { waveId: WAVE, run: RUN, cell: wrongRepositoryCell },
          ACTUAL,
          T0,
        )).status,
        "not_started",
        "self-consistent grant repository must still match authoritative task",
      );
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      const actualRead = read.value;
      const mismatchedAdmission = parseRepairStateSnapshotV1({
        ...actualRead.snapshot,
        reservations: actualRead.snapshot.reservations.map((reservation) =>
          reservation.id === first.reservationId
            ? { ...reservation, attempt: reservation.attempt + 1 }
            : reservation
        ),
      });
      const admissionCtx = await rig.claimCell(first);
      assert.equal(
        (await runMatrixCell(
          {
            ...admissionCtx.deps,
            state: {
              readRepair: () =>
                Promise.resolve(
                  portOk({ ...actualRead, snapshot: mismatchedAdmission }),
                ),
              readRelease: () => rig.store.readRelease(),
            },
          },
          { waveId: WAVE, run: RUN, cell: first },
          ACTUAL,
          T0,
        )).status,
        "not_started",
        "reservation attempt must match authoritative task attempt",
      );
      assert.equal(rig.model.requests.length, 0);

      const ctx = await rig.claimCell(first);
      const completed = await runMatrixCell(
        ctx.deps,
        { waveId: WAVE, run: RUN, cell: first },
        ACTUAL,
        T0,
      );
      assert.equal(completed.status, "completed");
      const head = completedReceipt(completed).candidate!.head!;

      const receipt = completedReceipt(completed);
      const wrongModel: MatrixCellResultV1 = {
        ...completed,
        receipt: {
          ...receipt,
          actual: { ...receipt.actual, observedModel: "gpt-other" },
        },
      };
      const beforeReject = await snapshot(rig);
      const rejected = await ingestMatrixResults(
        rig.deps,
        report.plan,
        [wrongModel],
        rig.ingestOptions(),
      );
      assert.equal(
        rejected.entries.find((entry) => entry.cellId === first.cellId)
          ?.disposition,
        "receipt_rejected",
      );
      assert.equal(rejected.ingested, 0);
      assert.equal((await snapshot(rig)).sequence, beforeReject.sequence);
      assert.equal(await rig.objectPresent(head), false, "no import on reject");

      // Missing bundle bytes are never accepted as a candidate.
      const noBundle: MatrixCellResultV1 = { ...completed, bundle: null };
      const unavailable = await ingestMatrixResults(
        rig.deps,
        report.plan,
        [noBundle],
        rig.ingestOptions(),
      );
      assert.equal(
        unavailable.entries.find((entry) => entry.cellId === first.cellId)
          ?.disposition,
        "candidate_unavailable",
      );
      assert.equal(await rig.objectPresent(head), false);

      // Conflicting duplicate artifacts for one cell are both refused.
      await rig.transfer([completed], [ctx]);
      const conflict = await ingestMatrixResults(
        rig.deps,
        report.plan,
        [
          { ...completed, completedAt: T0 },
          { ...completed, completedAt: T0 + 1 },
        ],
        rig.ingestOptions(),
      );
      assert.equal(
        conflict.entries.find((entry) => entry.cellId === first.cellId)
          ?.disposition,
        "conflict",
      );
      assert.equal(conflict.ingested, 0);

      const foreign: MatrixCellResultV1 = {
        ...completed,
        cellId: "f".repeat(64),
      };
      const mixed = await ingestMatrixResults(
        rig.deps,
        report.plan,
        [foreign, completed],
        rig.ingestOptions(),
      );
      assert.equal(
        mixed.entries.find((entry) => entry.cellId === "f".repeat(64))
          ?.disposition,
        "foreign",
      );
      assert.equal(mixed.ingested, 1);
      assert.equal(await rig.objectPresent(head), true, "imported on ingest");
      const afterFirst = await snapshot(rig);
      const secondRecord = afterFirst.work.find((record) =>
        record.id === second.taskId
      );
      assert.equal(secondRecord?.intent?.requestId, second.reservationId);
      assert.equal(
        afterFirst.reservations.find((entry) =>
          entry.id === second.reservationId
        )?.outcome,
        "reserved",
      );

      const replay = await ingestMatrixResults(
        rig.deps,
        report.plan,
        [completed],
        rig.ingestOptions(),
      );
      assert.equal(replay.ingested, 0);
      assert.equal(
        replay.entries.find((entry) => entry.cellId === first.cellId)
          ?.disposition,
        "duplicate",
      );
    } finally {
      await rig.cleanup();
    }
  },
);
