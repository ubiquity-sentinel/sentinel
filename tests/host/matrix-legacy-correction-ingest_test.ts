/**
 * Hosted ingest of a LEGACY correction cell (issue #103 follow-up): a record
 * whose published head predates candidate state is a hosted matrix start once
 * a review rejected that head. When the predecessor observation is unavailable
 * at ingest, the receipt must not be consumed: noting the candidate in its
 * legacy shape would clear the implementation intent without a preservation
 * intent, so no later consumer could re-import the artifact, and a fresh
 * runner's mirror could never restore the candidate (legacy restoration
 * accepts only the task-branch head). The ingest defers instead, leaving the
 * reservation reserved and the intent bound, and the next scan ingests it.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop-eligibility.ts";
import { reviewReceipt, SHA2, T0, workRecord } from "../state/helpers.ts";
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

Deno.test("matrix ingest: an unavailable predecessor observation of a legacy correction defers without consuming the receipt", async () => {
  const rig = await makeRig([ISSUE], 1);
  try {
    // Legacy shape: the published head SHA2 carries no candidate state, and a
    // completed review rejected it with an unresolved P0 (only a P0 rejects).
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
    const rejected = reviewReceipt("legacy-rejection", {
      pullRequest: { number: 7, head: SHA2, base: rig.base },
      outcome: "completed",
      observedReviewer: "chatgpt-codex-connector[bot]",
      resultId: "legacy-rejection-result",
      findings: [{
        id: "legacy-rejection-finding-0",
        fingerprint: "f".repeat(64),
        severity: "P0",
        path: "src/app.ts",
        message: "legacy correction finding",
        resolutionEvidence: null,
        resolved: false,
      }],
      unresolvedSeverities: ["P0"],
      submittedAt: T0 - 3_000,
      completedAt: T0 - 2_000,
      observedAt: T0 - 1_000,
    });
    const seeded = parseRepairStateSnapshotV1({
      ...seedSnapshot([record]),
      reviews: [rejected],
    });
    const written = await rig.store.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const hosted = { ...rig.deps, externalImplementations: true };
    assert.equal(record.target.candidateState, undefined, "legacy record");
    assert.ok(
      isMatrixImplementationReadyV1(record, seeded, rig.deps.configs[0], T0),
      "a review-rejected legacy head IS a hosted matrix start",
    );

    const planned = await planMatrixWave(hosted, rig.planOptions());
    assert.equal(planned.plan.cells.length, 1, JSON.stringify(planned));
    const cell = planned.plan.cells[0];
    assert.equal(cell.request.checkoutBase, SHA2, "a correction of SHA2");
    const ctx = await rig.claimCell(cell);
    const result = await runMatrixCell(
      ctx.deps,
      { waveId: WAVE, run: RUN, cell },
      ACTUAL,
      T0,
    );
    assert.equal(result.status, "completed");
    await rig.transfer([result], [ctx]);
    const candidate = result.receipt!.candidate!.head as GitSha;

    // The owned branch still carries SHA2, but its read is unavailable now.
    let unavailable = true;
    const branchRef = `refs/heads/${BRANCH}`;
    const readRef = rig.github.readRef.bind(rig.github);
    rig.github.readRef = (ref: string) =>
      ref !== branchRef ? readRef(ref) : Promise.resolve(
        unavailable
          ? portError("unavailable", "ref read unavailable")
          : { ok: true as const, value: { ref, sha: SHA2 } },
      );

    const before = await snapshot(rig);
    assert.equal(before.work[0].intent?.kind, "implementation");
    const deferred = await ingestMatrixResults(
      hosted,
      planned.plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(deferred.ingested, 0, JSON.stringify(deferred));
    assert.equal(deferred.entries[0].disposition, "deferred");
    assert.deepEqual(
      await snapshot(rig),
      before,
      "nothing consumed: the charge stays reserved and the intent bound",
    );

    // The consumer's next scan still selects the charged producer and, with
    // the observation back, ingests it durably: the predecessor is verified
    // and the candidate is bound to its preservation intent.
    unavailable = false;
    const ingested = await ingestMatrixResults(
      hosted,
      planned.plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(ingested.ingested, 1, JSON.stringify(ingested));
    const after = (await snapshot(rig)).work[0];
    assert.equal(after.target.head, candidate);
    assert.deepEqual(after.target.candidateState, {
      preserved: null,
      publishedHead: SHA2,
    });
    assert.equal(after.intent?.kind, "candidate_preservation");
    assert.equal(after.intent?.requestId, cell.reservationId);
    const charge = (await snapshot(rig)).reservations.find((row) =>
      row.id === cell.reservationId
    );
    assert.equal(charge?.outcome, "submitted", "charged, never refunded");
  } finally {
    await rig.cleanup();
  }
});
