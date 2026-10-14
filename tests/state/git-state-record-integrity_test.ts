// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import { asFindingFingerprint } from "../../src/contracts/brands.ts";
import { REPAIR_STATE_REF } from "../../src/state/mod.ts";
import {
  incidentEvidence,
  incidentSummary,
  pushRawTree,
  reviewReceipt,
  SHA2,
  sha256Hex,
  SHA3,
  T0,
} from "./helpers.ts";
import {
  appliedHead,
  duplicateRefEvidenceText,
  makeCtx,
  rawManifestText,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";

Deno.test("state: incident summaries keep identity fixed while lifecycle updates pass", async () => {
  const ctx = await makeCtx("incident-lifecycle");
  try {
    const store = storeAt(ctx, "a", "repair");
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ incidents: [incidentSummary("inc:1")] }),
        null,
      ),
    );

    // Legitimate repeated discovery: count/lastSeenAt/capturedAt advance and
    // severity/errorType/context/coverage/evidenceRef may update.
    const updated = incidentSummary("inc:1", {
      severity: "P1",
      lastSeenAt: T0 + 9000,
      count: 2,
      errorType: "UpstreamTerminated",
      context: {
        message: "still upstream terminated",
        location: "src/handler.ts:9",
        sample: ["line one"],
      },
      provenance: {
        source: "gateway",
        endpoint: "https://ai.ubq.fi",
        capturedAt: T0 + 8000,
        capturedBy: null,
      },
      coverage: {
        status: "incomplete",
        reason: "page limit",
        nextCursor: "p-2",
      },
      evidenceRef: {
        ref: "artifact://inbox/inc-1.pgp",
        digest: "e".repeat(64),
      },
    });
    const passed = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        incidents: [updated],
      }),
      head1,
    );
    assert.ok(passed.ok);
    if (passed.ok) assert.equal(passed.value.status, "applied");
    const head2 = passed.ok && passed.value.status === "applied"
      ? passed.value.head
      : null;
    assert.ok(head2);

    // Every identity/provenance tamper fails closed.
    const attempts: ReturnType<typeof incidentSummary>[] = [
      incidentSummary("inc:1", { fingerprint: "a".repeat(64) }),
      incidentSummary("inc:1", { firstSeenAt: T0 - 1000 }),
      incidentSummary("inc:1", { failingRevision: SHA3 }),
      { ...updated, count: 1 },
      { ...updated, lastSeenAt: T0 + 5000 },
      {
        ...updated,
        provenance: {
          ...updated.provenance,
          endpoint: "https://evil.example",
        },
      },
      {
        ...updated,
        provenance: { ...updated.provenance, capturedAt: T0 - 1 },
      },
    ];
    for (const mutant of attempts) {
      const result = await store.writeRepair(
        repairSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          incidents: [mutant],
        }),
        head2,
      );
      assert.ok(!result.ok, `expected rejection for ${JSON.stringify(mutant)}`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: incident evidence keeps identity, appends artifacts and fills replay once", async () => {
  const ctx = await makeCtx("evidence-lifecycle");
  try {
    const store = storeAt(ctx, "a", "repair");
    const evidence = incidentEvidence("ev:1");
    const head1 = appliedHead(
      await store.writeRepair(repairSnapshot({ evidence: [evidence] }), null),
    );

    // New distinct artifact appends and coverage may change; the prior
    // artifact stays exactly present.
    const extra = {
      ref: "artifact://inbox/ev-1-extra.pgp",
      digest: "f".repeat(64),
      sizeBytes: 128,
      expiresAt: T0 + 100000000,
      contentType: "text/plain",
    };
    const appended = incidentEvidence("ev:1", {
      artifacts: [...evidence.artifacts, extra],
      coverage: {
        status: "incomplete",
        reason: "page limit",
        nextCursor: "p-9",
      },
    });
    const passed = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        evidence: [appended],
      }),
      head1,
    );
    assert.ok(passed.ok);
    if (passed.ok) assert.equal(passed.value.status, "applied");
    const head2 = passed.ok && passed.value.status === "applied"
      ? passed.value.head
      : null;
    assert.ok(head2);

    const invalidAttempts: ReturnType<typeof incidentEvidence>[] = [
      // Removing a prior artifact is invalid.
      incidentEvidence("ev:1", { artifacts: [extra] }),
      // Altering a prior artifact is invalid.
      incidentEvidence("ev:1", {
        artifacts: [
          { ...evidence.artifacts[0], digest: "a".repeat(64) },
          extra,
        ],
      }),
      // Provenance cannot be rewritten.
      {
        ...appended,
        provenance: { ...appended.provenance, capturedAt: T0 + 1 },
      },
    ];
    for (const mutant of invalidAttempts) {
      const result = await store.writeRepair(
        repairSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          evidence: [mutant],
        }),
        head2,
      );
      assert.ok(!result.ok, `expected rejection for ${JSON.stringify(mutant)}`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
    }

    // Duplicate artifact refs (on an existing or a brand-new record) are
    // rejected by the frozen parser itself on every path — direct parse,
    // initial snapshot write and raw remote read are covered separately by
    // the parser guard tests; the store is not the only defense.

    // Replay metadata may go null -> valid, and fixtureDigest/reproducedAt
    // fill exactly once but never replace a non-null identity.
    const replay0 = incidentEvidence("ev:1", {
      artifacts: [...evidence.artifacts, extra],
      coverage: appended.coverage,
      replay: {
        fixtureRef: "fixture://captures/ev-1/upstream.json",
        fixtureDigest: null,
        upstreamCaptured: false,
        commandId: "replay_capture",
        reproducedAt: null,
      },
    });
    const h3 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          evidence: [replay0],
        }),
        head2,
      ),
    );
    const replay1 = incidentEvidence("ev:1", {
      artifacts: [...evidence.artifacts, extra],
      coverage: appended.coverage,
      replay: {
        fixtureRef: "fixture://captures/ev-1/upstream.json",
        fixtureDigest: "ab".repeat(32),
        upstreamCaptured: true,
        commandId: "replay_capture",
        reproducedAt: null,
      },
    });
    const h4 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          stateHead: h3,
          sequence: 4,
          updatedAt: T0 + 4000,
          evidence: [replay1],
        }),
        h3,
      ),
    );
    const replay2 = incidentEvidence("ev:1", {
      artifacts: [...evidence.artifacts, extra],
      coverage: appended.coverage,
      replay: {
        fixtureRef: "fixture://captures/ev-1/upstream.json",
        fixtureDigest: "ab".repeat(32),
        upstreamCaptured: true,
        commandId: "replay_capture",
        reproducedAt: T0 + 6000,
      },
    });
    const h5 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          stateHead: h4,
          sequence: 5,
          updatedAt: T0 + 5000,
          evidence: [replay2],
        }),
        h4,
      ),
    );
    const fillAttempts: ReturnType<typeof incidentEvidence>[] = [
      // Replacing the filled digest is invalid.
      incidentEvidence("ev:1", {
        artifacts: [...evidence.artifacts, extra],
        coverage: appended.coverage,
        replay: { ...replay2.replay!, fixtureDigest: "cd".repeat(32) },
      }),
      // Replacing reproducedAt is invalid.
      incidentEvidence("ev:1", {
        artifacts: [...evidence.artifacts, extra],
        coverage: appended.coverage,
        replay: { ...replay2.replay!, reproducedAt: T0 + 7000 },
      }),
      // The fixture ref is identity: it cannot change.
      incidentEvidence("ev:1", {
        artifacts: [...evidence.artifacts, extra],
        coverage: appended.coverage,
        replay: {
          ...replay2.replay!,
          fixtureRef: "fixture://captures/other.json",
        },
      }),
      // Replay metadata cannot be removed again.
      incidentEvidence("ev:1", {
        artifacts: [...evidence.artifacts, extra],
        coverage: appended.coverage,
        replay: null,
      }),
    ];
    for (const mutant of fillAttempts) {
      const result = await store.writeRepair(
        repairSnapshot({
          stateHead: h5,
          sequence: 6,
          updatedAt: T0 + 6000,
          evidence: [mutant],
        }),
        h5,
      );
      assert.ok(!result.ok, `expected rejection for ${JSON.stringify(mutant)}`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: review receipts may complete from pending but completed stays immutable", async () => {
  const ctx = await makeCtx("review-lifecycle");
  try {
    const store = storeAt(ctx, "a", "repair");
    const pending = reviewReceipt("rv:1");
    const head1 = appliedHead(
      await store.writeRepair(repairSnapshot({ reviews: [pending] }), null),
    );

    // Identity tampering fails: requestId, expectedReviewer, submittedAt, PR.
    const identityAttempts: ReturnType<typeof reviewReceipt>[] = [
      reviewReceipt("rv:1", { requestId: "req-other" }),
      reviewReceipt("rv:1", { expectedReviewer: "other[bot]" }),
      reviewReceipt("rv:1", { submittedAt: T0 + 1500 }),
      reviewReceipt("rv:1", {
        pullRequest: { number: 13, head: SHA3, base: SHA2 },
      }),
    ];
    for (const mutant of identityAttempts) {
      const result = await store.writeRepair(
        repairSnapshot({
          stateHead: head1,
          sequence: 2,
          updatedAt: T0 + 2000,
          reviews: [mutant],
        }),
        head1,
      );
      assert.ok(!result.ok, `expected rejection for ${JSON.stringify(mutant)}`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
    }

    // observedAt cannot move backward on a pending receipt.
    const backward = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reviews: [reviewReceipt("rv:1", { observedAt: T0 + 1500 })],
      }),
      head1,
    );
    assert.ok(!backward.ok);
    if (!backward.ok) assert.equal(backward.error.kind, "invalid");

    // A pending observation update (later observedAt) is legitimate.
    const observed = reviewReceipt("rv:1", { observedAt: T0 + 2500 });
    const observedResult = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reviews: [observed],
      }),
      head1,
    );
    assert.ok(observedResult.ok);
    if (observedResult.ok) {
      assert.equal(observedResult.value.status, "applied");
    }
    const head2 = observedResult.ok &&
        observedResult.value.status === "applied"
      ? observedResult.value.head
      : null;
    assert.ok(head2);

    // pending -> completed records the observed reviewer, result and findings.
    const completed = structuredClone(observed) as ReturnType<
      typeof reviewReceipt
    >;
    completed.outcome = "completed";
    completed.observedReviewer = completed.expectedReviewer;
    completed.resultId = "review-result-1";
    completed.summary = "One P1; otherwise acceptable.";
    completed.findings = [{
      id: "f-1",
      severity: "P1",
      path: null,
      message: "terminator dropped",
      fingerprint: asFindingFingerprint("a".repeat(64)),
      resolved: false,
      resolutionEvidence: null,
    }];
    completed.unresolvedSeverities = ["P1"];
    completed.completedAt = T0 + 3000;
    completed.observedAt = T0 + 4000;
    const completedResult = await store.writeRepair(
      repairSnapshot({
        stateHead: head2,
        sequence: 3,
        updatedAt: T0 + 3000,
        reviews: [completed],
      }),
      head2,
    );
    assert.ok(completedResult.ok);
    if (completedResult.ok) {
      assert.equal(completedResult.value.status, "applied");
    }
    const head3 = completedResult.ok &&
        completedResult.value.status === "applied"
      ? completedResult.value.head
      : null;
    assert.ok(head3);

    // A completed receipt is exactly immutable, and identity tampering on it
    // is still rejected.
    const mutateCompleted = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        reviews: [{ ...completed, summary: "changed" }],
      }),
      head3,
    );
    assert.ok(!mutateCompleted.ok);
    if (!mutateCompleted.ok) {
      assert.equal(mutateCompleted.error.kind, "invalid");
    }
    const tamperCompleted = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        reviews: [{
          ...completed,
          pullRequest: { ...completed.pullRequest, head: SHA3 },
        }],
      }),
      head3,
    );
    assert.ok(!tamperCompleted.ok);
    if (!tamperCompleted.ok) {
      assert.equal(tamperCompleted.error.kind, "invalid");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: duplicate artifact refs are rejected on the initial snapshot write", async () => {
  const ctx = await makeCtx("dup-artifact-initial");
  try {
    const store = storeAt(ctx, "a", "repair");
    // The guard must run on branch creation too, not only on transitions.
    const rawEvidence = JSON.parse(duplicateRefEvidenceText("ev:duplicate"));
    const result = await store.writeRepair(
      repairSnapshot({ evidence: [rawEvidence] }),
      null,
    );
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.error.kind, "invalid");
    // Nothing was applied: the ref stays absent.
    const read = await store.readRepair();
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.value.status, "absent");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: canonical raw remote records with duplicate artifact refs are rejected on read", async () => {
  const ctx = await makeCtx("dup-artifact-raw");
  try {
    const store = storeAt(ctx, "a", "repair");
    // Establish a valid first commit so the raw tree has a real parent.
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ evidence: [incidentEvidence("ev:1")] }),
        null,
      ),
    );

    // Push canonical bytes (exactly one semantic defect: a duplicate ref) as a
    // raw remote tree the store must validate; the read must fail closed,
    // never return the record. pushRawTree fetches the parent into the raw
    // work repo before building the child commit.
    const duplicateId = "ev:duplicate";
    await pushRawTree(ctx, head1, REPAIR_STATE_REF, {
      "manifest.json": rawManifestText(2, T0 + 2000, head1),
      [`evidence/${await sha256Hex(duplicateId)}.json`]:
        duplicateRefEvidenceText(
          duplicateId,
        ),
    }, ctx.env);
    const read = await store.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) assert.equal(read.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});
