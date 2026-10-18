/**
 * JAM B6a through the hosted matrix: a head whose latest review found the
 * task acceptance not fulfilled is a hosted correction start. The trusted
 * planner charges one `retry` cell continuing that head with the acceptance
 * statement as its first finding, the cell runs, and the ingest consumes it
 * like any P0/P1 correction. R80's own plan parser accepts the planned wave
 * (the rollback target consumes cells this generation planned).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type * as Matrix from "../../src/contracts/matrix.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { withAcceptanceFinding } from "../../src/repair/acceptance-correction.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop-eligibility.ts";
import { SHA2, T0, workRecord } from "../state/helpers.ts";
import { completedReceipt } from "../repair/loop-review-fixtures.ts";
import { NOT_FULFILLED } from "../repair/acceptance-fixtures.ts";
import {
  loadR80Modules,
  r80Available,
} from "../repair/acceptance-r80-source.ts";
import {
  ACTUAL,
  makeRig,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

const ISSUE = 401;
const BRANCH = candidateBranch(`issue-${ISSUE}` as never);
const available = await r80Available();

Deno.test("matrix: a not-fulfilled acceptance is planned, run and ingested as a charged correction cell", async () => {
  const rig = await makeRig([ISSUE], 1);
  try {
    const record = workRecord(`issue-${ISSUE}`, {
      source: { kind: "issue", id: String(ISSUE), revision: rig.base },
      related: { incidentId: null, issueNumber: ISSUE },
      target: {
        base: rig.base,
        branch: BRANCH,
        checkpoint: null,
        head: SHA2,
        pr: 7,
      },
      nextStep: "work",
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
      firstSeenAt: T0 - 60_000,
    });
    const receipt = await withAcceptanceFinding(
      completedReceipt(7, SHA2, rig.base, {
        repository: record.repository,
        taskAcceptance: { ...NOT_FULFILLED, issueNumber: ISSUE },
        submittedAt: T0 - 3_000,
        completedAt: T0 - 2_000,
        observedAt: T0 - 1_000,
      }),
    );
    assert.ok(receipt);
    const seeded = parseRepairStateSnapshotV1({
      ...seedSnapshot([record]),
      reviews: [receipt],
    });
    const written = await rig.store.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const hosted = { ...rig.deps, externalImplementations: true };
    assert.ok(
      isMatrixImplementationReadyV1(record, seeded, rig.deps.configs[0], T0),
    );

    const planned = await planMatrixWave(hosted, rig.planOptions());
    assert.equal(planned.plan.cells.length, 1, JSON.stringify(planned));
    const cell = planned.plan.cells[0];
    assert.equal(cell.request.checkoutBase, SHA2, "continues the refused head");
    assert.deepEqual(cell.request.reviewFindings?.[0], {
      severity: "P1",
      path: null,
      message: receipt.findings[0]!.message,
    });
    const charged = await snapshot(rig);
    assert.equal(charged.work[0].intent?.kind, "implementation");
    assert.equal(charged.reservations.length, 1, "one charged correction");
    assert.equal(charged.reservations[0].purpose, "retry");

    const ctx = await rig.claimCell(cell);
    const result = await runMatrixCell(
      ctx.deps,
      { waveId: WAVE, run: RUN, cell },
      ACTUAL,
      T0,
    );
    assert.equal(result.status, "completed");
    await rig.transfer([result], [ctx]);
    const ingested = await ingestMatrixResults(
      hosted,
      planned.plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(ingested.ingested, 1, JSON.stringify(ingested));
    const after = await snapshot(rig);
    assert.equal(after.work[0].target.head, result.receipt!.candidate!.head);
    assert.notEqual(after.work[0].target.head, SHA2 as GitSha);
    assert.equal(
      after.reservations.find((row) => row.id === cell.reservationId)
        ?.outcome,
      "submitted",
      "charged, never refunded",
    );
    assert.deepEqual(after.reviews, [receipt], "the receipt stays verbatim");
  } finally {
    await rig.cleanup();
  }
});

Deno.test({
  name: "matrix: R80's plan parser accepts the planned acceptance correction",
  ignore: !available,
  async fn() {
    const loaded = await loadR80Modules(["src/contracts/matrix.ts"]);
    const rig = await makeRig([ISSUE], 1);
    try {
      const [r80] = loaded.modules as unknown as [typeof Matrix];
      const record = workRecord(`issue-${ISSUE}`, {
        source: { kind: "issue", id: String(ISSUE), revision: rig.base },
        related: { incidentId: null, issueNumber: ISSUE },
        target: {
          base: rig.base,
          branch: BRANCH,
          checkpoint: null,
          head: SHA2,
          pr: 7,
        },
        nextStep: "work",
        counters: { attempts: 1, retries: 0, reviewRounds: 1 },
        firstSeenAt: T0 - 60_000,
      });
      const receipt = await withAcceptanceFinding(
        completedReceipt(7, SHA2, rig.base, {
          repository: record.repository,
          taskAcceptance: { ...NOT_FULFILLED, issueNumber: ISSUE },
          submittedAt: T0 - 3_000,
          completedAt: T0 - 2_000,
          observedAt: T0 - 1_000,
        }),
      );
      const written = await rig.store.writeRepair(
        parseRepairStateSnapshotV1({
          ...seedSnapshot([record]),
          reviews: [receipt],
        }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const planned = await planMatrixWave(
        { ...rig.deps, externalImplementations: true },
        rig.planOptions(),
      );
      assert.equal(planned.plan.cells.length, 1);
      const parsed = r80.parseMatrixPlanV1(
        JSON.parse(canonicalStringify(planned.plan)),
      );
      assert.equal(
        canonicalStringify(parsed),
        canonicalStringify(planned.plan),
      );
    } finally {
      await rig.cleanup();
      await loaded.dispose();
    }
  },
});
