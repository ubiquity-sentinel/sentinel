/** Synthetic, credential-free rejection evidence; never original model output. */
import assert from "node:assert/strict";
import {
  NATIVE_REVIEW_CLOSE,
  NATIVE_REVIEW_OPEN,
} from "../../src/github/native-review-result.ts";
import {
  MAX_RESULT_SUMMARY,
  parseReviewJournalBody,
  reviewResultDigest,
} from "../../src/github/review-journal.ts";
import { classifyNativeReviewRejection } from "../../src/github/native-review-result.ts";
import {
  MAX_UNAVAILABLE_REASON_CHARS,
  staticUnavailableSummary,
} from "../../src/github/codex-review-transport.ts";
import {
  agentMessage,
  CLEAN_RESULT,
  FINDINGS_RESULT,
  MALFORMED_PREFIX,
  ScriptedCodexSession,
  snapshotFixture,
  startReview,
  turnCompleted,
} from "./codex-reviewer-helpers.ts";

import {
  makeHarness,
  onlyReview,
  OP_KEY,
  RecordingSession,
  REQUEST_ID,
  settle,
  submission,
} from "./codex-review-transport-helpers.ts";

const PRIVATE_MARKER = "SYNTHETIC_PRIVATE_REVIEW_SENTINEL";
const clean = { ...CLEAN_RESULT, summary: PRIVATE_MARKER };

function envelope(
  binding: unknown,
  result: unknown,
  recovered: boolean,
  extraKey = false,
): string {
  const json = JSON.stringify({
    binding,
    result,
    ...(extraKey ? { [PRIVATE_MARKER]: true } : {}),
  });
  // An existing deterministic rewrite removes this trailing comma.
  return NATIVE_REVIEW_OPEN +
    (recovered ? json.slice(0, -1) + ",}" : json) + NATIVE_REVIEW_CLOSE;
}

async function outcome(build: (binding: unknown) => string) {
  const session = new ScriptedCodexSession();
  session.plan = (scripted) => {
    scripted.emit(
      "item/completed",
      agentMessage(scripted.turnId, "item-1", build(scripted.nativeBinding)),
    );
    scripted.emit("turn/completed", turnCompleted(scripted.turnId));
  };
  return await startReview(session, await snapshotFixture());
}

Deno.test("native rejection diagnostics: strict and recovered candidates retain the rejected stage without raw output", async (t) => {
  for (const recovered of [false, true]) {
    const prefix = recovered ? "recovered_" : "";
    const cases = [
      {
        category: `${prefix}native_envelope`,
        build: (binding: unknown) => envelope(binding, clean, recovered, true),
      },
      {
        category: `${prefix}native_binding`,
        build: (binding: unknown) =>
          envelope(
            { ...(binding as object), head: "0".repeat(40) },
            clean,
            recovered,
          ),
      },
      {
        category: `${prefix}summary`,
        build: (binding: unknown) =>
          envelope(binding, { ...clean, summary: 7 }, recovered),
      },
      {
        category: `${prefix}native_findings`,
        build: (binding: unknown) =>
          envelope(
            binding,
            { ...FINDINGS_RESULT, summary: PRIVATE_MARKER },
            recovered,
          ),
      },
    ];
    for (const item of cases) {
      await t.step(item.category, async () => {
        const rejected = await outcome(item.build);
        assert.equal(rejected.status, "unavailable");
        assert.equal(rejected.result, null);
        assert.equal(rejected.execution, null);
        assert.equal(rejected.detail, `${MALFORMED_PREFIX}[${item.category}]`);
        assert.ok(rejected.detail.length <= MAX_UNAVAILABLE_REASON_CHARS);
        assert.equal(
          staticUnavailableSummary(rejected.detail),
          rejected.detail,
        );
        assert.equal(JSON.stringify(rejected).includes(PRIVATE_MARKER), false);
      });
    }
  }
});

Deno.test("native rejection diagnostics: unrecoverable syntax remains distinct and recovery changes no accepted verdict", async () => {
  const syntax = await outcome(() =>
    NATIVE_REVIEW_OPEN + `not JSON ${PRIVATE_MARKER}` + NATIVE_REVIEW_CLOSE
  );
  assert.equal(syntax.status, "unavailable");
  assert.equal(syntax.execution, null);
  assert.equal(syntax.result, null);
  assert.equal(syntax.detail, `${MALFORMED_PREFIX}[json_syntax]`);
  assert.equal(JSON.stringify(syntax).includes(PRIVATE_MARKER), false);
  for (const recovered of [false, true]) {
    const accepted = await outcome((binding) =>
      envelope(binding, CLEAN_RESULT, recovered)
    );
    assert.equal(accepted.status, "clean");
    assert.deepEqual(accepted.result, CLEAN_RESULT);
    assert.notEqual(accepted.execution, null);
  }
});

Deno.test("native rejection diagnostics: bounds and missing diagnostics never become acceptance", async () => {
  assert.equal(
    classifyNativeReviewRejection(new Error(PRIVATE_MARKER)),
    "unknown",
  );
  assert.equal(classifyNativeReviewRejection(null), "unknown");
  for (const recovered of [false, true]) {
    const rejected = await outcome((binding) =>
      envelope(binding, {
        ...clean,
        summary: "x".repeat(MAX_RESULT_SUMMARY + 1),
      }, recovered)
    );
    assert.equal(rejected.status, "unavailable");
    assert.equal(rejected.result, null);
    assert.equal(rejected.execution, null);
    assert.equal(
      rejected.detail,
      "structured review unavailable: the structured result exceeded the accepted bound",
    );
  }
});

Deno.test("native rejection diagnostics: durable unavailable publication and fresh reads retain only the category", async (t) => {
  for (
    const category of [
      "json_syntax",
      "recovered_native_binding",
      "recovered_summary",
      "recovered_native_findings",
    ]
  ) {
    await t.step(category, async () => {
      const session = new RecordingSession();
      const receive = session.onNotification.bind(session);
      session.onNotification = (handler) =>
        receive((event) => {
          const params = event.params as {
            item?: { type?: string; review?: string };
          };
          if (
            event.method === "item/completed" &&
            params.item?.type === "exitedReviewMode"
          ) {
            const text = params.item.review!;
            const original = JSON.parse(
              text.slice(
                NATIVE_REVIEW_OPEN.length,
                text.indexOf(NATIVE_REVIEW_CLOSE),
              ),
            );
            let binding: unknown = original.binding;
            let result: unknown = clean;
            if (category === "recovered_native_binding") {
              binding = { ...original.binding, head: "0".repeat(40) };
            } else if (category === "recovered_summary") {
              result = { ...clean, summary: 7 };
            } else if (category === "recovered_native_findings") {
              result = { ...FINDINGS_RESULT, summary: PRIVATE_MARKER };
            }
            params.item.review = category === "json_syntax"
              ? NATIVE_REVIEW_OPEN + PRIVATE_MARKER + NATIVE_REVIEW_CLOSE
              : envelope(binding, result, true);
          }
          handler(event);
        });
      const h = makeHarness({ session });
      const submitted = await h.transport.submitReview(submission());
      assert.equal(submitted.ok, true);
      await settle(h.transport);
      const review = onlyReview(h.store);
      const saved = review.body!;
      const journal = await parseReviewJournalBody(saved);
      assert.equal(journal.phase, "ready");
      if (journal.phase !== "ready") {
        assert.fail("expected unavailable ready journal");
      }
      assert.equal(journal.operationKey, OP_KEY);
      assert.equal(journal.requestId, REQUEST_ID);
      assert.equal(journal.result.verdict, "unavailable");
      assert.equal(journal.result.summary, `${MALFORMED_PREFIX}[${category}]`);
      assert.deepEqual(journal.result.findings, []);
      assert.equal(journal.execution, null);
      assert.equal(
        journal.resultDigest,
        await reviewResultDigest(journal.result),
      );
      assert.equal(saved.includes(PRIVATE_MARKER), false);
      assert.equal(JSON.stringify(journal).includes(PRIVATE_MARKER), false);
      const read = await h.freshTransport().readReview({
        operationKey: OP_KEY,
        requestId: REQUEST_ID,
        prNumber: 1,
      });
      assert.equal(read.ok, true);
      if (read.ok) assert.equal(read.value.status, "unavailable");
      assert.equal(
        onlyReview(h.store).body,
        saved,
        "observation never rewrites the unavailable receipt",
      );
      assert.equal(
        session.turnStarts(),
        1,
        "fresh reads authorize no new charged turn",
      );
      assert.equal(session.closed, 1);
      assert.equal(h.store.submits, 1);
    });
  }
});
