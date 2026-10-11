/**
 * T03: durable GitHub Codex review transport acceptance.
 *
 * The scripted HTTP handler below is a DURABLE remote store shared by fresh
 * transport instances (read/write through the real `GitHubApiClient`); the
 * producer is the real recording `CodexStructuredReviewer` over a scripted
 * app-server session and the snapshot producer is the real `GitReviewSnapshot`
 * against real temporary Git repositories. No live GitHub, model, network or
 * paid call is made; every wait is milliseconds or driven by a controllable
 * promise.
 */

import assert from "node:assert/strict";
import {
  isJournalBoundExceeded,
  MAX_JOURNAL_BYTES,
  parseReviewJournalBody,
  parseReviewResultJson,
  renderReviewJournalBody,
  reviewResultDigest,
} from "../../src/github/review-journal.ts";
import { REPO, REVIEWER, T0 } from "./helpers.ts";
import { asGitSha } from "../../src/contracts/brands.ts";
import {
  CLEAN_RESULT,
  FINDINGS_RESULT,
  HEAD,
  makeHarness,
  onlyReview,
  OP_KEY,
  oversizedFindingsResult,
  PR,
  PROVIDER,
  readyJournal,
  RecordingSession,
  REQUEST_ID,
  seed,
  settle,
  submission,
  withRealGitRange,
} from "./codex-review-transport-helpers.ts";

Deno.test(
  "transport: real Git snapshot and recording session publish one exact clean COMMENT",
  async () => {
    await withRealGitRange(async ({ base, head, snapshot }) => {
      const session = new RecordingSession();
      session.result = CLEAN_RESULT;
      const h = makeHarness({ session, snapshot });
      const submitted = await h.transport.submitReview(
        submission({ expectedBase: base, expectedHead: head }),
      );
      assert.equal(submitted.ok, true);
      assert.equal(submitted.ok ? submitted.value.status : "", "submitted");
      await settle(h.transport);
      const review = onlyReview(h.store);
      assert.equal(review.state, "commented");
      assert.equal(review.head, head);
      assert.equal(session.opened, 1);
      assert.equal(session.turnStarts(), 1);
      assert.equal(session.closed, 1);
      assert.equal(h.store.creates, 1);
      assert.equal(
        h.store.requests.filter((entry) =>
          entry === "POST /repos/ubiquity/sentinel/pulls/1/reviews"
        ).length,
        1,
        "exactly one review object is created",
      );
      // One running update and one ready update, then exactly one COMMENT.
      assert.equal(h.store.updates, 2);
      assert.equal(h.store.submits, 1);
      const body = review.body ?? "";
      const journal = await parseReviewJournalBody(body);
      assert.ok(journal.phase === "ready");
      assert.deepEqual(journal.result, CLEAN_RESULT);
      // The durable review binding is proved on the PARSED journal identity,
      // never by a substring of the rendered body.
      assert.equal(journal.expectedBase, base);
      assert.equal(journal.expectedHead, head);

      // A fresh transport instance reads the durable completion, not a memory.
      const read = await h.freshTransport().readReview({
        operationKey: OP_KEY,
        requestId: null,
        prNumber: PR,
      });
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.value.status, "completed");
        assert.equal(
          read.value.resultDigest,
          await reviewResultDigest(CLEAN_RESULT),
        );
        assert.equal(read.value.expectedReviewer, REVIEWER);
        assert.equal(read.value.expectedHead, head);
      }
    });
  },
);

Deno.test(
  "transport: configured review model identity is durable across the review handoff",
  async () => {
    const configured = "route-selected-review-model";
    await withRealGitRange(async ({ base, head, snapshot }) => {
      const session = new RecordingSession();
      session.model = configured;
      const h = makeHarness({ session, snapshot, reviewModel: configured });
      const submitted = await h.transport.submitReview(
        submission({ expectedBase: base, expectedHead: head }),
      );
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      await settle(h.transport);
      const review = onlyReview(h.store);
      assert.equal(review.state, "commented");

      // The submitted thread and turn bind the configured model, never the
      // omitted-caller default literal.
      const threadParams = session.params[1] as Record<string, unknown>;
      assert.equal(threadParams.model, configured);
      assert.equal(threadParams.modelProvider, PROVIDER);
      assert.equal(
        (threadParams.config as Record<string, unknown>).review_model,
        configured,
      );
      const turnParams = session.params[2] as Record<string, unknown>;
      assert.equal(turnParams.model, configured);
      assert.equal(turnParams.effort, "max");

      // The durable journal round-trips the exact configured identity.
      const journal = await parseReviewJournalBody(review.body ?? "");
      assert.equal(journal.phase, "ready");
      if (journal.phase === "ready") {
        assert.equal(journal.execution?.model, configured);
        assert.equal(journal.execution?.submittedProvider, PROVIDER);
        assert.equal(journal.execution?.reasoning, "max");
        assert.equal(journal.execution?.actual.observedModel, configured);
        assert.equal(journal.execution?.actual.observedReasoning, "max");
      }

      // A fresh transport instance still observes the durable completion.
      const read = await h.freshTransport().readReview({
        operationKey: OP_KEY,
        requestId: null,
        prNumber: PR,
      });
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.value.status, "completed");
        assert.equal(read.value.expectedHead, head);
      }
    });
  },
);

Deno.test(
  "transport: full multiline findings are published intact",
  async () => {
    await withRealGitRange(async ({ base, head, snapshot }) => {
      const session = new RecordingSession();
      session.result = FINDINGS_RESULT;
      const h = makeHarness({ session, snapshot });
      const submitted = await h.transport.submitReview(
        submission({ expectedBase: base, expectedHead: head }),
      );
      assert.equal(submitted.ok, true);
      await settle(h.transport);
      const review = onlyReview(h.store);
      const body = review.body ?? "";
      const journal = await parseReviewJournalBody(body);
      assert.ok(journal.phase === "ready");
      assert.deepEqual(journal.result, FINDINGS_RESULT);
      assert.ok(body.includes("Deposit uses subtraction"));
      assert.ok(body.includes("`balance - amount`"));

      const read = await h.freshTransport().readReview({
        operationKey: OP_KEY,
        requestId: null,
        prNumber: PR,
      });
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.value.status, "completed");
        assert.equal(read.value.summary, FINDINGS_RESULT.summary);
      }
    });
  },
);

Deno.test(
  "transport: an oversized valid result settles as a bounded unavailable journal",
  async () => {
    await withRealGitRange(async ({ base, head, snapshot }) => {
      const result = oversizedFindingsResult();
      // The model-result parser accepts each finding and the complete JSON;
      // that does not promise that the journal's duplicated representations
      // fit the publication bound.
      assert.deepEqual(parseReviewResultJson(JSON.stringify(result)), result);
      const candidate = await readyJournal(result);
      let renderError: unknown = null;
      try {
        renderReviewJournalBody(candidate);
      } catch (error) {
        renderError = error;
      }
      assert.equal(isJournalBoundExceeded(renderError), true);

      const session = new RecordingSession();
      session.result = result;
      const h = makeHarness({ session, snapshot });
      // Both durable publication writes report an ambiguous response after
      // applying. The consumer must reconcile exact readback, not retry.
      h.store.lostUpdate = true;
      h.store.lostSubmit = true;
      const submitted = await h.transport.submitReview(
        submission({ expectedBase: base, expectedHead: head }),
      );
      assert.equal(submitted.ok, true);
      assert.equal(submitted.ok ? submitted.value.status : "", "submitted");
      await settle(h.transport);

      const review = onlyReview(h.store);
      assert.equal(review.state, "commented");
      assert.equal(session.turnStarts(), 1);
      assert.equal(session.closed, 1);
      assert.equal(h.store.creates, 1);
      assert.equal(h.store.updates, 2);
      assert.equal(h.store.submits, 1);
      assert.ok(
        new TextEncoder().encode(review.body ?? "").byteLength <=
          MAX_JOURNAL_BYTES,
      );
      const journal = await parseReviewJournalBody(review.body ?? "");
      assert.ok(journal.phase === "ready");
      assert.equal(journal.result.verdict, "unavailable");
      assert.deepEqual(journal.result.findings, []);
      assert.equal(journal.execution, null);
      assert.equal(journal.operationKey, OP_KEY);
      assert.equal(journal.requestId, REQUEST_ID);
      assert.equal(journal.reviewId, review.id);
      assert.equal(journal.prNumber, PR);
      assert.equal(journal.expectedBase, base);
      assert.equal(journal.expectedHead, head);

      // A fresh consumer recognizes the terminal unavailable disposition and
      // an exact resubmission adopts it without another review or model start.
      const fresh = h.freshTransport();
      const read = await fresh.readReview({
        operationKey: OP_KEY,
        requestId: null,
        prNumber: PR,
      });
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.value.status, "unavailable");
        assert.equal(read.value.operationKey, OP_KEY);
        assert.equal(read.value.requestId, REQUEST_ID);
        assert.equal(read.value.githubReviewId, review.id);
        assert.equal(read.value.expectedBase, base);
        assert.equal(read.value.expectedHead, head);
      }
      assert.equal(h.snapshotCaptures(), 1);
      assert.equal(h.sessions.length, 1);
      const retry = await fresh.submitReview(
        submission({ expectedBase: base, expectedHead: head }),
      );
      assert.equal(retry.ok, true);
      assert.equal(retry.ok ? retry.value.status : "", "submitted");
      assert.equal(h.store.creates, 1);
      assert.equal(h.store.submits, 1);
      assert.equal(session.turnStarts(), 1);
    });
  },
);

// ---------------------------------------------------------------------------
// Strict consumers: prose, digest, publisher, duplicates, foreign drafts
// ---------------------------------------------------------------------------

Deno.test(
  "transport: old clean prose is never adopted as completion",
  async () => {
    const h = makeHarness();
    seed(
      h.store,
      "## Codex review\n\nNo issues found. Looks good to merge.",
      "commented",
    );
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");
  },
);

Deno.test(
  "transport: a digest mismatch in the standing ready body is unavailable",
  async () => {
    const h = makeHarness();
    const journal = await readyJournal(CLEAN_RESULT);
    seed(
      h.store,
      renderReviewJournalBody({
        ...journal,
        resultDigest: "0".repeat(64),
      }),
      "commented",
    );
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");
  },
);

Deno.test(
  "transport: wrong publisher, head or base never completes",
  async () => {
    const foreign = makeHarness();
    seed(
      foreign.store,
      renderReviewJournalBody(await readyJournal(CLEAN_RESULT)),
      "commented",
      { author: "someone-else[bot]" },
    );
    const readForeign = await foreign.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(readForeign.ok, true);
    if (readForeign.ok) assert.equal(readForeign.value.status, "unavailable");

    const wrongHead = makeHarness();
    seed(
      wrongHead.store,
      renderReviewJournalBody(await readyJournal(CLEAN_RESULT)),
      "commented",
      { head: asGitSha("c".repeat(40)) },
    );
    const readHead = await wrongHead.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(readHead.ok, true);
    if (readHead.ok) assert.equal(readHead.value.status, "unavailable");

    const wrongBase = makeHarness();
    // A durable intent for the exact operation on a DIFFERENT base is never
    // upgraded into a preparation or start: the submission stays unavailable.
    seed(
      wrongBase.store,
      renderReviewJournalBody({
        version: "v1",
        phase: "intent",
        repository: { owner: REPO.owner, name: REPO.name },
        prNumber: PR,
        expectedHead: HEAD,
        expectedBase: asGitSha("d".repeat(40)),
        operationKey: OP_KEY,
        publisher: REVIEWER,
        requestId: REQUEST_ID,
        requestedAt: T0 - 5_000,
      }),
      "pending",
    );
    const readBase = await wrongBase.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(readBase.ok, true);
    if (readBase.ok) assert.equal(readBase.value.status, "unavailable");
    const submittedBase = await wrongBase.transport.submitReview(submission());
    assert.equal(submittedBase.ok, false);
    assert.equal(wrongBase.sessions.length, 0);
    assert.equal(wrongBase.store.creates, 0);
  },
);

Deno.test(
  "transport: a COMMENTED record cannot hide a duplicate pending record",
  async () => {
    const h = makeHarness();
    const body = renderReviewJournalBody(await readyJournal(CLEAN_RESULT));
    seed(h.store, body, "commented", { id: 100 });
    seed(h.store, body, "pending", { id: 101 });
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");

    // A fresh submission reconciles the same conflict and never starts a model.
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, false);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.store.creates, 0);
  },
);

Deno.test(
  "transport: foreign and unrelated publisher drafts block adoption",
  async () => {
    const h = makeHarness();
    seed(
      h.store,
      renderReviewJournalBody(
        await readyJournal(CLEAN_RESULT, { operationKey: "review:other" }),
      ),
      "pending",
      { id: 200 },
    );
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");

    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, false);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.store.creates, 0);
  },
);
