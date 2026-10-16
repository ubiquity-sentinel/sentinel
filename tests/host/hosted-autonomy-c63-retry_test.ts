/**
 * The three failed C63 admissions settled `ambiguous` are retried by the
 * ordinary retry authority, and historical C63 recovery treats a row the
 * retry moved past its admission as consumed instead of failing maintenance.
 * Any other drift from the exact C63 binding still fails closed.
 */
import assert from "node:assert/strict";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { recoverHostedHistoricalC63 } from "../../ops/hosted-autonomy-historical-recovery.ts";
import { HISTORICAL_C63 } from "../../ops/hosted-autonomy-matrix-bindings.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import { reservation, SHA1, T0, workRecord } from "../state/helpers.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";

const ROW = HISTORICAL_C63.rows[0];

function c63Snapshot(outcome: "ambiguous" | "reserved"): RepairStateSnapshotV1 {
  const record = workRecord(ROW.id, {
    repository: HISTORICAL_C63.repository,
    source: {
      kind: "issue",
      id: String(ROW.issue),
      revision: HISTORICAL_C63.base,
    },
    related: { incidentId: null, issueNumber: ROW.issue },
    target: {
      base: HISTORICAL_C63.base,
      branch: `sentinel/repair/${ROW.id}`,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "blocked",
    counters: { attempts: 2, retries: 0, reviewRounds: 0 },
    blocker: {
      kind: "other",
      message: "model run did not complete with a trusted candidate",
      since: T0 + 2000,
    },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(ROW.reservation),
      startedAt: T0,
      branch: `sentinel/repair/${ROW.id}`,
      expectedHead: null,
      observedBase: HISTORICAL_C63.base,
      pr: null,
      requestId: ROW.reservation,
      resultId: null,
    },
  });
  return repairSnapshot([record], [], [], [
    reservation(ROW.reservation, {
      repository: HISTORICAL_C63.repository,
      taskId: ROW.id,
      head: HISTORICAL_C63.base,
      attempt: 2,
      purpose: "retry",
      outcome,
      settledAt: outcome === "reserved" ? null : T0 + 2000,
    }),
  ]);
}

function recover(snapshot: RepairStateSnapshotV1) {
  return recoverHostedHistoricalC63({
    state: {
      readRepair: () =>
        Promise.resolve({
          ok: true,
          value: { status: "found", head: "f".repeat(40), snapshot },
        }),
      // Release custody absent: a still-bound row defers, a consumed row is
      // skipped before any release read.
      readRelease: () =>
        Promise.resolve({ ok: true, value: { status: "absent" } }),
    },
  } as never);
}

Deno.test("C63 retry: a failed C63 admission settled ambiguous is retried and its row is consumed", async () => {
  const snapshot = c63Snapshot("ambiguous");
  // Before the retry the row is still bound: recovery defers on custody.
  assert.deepEqual(await recover(snapshot), { ingested: 0, deferred: true });

  const plans = planHostedRetries(snapshot, T0 + 5000, SHA1);
  assert.deepEqual(plans.map((plan) => plan.id), [ROW.id]);
  const retried = applyHostedRetries(snapshot, SHA1, plans, T0 + 5000);
  const record = retried.work[0];
  assert.equal(record.nextStep, "work");
  assert.notEqual(record.intent?.requestId, ROW.reservation);
  // The original charge stays charged: a retry never refunds it.
  assert.deepEqual(retried.reservations, snapshot.reservations);

  // The moved row is consumed: maintenance never fails on it.
  assert.deepEqual(await recover(retried), { ingested: 0, deferred: false });
});

Deno.test("C63 retry: a moved row whose C63 charge is not settled still fails closed", async () => {
  const snapshot = c63Snapshot("reserved");
  const moved: RepairStateSnapshotV1 = {
    ...snapshot,
    work: snapshot.work.map((row) => ({
      ...row,
      nextStep: "work" as const,
      blocker: null,
      intent: null,
    })),
  };
  await assert.rejects(
    () => recover(moved),
    /historical matrix selected reservation binding unavailable/,
  );
});
