// codex reviewer results_test.

import assert from "node:assert/strict";
import { finalizeReviewCompletion } from "../../src/github/codex-reviewer.ts";
import {
  agentMessage,
  boundRejectText,
  cardinalityRejectText,
  CLEAN_RESULT,
  completedFinalMessage,
  contains,
  CONTRACT_INSTRUCTIONS,
  FINDINGS_RESULT,
  JSON_REJECT_TEXT,
  JSON_REJECT_TEXT_ALT,
  makeReviewer,
  MALFORMED_PREFIX,
  pathRejectText,
  prepareRequest,
  reasoningItem,
  rejectedFinalCategory,
  RUBRIC_PHRASES,
  ScriptedCodexSession,
  shapeRejectText,
  snapshotFixture,
  startReview,
  submittedGuidance,
  submittedPrompt,
  titleRejectText,
  turnCompleted,
  UNAVAILABLE_PREFIX,
  userItem,
  userMessage,
} from "./codex-reviewer-helpers.ts";

Deno.test(
  "reviewer: throwing registration or invalid queued evidence forbids the send",
  async () => {
    const throwingRegistration = new ScriptedCodexSession();
    throwingRegistration.onNotification = () => {
      throw new Error("raw registration detail");
    };
    const throwReviewer = makeReviewer(throwingRegistration);
    const throwPrepared = await throwReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!throwPrepared.ok) assert.fail(throwPrepared.error.detail);
    const throwRun = throwPrepared.value;
    const thrown = await throwRun.start();
    assert.equal(thrown.ok, false);
    if (thrown.ok) assert.fail("expected rejection");
    contains(thrown.error.detail, "registration");
    assert.equal(
      JSON.stringify(thrown).includes("raw registration detail"),
      false,
    );
    assert.equal(
      throwingRegistration.turnStarts(),
      0,
      "no turn/start after throwing registration",
    );
    const thrownClose = await throwRun.close();
    assert.equal(thrownClose.failure, "close_failed");
    assert.equal(typeof thrownClose.settled, "boolean");

    // Invalid evidence already queued before registration is validated during
    // registration replay, before any turn/start.
    const queued = new ScriptedCodexSession();
    queued.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "item-x" },
    });
    const queuedReviewer = makeReviewer(queued);
    const queuedPrepared = await queuedReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!queuedPrepared.ok) assert.fail(queuedPrepared.error.detail);
    const queuedRun = queuedPrepared.value;
    const queuedOutcome = await queuedRun.start();
    assert.equal(queuedOutcome.ok, false);
    if (queuedOutcome.ok) assert.fail("expected rejection");
    contains(queuedOutcome.error.detail, "identity");
    assert.equal(
      queued.turnStarts(),
      0,
      "queued invalid evidence forbids the send",
    );
    await queuedRun.close();
  },
);

Deno.test(
  "reviewer: contradictory terminal and second final item are sticky after completion",
  async () => {
    const contradictory = new ScriptedCodexSession();
    contradictory.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      scripted.emit(
        "turn/completed",
        turnCompleted(scripted.turnId, "interrupted"),
      );
    };
    const contradictoryReviewer = makeReviewer(contradictory);
    const contradictoryPrepared = await contradictoryReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!contradictoryPrepared.ok) {
      assert.fail(contradictoryPrepared.error.detail);
    }
    const contradictoryRun = contradictoryPrepared.value;
    const contradictoryOutcome = await contradictoryRun.start();
    if (!contradictoryOutcome.ok) {
      assert.fail(contradictoryOutcome.error.detail);
    }
    assert.equal(contradictoryOutcome.value.status, "unavailable");
    contains(contradictoryOutcome.value.detail ?? "", "contradictory");
    assert.equal(contradictoryOutcome.value.execution, null);
    const contradictoryClose = await contradictoryRun.close();
    assert.equal(contradictoryClose.failure, "close_failed");

    const secondFinal = new ScriptedCodexSession();
    secondFinal.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-2", JSON.stringify(CLEAN_RESULT)),
      );
    };
    const secondReviewer = makeReviewer(secondFinal);
    const secondPrepared = await secondReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!secondPrepared.ok) assert.fail(secondPrepared.error.detail);
    const secondRun = secondPrepared.value;
    const secondOutcome = await secondRun.start();
    if (!secondOutcome.ok) assert.fail(secondOutcome.error.detail);
    assert.equal(secondOutcome.value.status, "unavailable");
    contains(secondOutcome.value.detail ?? "", "ambiguous");
    const secondClose = await secondRun.close();
    assert.equal(secondClose.failure, "close_failed");
    const finalized = finalizeReviewCompletion(secondOutcome, secondClose);
    assert.equal(finalized.ok, true);
    if (!finalized.ok) assert.fail("expected a correlated unavailable outcome");
    assert.equal(finalized.value.status, "unavailable");
    assert.equal(finalized.value.execution, null);
  },
);

Deno.test(
  "reviewer: off-policy routing or a server request during close invalidates clean",
  async () => {
    for (const kind of ["reroute", "server-request"] as const) {
      const session = new ScriptedCodexSession();
      session.plan = (scripted) => {
        scripted.emit(
          "item/completed",
          agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
        );
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      session.closeHook = () => {
        if (kind === "reroute") {
          session.emit("model/rerouted", {
            threadId: "thread-1",
            turnId: session.turnId,
            fromModel: "gpt-reserve",
            toModel: "gpt-reserve",
            reason: "capacity",
          });
        } else {
          session.requestServer("item/commandExecution/requestApproval");
        }
      };
      const reviewer = makeReviewer(session);
      const prepared = await reviewer.prepare(
        prepareRequest(await snapshotFixture()),
      );
      if (!prepared.ok) assert.fail(prepared.error.detail);
      const review = prepared.value;
      const outcome = await review.start();
      if (!outcome.ok) assert.fail(outcome.error.detail);
      assert.equal(outcome.value.status, "clean", kind);
      const closed = await review.close();
      assert.equal(closed.failure, "close_failed", kind);
      assert.equal(closed.timedOut, false, kind);
      const finalized = finalizeReviewCompletion(outcome, closed);
      assert.equal(finalized.ok, false, kind);
      if (finalized.ok) assert.fail("expected rejection");
      assert.equal(finalized.error.kind, "unavailable");
      const again = await review.close();
      assert.deepEqual(again, closed, "close stays idempotent");
      assert.equal(session.closed, 1, kind);
    }
  },
);

Deno.test(
  "reviewer: a second final item delivered during close invalidates clean",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    session.closeHook = () => {
      session.emit(
        "item/completed",
        agentMessage(session.turnId, "item-2", JSON.stringify(CLEAN_RESULT)),
      );
    };
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    const closed = await review.close();
    assert.equal(closed.failure, "close_failed");
    const finalized = finalizeReviewCompletion(outcome, closed);
    assert.equal(
      finalized.ok,
      false,
      "duplicate final output invalidates clean",
    );
  },
);

Deno.test(
  "reviewer: full normal lifecycle accepts the prompt echo as input, never the result",
  async () => {
    const session = new ScriptedCodexSession();
    session.live = (scripted) => {
      const prompt = submittedPrompt(session);
      scripted.emit(
        "item/started",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit(
        "item/completed",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit(
        "item/started",
        reasoningItem(scripted.turnId, "reasoning-1"),
      );
      scripted.emit(
        "item/completed",
        reasoningItem(scripted.turnId, "reasoning-1"),
      );
      scripted.emit(
        "item/started",
        agentMessage(scripted.turnId, "item-final", ""),
      );
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    assert.deepEqual(outcome.value.result, CLEAN_RESULT);
    assert.equal(
      outcome.value.resultId,
      "item-final",
      "the echoed user item is never the result",
    );
    assert.equal(outcome.value.execution?.turnId, "turn-1");
    assert.equal(outcome.value.execution?.resultId, "item-final");
    assert.equal(outcome.value.detail, null);
    assert.equal(session.turnStarts(), 1);

    const closed = await review.close();
    assert.equal(closed.settled, true);
    assert.equal(closed.failure, null);
    assert.equal(closed.timedOut, false);
    const finalized = finalizeReviewCompletion(outcome, closed);
    assert.equal(
      finalized.ok,
      true,
      "a settled close preserves the clean result",
    );
  },
);

Deno.test(
  "reviewer: the prompt echo alone is input evidence and never completes a review",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      const prompt = submittedPrompt(session);
      scripted.emit(
        "item/started",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit(
        "item/completed",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.result, null);
    assert.equal(outcome.resultId, null);
    assert.equal(outcome.execution, null);
    contains(outcome.detail ?? "", "final agent message");
    assert.equal(outcome.actual?.observedTerminalStatus, "completed");
  },
);

Deno.test(
  "reviewer: malformed or mismatched prompt echoes fail closed before any clean verdict",
  async () => {
    const cases: {
      name: string;
      needle: string;
      build: (
        prompt: string,
      ) => {
        started: Record<string, unknown>;
        completed: Record<string, unknown>;
      };
    }[] = [
      {
        name: "unbounded item id",
        needle: "identity",
        build: (prompt) => ({
          started: userItem("", prompt),
          completed: userItem("", prompt),
        }),
      },
      {
        name: "missing content",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, { content: undefined }),
          completed: userItem("user-1", prompt, { content: undefined }),
        }),
      },
      {
        name: "two text parts",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, {
            content: [
              { type: "text", text: prompt, text_elements: [] },
              { type: "text", text: prompt, text_elements: [] },
            ],
          }),
          completed: userItem("user-1", prompt),
        }),
      },
      {
        name: "image content",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, {
            content: [{ type: "image", url: "file:///etc/passwd" }],
          }),
          completed: userItem("user-1", prompt),
        }),
      },
      {
        name: "tool content",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, {
            content: [{ type: "tool", name: "shell" }],
          }),
          completed: userItem("user-1", prompt),
        }),
      },
      {
        name: "mismatched text",
        needle: "user message",
        build: () => ({
          started: userItem("user-1", "a different prompt"),
          completed: userItem("user-1", "a different prompt"),
        }),
      },
      {
        name: "nonempty text elements",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, {
            content: [{
              type: "text",
              text: prompt,
              text_elements: [{ type: "mention", text: "@account.ts" }],
            }],
          }),
          completed: userItem("user-1", prompt),
        }),
      },
      {
        name: "missing text elements",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, {
            content: [{ type: "text", text: prompt }],
          }),
          completed: userItem("user-1", prompt),
        }),
      },
      {
        name: "result-shaped echo text",
        needle: "user message",
        build: () => ({
          started: userItem("user-1", JSON.stringify(CLEAN_RESULT)),
          completed: userItem("user-1", JSON.stringify(CLEAN_RESULT)),
        }),
      },
      {
        name: "different user item id",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt),
          completed: userItem("user-2", prompt),
        }),
      },
    ];

    for (const item of cases) {
      const session = new ScriptedCodexSession();
      session.plan = (scripted) => {
        const echo = item.build(submittedPrompt(session));
        scripted.emit(
          "item/started",
          userMessage(scripted.turnId, echo.started),
        );
        scripted.emit(
          "item/completed",
          userMessage(scripted.turnId, echo.completed),
        );
        // A later sole final result, exact completed terminal and settled
        // close are all present: only the echo violation keeps this
        // unavailable.
        scripted.emit(
          "item/completed",
          agentMessage(
            scripted.turnId,
            "item-final",
            JSON.stringify(CLEAN_RESULT),
          ),
        );
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      const reviewer = makeReviewer(session);
      const prepared = await reviewer.prepare(
        prepareRequest(await snapshotFixture()),
      );
      if (!prepared.ok) assert.fail(prepared.error.detail);
      const review = prepared.value;
      const outcome = await review.start();
      if (!outcome.ok) assert.fail(outcome.error.detail);
      assert.equal(outcome.value.status, "unavailable", item.name);
      assert.equal(outcome.value.result, null, item.name);
      assert.equal(outcome.value.execution, null, item.name);
      contains(outcome.value.detail ?? "", item.needle, item.name);
      const closed = await review.close();
      assert.equal(closed.settled, true, item.name);
      assert.equal(closed.failure, "close_failed", item.name);
      const finalized = finalizeReviewCompletion(outcome, closed);
      assert.equal(finalized.ok, true, item.name);
      if (!finalized.ok) {
        assert.fail("expected a correlated unavailable outcome");
      }
      assert.equal(finalized.value.status, "unavailable", item.name);
    }
  },
);

Deno.test(
  "reviewer: a different user item delivered during close invalidates clean",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      const prompt = submittedPrompt(session);
      scripted.emit(
        "item/started",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit(
        "item/completed",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-1",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    session.closeHook = () => {
      session.emit(
        "item/completed",
        userMessage(
          session.turnId,
          userItem("user-2", submittedPrompt(session)),
        ),
      );
    };
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    const closed = await review.close();
    assert.equal(closed.failure, "close_failed");
    const finalized = finalizeReviewCompletion(outcome, closed);
    assert.equal(
      finalized.ok,
      false,
      "a second, different user item invalidates clean",
    );
  },
);

Deno.test(
  "structured review contract: rejected final messages keep unavailable with distinct fixed sanitized categories",
  async () => {
    const invalidJson = await rejectedFinalCategory(JSON_REJECT_TEXT);
    assert.equal(
      invalidJson,
      `${MALFORMED_PREFIX}[json_syntax]`,
      "invalid JSON keeps its exact fixed category",
    );
    assert.equal(
      await rejectedFinalCategory(JSON_REJECT_TEXT_ALT),
      invalidJson,
      "invalid JSON keeps one fixed category",
    );

    const shape = await rejectedFinalCategory(shapeRejectText(3));
    assert.equal(
      shape,
      `${MALFORMED_PREFIX}[finding_range]`,
      "a reversed finding line range keeps its exact fixed category",
    );
    assert.equal(
      await rejectedFinalCategory(shapeRejectText(7)),
      shape,
      "a strict-shape violation keeps one fixed category",
    );
    assert.notEqual(
      invalidJson,
      shape,
      "invalid JSON and a strict-shape violation must not share one generic category",
    );

    const bound = await rejectedFinalCategory(boundRejectText());
    assert.equal(
      bound,
      `${UNAVAILABLE_PREFIX} the structured result exceeded the accepted bound`,
      "a bound overflow keeps its exact fixed category",
    );
    assert.notEqual(bound, invalidJson, "the bound category stays distinct");
    assert.notEqual(bound, shape, "the bound category stays distinct");

    // Three static malformed results must not collapse into one opaque
    // category: the malformed finding path, the malformed finding title and
    // the verdict/findings cardinality mismatch stay individually named.
    const path = await rejectedFinalCategory(pathRejectText());
    assert.equal(
      path,
      `${MALFORMED_PREFIX}[finding_path]`,
      "a malformed finding path keeps its exact fixed category",
    );
    const title = await rejectedFinalCategory(titleRejectText());
    assert.equal(
      title,
      `${MALFORMED_PREFIX}[finding_title]`,
      "a malformed finding title keeps its exact fixed category",
    );
    const cardinality = await rejectedFinalCategory(cardinalityRejectText());
    assert.equal(
      cardinality,
      `${MALFORMED_PREFIX}[findings_cardinality]`,
      "a verdict/findings mismatch keeps its exact fixed category",
    );
    assert.equal(
      new Set([path, title, cardinality]).size,
      3,
      "the three malformed results must keep three distinct categories",
    );

    const clean = await completedFinalMessage(JSON.stringify(CLEAN_RESULT));
    assert.equal(clean.status, "clean");
    assert.equal(clean.detail, null);
    assert.deepEqual(clean.result, CLEAN_RESULT);
    assert.ok(clean.execution !== null);
    assert.ok(clean.actual !== null);

    const findings = await completedFinalMessage(
      JSON.stringify(FINDINGS_RESULT),
    );
    assert.equal(findings.status, "findings");
    assert.equal(findings.detail, null);
    assert.equal(findings.result?.verdict, "findings");
    assert.equal(findings.result?.findings.length, 1);
    assert.ok(findings.execution !== null);
    assert.ok(findings.actual !== null);
  },
);

Deno.test(
  "structured review contract: parser-only cross-field constraints are stated in the submitted instructions",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "clean");
    const guidance = submittedGuidance(session);
    assert.notEqual(guidance, "", "the submitted turn carries instructions");
    for (const instruction of CONTRACT_INSTRUCTIONS) {
      contains(
        guidance,
        instruction,
        "each parser-only cross-field constraint must be stated exactly",
      );
    }
    contains(guidance, "lineEnd at most candidateLines");
  },
);

Deno.test(
  "structured review contract: native mode owns the rubric without a caller copy or attached schema",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "clean");
    const guidance = submittedGuidance(session);
    for (const phrase of RUBRIC_PHRASES) {
      assert.equal(guidance.includes(phrase), false);
    }
    const thread = session.params[1] as Record<string, unknown>;
    assert.equal(Object.hasOwn(thread, "baseInstructions"), false);
    assert.equal(Object.hasOwn(thread, "developerInstructions"), false);
    contains(guidance, "native Codex review mode");
    contains(guidance, "not a protocol-enforced output schema");
  },
);

Deno.test("reviewer: native entry, returned thread and strict envelope are mandatory", async (t) => {
  for (
    const variant of [
      "missing-entry",
      "wrong-thread",
      "ordinary-message",
      "prose",
      "duplicate-envelope",
      "contradictory-findings",
    ] as const
  ) {
    await t.step(variant, async () => {
      const session = new ScriptedCodexSession();
      if (variant === "missing-entry") session.nativeEntry = false;
      if (variant === "wrong-thread") {
        session.turnResponse = {
          turn: { id: "turn-1" },
          reviewThreadId: "foreign",
        };
      }
      session.plan = (scripted) => {
        if (variant === "ordinary-message") {
          scripted.emit("item/completed", {
            threadId: "thread-1",
            turnId: scripted.turnId,
            item: {
              type: "agentMessage",
              id: "generic",
              text: JSON.stringify(CLEAN_RESULT),
            },
          });
        } else {
          const envelope = "<SENTINEL_NATIVE_REVIEW_V1>" +
            JSON.stringify({
              binding: scripted.nativeBinding,
              result: CLEAN_RESULT,
            }) + "</SENTINEL_NATIVE_REVIEW_V1>";
          const text = variant === "prose"
            ? "Looks good"
            : variant === "duplicate-envelope"
            ? envelope + envelope
            : variant === "contradictory-findings"
            ? envelope +
              "\n\nReview comment:\n\n- [P0] Undisclosed defect — /tmp/sentinel-review-checkout/account.ts:1-1"
            : JSON.stringify(CLEAN_RESULT);
          scripted.emit(
            "item/completed",
            agentMessage(scripted.turnId, "native-exit", text),
          );
        }
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      const reviewer = makeReviewer(session);
      const prepared = await reviewer.prepare(
        prepareRequest(await snapshotFixture()),
      );
      if (!prepared.ok) assert.fail(prepared.error.detail);
      try {
        const outcome = await prepared.value.start();
        assert.ok(!outcome.ok || outcome.value.status === "unavailable");
        assert.equal(session.turnStarts(), 1);
        assert.equal(session.sent.includes("turn/start"), false);
      } finally {
        await prepared.value.close();
      }
    });
  }
});
