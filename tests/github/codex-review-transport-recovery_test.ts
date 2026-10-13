/** Exact-owned pending journal recovery after proved session settlement. */
import assert from "node:assert/strict";
import {
  parseReviewJournalBody,
  renderReviewJournalBody,
} from "../../src/github/review-journal.ts";
import { REVIEW_TRANSPORT_TOTAL_MS } from "../../src/github/codex-review-transport.ts";
import {
  DurableReviewStore,
  makeHarness,
  onlyReview,
  OP_KEY,
  PR,
  RecordingSession,
  submission,
} from "./codex-review-transport-helpers.ts";

async function stoppedPending(settled = true) {
  const store = new DurableReviewStore();
  const session = settled ? undefined : new RecordingSession();
  if (session !== undefined) session.settled = false;
  const harness = makeHarness({ store, session });
  const handle = store.handle;
  let crossed = false;
  store.handle = async (request) => {
    const result = await handle(request);
    if (
      !crossed && request.method === "GET" &&
      request.url.endsWith("/reviews/100") &&
      (await parseReviewJournalBody(onlyReview(store).body!)).phase ===
        "running"
    ) {
      crossed = true;
      // Cross the start gate while preserving the existing close grace.
      harness.clock.advance(60_001);
    }
    return result;
  };
  const submitted = await harness.transport.submitReview(submission());
  assert.equal(submitted.ok, true);
  if (submitted.ok) assert.equal(submitted.value.status, "ambiguous");
  assert.equal(harness.sessions[0]!.turnStarts(), 0);
  assert.equal(onlyReview(store).state, "pending");
  return harness;
}

const observation = { operationKey: OP_KEY, requestId: null, prNumber: PR };

Deno.test(
  "transport recovery: exact settled owner terminalizes its pending journal before a fresh round",
  async () => {
    const h = await stoppedPending();
    const before = await parseReviewJournalBody(onlyReview(h.store).body!);
    assert.equal(before.phase, "running");
    const read = await h.transport.readReview(observation);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.status, "unavailable");
      assert.notEqual(read.value.completedAt, null);
    }
    const after = await parseReviewJournalBody(onlyReview(h.store).body!);
    assert.equal(after.phase, "ready");
    assert.equal(after.operationKey, before.operationKey);
    assert.equal(after.requestId, before.requestId);
    assert.equal(after.expectedHead, before.expectedHead);
    assert.equal(after.expectedBase, before.expectedBase);
    assert.equal(after.requestedAt, before.requestedAt);
    if (after.phase === "ready") {
      assert.equal(after.result.verdict, "unavailable");
      assert.equal(after.execution, null);
    }
    assert.equal(onlyReview(h.store).state, "commented");
    assert.equal(h.sessions.length, 1, "reconciliation never opens a session");
    const nextKey = `${OP_KEY}:attempt-2`;
    const next = await h.transport.submitReview(submission({
      operationKey: nextKey,
      latestStartAt: h.clock.now() + 60_000,
      settleBy: h.clock.now() + REVIEW_TRANSPORT_TOTAL_MS,
    }));
    assert.equal(next.ok, true);
    if (next.ok) assert.equal(next.value.status, "submitted");
    const drained = await h.transport.drain({
      deadline: h.clock.now() + REVIEW_TRANSPORT_TOTAL_MS,
      interrupt: false,
    });
    assert.equal(drained.ok, true, drained.faults.join(","));
    assert.equal(h.sessions.length, 2);
    assert.equal(h.sessions[1]!.turnStarts(), 1);
    assert.equal(h.store.creates, 2);
    const completed = await h.transport.readReview({
      ...observation,
      operationKey: nextKey,
    });
    assert.equal(completed.ok, true);
    if (completed.ok) assert.equal(completed.value.status, "completed");
  },
);

Deno.test(
  "transport recovery: a fresh host cannot terminalize another owner's pending journal",
  async () => {
    const h = await stoppedPending();
    const body = onlyReview(h.store).body;
    const read = await h.freshTransport().readReview(observation);
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.completedAt, null);
    assert.equal(onlyReview(h.store).body, body);
    assert.equal(h.store.submits, 0);
    assert.equal(h.sessions.length, 1);
  },
);

Deno.test(
  "transport recovery: a changed running execution cannot borrow local settlement proof",
  async () => {
    const h = await stoppedPending();
    const review = onlyReview(h.store);
    const journal = await parseReviewJournalBody(review.body!);
    assert.equal(journal.phase, "running");
    if (journal.phase !== "running") assert.fail("expected running journal");
    review.body = renderReviewJournalBody({
      ...journal,
      execution: { ...journal.execution, threadId: "another-thread" },
    });
    const body = review.body;
    const read = await h.transport.readReview(observation);
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.completedAt, null);
    assert.equal(review.body, body);
    assert.equal(h.store.submits, 0);
  },
);

Deno.test(
  "transport recovery: an unproved close retains the pending journal and ownership",
  async () => {
    const h = await stoppedPending(false);
    const body = onlyReview(h.store).body;
    const read = await h.transport.readReview(observation);
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.completedAt, null);
    assert.equal(onlyReview(h.store).body, body);
    assert.equal(h.store.submits, 0);
    const refused = await h.transport.submitReview(submission({
      operationKey: `${OP_KEY}:attempt-2`,
      latestStartAt: h.clock.now() + 60_000,
      settleBy: h.clock.now() + REVIEW_TRANSPORT_TOTAL_MS,
    }));
    assert.equal(refused.ok, false);
    assert.equal(h.sessions.length, 1);
    assert.equal(h.sessions[0]!.turnStarts(), 0);
  },
);
