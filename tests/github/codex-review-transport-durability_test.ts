// codex review transport durability_test.

import assert from "node:assert/strict";
import {
  parseReviewJournalBody,
  renderReviewJournalBody,
  type ReviewJournalRunningV1,
} from "../../src/github/review-journal.ts";
import { REPO, REVIEWER, T0 } from "./helpers.ts";
import {
  REVIEW_TRANSPORT_TOTAL_MS,
  staticUnavailableSummary,
} from "../../src/github/codex-review-transport.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import {
  BASE,
  CLEAN_RESULT,
  HEAD,
  makeHarness,
  onlyReview,
  OP_KEY,
  PR,
  readyExecution,
  readyJournal,
  RecordingSession,
  REQUEST_ID,
  seed,
  settle,
  snapshotFixture,
  submission,
  withRealGitRange,
} from "./codex-review-transport-helpers.ts";

// ---------------------------------------------------------------------------
// Durable running journal, lost writes, no duplicate model
// ---------------------------------------------------------------------------

Deno.test(
  "transport: a tampered running readback prevents the single start",
  async () => {
    const h = makeHarness();
    h.store.tamperUpdates = true;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    assert.equal(submitted.ok ? submitted.value.status : "", "ambiguous");
    const session = h.sessions[0];
    assert.equal(session.turnStarts(), 0);
    assert.equal(session.closed, 1);
    // The durable journal stands: a fresh host reads it as unavailable
    // (charged), never as a completed review and never as a restart.
    const read = await h.freshTransport().readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");
    assert.equal(h.store.submits, 0);
  },
);

Deno.test(
  "transport: a rejected running update with no readback proof prevents the start",
  async () => {
    const h = makeHarness();
    h.store.failUpdate = true;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, false);
    const session = h.sessions[0];
    assert.equal(session.turnStarts(), 0);
    assert.equal(session.closed, 1);
  },
);

Deno.test(
  "transport: a lost create is recovered from the exact intent without a second create",
  async () => {
    const h = makeHarness();
    h.store.lostCreate = true;
    h.store.lostCreateApplies = true;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    assert.equal(submitted.ok ? submitted.value.status : "", "submitted");
    await settle(h.transport);
    assert.equal(h.store.creates, 1);
    assert.equal(h.sessions[0].turnStarts(), 1);
    assert.equal(onlyReview(h.store).state, "commented");
  },
);

Deno.test(
  "transport: an uncertain lost create is ambiguous and never creates twice",
  async () => {
    const h = makeHarness();
    h.store.lostCreate = true;
    h.store.lostCreateApplies = false;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    assert.equal(submitted.ok ? submitted.value.status : "", "ambiguous");
    assert.equal(h.store.creates, 1);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.store.reviews.size, 0);
  },
);

Deno.test(
  "transport: a lost running update is reconciled by the exact readback before the start",
  async () => {
    const h = makeHarness();
    h.store.lostUpdate = true;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    assert.equal(submitted.ok ? submitted.value.status : "", "submitted");
    await settle(h.transport);
    // Exactly one running update (never retried) plus the ready update.
    assert.equal(h.store.updates, 2);
    assert.equal(h.sessions[0].turnStarts(), 1);
  },
);

Deno.test(
  "transport: a lost submit response is reconciled by exact id and publishes once",
  async () => {
    const h = makeHarness();
    h.store.lostSubmit = true;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    await settle(h.transport);
    assert.equal(h.store.submits, 1);
    assert.equal(h.store.creates, 1);
    assert.equal(onlyReview(h.store).state, "commented");
    const read = await h.freshTransport().readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "completed");
  },
);

Deno.test(
  "transport: a stale running journal on a fresh host is unavailable and never restarts the model",
  async () => {
    const h = makeHarness();
    const running: ReviewJournalRunningV1 = {
      version: "v1",
      phase: "running",
      repository: { owner: REPO.owner, name: REPO.name },
      prNumber: PR,
      expectedHead: HEAD,
      expectedBase: BASE,
      operationKey: OP_KEY,
      publisher: REVIEWER,
      requestId: REQUEST_ID,
      requestedAt: T0 - 5_000,
      reviewId: 100,
      execution: readyExecution(),
    };
    seed(h.store, renderReviewJournalBody(running), "pending");

    const fresh = h.freshTransport();
    const read = await fresh.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");

    // A new submission for the same review identity reconciles the durable
    // record, stays charged and never prepares or starts a model.
    const submitted = await fresh.submitReview(submission());
    assert.equal(submitted.ok, false);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.store.creates, 0);
  },
);

Deno.test(
  "transport: a ready pending journal is published from readReview with no inference",
  async () => {
    const h = makeHarness();
    const journal = await readyJournal(CLEAN_RESULT);
    seed(h.store, renderReviewJournalBody(journal), "pending");

    const fresh = h.freshTransport();
    const read = await fresh.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.status, "completed");
      assert.equal(read.value.completedAt, journal.completedAt);
      assert.equal(read.value.resultDigest, journal.resultDigest);
      assert.equal(read.value.resultId, "result-1");
      assert.equal(read.value.requestId, journal.requestId);
    }
    const review = onlyReview(h.store);
    assert.equal(review.state, "commented");
    // No snapshot, no prepare, no model start, no new review object and the
    // ORIGINAL journal bytes are the submitted body.
    assert.equal(h.snapshotCaptures(), 0);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.store.creates, 0);
    assert.equal(h.store.updates, 0);
    assert.equal(h.store.submits, 1);
    assert.equal(h.store.submittedBodies[0], review.body);
  },
);

Deno.test(
  "transport: a durable unavailable disposition never completes clean",
  async () => {
    const session = new RecordingSession();
    session.failStart = true;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    await settle(h.transport);
    const review = onlyReview(h.store);
    const unavailable = await parseReviewJournalBody(review.body ?? "");
    assert.ok(unavailable.phase === "ready");
    assert.equal(unavailable.result.verdict, "unavailable");
    const read = await h.freshTransport().readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.status, "unavailable");
      assert.equal(read.value.terminalTurnSucceeded, false);
    }
  },
);

Deno.test(
  "transport: a settled start refusal keeps its own bounded static reason",
  async () => {
    // `failStart` rejects the single turn submission AFTER preparation, so the
    // real producer returns a TYPED start refusal (not a throw) and proves
    // process settlement. That refusal is the only evidence that distinguishes
    // "this attempt is over with no verdict" from "nothing concluded yet", so
    // the durable disposition must carry its exact static detail.
    const session = new RecordingSession();
    session.failStart = true;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    await settle(h.transport);
    const review = onlyReview(h.store);
    const unavailable = await parseReviewJournalBody(review.body ?? "");
    assert.ok(unavailable.phase === "ready");
    assert.equal(unavailable.result.verdict, "unavailable");
    assert.equal(
      unavailable.result.summary,
      "structured review unavailable: the single turn submission was not acknowledged",
    );
    // The durable disposition is terminal: a fresh host reads the same
    // bounded static reason and a completed instant, never a pending wait.
    const read = await h.freshTransport().readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.status, "unavailable");
      assert.equal(
        read.value.summary,
        "structured review unavailable: the single turn submission was not acknowledged",
      );
      assert.notEqual(read.value.completedAt, null);
      assert.equal(read.value.expectedBase, BASE);
    }
  },
);

Deno.test(
  "transport: an unavailable disposition never carries unfiltered text",
  () => {
    // Every accepted disposition reason is a short single-line printable-ASCII
    // static detail; anything else (raw error text, provider output, a stack,
    // an empty string, a multi-line message) is replaced by the generic
    // sentence, so the durable journal can never carry unfiltered content.
    for (
      const reason of [
        "",
        "line one\nline two",
        "bell \u0007 here",
        "x".repeat(257),
        "review transport: \u00e9\u00e8",
        "review transport: the start was rejected",
      ]
    ) {
      const bounded = staticUnavailableSummary(reason);
      const accepted = reason.length > 0 && reason.length <= 256 &&
        /^[\x20-\x7e]+$/.test(reason);
      assert.equal(
        bounded,
        accepted
          ? reason
          : "structured review unavailable: the review did not produce a validated result",
        reason,
      );
    }
    assert.equal(
      staticUnavailableSummary(null),
      "structured review unavailable: the review did not produce a validated result",
    );
    assert.equal(
      staticUnavailableSummary(42),
      "structured review unavailable: the review did not produce a validated result",
    );
  },
);

Deno.test(
  "transport: an unproved close keeps ownership and publishes no disposition",
  async () => {
    const session = new RecordingSession();
    session.hangStart = true;
    session.settled = false;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    const report = await h.transport.drain({ deadline: T0, interrupt: true });
    assert.equal(report.ok, false);
    assert.equal(report.operations[0].outcome, "faulted");
    assert.equal(report.operations[0].processSettled, false);
    assert.equal(report.interrupted, true);
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.notEqual(read.value.status, "completed");
    assert.equal(h.store.submits, 0);
  },
);

// ---------------------------------------------------------------------------
// Overlap and drain
// ---------------------------------------------------------------------------

Deno.test(
  "transport: one live review overlaps a second implementation target",
  async () => {
    const session = new RecordingSession();
    session.delayMs = 50;
    const h = makeHarness({ session });
    const first = await h.transport.submitReview(submission());
    assert.equal(first.ok, true);
    // The review is live and independent: the one implementation writer can
    // advance another task while it runs. A second review for the SAME PR is
    // rejected as overlapping.
    const overlap = await h.transport.submitReview(
      submission({ operationKey: "review:work-2" }),
    );
    assert.equal(overlap.ok, false);
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "pending");
    assert.equal(session.turnStarts(), 1);
    // The healthy review still completes and settles normally.
    await settle(h.transport);
    assert.equal(onlyReview(h.store).state, "commented");
  },
);

Deno.test(
  "transport: drain awaits a healthy review without an eager interruption",
  async () => {
    const session = new RecordingSession();
    session.delayMs = 5;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    const report = await h.transport.drain({
      deadline: T0 + REVIEW_TRANSPORT_TOTAL_MS,
      interrupt: true,
    });
    assert.equal(report.ok, true);
    assert.equal(report.operations.length, 1);
    assert.equal(report.operations[0].outcome, "settled");
    assert.equal(report.operations[0].phase, "published");
    assert.equal(report.operations[0].processSettled, true);
    // Never interrupted merely because input.interrupt was true.
    assert.equal(report.interrupted, false);
    assert.equal(session.turnStarts(), 1);
    assert.equal(session.closed, 1);
  },
);

Deno.test(
  "transport: drain stops admission and a late submission never starts a model",
  async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new RecordingSession();
    const h = makeHarness({
      session,
      snapshot: {
        async capture() {
          await gate;
          return portOk(await snapshotFixture());
        },
      },
    });
    const pending = h.transport.submitReview(submission());
    const report = await h.transport.drain({ deadline: T0, interrupt: true });
    // The in-flight submission could not be awaited inside the caller's
    // deadline: ownership is retained and the operation is reported faulted.
    assert.equal(report.ok, false);
    assert.equal(report.operations[0].outcome, "faulted");
    release!();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(
      result.ok ? result.value.status : "",
      "rejected",
      "a submission awaiting work during drain must not start",
    );
    assert.equal(session.turnStarts(), 0);
    assert.equal(h.store.creates, 0);
  },
);

Deno.test(
  "transport: a short deadline rejects a last-second review before any create",
  async () => {
    const h = makeHarness();
    const late = await h.transport.submitReview(
      submission({ latestStartAt: T0, settleBy: T0 + 100_000 }),
    );
    assert.equal(late.ok, false);
    assert.equal(h.store.creates, 0);

    // The clock crosses the full-review bound while the snapshot is captured.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = makeHarness({
      snapshot: {
        async capture() {
          await gate;
          return portOk(await snapshotFixture());
        },
      },
    });
    const pending = gated.transport.submitReview(submission());
    gated.clock.advance(120_000);
    release!();
    const rejected = await pending;
    assert.equal(rejected.ok, true);
    assert.equal(rejected.ok ? rejected.value.status : "", "rejected");
    assert.equal(gated.store.creates, 0);
    assert.equal(gated.sessions.length, 0);
  },
);

Deno.test("transport: native review mode is the only journaled model start", async () => {
  const h = makeHarness();
  const submitted = await h.transport.submitReview(submission());
  assert.equal(submitted.ok, true);
  await settle(h.transport);
  const session = h.sessions[0];
  assert.equal(session.sent.includes("turn/start"), false);
  assert.equal(
    session.sent.filter((method) => method === "review/start").length,
    1,
  );
  const thread = session.params[session.sent.indexOf("thread/start")] as Record<
    string,
    unknown
  >;
  for (const key of ["model", "modelProvider", "effort", "outputSchema"]) {
    assert.equal(Object.hasOwn(thread, key), false, key);
  }
  const params = session.params[session.sent.indexOf("review/start")] as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(params).sort(), [
    "delivery",
    "target",
    "threadId",
  ]);
});

Deno.test("transport: real Git native lifecycle retains exact issue acceptance and refuses its absence", async () => {
  await withRealGitRange(async ({ base, head, snapshot }) => {
    const statement = {
      issueNumber: 41,
      title: "Add deposits",
      body: "deposit must add the supplied amount.",
    };
    const task = {
      ...statement,
      digest: await reviewTaskStatementDigest(statement),
    };
    for (const fulfilled of [true, false]) {
      const session = new RecordingSession();
      session.result = {
        ...CLEAN_RESULT,
        taskAcceptance: fulfilled
          ? {
            issueNumber: task.issueNumber,
            taskDigest: task.digest,
            verdict: "fulfilled",
            evidence: [
              "account.ts adds the supplied amount at the exact head.",
            ],
          }
          : null,
      };
      const h = makeHarness({ session, snapshot });
      const result = await h.transport.submitReview(
        submission({ expectedBase: base, expectedHead: head, task }),
      );
      assert.equal(result.ok, true);
      await settle(h.transport);
      const body = onlyReview(h.store).body!;
      const journal = await parseReviewJournalBody(body);
      assert.equal(journal.phase, "ready");
      if (journal.phase !== "ready") {
        assert.fail("native review did not settle");
      }
      assert.equal(journal.result.verdict, fulfilled ? "clean" : "unavailable");
      assert.equal(journal.expectedHead, head);
      assert.equal(journal.expectedBase, base);
      if (fulfilled) {
        assert.equal(journal.execution?.nativeReview?.mode, "review/start");
        assert.equal(
          journal.execution?.actual.nativeReview?.enteredItemId,
          "entered-1",
        );
        assert.equal(
          journal.execution?.actual.nativeReview?.exitedItemId,
          "item-1",
        );
        assert.equal(journal.result.taskAcceptance?.taskDigest, task.digest);
      } else assert.equal(journal.execution, null);
      assert.equal(session.turnStarts(), 1);
      assert.equal(session.sent.includes("turn/start"), false);
      assert.equal(session.closed, 1);
    }
  });
});

Deno.test("transport: historical generic journals stay byte-readable but cannot satisfy native completion", async () => {
  const h = makeHarness();
  const native = readyExecution();
  const { nativeReview: _native, ...legacy } = native;
  const { nativeReview: _actual, ...actual } = native.actual;
  const execution = {
    ...legacy,
    model: "historical-reviewer",
    reasoning: "max" as const,
    actual: {
      ...actual,
      evidenceKind: "request-runtime" as const,
      observedModel: "historical-reviewer",
      observedReasoning: "max" as const,
    },
  };
  const journal = await readyJournal(CLEAN_RESULT, { execution });
  const body = renderReviewJournalBody(journal);
  assert.equal(
    renderReviewJournalBody(await parseReviewJournalBody(body)),
    body,
  );
  seed(h.store, body, "commented");
  const read = await h.freshTransport().readReview({
    operationKey: OP_KEY,
    requestId: null,
    prNumber: PR,
  });
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.value.status, "unavailable");
  assert.equal(onlyReview(h.store).body, body);
  assert.equal(h.sessions.length, 0);
});
