import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { validateSnapshotTransition } from "../../src/state/state-transition.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  applyMatrixRuntimeReadmissions,
  planMatrixRuntimeReadmissions,
  runHostedMatrixRuntimeReadmissionPass,
  verifyMatrixRuntimeReadmissions,
} from "../../ops/hosted-autonomy-matrix-runtime-readmission.ts";
import type { HostedAutonomyPassContextV1 } from "../../ops/hosted-autonomy-scopes.ts";
import { REPO, reservation, SHA1, T0, workRecord } from "../state/helpers.ts";

const PRODUCER = "41319256619:1";
const RUNTIME = "026c6896008e269731ff1027f1f8bc4a6403de5d";
const PLAN = "8cff0f1062e24c77c1cb76d39f4eeafc01fecdb607e0bf4487cf2d31d0414a6e";
const ARCHIVE =
  "sha256:a3a60916e6da3dc194443d0b7fd4403409f50446ec3b39747124ed3401da095c";
const ARTIFACT = 13089656675;
const PLANNER = 124886926479;
const OBSERVED_HEAD = "e".repeat(40) as GitSha;

function reservationId(index: number) {
  return index.toString(16).padStart(64, "0");
}

function message(index: number) {
  return `authenticated historical matrix runtime mismatch; producer=${PRODUCER}; runtime=${RUNTIME}; plan=${PLAN}; artifact=${ARTIFACT}; archive=${ARCHIVE}; planner=${PLANNER}; result=${
    (index + 1).toString(16).padStart(64, "0")
  }; original admission retained`;
}

function parkedRecord(index: number) {
  const id = `issue-ubiquity-ai.ubq.fi-${index}`;
  const charge = reservationId(index);
  const branch = candidateBranch(id as never);
  const record = workRecord(id, {
    repository: REPO,
    source: { kind: "issue", id: String(index), revision: SHA1 },
    related: { incidentId: null, issueNumber: index },
    nextStep: "blocked",
    blocker: { kind: "other", message: message(index), since: T0 },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    target: {
      base: SHA1,
      branch,
      checkpoint: null,
      head: null,
      pr: null,
    },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(charge),
      startedAt: T0,
      branch,
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId: charge,
      resultId: null,
    },
  });
  const row = reservation(charge, {
    repository: REPO,
    taskId: record.id,
    head: SHA1,
    attempt: 1,
    purpose: "implementation",
    createdAt: T0,
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
  });
  return { record, row };
}

function snapshot(count = 33) {
  const rows = Array.from(
    { length: count },
    (_, index) => parkedRecord(index + 1),
  );
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: rows.map((row) => row.record),
    reservations: rows.map((row) => row.row),
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

Deno.test("matrix runtime re-admission plans the 33 parked wave records", async () => {
  const repair = snapshot();
  const planned = planMatrixRuntimeReadmissions(repair);
  assert.equal(planned.length, 33);
  assert.equal(new Set(planned.map((row) => row.id)).size, 33);
  assert.ok(planned.every((row) => row.binding.runId === 41319256619));
  const verified = await verifyMatrixRuntimeReadmissions(
    planned,
    () =>
      Promise.resolve({
        id: ARTIFACT,
        digest: ARCHIVE,
        expired: false,
      }),
    T0 + 60_000,
    [],
  );
  assert.equal(verified.length, 33);
  const next = applyMatrixRuntimeReadmissions(
    repair,
    OBSERVED_HEAD,
    verified,
    T0 + 1000,
  );
  assert.equal(next.stateHead, OBSERVED_HEAD);
  assert.equal(
    next.work.filter((row) => row.nextStep === "work").length,
    33,
  );
  for (const record of next.work) {
    assert.equal(record.blocker, null);
    assert.notEqual(record.intent, null);
    assert.equal(record.counters.attempts, 1);
  }
  assert.equal(next.reservations.length, 33);
  assert.ok(next.reservations.every((row) => row.outcome === "reserved"));
});

Deno.test("matrix runtime re-admission refuses an unreadable or different artifact", async () => {
  const repair = snapshot(2);
  const planned = planMatrixRuntimeReadmissions(repair);
  const actions: string[] = [];
  for (
    const plan of [
      null,
      { id: ARTIFACT, digest: ARCHIVE, expired: true },
      { id: ARTIFACT + 1, digest: ARCHIVE, expired: false },
      { id: ARTIFACT, digest: "sha256:" + "f".repeat(64), expired: false },
    ]
  ) {
    const verified = await verifyMatrixRuntimeReadmissions(
      planned,
      () => Promise.resolve(plan),
      T0 + 60_000,
      actions,
    );
    assert.equal(verified.length, 0);
  }
  assert.equal(actions.length, 8);
});

Deno.test("matrix runtime re-admission leaves a record whose binding changed untouched", () => {
  const repair = snapshot(1);
  const changed = {
    ...repair,
    work: repair.work.map((record) =>
      workRecord(record.id, {
        ...record,
        blocker: {
          kind: "other",
          message: "some other blocker",
          since: T0,
        },
      })
    ),
  };
  assert.equal(planMatrixRuntimeReadmissions(changed).length, 0);
});

Deno.test("matrix runtime re-admission writes the observed head so the store applies it", async () => {
  const repair = snapshot(2);
  let stored = repair;
  let head: GitSha = OBSERVED_HEAD;
  const state = {
    readRepair: () =>
      Promise.resolve({
        ok: true as const,
        value: { status: "found" as const, snapshot: stored, head, ref: null },
      }),
    writeRepair: (
      next: Parameters<typeof applyMatrixRuntimeReadmissions>[0],
      expectedHead: GitSha | null,
    ) => {
      const error = validateSnapshotTransition(stored, next, expectedHead);
      if (error !== null) throw new Error(error);
      stored = next;
      head = expectedHead ?? OBSERVED_HEAD;
      return Promise.resolve({
        ok: true as const,
        value: { status: "applied" as const, head },
      });
    },
  };
  const context = {
    deps: {
      state,
      closedMatrix: () =>
        Promise.resolve({
          readPlanArtifact: () =>
            Promise.resolve({
              id: ARTIFACT,
              digest: ARCHIVE,
              expired: false,
            }),
        }),
      clock: { now: () => T0 + 1000 },
    },
    actions: [],
    revisions: [],
    snapshot: repair,
    observedHead: OBSERVED_HEAD,
    initialHead: OBSERVED_HEAD,
    closedIssues: new Set<string>(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set<string>(),
  } as unknown as HostedAutonomyPassContextV1;
  const result = await runHostedMatrixRuntimeReadmissionPass(context);
  assert.equal(result?.status, "applied", JSON.stringify(result));
  assert.equal(stored.stateHead, OBSERVED_HEAD);
  assert.equal(stored.work.filter((row) => row.nextStep === "work").length, 2);
  assert.equal(
    context.actions.filter((action) =>
      action.endsWith(":readmit:matrix_runtime_bound_history")
    ).length,
    2,
  );
});
