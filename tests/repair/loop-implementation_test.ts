/** Candidate eligibility, implementation uncertainty and P0 correction. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
  SHA4,
} from "./loop-rig.ts";
import { positiveLifecycle } from "./loop-candidate-fixtures.ts";

Deno.test("generated/cache-only candidates are never a repair", async () => {
  const rig = await makeRig("artifactonly", {
    model: {
      changedPaths: [".npm/_logs/2026-10-02T10_54_49_178Z-debug-0.log"],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "blocked");
    assert.equal(
      state.work[0]!.blocker?.message,
      "model candidate changed only generated/cache artifacts",
    );
    assert.equal(
      rig.github.pushes.length,
      0,
      "an artifact-only candidate is never published",
    );
    assert.equal(
      rig.github.calls.includes("requestReview"),
      false,
      "an artifact-only candidate is never reviewed",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("duplicate unresolved review severities are normalized before parsing", async () => {
  const rig = await makeRig("reviewseverity", {
    model: { heads: [SHA3, SHA4] },
    github: { candidateLifecycle: positiveLifecycle() },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    // Two unresolved findings of the one blocking severity (P0, owner
    // directive 2026-10-24) collapse to a single recorded severity and still
    // reject the head into one correction round.
    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([
      {
        id: "finding-p0-a",
        severity: "P0",
        path: "src/app.ts",
        message: "first required fix",
        fingerprint: "b".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      },
      {
        id: "finding-p0-b",
        severity: "P0",
        path: "src/app.ts",
        message: "second required fix",
        fingerprint: "c".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      },
    ], rig.clock.now());
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    const state = await rig.snapshot();
    assert.equal(state.reviews.length, 1);
    assert.deepEqual(state.reviews[0].unresolvedSeverities, ["P0"]);
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].target.head, SHA4);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("model uncertainty stays charged ambiguous and never resubmits", async () => {
  const rig = await makeRig("uncertain", {
    model: { portError: true },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    let state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "blocked");
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].outcome, "ambiguous");
    assert.ok(state.reservations[0].settledAt !== null);
    assert.equal(rig.model.requests.length, 1);

    // Never resubmit: subsequent runs leave the record blocked and unchanged.
    const sequenceBefore = await rig.sequence();
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(rig.model.requests.length, 1);
    assert.equal(await rig.sequence(), sequenceBefore);
    state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "blocked");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test(
  "repair loop: implementation uncertainty persists after budget settlement",
  async () => {
    // Regression for the audited defect: the ambiguous settlement of an
    // unsettled implementation intent writes the SAME authoritative repair
    // state, so the block must be applied to the REREAD head. Applying it to
    // the pre-settlement context is refused as state_error and the blocked
    // disposition is lost (the reservation still moves reserved -> ambiguous).
    const sourceIssue = issueRecord(31, {
      title: "uncertain implementation",
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    const github = new RelationsFakeGithub({ baseSha: SHA1 });
    github.listed = [sourceIssue];
    github.latest.set(31, sourceIssue);
    const rig = makeMemoryRig(github);
    const reservationId = "res-uncertain";
    const taskId = asWorkItemId("issue-31");
    const branch = candidateBranch(taskId);
    const uncertain = workRecord("issue-31", {
      source: { kind: "issue", id: "31", revision: SHA1 },
      related: { incidentId: null, issueNumber: 31 },
      target: { base: SHA1, branch, checkpoint: null, head: null, pr: null },
      nextStep: "work",
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      intent: {
        kind: "implementation",
        key: implementationIntentKey(reservationId),
        startedAt: T0,
        branch,
        expectedHead: null,
        observedBase: SHA1,
        pr: null,
        requestId: reservationId,
        resultId: null,
      },
    });
    // Unsettled reservation in the authoritative state the budget port writes.
    const charge = reservation(reservationId, {
      taskId,
      attempt: 1,
      head: SHA1,
      purpose: "implementation",
      outcome: "reserved",
      settledAt: null,
    });
    const written = await rig.state.writeRepair(
      seededSnapshot([uncertain], { reservations: [charge] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    // BASE returns state_error here (settlement moved the head); the fix
    // reloads the settled head and stores the blocked disposition.
    const outcome = await rig.run(3);
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.reservations.length, 1, "no replacement admission");
    assert.equal(state.reservations[0].id, reservationId);
    assert.equal(state.reservations[0].outcome, "ambiguous");
    assert.ok(state.reservations[0].settledAt !== null, "charge settled");
    const stored = state.work.find((work) => work.id === "issue-31")!;
    assert.equal(stored.nextStep, "blocked");
    assert.equal(stored.blocker?.kind, "other");
    assert.equal(stored.intent?.requestId, reservationId);
    assert.equal(rig.model.requests.length, 0, "never resubmitted");
  },
);

Deno.test("P0 findings trigger a fresh bounded implementation/candidate/replay path", async () => {
  const rig = await makeRig("p0fresh", {
    model: { heads: [SHA3, SHA4] },
    github: { candidateLifecycle: positiveLifecycle() },
  });
  try {
    // Run 1: the first candidate (SHA3) reaches the review wait.
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(rig.model.requests.length, 1);
    let state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].target.head, SHA3);

    // A P0 finding arrives on the observed head: it never merges and never
    // re-requests a review of the SAME rejected candidate. Instead the record
    // forgets the rejected head and runs a fresh bounded implementation,
    // validates the new candidate through the replay path and only then
    // updates the same PR and requests a review of the NEW head.
    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([{
      id: "finding-1",
      severity: "P0",
      path: "src/app.ts",
      message: "required fix",
      fingerprint: "a".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }], rig.clock.now());
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.model.requests.length,
      2,
      "a P0 finding opens exactly one fresh implementation",
    );
    assert.equal(
      rig.model.requests[1]?.base,
      SHA1,
      "correction preserves the reviewed development base in the request",
    );
    assert.equal(
      rig.model.requests[1]?.checkoutBase,
      SHA3,
      "correction starts from the rejected candidate head",
    );
    // The correction also carries the EXACT findings of the rejecting review:
    // without them the same change is re-implemented and the task can never
    // converge (a real four-round stalemate before this field existed).
    assert.deepEqual(
      rig.model.requests[1]?.reviewFindings,
      [{
        severity: "P0",
        path: "src/app.ts",
        message: "required fix",
      }],
      "the correction receives the unresolved review findings",
    );
    assert.equal(
      rig.model.requests[0]?.reviewFindings,
      undefined,
      "a first implementation carries no rejection findings",
    );

    state = await rig.snapshot();
    const work = state.work[0];
    assert.equal(work.nextStep, "review");
    assert.equal(work.target.head, SHA4, "corrected candidate head");
    assert.equal(work.target.pr, 7, "correction lands on the same PR");
    assert.equal(work.counters.attempts, 2);
    assert.equal(work.counters.reviewRounds, 2, "fresh correction round");
    assert.equal(
      rig.github.calls.includes("merge"),
      false,
      "P0 must never merge",
    );
    // The new candidate went through the before/after replay path with exact
    // original + candidate identities (a fresh candidate, not the old one).
    assert.equal(state.replays.length, 2);
    const newer = state.replays.find(
      (result) => result.candidate.revision === SHA4,
    );
    assert.ok(newer, "fresh candidate has a durable replay result");
    assert.equal(newer?.candidate.outcome, "passed");
    assert.equal(newer?.original.revision, SHA2);
    assert.equal(newer?.original.outcome, "failed");
    assert.equal(newer?.original.failure?.intended, true);
    // The corrected head is pushed onto the same branch and requested for
    // review once; no duplicate PR is created.
    assert.deepEqual(
      rig.github.pushes.map((push) => push.sha),
      [SHA3, SHA4],
      "new head pushed once to the existing branch",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      1,
      "no duplicate PR publication",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      2,
      "one review request per corrected head",
    );
    assert.equal(
      state.reservations.filter((reservation) =>
        reservation.outcome === "submitted"
      ).length,
      4,
      "implementation + review + retry implementation + correction review are each charged once",
    );
    // The rejected head is not silently forgotten: the review receipt remains
    // attached as evidence and the P0 finding is recorded.
    assert.ok(
      work.evidence.some((ref) => ref.kind === "review_receipt"),
      "P0 review receipt is retained as evidence",
    );
    assert.ok(
      state.reviews.some((review) =>
        review.outcome === "completed" &&
        review.unresolvedSeverities.includes("P0")
      ),
      "P0 finding is durably recorded",
    );
    // A LATER correction also carries the earlier rejections of the same pull
    // request, so the model can converge on the rule rather than the last case.
    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([{
      id: "finding-2",
      severity: "P0",
      path: "src/github/text.ts",
      message: "second required fix",
      fingerprint: "b".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }], rig.clock.now());
    const third = await rig.run();
    assert.equal(third.status, "idle", JSON.stringify(third));
    assert.equal(rig.model.requests.length, 3);
    const history = rig.model.requests[2]?.reviewFindings ?? [];
    const messages = history.map((finding) => finding.message);
    assert.ok(
      messages.includes("second required fix"),
      "the current rejection is carried",
    );
    assert.ok(
      messages.includes("required fix"),
      "the earlier rejection of the same pull request is carried too",
    );
  } finally {
    await rig.ctx.cleanup();
  }

  // No-verdict review observation keeps waiting (not an attempt or request).
  const rig3 = await makeRig("noverdict", {
    github: {
      reviewUnavailable: true,
      candidateLifecycle: positiveLifecycle(),
    },
  });
  try {
    await rig3.run();
    rig3.clock.advance(15 * 60_000 + 1);
    const before = rig3.model.requests.length;
    const reviewed = await rig3.run();
    assert.equal(reviewed.status, "idle", JSON.stringify(reviewed));
    const state3 = await rig3.snapshot();
    assert.ok(
      state3.work[0].wait?.reason === "review_pending" ||
        state3.work[0].wait?.reason === "review_quota" ||
        state3.work[0].wait?.reason === "unavailable",
    );
    assert.equal(
      state3.work[0].blocker,
      null,
      "a no-verdict review never terminally blocks",
    );
    assert.equal(rig3.model.requests.length, before);
  } finally {
    await rig3.ctx.cleanup();
  }

  // Protected path: candidate blocked before any publication.
  const rig4 = await makeRig("protected", {
    model: { changedPaths: ["src/handler.ts"] },
  });
  try {
    await rig4.run();
    const state4 = await rig4.snapshot();
    assert.equal(state4.work[0].nextStep, "blocked");
    assert.equal(rig4.github.pushes.length, 0);
    assert.equal(state4.reservations[0].outcome, "submitted", "charged");
  } finally {
    await rig4.ctx.cleanup();
  }
});

Deno.test("P1/P2/P3-only findings never spend a correction round", async () => {
  // Owner directive 2026-10-24: only an unresolved P0 blocks. An unresolved
  // P1 is recorded exactly like P2/P3 and spends no correction round either.
  const rig = await makeRig("p1nocorrection", {
    model: { heads: [SHA3, SHA4] },
    github: { candidateLifecycle: positiveLifecycle() },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(rig.model.requests.length, 1);
    assert.equal((await rig.snapshot()).work[0].target.head, SHA3);

    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([{
      id: "finding-p1",
      severity: "P1",
      path: "src/app.ts",
      message: "non-blocking required fix",
      fingerprint: "a".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }, {
      id: "finding-p2",
      severity: "P2",
      path: "src/app.ts",
      message: "optional improvement",
      fingerprint: "b".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }, {
      id: "finding-p3",
      severity: "P3",
      path: null,
      message: "nit",
      fingerprint: "c".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }], rig.clock.now());
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.model.requests.length,
      1,
      "non-blocking findings open no correction implementation",
    );
    const after = await rig.snapshot();
    const work = after.work[0];
    assert.ok(
      after.reviews.some((review) =>
        review.outcome === "completed" &&
        review.unresolvedSeverities.includes("P1")
      ),
      "the unresolved P1 is recorded without rejecting the head",
    );
    assert.equal(
      work.nextStep,
      "delivery",
      "a non-blocking verdict proceeds to delivery",
    );
    assert.equal(work.target.head, SHA3, "the reviewed head is kept");
    assert.equal(work.counters.reviewRounds, 1, "no extra review round");
    assert.deepEqual(
      rig.github.pushes.map((push) => push.sha),
      [SHA3],
      "no corrected head is pushed",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
