// codex review transport drain_test.

import assert from "node:assert/strict";
import { renderReviewJournalBody } from "../../src/github/review-journal.ts";
import { T0 } from "./helpers.ts";
import {
  CLEAN_RESULT,
  DelayedCloseSession,
  DurableReviewStore,
  makeHarness,
  onlyReview,
  OP_KEY,
  OTHER_HEAD,
  PR,
  readyJournal,
  RecordingSession,
  REQUEST_ID,
  seed,
  settle,
  submission,
  waitFor,
} from "./codex-review-transport-helpers.ts";

Deno.test(
  "transport: an unknown operation key never falls back to a request-id match",
  async () => {
    const session = new RecordingSession();
    session.delayMs = 50;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    // The live owned operation carries REQUEST_ID, but this read names a
    // DIFFERENT operation key: every supplied identifier must match exactly,
    // so the local live receipt is never returned.
    const read = await h.transport.readReview({
      operationKey: "review:unknown-operation",
      requestId: REQUEST_ID,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.notEqual(
        read.value.status,
        "pending",
        "an unknown operation key must not match another operation by request id",
      );
    }
    // The exact identity still resolves locally while the operation is live.
    const exact = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: REQUEST_ID,
      prNumber: PR,
    });
    assert.equal(exact.ok, true);
    await settle(h.transport);
  },
);

Deno.test(
  "transport: a published journal for a different head is never adopted by identity",
  async () => {
    const store = new DurableReviewStore();
    const h = makeHarness({ store });
    // A standing COMMENTED ready journal for the SAME operation key/request id
    // but a DIFFERENT head: it must never be adopted as this submission.
    seed(
      store,
      renderReviewJournalBody(await readyJournal(CLEAN_RESULT)),
      "commented",
    );
    const fresh = h.freshTransport();
    const submitted = await fresh.submitReview(
      submission({ expectedHead: OTHER_HEAD }),
    );
    assert.equal(submitted.ok, true);
    assert.equal(submitted.ok ? submitted.value.status : "", "submitted");
    // The different-head record was NOT adopted: this submission reconciled it
    // as a foreign record and created/published its own exact-head review.
    assert.equal(store.creates, 1, "no adoption of the foreign-head record");
    await settle(fresh);
    assert.equal(store.submits, 1, "this submission published its own review");
    const created = [...store.reviews.values()].find((review) =>
      review.head === OTHER_HEAD
    );
    assert.ok(created, "the exact-head review exists");
  },
);

Deno.test(
  "transport: drain never awaits an owned close past the caller deadline",
  async () => {
    const session = new DelayedCloseSession(150);
    session.hangStart = true;
    session.settled = false;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    const started = Date.now();
    const report = await h.transport.drain({
      deadline: h.clock.now() + 5,
      interrupt: true,
    });
    const elapsed = Date.now() - started;
    // Caller time is gone: the close was initiated and its exact promise is
    // retained, but the drain reports the unsettled fault honestly instead of
    // waiting past the deadline.
    assert.equal(report.ok, false);
    assert.equal(report.operations[0].outcome, "faulted");
    assert.equal(report.operations[0].processSettled, false);
    assert.equal(report.interrupted, true);
    assert.ok(
      elapsed < 120,
      `the drain returned inside the caller deadline (${elapsed}ms)`,
    );
    // Release the outstanding close so no owned promise is left pending.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(session.closeCalls, 1, "the close is never duplicated");
    assert.equal(h.sessions.length, 1);
  },
);

Deno.test(
  "transport: a hung prestart submission retains and closes its prepared handle",
  async () => {
    const store = new DurableReviewStore();
    let release!: () => void;
    store.updateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new RecordingSession();
    const h = makeHarness({ store, session });
    const submitted = h.transport.submitReview(submission());
    await waitFor(() => store.updates >= 1);
    const report = await h.transport.drain({
      deadline: h.clock.now() + 5,
      interrupt: true,
    });
    assert.equal(report.ok, false);
    assert.equal(report.operations[0].outcome, "faulted");
    assert.equal(report.operations[0].processSettled, true);
    assert.equal(report.operations[0].durable, false);
    assert.equal(report.operations[0].phase, "intent");
    assert.equal(
      report.interrupted,
      false,
      "closing an unstarted prepared session is not an interruption",
    );
    assert.equal(session.turnStarts(), 0, "no model start exists");
    assert.equal(session.closed, 1, "the owned handle was closed");
    // Release the gated running update: the submission settles with no leak.
    release();
    const settled = await submitted;
    assert.equal(settled.ok, true);
    assert.equal(settled.ok ? settled.value.status : "", "ambiguous");
  },
);

Deno.test(
  "transport: only an actually started session is interrupted",
  async () => {
    // (a) An unstarted prepared handle is closed, never "interrupted".
    const preStore = new DurableReviewStore();
    let releasePre!: () => void;
    preStore.updateGate = new Promise<void>((resolve) => {
      releasePre = resolve;
    });
    const preSession = new RecordingSession();
    const pre = makeHarness({ store: preStore, session: preSession });
    const pendingSubmit = pre.transport.submitReview(submission());
    await waitFor(() => preStore.updates >= 1);
    const preReport = await pre.transport.drain({
      deadline: pre.clock.now() + 5,
      interrupt: true,
    });
    assert.equal(preReport.interrupted, false);
    assert.equal(preReport.operations[0].processSettled, true);
    releasePre();
    await pendingSubmit;

    // (b) A session that actually started and outlives the work boundary IS
    // interrupted, and its unproved close is never reported as settled.
    const startedSession = new RecordingSession();
    startedSession.hangStart = true;
    startedSession.settled = false;
    const run = makeHarness({ session: startedSession });
    const submitted = await run.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    const runReport = await run.transport.drain({
      deadline: run.clock.now() + 5,
      interrupt: true,
    });
    assert.equal(runReport.interrupted, true);
    assert.equal(runReport.operations[0].outcome, "faulted");
    assert.equal(runReport.operations[0].processSettled, false);
  },
);

Deno.test(
  "transport: drain proves owned journal finalization, not only the process close",
  async () => {
    const store = new DurableReviewStore();
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    store.readyUpdateGate = readyGate;
    const session = new RecordingSession();
    // The owned turn only settles when the session closes, and that close DOES
    // prove process settlement. The ready journal PUT/readback (and therefore
    // the COMMENT) stays gated afterwards.
    session.hangStart = true;
    session.settled = true;
    const h = makeHarness({ store, session });
    try {
      const submitted = await h.transport.submitReview(submission());
      assert.equal(submitted.ok, true);
      assert.equal(submitted.ok ? submitted.value.status : "", "submitted");

      const report = await h.transport.drain({
        deadline: h.clock.now() + 50,
        interrupt: true,
      });
      // The process close settled, but the owned journal finalization is still
      // pending: a drain may NOT report success on the proved close alone.
      assert.equal(report.ok, false);
      assert.equal(report.operations[0].outcome, "faulted");
      assert.equal(report.operations[0].processSettled, true);
      assert.equal(report.operations[0].durable, false);
      assert.equal(store.updates, 2, "the ready PUT was attempted");
      assert.equal(
        store.submits,
        0,
        "no COMMENT before finalization is proved",
      );
    } finally {
      // Every gate is released even when an assertion above failed.
      releaseReady();
    }
    // The retained owned promise still finalizes the journal: exactly one
    // COMMENT, and because the close interrupted a failed turn/start the
    // journal completes with the durable disposition `unavailable` for a fresh
    // reader rather than a completed review.
    await waitFor(() => store.submits === 1);
    assert.equal(onlyReview(store).state, "commented");
    const read = await h.freshTransport().readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");
  },
);

Deno.test(
  "transport: an unproved close keeps ownership against a same-key retry",
  async () => {
    const session = new RecordingSession();
    session.failStart = true;
    session.settled = false;
    const h = makeHarness({ session, maxActiveReviews: 1 });
    const first = await h.transport.submitReview(submission());
    assert.equal(first.ok, true);
    assert.equal(first.ok ? first.value.status : "", "submitted");
    // The owned run ends with an UNPROVED close: `done` is set locally, but the
    // retained prepared handle still owns the producer process.
    await waitFor(() => session.closed >= 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A same-key resubmission before any drain may never replace the operation
    // and drop the retained process ownership.
    const retry = await h.transport.submitReview(submission());
    assert.equal(
      retry.ok,
      false,
      "no replacement while settlement is unproved",
    );
    assert.equal(retry.ok ? "" : retry.error.kind, "conflict");
    // The retained operation still counts against active capacity.
    const other = await h.transport.submitReview(
      submission({ operationKey: "review:work-2", prNumber: 2 }),
    );
    assert.equal(
      other.ok,
      false,
      "the retained handle still occupies capacity",
    );
    assert.equal(other.ok ? "" : other.error.kind, "conflict");
    // No new prepare, start or review object: the original owned session and
    // the single durable intent stand.
    assert.equal(h.sessions.length, 1);
    assert.equal(session.opened, 1);
    assert.equal(session.turnStarts(), 1);
    assert.equal(h.store.creates, 1);

    // The drain still reports the RETAINED original handle, never a
    // replacement, and the close is never duplicated.
    const report = await h.transport.drain({ deadline: T0, interrupt: true });
    assert.equal(report.operations.length, 1);
    assert.equal(report.operations[0].operationKey, OP_KEY);
    assert.equal(report.operations[0].outcome, "faulted");
    assert.equal(report.operations[0].processSettled, false);
    assert.equal(session.closed, 1, "the close is never duplicated");
    assert.equal(h.sessions.length, 1, "no replacement session was prepared");
    assert.equal(
      h.store.submits,
      0,
      "no disposition without proved settlement",
    );
  },
);
