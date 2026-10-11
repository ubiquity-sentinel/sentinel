// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import {
  DEP_2,
  incidentSummary,
  monitoredReleaseRecord,
  releaseRecord,
  releaseRequest,
  reservation,
  reviewReceipt,
  SHA3,
  T0,
  workRecord,
} from "./helpers.ts";
import {
  appliedHead,
  makeCtx,
  releaseSnapshot,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";

Deno.test("state: release requests, releases and generic records are preserved", async () => {
  const ctx = await makeCtx("preserve");
  try {
    const store = storeAt(ctx, "a", "repair");
    const request = releaseRequest("q:1");
    const incident = incidentSummary("inc:1");
    const receipt = reviewReceipt("rv:1");
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          work: [workRecord("w:1")],
          reservations: [reservation("r:1")],
          releaseRequests: [request],
          incidents: [incident],
          reviews: [receipt],
        }),
        null,
      ),
    );

    // Dropping any prior record is invalid.
    const dropRequest = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1")],
        reservations: [reservation("r:1")],
        releaseRequests: [],
      }),
      head1,
    );
    assert.ok(!dropRequest.ok);
    if (!dropRequest.ok) assert.equal(dropRequest.error.kind, "invalid");
    const dropIncident = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1")],
        reservations: [reservation("r:1")],
        releaseRequests: [request],
        incidents: [],
      }),
      head1,
    );
    assert.ok(!dropIncident.ok);
    if (!dropIncident.ok) assert.equal(dropIncident.error.kind, "invalid");

    // Request identity cannot change; open -> fulfilled is a valid transition;
    // a terminal request cannot restart or mutate.
    const identityChange = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1")],
        reservations: [reservation("r:1")],
        releaseRequests: [releaseRequest("q:1", { revision: SHA3 })],
      }),
      head1,
    );
    assert.ok(!identityChange.ok);
    if (!identityChange.ok) assert.equal(identityChange.error.kind, "invalid");

    const fulfilled = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1")],
        reservations: [reservation("r:1")],
        releaseRequests: [releaseRequest("q:1", { status: "fulfilled" })],
        incidents: [incident],
        reviews: [receipt],
      }),
      head1,
    );
    assert.ok(fulfilled.ok);
    if (fulfilled.ok) assert.equal(fulfilled.value.status, "applied");
    const head2 = fulfilled.ok && fulfilled.value.status === "applied"
      ? fulfilled.value.head
      : null;
    assert.ok(head2);

    const terminalRestart = await store.writeRepair(
      repairSnapshot({
        stateHead: head2,
        sequence: 3,
        updatedAt: T0 + 3000,
        work: [workRecord("w:1"), workRecord("w:2")],
        reservations: [reservation("r:1")],
        releaseRequests: [releaseRequest("q:1", { status: "open" })],
        incidents: [incident],
        reviews: [receipt],
      }),
      head2,
    );
    assert.ok(!terminalRestart.ok);
    if (!terminalRestart.ok) {
      assert.equal(terminalRestart.error.kind, "invalid");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: release records stay identity-pinned and terminal", async () => {
  const ctx = await makeCtx("release-guards");
  try {
    const store = storeAt(ctx, "a", "release");
    const requested = releaseRecord("rel:1");
    const head1 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({ releases: [requested] }),
        null,
      ),
    );

    // Request identity cannot change after creation.
    const identityChange = await store.writeRelease(
      releaseSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        releases: [
          releaseRecord("rel:1", {
            requestRevision: SHA3,
            candidate: { identity: DEP_2, buildTransactionId: "txn-rel-1" },
          }),
        ],
      }),
      head1,
    );
    assert.ok(!identityChange.ok);
    if (!identityChange.ok) assert.equal(identityChange.error.kind, "invalid");

    // requested -> monitoring -> accepted are the forward transitions.
    const monitored = monitoredReleaseRecord("rel:1", "monitoring");
    const head2 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({
          stateHead: head1,
          sequence: 2,
          updatedAt: T0 + 2000,
          releases: [monitored],
        }),
        head1,
      ),
    );
    const accepted = monitoredReleaseRecord("rel:1", "accepted");
    const head3 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          releases: [accepted],
        }),
        head2,
      ),
    );

    // An accepted release cannot be reset into a fresh promotion nor mutate.
    const reset = await store.writeRelease(
      releaseSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        releases: [
          monitoredReleaseRecord("rel:1", "monitoring"),
        ],
      }),
      head3,
    );
    assert.ok(!reset.ok);
    if (!reset.ok) assert.equal(reset.error.kind, "invalid");
    const mutateTerminal = await store.writeRelease(
      releaseSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        releases: [
          {
            ...accepted,
            observed: { ...accepted.observed, domain: "https://evil.example" },
          },
        ],
      }),
      head3,
    );
    assert.ok(!mutateTerminal.ok);
    if (!mutateTerminal.ok) assert.equal(mutateTerminal.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: release records persist same-phase monitoring and interrupted coverage", async () => {
  const ctx = await makeCtx("release-same-phase");
  try {
    const store = storeAt(ctx, "a", "release");
    const m1 = monitoredReleaseRecord("rel:1", "monitoring");
    const r2 = releaseRecord("rel:2");
    const head1 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({ releases: [m1, r2] }),
        null,
      ),
    );

    // Same-phase persistence: another monitoring sample, and a requested
    // record persisting its saved promote intent.
    const m2 = {
      ...m1,
      updatedAt: T0 + 2000,
      monitoring: {
        startedAt: T0 + 3000,
        samples: 2,
        continuous: true,
        lastSampleAt: T0 + 63000,
      },
    };
    const t2 = {
      ...r2,
      updatedAt: T0 + 2000,
      intent: {
        action: "promote" as const,
        key: "promote/rel-2",
        persistedAt: T0 + 2000,
      },
    };
    const head2 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({
          stateHead: head1,
          sequence: 2,
          updatedAt: T0 + 2000,
          releases: [m2, t2],
        }),
        head1,
      ),
    );

    // Interrupted monitoring resets coverage; requested -> promoting is a
    // forward transition.
    const m3 = {
      ...m2,
      updatedAt: T0 + 3000,
      monitoring: {
        startedAt: T0 + 3000,
        samples: 2,
        continuous: false,
        lastSampleAt: T0 + 63000,
      },
    };
    const t3 = { ...t2, phase: "promoting" as const, updatedAt: T0 + 3000 };
    const head3 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          releases: [m3, t3],
        }),
        head2,
      ),
    );

    // A monitoring restart after the interruption, and a same-phase promoting
    // persistence.
    const m4 = {
      ...m3,
      updatedAt: T0 + 4000,
      monitoring: {
        startedAt: T0 + 90000,
        samples: 1,
        continuous: true,
        lastSampleAt: T0 + 120000,
      },
    };
    const t4 = { ...t3, updatedAt: T0 + 4000 };
    const head4 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({
          stateHead: head3,
          sequence: 4,
          updatedAt: T0 + 4000,
          releases: [m4, t4],
        }),
        head3,
      ),
    );

    // Per-record updatedAt cannot move backward.
    const backwardTime = await store.writeRelease(
      releaseSnapshot({
        stateHead: head4,
        sequence: 5,
        updatedAt: T0 + 5000,
        releases: [{ ...m4, updatedAt: T0 + 3500 }, t4],
      }),
      head4,
    );
    assert.ok(!backwardTime.ok);
    if (!backwardTime.ok) {
      assert.equal(backwardTime.error.kind, "invalid");
    }

    // Backward phase resets stay forbidden (monitoring -> requested).
    const resetPhase = await store.writeRelease(
      releaseSnapshot({
        stateHead: head4,
        sequence: 5,
        updatedAt: T0 + 5000,
        releases: [
          releaseRecord("rel:1", { updatedAt: T0 + 5000 }),
          t4,
        ],
      }),
      head4,
    );
    assert.ok(!resetPhase.ok);
    if (!resetPhase.ok) assert.equal(resetPhase.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});
