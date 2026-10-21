import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import assert from "node:assert/strict";
import { deriveReservationId } from "../../src/budget/mod.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import type {
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  applyMismatchDispositionPlanV1,
  collectMismatchDispositionCandidatesV1,
  MISMATCH_DISPOSITION_RETRYABLE_BLOCKER,
  type MismatchDispositionObservationsV1,
  runMismatchDispositionPassV1,
} from "../../ops/runtime-mismatch-recovery-disposition.ts";
import {
  HOSTED_AUTONOMY_RETRYABLE,
  type HostedAutonomyGitHubV1,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { reservation, SHA1, T0, workRecord } from "../state/helpers.ts";

const WORK_ID = "issue-ubiquity-ai.ubq.fi-1";
const REPO = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
};
const PRODUCER = "37413367329:1";
const BLOCKER =
  `authenticated historical matrix runtime mismatch; producer=${PRODUCER}; original admission retained`;

function testRelease(): unknown {
  return {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  };
}

async function fixture(overrides: {
  blockerMessage?: string;
  reservationOutcome?: "reserved" | "ambiguous";
  head?: string | null;
  intentNull?: boolean;
} = {}): Promise<{
  snapshot: RepairStateSnapshotV1;
  recordId: string;
  reservationId: string;
}> {
  const recordId = WORK_ID;
  const branch = candidateBranch(recordId as never);
  const reservationId = await deriveReservationId({
    repository: REPO,
    taskId: recordId as never,
    head: SHA1 as never,
    attempt: 1,
    purpose: "retry",
  });
  const record = workRecord(recordId, {
    repository: REPO,
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: overrides.blockerMessage ?? BLOCKER,
      since: T0,
    },
    target: {
      base: SHA1,
      branch,
      checkpoint: null,
      head: overrides.head ?? null,
      pr: null,
    },
    intent: overrides.intentNull === true ? null : {
      kind: "implementation",
      key: implementationIntentKey(reservationId),
      startedAt: T0 - 1000,
      branch,
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId: reservationId,
      resultId: null,
    },
  });
  const row = reservation(reservationId, {
    repository: REPO,
    taskId: recordId,
    head: SHA1,
    purpose: "retry",
    outcome: overrides.reservationOutcome ?? "reserved",
    settledAt: overrides.reservationOutcome === "ambiguous" ? T0 + 1 : null,
  });
  const snapshot = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 7,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [record],
    reservations: [row],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  return { snapshot, recordId, reservationId };
}

function observations(
  overrides: Partial<{
    refAbsent: boolean | null;
    pulls:
      | readonly { number: number; state: string; head: string | null }[]
      | null;
    terminal: boolean | null;
  }> = {},
): MismatchDispositionObservationsV1 {
  return {
    readRefAbsent: () =>
      Promise.resolve(
        overrides.refAbsent === undefined ? true : overrides.refAbsent,
      ),
    listPullsByHead: () =>
      Promise.resolve(overrides.pulls === undefined ? [] : overrides.pulls),
    readRunTerminal: () =>
      Promise.resolve(
        overrides.terminal === undefined ? true : overrides.terminal,
      ),
  };
}

class FakeState
  implements
    Pick<StateReadView, "readRepair" | "readRelease">,
    RepairStateWriter {
  snapshot: RepairStateSnapshotV1;
  head = SHA1;
  writes = 0;
  mode: "applied" | "conflict" | "ambiguous" | "throw" | "drift" = "applied";
  constructor(snapshot: RepairStateSnapshotV1) {
    this.snapshot = snapshot;
  }
  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    return Promise.resolve({
      ok: true,
      value: {
        status: "found",
        snapshot: testRelease() as ReleaseStateSnapshotV1,
        head: SHA1,
        ref: null,
      },
    });
  }
  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    if (this.mode === "drift") {
      this.mode = "applied";
      return Promise.resolve({
        ok: true,
        value: {
          status: "found",
          snapshot: { ...this.snapshot, sequence: this.snapshot.sequence + 9 },
          head: SHA1,
          ref: null,
        },
      });
    }
    return Promise.resolve({
      ok: true,
      value: {
        status: "found",
        snapshot: this.snapshot,
        head: this.head,
        ref: null,
      },
    });
  }
  writeRepair(
    next: RepairStateSnapshotV1,
    _expectedHead: string | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.writes++;
    if (this.mode === "throw") return Promise.reject(new Error("offline"));
    if (this.mode === "conflict") {
      return Promise.resolve({
        ok: true,
        value: { status: "conflict", currentHead: SHA1 },
      });
    }
    if (this.mode === "ambiguous") {
      return Promise.resolve({
        ok: true,
        value: { status: "ambiguous", currentHead: null },
      });
    }
    this.snapshot = next;
    this.head = SHA1;
    return Promise.resolve({
      ok: true,
      value: { status: "applied", head: SHA1 },
    });
  }
}

Deno.test("disposition collects one no-effect binding and proof for an eligible record", async () => {
  const f = await fixture();
  const candidates = await collectMismatchDispositionCandidatesV1({
    snapshot: f.snapshot,
    observationsFor: () => observations(),
    producerTerminal: () => Promise.resolve(true),
  });
  assert.equal(candidates.retained.length, 0);
  assert.equal(candidates.bindings.length, 1);
  const binding = candidates.bindings[0]!;
  assert.equal(binding.id, f.recordId);
  assert.equal(binding.reservationId, f.reservationId);
  assert.equal(binding.producerRun, "37413367329");
  assert.equal(binding.producerAttempt, 1);
  assert.equal(binding.producerTerminal, true);
  assert.equal(binding.purpose, "retry");
  const proof = candidates.proofs[f.recordId]!;
  assert.equal(proof.exclusiveCustody, true);
  assert.equal(proof.publicationRefs.length, 0);
  assert.equal(proof.prObservations.length, 0);
  assert(proof.effectDisposition !== null);
});

Deno.test("disposition retains every unproven or present effect fact", async () => {
  const cases: {
    name: string;
    obs: MismatchDispositionObservationsV1;
    terminal: boolean | null;
    reason: string;
  }[] = [
    {
      name: "repair ref present",
      obs: observations({ refAbsent: false }),
      terminal: true,
      reason: "repair ref present",
    },
    {
      name: "repair ref unreadable",
      obs: observations({ refAbsent: null }),
      terminal: true,
      reason: "repair ref unreadable",
    },
    {
      name: "pull present",
      obs: observations({
        pulls: [{ number: 12, state: "open", head: "x" }],
      }),
      terminal: true,
      reason: "pull observations present",
    },
    {
      name: "pull listing unreadable",
      obs: observations({ pulls: null }),
      terminal: true,
      reason: "pull listing unreadable",
    },
    {
      // The producer run belongs to the SELF repository, so its terminal fact
      // arrives through the separate producer capability, never through the
      // target record's observations.
      name: "producer not terminal",
      obs: observations(),
      terminal: false,
      reason: "producer run not terminal",
    },
    {
      name: "producer unreadable",
      obs: observations(),
      terminal: null,
      reason: "producer run unreadable",
    },
  ];
  for (const item of cases) {
    const f = await fixture();
    const candidates = await collectMismatchDispositionCandidatesV1({
      snapshot: f.snapshot,
      observationsFor: () => item.obs,
      producerTerminal: () => Promise.resolve(item.terminal),
    });
    assert.equal(candidates.bindings.length, 0, item.name);
    assert.equal(candidates.retained[0]?.reason, item.reason, item.name);
  }
});

Deno.test("disposition retains a settled charge, head or missing intent", async () => {
  const missingIntent = await fixture({ intentNull: true });
  const settled = await fixture({ reservationOutcome: "ambiguous" });
  const head = await fixture({ head: SHA1 });
  const unparsed = await fixture({
    blockerMessage:
      "authenticated historical matrix runtime mismatch; original admission retained",
  });
  for (
    const [name, f] of [
      ["intent", missingIntent],
      ["settled", settled],
      ["head", head],
      ["unparsed", unparsed],
    ] as const
  ) {
    const candidates = await collectMismatchDispositionCandidatesV1({
      snapshot: f.snapshot,
      observationsFor: () => observations(),
      producerTerminal: () => Promise.resolve(true),
    });
    assert.equal(candidates.bindings.length, 0, name);
    assert.equal(candidates.retained.length, 1, name);
  }
});

Deno.test("disposition retains an absent capability and honors the batch limit", async () => {
  const f = await fixture();
  const absent = await collectMismatchDispositionCandidatesV1({
    snapshot: f.snapshot,
    observationsFor: () => null,
    producerTerminal: () => Promise.resolve(true),
  });
  assert.equal(absent.bindings.length, 0);
  assert.equal(absent.retained[0]?.reason, "observation capability absent");
  const limited = await collectMismatchDispositionCandidatesV1({
    snapshot: f.snapshot,
    observationsFor: () => observations(),
    producerTerminal: () => Promise.resolve(true),
    limit: 1,
  });
  assert.equal(limited.bindings.length, 1);
});

Deno.test("disposition apply settles the charge ambiguous and installs the retryable blocker", async () => {
  const f = await fixture();
  const candidates = await collectMismatchDispositionCandidatesV1({
    snapshot: f.snapshot,
    observationsFor: () => observations(),
    producerTerminal: () => Promise.resolve(true),
  });
  const plan = {
    ok: true as const,
    proposals: [{
      id: f.recordId,
      casBase: SHA1,
      settleReservation: {
        reservationId: f.reservationId,
        outcome: "ambiguous" as const,
      },
      replacementBlocker: {
        kind: "other",
        message: MISMATCH_DISPOSITION_RETRYABLE_BLOCKER,
      },
    }],
  };
  assert.equal(candidates.bindings.length, 1);
  const applied = applyMismatchDispositionPlanV1({
    snapshot: f.snapshot,
    plan,
    head: SHA1 as never,
    now: T0 + 5,
  });
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  const record = applied.snapshot.work[0]!;
  assert.equal(record.blocker?.message, MISMATCH_DISPOSITION_RETRYABLE_BLOCKER);
  assert.equal(record.blocker?.since, T0 + 5);
  assert.equal(record.intent?.key, `impl:${f.reservationId}`);
  const row = applied.snapshot.reservations[0]!;
  assert.equal(row.outcome, "ambiguous");
  assert.equal(row.settledAt, T0 + 5);
  assert.equal(row.proofRef, null);
  assert.equal(applied.snapshot.sequence, f.snapshot.sequence + 1);
  assert.equal(applied.snapshot.updatedAt, T0 + 5);
  assert.equal(applied.snapshot.stateHead, SHA1);
  assert.deepEqual(applied.applied, [f.recordId]);
});

Deno.test("disposition replacement blocker is owned by the maintenance retry pass", () => {
  const rule = HOSTED_AUTONOMY_RETRYABLE.find((item) =>
    MISMATCH_DISPOSITION_RETRYABLE_BLOCKER.startsWith(item.prefix)
  );
  assert(rule !== undefined);
  assert.equal(rule.nextStep, "work");
});

Deno.test("disposition apply refuses a changed record, settled charge or empty plan", async () => {
  const f = await fixture();
  const proposal = {
    id: f.recordId,
    casBase: SHA1,
    settleReservation: {
      reservationId: f.reservationId,
      outcome: "ambiguous" as const,
    },
    replacementBlocker: {
      kind: "other",
      message: MISMATCH_DISPOSITION_RETRYABLE_BLOCKER,
    },
  };
  const empty = applyMismatchDispositionPlanV1({
    snapshot: f.snapshot,
    plan: { ok: true, proposals: [] },
    head: SHA1 as never,
    now: T0 + 5,
  });
  assert.equal(empty.ok, false);
  const settled = applyMismatchDispositionPlanV1({
    snapshot: f.snapshot,
    plan: { ok: true, proposals: [proposal] },
    head: SHA1 as never,
    now: T0 - 1,
  });
  assert.equal(settled.ok, false);
  const changed = applyMismatchDispositionPlanV1({
    snapshot: {
      ...f.snapshot,
      work: [{ ...f.snapshot.work[0]!, nextStep: "work" as const }],
    },
    plan: { ok: true, proposals: [proposal] },
    head: SHA1 as never,
    now: T0 + 5,
  });
  assert.equal(changed.ok, false);
});

Deno.test("disposition pass applies one write and verifies the canonical readback", async () => {
  const f = await fixture();
  const state = new FakeState(f.snapshot);
  const result = await runMismatchDispositionPassV1({
    snapshot: f.snapshot,
    head: SHA1 as never,
    release: testRelease(),
    expectedReleaseHead: null,
    observationsFor: () => observations(),
    producerTerminal: () => Promise.resolve(true),
    now: T0 + 5,
    state,
  });
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(state.writes, 1);
  assert.deepEqual(result.applied, [f.recordId]);
  assert.equal(state.snapshot.reservations[0]?.outcome, "ambiguous");
  assert.equal(
    state.snapshot.work[0]?.blocker?.message,
    MISMATCH_DISPOSITION_RETRYABLE_BLOCKER,
  );
});

Deno.test("disposition pass fails closed on conflict, ambiguity, unavailable write and drifted readback", async () => {
  for (
    const mode of ["conflict", "ambiguous", "throw", "drift"] as const
  ) {
    const f = await fixture();
    const state = new FakeState(f.snapshot);
    state.mode = mode;
    const result = await runMismatchDispositionPassV1({
      snapshot: f.snapshot,
      head: SHA1 as never,
      release: testRelease(),
      expectedReleaseHead: null,
      observationsFor: () => observations(),
      producerTerminal: () => Promise.resolve(true),
      now: T0 + 5,
      state,
    });
    assert.equal(result.kind, "failed", mode);
    if (result.kind !== "failed") continue;
    const expected = mode === "conflict"
      ? "write_conflict"
      : mode === "ambiguous"
      ? "write_ambiguous"
      : mode === "throw"
      ? "write_unavailable"
      : "readback_unverified";
    assert.equal(result.reason, expected, mode);
  }
});

Deno.test("disposition pass reports no candidates without any write", async () => {
  const f = await fixture();
  const state = new FakeState(f.snapshot);
  const result = await runMismatchDispositionPassV1({
    snapshot: f.snapshot,
    head: SHA1 as never,
    release: null,
    expectedReleaseHead: null,
    observationsFor: () => observations(),
    producerTerminal: () => Promise.resolve(true),
    now: T0 + 5,
    state,
  });
  assert.equal(result.kind, "none");
  if (result.kind !== "none") return;
  assert.equal(result.reason, "release_absent");
  assert.equal(state.writes, 0);
  const none = await runMismatchDispositionPassV1({
    snapshot: {
      ...f.snapshot,
      work: [{ ...f.snapshot.work[0]!, nextStep: "done" as const }],
    },
    head: SHA1 as never,
    release: testRelease(),
    expectedReleaseHead: null,
    observationsFor: () => observations(),
    producerTerminal: () => Promise.resolve(true),
    now: T0 + 5,
    state: new FakeState(f.snapshot),
  });
  assert.equal(none.kind, "none");
  if (none.kind !== "none") return;
  assert.equal(none.reason, "no_candidates");
});

Deno.test("disposition pass preserves unrelated rows byte-identical", async () => {
  const f = await fixture();
  const other = workRecord("issue-ubiquity-sentinel-8", {
    repository: {
      owner: "ubiquity-sentinel",
      name: "sentinel",
      installationId: 0,
    },
    nextStep: "work",
  });
  const snapshot = parseRepairStateSnapshotV1({
    ...f.snapshot,
    work: [f.snapshot.work[0]!, other],
  });
  const before = canonicalStringify(other);
  const state = new FakeState(snapshot);
  const result = await runMismatchDispositionPassV1({
    snapshot,
    head: SHA1 as never,
    release: testRelease(),
    expectedReleaseHead: null,
    observationsFor: () => observations(),
    producerTerminal: () => Promise.resolve(true),
    now: T0 + 5,
    state,
  });
  assert.equal(result.kind, "applied");
  const after = state.snapshot.work.find((row) =>
    row.id === "issue-ubiquity-sentinel-8"
  );
  assert(after !== undefined);
  assert.equal(canonicalStringify(after), before);
});

function hostedSurface(
  overrides: Partial<HostedAutonomyGitHubV1> = {},
): HostedAutonomyGitHubV1 {
  return {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: () => Promise.resolve(null),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => Promise.resolve(null),
    readIssueOpen: () => Promise.resolve(true),
    merge: () => Promise.resolve(null),
    closeIssue: () => Promise.resolve(false),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    ...overrides,
  };
}

Deno.test("hosted autonomy main disposes an evidenced runtime mismatch in one write", async () => {
  const f = await fixture();
  const state = new FakeState(f.snapshot);
  const result = await runHostedAutonomy(
    await withDarkQueueAuthority({
      state,
      githubFor: () => hostedSurface({ mismatchDisposition: observations() }),
      clock: { now: () => T0 + 5 },
    }),
  );
  assert.equal(result.kind, "hosted_autonomy");
  assert.equal(result.status, "applied");
  assert.equal(result.reason, "dispositioned");
  assert.equal(result.appliedHead, SHA1);
  assert.equal(state.writes, 1);
  assert.equal(state.snapshot.reservations[0]?.outcome, "ambiguous");
  assert.equal(
    state.snapshot.work[0]?.blocker?.message,
    MISMATCH_DISPOSITION_RETRYABLE_BLOCKER,
  );
  assert(
    result.actions.some((action) =>
      action.startsWith("disposition:issue-ubiquity-ai.ubq.fi-1:")
    ),
  );
});
