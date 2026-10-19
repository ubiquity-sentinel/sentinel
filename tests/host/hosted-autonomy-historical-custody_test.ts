import assert from "node:assert/strict";
import { DORMANT_HOSTED_POLICIES } from "./actions-supervisor-fixture.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import {
  HISTORICAL_MATRIX_QUARANTINE,
  HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE,
  runHistoricalMatrixQuarantine,
} from "../../src/host/matrix-actions.ts";
import { runHostedSupervisorFinalize } from "../../src/host/actions-supervisor.ts";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import {
  createHostedHistoricalMatrixQuarantine,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import { reservation, T0, workRecord } from "../state/helpers.ts";
import {
  BASE,
  blockedRecord,
  deliveryRecord,
  SELF_REPO,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";
import { historicalWithNewerCurrent } from "./hosted-autonomy-newer-current-fixtures.ts";

Deno.test("historical missing-cell quarantine: strict leaf, retained ambiguous charge and idempotent maintenance", async () => {
  const f = await historicalMalformedRig(true, 1, true, true);
  const previousCwd = Deno.cwd();
  Deno.chdir(f.checkout);
  try {
    f.artifacts.splice(f.artifacts.findIndex((row) => row.id === 502), 1);
    const seed = await f.rig.state.readRepair();
    assert(seed.ok && seed.value.status === "found");
    const added = await f.rig.state.writeRepair({
      ...seed.value.snapshot,
      stateHead: seed.value.head,
      sequence: seed.value.snapshot.sequence + 1,
      updatedAt: f.clock.now(),
      work: [
        ...seed.value.snapshot.work,
        blockedRecord({
          target: { ...deliveryRecord().target, pr: null },
        }),
      ],
    }, seed.value.head);
    assert(added.ok && added.value.status === "applied");
    const release = createReleaseStateStore({
      scratchDir: `${f.rig.tmp}/missing-cell-witness`,
      remoteUrl: `${f.rig.tmp}/remote.git`,
    });
    assert.equal(
      (await runHostedSupervisorFinalize({
        ...DORMANT_HOSTED_POLICIES,
        state: release,
        clock: f.clock,
        run: f.nativeRun,
        evidence: {
          readExecution: f.historicalMatrix.readExecution,
          verifyRevision: () => Promise.resolve(portOk(true)),
          verifyRequest: () => Promise.resolve(portOk(false)),
        },
      })).status,
      "idle",
    );
    const saved = await release.readRelease();
    assert(saved.ok && saved.value.status === "found");
    const witnessProof = saved.value.snapshot.hostedRuntimes[0]
      .lastExecutionProof!;
    assert(witnessProof.outcome !== "not_started");
    f.historicalMatrix.historicalReleaseWitnesses =
      createHostedHistoricalMatrixQuarantine({
        state: f.rig.state,
        clock: f.clock,
        token: "offline-native-token",
        artifactRoot: `${f.rig.tmp}/witness-artifacts`,
        http: f.http,
        artifactHttp: f.http,
        historicalReleaseWitnesses: [{
          commit: saved.value.head,
          executionId: witnessProof.execution.id,
          logDigest: witnessProof.logDigest,
          reservationIds: [f.charges[0].id],
        }],
      }).historicalReleaseWitnesses;
    const before = await f.rig.state.readRepair();
    const releaseBefore = await f.rig.state.readRelease();
    assert(before.ok && before.value.status === "found");
    const native = await f.historicalMatrix.readExecution(f.execution);
    assert(native.ok && native.value && native.value.outcome !== "not_started");
    const proof = native.value;
    await assert.rejects(() =>
      f.historicalMatrix.transport.rejectHistorical!({
        proof,
      }), /matrix artifact provenance unavailable or conflicting/);
    assert.deepEqual(await f.rig.state.readRepair(), before);
    const result = await f.run();
    assert(result.actions.includes("historical-matrix:quarantined:1"));
    assert(
      result.actions.some((action) =>
        action.startsWith(`retry:${TARGET}:grant=`)
      ),
      JSON.stringify(result.actions),
    );
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.find((row) => row.id === TARGET)?.nextStep,
      "work",
    );
    const blocked = after.value.snapshot.work.find((row) =>
      row.id === f.records[0].id
    )!;
    assert.equal(blocked.nextStep, "blocked");
    assert.equal(
      blocked.blocker?.message,
      "authenticated historical matrix artifact missing under rejection proof; absence unproven; model outcome uncertain",
    );
    assert.deepEqual({
      ...blocked,
      nextStep: f.records[0].nextStep,
      blocker: f.records[0].blocker,
      wait: f.records[0].wait,
      updatedAt: f.records[0].updatedAt,
    }, f.records[0]);
    // The missing-cell admission reaches a final ambiguous settlement:
    // absence cannot prove non-submission, and the retained charge is never
    // refunded or rewritten beyond the settlement transition. Every other
    // reservation is preserved byte for byte.
    const missingCharge = after.value.snapshot.reservations.find((row) =>
      row.id === f.charges[0].id
    )!;
    const originalCharge = before.value.snapshot.reservations.find((row) =>
      row.id === f.charges[0].id
    )!;
    assert.equal(missingCharge.outcome, "ambiguous");
    assert.equal(missingCharge.proofRef, null);
    assert(
      missingCharge.settledAt !== null &&
        Number.isSafeInteger(missingCharge.settledAt) &&
        missingCharge.settledAt >= originalCharge.createdAt,
    );
    assert.deepEqual({
      ...missingCharge,
      outcome: originalCharge.outcome,
      settledAt: originalCharge.settledAt,
    }, originalCharge);
    assert.deepEqual(
      after.value.snapshot.reservations.filter((row) =>
        row.id !== f.charges[0].id
      ),
      before.value.snapshot.reservations.filter((row) =>
        row.id !== f.charges[0].id
      ),
    );
    assert.deepEqual(
      after.value.snapshot.work.find((row) => row.id === f.records[1].id),
      f.records[1],
    );
    assert.deepEqual(
      after.value.snapshot.reviews,
      before.value.snapshot.reviews,
    );
    assert.deepEqual(
      after.value.snapshot.releaseRequests,
      before.value.snapshot.releaseRequests,
    );
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    assert.equal(await f.runMain(), 0);
    assert.deepEqual(await f.rig.state.readRepair(), after);
    f.historicalMatrix.revalidateNotStarted = true;
    assert.equal(await runHistoricalMatrixQuarantine(f.historicalMatrix), 0);
    assert.deepEqual(await f.rig.state.readRepair(), after);
    f.historicalMatrix.transport.rejectHistorical = () =>
      Promise.reject(new Error("unknown historical refusal"));
    await assert.rejects(
      () => runHistoricalMatrixQuarantine(f.historicalMatrix),
      /unknown historical refusal/,
    );
    assert.equal(await f.runMain(), 1);
    assert.deepEqual(await f.rig.state.readRepair(), after);
  } finally {
    Deno.chdir(previousCwd);
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical release witness: overwritten ordinary proof still quarantines exact old wave", async () => {
  const f = await historicalWithNewerCurrent("settled", true);
  const priorCwd = Deno.cwd();
  Deno.chdir(f.checkout);
  try {
    const proof = f.witness.snapshot.hostedRuntimes[0].lastExecutionProof!;
    assert(proof.outcome !== "not_started");
    const historicalMatrix = createHostedHistoricalMatrixQuarantine({
      state: f.rig.state,
      clock: f.clock,
      token: "offline-native-token",
      artifactRoot: `${f.rig.tmp}/witness-artifacts`,
      http: f.currentHttp,
      artifactHttp: f.currentHttp,
      historicalReleaseWitnesses: [{
        commit: f.witness.head,
        executionId: proof.execution.id,
        logDigest: proof.logDigest,
        reservationIds: f.charges.slice(0, 17).map((row) => row.id),
      }],
    });
    const before = await f.release.readRelease();
    const repairBefore = await f.rig.state.readRepair();
    await assert.rejects(() =>
      runHistoricalMatrixQuarantine({
        ...historicalMatrix,
        historicalReleaseWitnesses: undefined,
      }), /historical matrix native settlement unavailable/);
    assert.deepEqual(await f.rig.state.readRepair(), repairBefore);
    await assert.rejects(
      () => runHistoricalMatrixQuarantine(historicalMatrix),
      /historical matrix native settlement unavailable/,
    );
    const afterOld = await f.rig.state.readRepair();
    assert(afterOld.ok && afterOld.value.status === "found");
    assert.deepEqual(
      afterOld.value.snapshot.work.find((row) => row.id === f.records[17].id),
      f.records[17],
    );
    assert(
      afterOld.value.snapshot.reservations.slice(0, 17).every((row) =>
        row.outcome === "ambiguous"
      ),
    );
    const requestId = "e".repeat(64);
    const later = workRecord("later-normal", {
      ...f.records[17],
      id: "later-normal",
      source: { ...f.records[17].source, id: "later-normal" },
      related: { incidentId: null, issueNumber: 19 },
      target: {
        ...f.records[17].target,
        branch: candidateBranch("later-normal" as WorkItemId),
      },
      intent: {
        ...f.records[17].intent!,
        requestId,
        key: implementationIntentKey(requestId),
        branch: candidateBranch("later-normal" as WorkItemId),
        startedAt: T0 + 62_001,
      },
      updatedAt: T0 + 62_001,
    });
    const charge = reservation(requestId, {
      repository: SELF_REPO,
      taskId: later.id,
      head: BASE,
      createdAt: T0 + 62_001,
    });
    const added = await f.rig.state.writeRepair({
      ...afterOld.value.snapshot,
      stateHead: afterOld.value.head,
      sequence: afterOld.value.snapshot.sequence + 1,
      updatedAt: f.clock.now(),
      work: [...afterOld.value.snapshot.work, later],
      reservations: [...afterOld.value.snapshot.reservations, charge],
    }, afterOld.value.head);
    assert(added.ok && added.value.status === "applied");
    const latest = before.ok && before.value.status === "found"
      ? before.value.snapshot.hostedRuntimes[0].lastExecutionProof!
      : null;
    assert(latest && latest.outcome !== "not_started");
    const readExecution = historicalMatrix.readExecution;
    historicalMatrix.readExecution = (execution) =>
      execution.id === latest.execution.id
        ? Promise.resolve(portOk(latest))
        : readExecution(execution);
    const request = {
      ...f.plan.cells[0].request,
      taskId: later.id,
      issue: { number: 19, title: "later", body: "later" },
    };
    let normalCalls = 0;
    historicalMatrix.transport.rejectHistorical = async ({ proof }) => {
      assert.equal(proof.execution.id, latest.execution.id);
      normalCalls++;
      return [{
        reason: "reservation_after_manifest",
        proof,
        planDigest: "d".repeat(64),
        plannerJobId: 2501,
        plannerStartedAt: new Date(T0).toISOString(),
        plannerCompletedAt: new Date(T0 + 3_600_000).toISOString(),
        affected: [{
          request,
          requestDigest: await matrixDigestV1(request),
          work: later,
          workDigest: await matrixDigestV1(later),
          reservation: charge,
          reservationDigest: await matrixDigestV1(charge),
        }],
        cells: [],
      }];
    };
    const result = await runHostedAutonomy({
      state: f.rig.state,
      githubFor: f.rig.githubFor,
      clock: f.clock,
      historicalMatrix,
    });
    assert(result.actions.includes("historical-matrix:quarantined:1"));
    assert.equal(normalCalls, 1);
    const afterLater = await f.rig.state.readRepair();
    assert(afterLater.ok && afterLater.value.status === "found");
    assert.equal(
      afterLater.value.snapshot.work.find((row) => row.id === later.id)
        ?.nextStep,
      "blocked",
    );
    assert.deepEqual(
      afterLater.value.snapshot.work.find((row) => row.id === f.records[17].id),
      f.records[17],
    );
    assert.deepEqual(await f.release.readRelease(), before);
    console.log(`historical witness native requests: ${f.calls.length}`);
  } finally {
    Deno.chdir(priorCwd);
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical not started: real already-quarantined ambiguous state recovers through the authenticated transport", async () => {
  const f = await historicalMalformedRig(true, 1, true);
  // Authenticated not-started revalidation is explicit: the trusted production
  // maintenance route enables it, and this consumer proves that exact path. The
  // default quarantine pass keeps every already-quarantined record closed.
  f.historicalMatrix.revalidateNotStarted = true;
  const recoveredCount = 1;
  const siblingIndex = recoveredCount;
  try {
    const seeded = await f.rig.state.readRepair();
    assert(seeded.ok && seeded.value.status === "found");
    // Model the exact original quarantined class: every target record is
    // already blocked with the historical manifest rejection and its original
    // charge is already settled ambiguous with its original instant.
    const quarantinedAt = f.clock.now();
    const write = await f.rig.state.writeRepair({
      ...seeded.value.snapshot,
      stateHead: seeded.value.head,
      sequence: seeded.value.snapshot.sequence + 1,
      updatedAt: quarantinedAt,
      work: seeded.value.snapshot.work.map((row) => {
        const index = f.records.findIndex((record) => record.id === row.id);
        return index >= 0 && index < recoveredCount
          ? {
            ...row,
            nextStep: "blocked" as const,
            blocker: {
              kind: "other" as const,
              message: HISTORICAL_MATRIX_QUARANTINE,
              since: row.updatedAt,
            },
            wait: null,
          }
          : row;
      }),
      reservations: seeded.value.snapshot.reservations.map((row) => {
        const index = f.charges.findIndex((charge) => charge.id === row.id);
        return index >= 0 && index < recoveredCount
          ? {
            ...row,
            outcome: "ambiguous" as const,
            settledAt: row.createdAt + 1_000,
            proofRef: null,
          }
          : row;
      }),
    }, seeded.value.head);
    assert(write.ok && write.value.status === "applied", JSON.stringify(write));
    const before = await f.rig.state.readRepair();
    assert(before.ok && before.value.status === "found");
    const result = await f.run();
    assert(
      result.actions.includes(
        `historical-matrix:quarantined:${recoveredCount}`,
      ),
      JSON.stringify(result.actions),
    );
    assert(
      result.actions.some((action) => action.startsWith("retry:historical-")),
      "the existing retry authority grants fresh eligible work",
    );
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    for (let i = 0; i < recoveredCount; i++) {
      const record: WorkRecordV1 = after.value.snapshot.work.find((row) =>
        row.id === f.records[i].id
      )!;
      assert.equal(
        record.nextStep,
        "work",
        `record ${i} rejoined the lifecycle`,
      );
      assert.equal(record.blocker, null);
      assert.deepEqual(record.counters, f.records[i].counters);
      // The already-settled ambiguous charge is preserved byte for byte: it is
      // never re-settled and never receives a new settlement instant.
      assert.deepEqual(
        after.value.snapshot.reservations.find((row) =>
          row.id === f.charges[i].id
        ),
        before.value.snapshot.reservations.find((row) =>
          row.id === f.charges[i].id
        ),
        `charge ${i} bytes preserved`,
      );
    }
    assert.deepEqual(
      after.value.snapshot.work.find((row) =>
        row.id === f.records[siblingIndex].id
      ),
      f.records[siblingIndex],
    );
    assert.deepEqual(
      after.value.snapshot.reservations.find((row) =>
        row.id === f.charges[siblingIndex].id
      ),
      f.charges[siblingIndex],
    );
    // A replay of the same already-recovered wave has nothing left to
    // quarantine and mutates nothing.
    const replayBefore = await f.rig.state.readRepair();
    const replay = await f.run();
    assert.ok(
      !replay.actions.some((action) => action.startsWith("historical-matrix:")),
      JSON.stringify(replay.actions),
    );
    assert.deepEqual(await f.rig.state.readRepair(), replayBefore);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical revalidation: missing cell becomes unprovable while evidenced sibling recovers", async () => {
  const f = await historicalMalformedRig(true, 2, true);
  // Authenticated not-started revalidation is explicit, as in the recovery
  // test above.
  f.historicalMatrix.revalidateNotStarted = true;
  try {
    const seeded = await f.rig.state.readRepair();
    assert(seeded.ok && seeded.value.status === "found");
    // Quarantine both records with the exact original quarantine class.
    const quarantinedAt = f.clock.now();
    const write = await f.rig.state.writeRepair({
      ...seeded.value.snapshot,
      stateHead: seeded.value.head,
      sequence: seeded.value.snapshot.sequence + 1,
      updatedAt: quarantinedAt,
      work: seeded.value.snapshot.work.map((row) => {
        const index = f.records.findIndex((record) => record.id === row.id);
        return index >= 0 && index < 2
          ? {
            ...row,
            nextStep: "blocked" as const,
            blocker: {
              kind: "other" as const,
              message: HISTORICAL_MATRIX_QUARANTINE,
              since: row.updatedAt,
            },
            wait: null,
          }
          : row;
      }),
      reservations: seeded.value.snapshot.reservations.map((row) => {
        const index = f.charges.findIndex((charge) => charge.id === row.id);
        return index >= 0 && index < 2
          ? {
            ...row,
            outcome: "ambiguous" as const,
            settledAt: row.createdAt + 1_000,
            proofRef: null,
          }
          : row;
      }),
    }, seeded.value.head);
    assert(write.ok && write.value.status === "applied", JSON.stringify(write));
    // Simulate permanent loss of the first cell's artifact (expired, never
    // uploaded, or otherwise unrecoverable). The plan still passes its
    // pre-filter via the second cell's artifact.
    const missingName = `sentinel-matrix-cell-71-2-${f.cells[0].cellId}`;
    const artifactIndex = f.artifacts.findIndex((artifact) =>
      (artifact as { name: string }).name === missingName
    );
    assert(artifactIndex >= 0, "expected the cell artifact to exist");
    f.artifacts.splice(artifactIndex, 1);
    const before = await f.rig.state.readRepair();
    const releaseBefore = await f.rig.state.readRelease();
    assert(before.ok && before.value.status === "found");
    // Missing evidence receives its own uncertainty disposition; the
    // authenticated sibling alone can prove non-submission.
    const result = await f.run();
    assert(
      result.actions.includes("historical-matrix:quarantined:2"),
      `expected two dispositions, got ${JSON.stringify(result.actions)}`,
    );
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    // The record whose artifact is missing stays blocked: no not-started
    // claim is made without the artifact proof.
    const unprovable: WorkRecordV1 = after.value.snapshot.work.find((row) =>
      row.id === f.records[0].id
    )!;
    assert.equal(unprovable.nextStep, "blocked");
    assert.equal(
      unprovable.blocker?.message,
      HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE,
    );
    const retained = before.value.snapshot.work.find((row) =>
      row.id === unprovable.id
    )!;
    assert.deepEqual({
      ...unprovable,
      blocker: retained.blocker,
      wait: retained.wait,
      updatedAt: retained.updatedAt,
    }, retained);
    assert.deepEqual(
      after.value.snapshot.reservations.find((row) =>
        row.id === f.charges[0].id
      ),
      before.value.snapshot.reservations.find((row) =>
        row.id === f.charges[0].id
      ),
    );
    assert.deepEqual(
      after.value.snapshot.reviews,
      before.value.snapshot.reviews,
    );
    assert.deepEqual(
      after.value.snapshot.releaseRequests,
      before.value.snapshot.releaseRequests,
    );
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    // The record whose artifact exists is revalidated normally.
    const provable: WorkRecordV1 = after.value.snapshot.work.find((row) =>
      row.id === f.records[1].id
    )!;
    assert.equal(provable.nextStep, "work", "provable record rejoins");
    assert.equal(provable.blocker, null);
    const previousCwd = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      assert.equal(await runHistoricalMatrixQuarantine(f.historicalMatrix), 0);
    } finally {
      Deno.chdir(previousCwd);
    }
    assert.deepEqual(await f.rig.state.readRepair(), after);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical not started: another blocker never recovers and mutates nothing", async () => {
  const f = await historicalMalformedRig();
  // The capability is ACTIVE here: an unrelated blocker must still never be
  // reconciled, read or mutated even under explicit not-started revalidation.
  f.historicalMatrix.revalidateNotStarted = true;
  try {
    const seeded = await f.rig.state.readRepair();
    assert(seeded.ok && seeded.value.status === "found");
    const blocked = await f.rig.state.writeRepair({
      ...seeded.value.snapshot,
      stateHead: seeded.value.head,
      sequence: seeded.value.snapshot.sequence + 1,
      updatedAt: f.clock.now(),
      work: seeded.value.snapshot.work.map((row) => {
        const index = f.records.findIndex((record) => record.id === row.id);
        return index >= 0 && index < 17
          ? {
            ...row,
            nextStep: "blocked" as const,
            blocker: {
              kind: "other" as const,
              message: "unrelated terminal blocker",
              since: row.updatedAt,
            },
            wait: null,
          }
          : row;
      }),
    }, seeded.value.head);
    assert(blocked.ok && blocked.value.status === "applied");
    const before = await f.rig.state.readRepair();
    const result = await f.run();
    assert.ok(
      !result.actions.some((action) => action.startsWith("historical-matrix:")),
      JSON.stringify(result.actions),
    );
    assert.deepEqual(await f.rig.state.readRepair(), before);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});
