/** Drives one real native review whose exact final text a test chooses. */
import assert from "node:assert/strict";
import type { StructuredReviewOutcomeV1 } from "../../src/github/codex-reviewer.ts";
import {
  agentMessage,
  makeReviewer,
  prepareRequest,
  ScriptedCodexSession,
  snapshotFixture,
  turnCompleted,
} from "./codex-reviewer-helpers.ts";

/**
 * One complete native review whose exitedReviewMode text is exactly `build`'s
 * result (the scripted session's own envelope is replaced), driven through the
 * real reviewer; returns its outcome and every line it printed.
 */
export async function nativeReview(
  build: (binding: unknown) => string,
  ownerRunId = "run-1",
): Promise<{ outcome: StructuredReviewOutcomeV1; printed: string[] }> {
  const session = new ScriptedCodexSession();
  session.plan = (scripted) => {
    scripted.emit(
      "item/completed",
      agentMessage(scripted.turnId, "item-1", "{}"),
    );
    scripted.emit("turn/completed", turnCompleted(scripted.turnId));
  };
  const receive = session.onNotification.bind(session);
  session.onNotification = (handler) =>
    receive((event) => {
      const item = (event.params as { item?: Record<string, unknown> }).item;
      if (
        event.method === "item/completed" && item?.type === "exitedReviewMode"
      ) item.review = build(session.nativeBinding);
      handler(event);
    });
  const printed: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) =>
    printed.push(args.map(String).join(" "));
  try {
    const prepared = await makeReviewer(session).prepare(
      prepareRequest(await snapshotFixture(), { ownerRunId }),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const started = await prepared.value.start();
    if (!started.ok) assert.fail(started.error.detail);
    await prepared.value.close();
    return { outcome: started.value, printed };
  } finally {
    console.log = original;
  }
}
