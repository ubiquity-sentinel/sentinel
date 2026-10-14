/** Additive owner identity preserves every absent legacy journal/result field. */
import assert from "node:assert/strict";
import {
  parseReviewJournalBody,
  renderReviewJournalBody,
} from "../../src/github/review-journal.ts";
import {
  CLEAN_RESULT,
  readyJournal,
} from "./codex-review-transport-helpers.ts";
import { intent } from "./hosted-execution-helpers.ts";

Deno.test("review owner codec: absent legacy owner and task acceptance preserve canonical bytes", async () => {
  const legacy = await readyJournal(CLEAN_RESULT);
  const body = renderReviewJournalBody(legacy);
  const parsed = await parseReviewJournalBody(body);
  assert.equal(Object.hasOwn(parsed, "ownerExecution"), false);
  if (parsed.phase !== "ready") assert.fail("expected ready");
  assert.equal(Object.hasOwn(parsed.result, "taskAcceptance"), false);
  assert.equal(renderReviewJournalBody(parsed), body);
});

Deno.test("review owner codec: future owner persists exactly through ready and refuses changed owner", async () => {
  const original = await readyJournal(CLEAN_RESULT);
  const ownerExecution = intent({ createdAt: original.requestedAt - 1000 });
  const journal = {
    ...original,
    ownerExecution,
    execution: { ...original.execution!, ownerRunId: ownerExecution.id },
  };
  const body = renderReviewJournalBody(journal);
  const parsed = await parseReviewJournalBody(body);
  assert.deepEqual(parsed.ownerExecution, ownerExecution);
  assert.equal(renderReviewJournalBody(parsed), body);
  await assert.rejects(() =>
    parseReviewJournalBody(
      renderReviewJournalBody({
        ...journal,
        execution: { ...journal.execution, ownerRunId: "unproved-invocation" },
      }),
    )
  );
  await assert.rejects(() =>
    parseReviewJournalBody(
      renderReviewJournalBody({
        ...journal,
        ownerExecution: { ...ownerExecution, purpose: "bootstrap" },
      }),
    )
  );
});
