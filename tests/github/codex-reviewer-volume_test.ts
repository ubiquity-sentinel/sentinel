import assert from "node:assert/strict";
import type { CodexServerNotificationV1 } from "../../src/repair/codex-transport.ts";
import { finalizeReviewCompletion } from "../../src/github/codex-reviewer.ts";
import {
  agentMessage,
  CLEAN_RESULT,
  commandItem,
  makeReviewer,
  prepareRequest,
  ScriptedCodexSession,
  snapshotFixture,
  turnCompleted,
} from "./codex-reviewer-helpers.ts";

type RetentionState = {
  earlyEvents: unknown[];
  earlyBytes: number;
  commandItems: Map<string, unknown>;
  finalMessage: { text: string; truncated: boolean } | null;
  eventCount: number;
  settled: boolean;
};

class ProjectedSession extends ScriptedCodexSession {
  private receiver: ((event: CodexServerNotificationV1) => void) | null = null;

  override onNotification(
    handler: (event: CodexServerNotificationV1) => void,
  ): void {
    this.receiver = handler;
    super.onNotification(handler);
  }

  emitProjected(text: string): void {
    this.emit(
      "item/started",
      agentMessage(this.turnId, "truncated-result", ""),
    );
    const event = {
      method: "item/completed",
      params: agentMessage(this.turnId, "truncated-result", text, "final"),
      outputVolume: {
        observedParamsChars: 20 * 1024 * 1024,
        truncatedOutputPaths: ["item.review"] as const,
      },
    };
    this.receiver?.(event);
  }
}

async function preparedSession(session: ScriptedCodexSession) {
  const prepared = await makeReviewer(session).prepare(
    prepareRequest(await snapshotFixture()),
  );
  if (!prepared.ok) assert.fail(prepared.error.detail);
  return {
    review: prepared.value,
    state: prepared.value as unknown as RetentionState,
  };
}

function finish(session: ScriptedCodexSession, id = "exact-result"): void {
  session.emit(
    "item/completed",
    agentMessage(
      session.turnId,
      id,
      JSON.stringify(CLEAN_RESULT),
      "final_answer",
    ),
  );
  session.emit("turn/completed", turnCompleted(session.turnId));
}

Deno.test("reviewer: output volume and commentary do not end a native review", async () => {
  const session = new ScriptedCodexSession();
  const { review, state } = await preparedSession(session);
  let terminalSent = false;
  session.live = (scripted) => {
    const identity = { threadId: "thread-1", turnId: scripted.turnId };
    scripted.emit("item/started", {
      ...identity,
      item: commandItem("read-1", "inProgress"),
    });
    for (let index = 0; index < 5_000; index++) {
      scripted.emit("item/commandExecution/outputDelta", {
        ...identity,
        itemId: "read-1",
        delta: "x".repeat(1_024),
      });
      if (index % 10 === 0) {
        scripted.emit(
          "item/completed",
          agentMessage(
            scripted.turnId,
            `commentary-${index}`,
            "read evidence ".repeat(1_000),
            "commentary",
          ),
        );
      }
      assert.equal(
        state.settled,
        false,
        "volume must not wake the owner to close",
      );
      assert.equal(state.earlyEvents.length, 0);
      assert.equal(state.commandItems.size, 1);
      assert.equal(
        state.finalMessage,
        null,
        "commentary and command output are not retained",
      );
    }
    scripted.emit("item/completed", {
      ...identity,
      item: commandItem("read-1", "completed"),
    });
    scripted.emit(
      "item/completed",
      agentMessage(
        scripted.turnId,
        "exact-result",
        JSON.stringify(CLEAN_RESULT),
        "final_answer",
      ),
    );
    terminalSent = true;
    scripted.emit("turn/completed", turnCompleted(scripted.turnId));
  };
  const outcome = await review.start();
  if (!outcome.ok) assert.fail(outcome.error.detail);
  assert.equal(outcome.value.status, "clean");
  assert.deepEqual(outcome.value.result, CLEAN_RESULT);
  assert.equal(outcome.value.resultId, "exact-result");
  assert.equal(outcome.value.execution?.actual.terminalOrigin, "runtime");
  assert.ok((outcome.value.actual?.outputChars ?? 0) > 4 * 1024 * 1024);
  assert.ok(terminalSent);
  assert.ok(!session.sent.includes("turn/interrupt"));
  assert.ok(state.eventCount > 4_096);
  assert.ok(state.finalMessage?.text.includes(JSON.stringify(CLEAN_RESULT)));
  await review.close();
});

Deno.test("reviewer: early telemetry and commentary do not consume replay retention", async () => {
  const session = new ScriptedCodexSession();
  const { review, state } = await preparedSession(session);
  session.plan = (scripted) => {
    for (let index = 0; index < 5_000; index++) {
      scripted.emit("item/reasoning/textDelta", { delta: "x".repeat(2_048) });
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          `comment-${index}`,
          "x".repeat(2_048),
          "commentary",
        ),
      );
      assert.equal(state.earlyEvents.length, 2);
      assert.ok(state.earlyBytes > 0);
      assert.equal(state.settled, false);
    }
    finish(scripted);
  };
  const result = await review.start();
  if (!result.ok) assert.fail(result.error.detail);
  assert.equal(result.value.status, "clean");
  assert.equal(result.value.actual?.terminalOrigin, "runtime");
  assert.equal(state.earlyEvents.length, 0);
  assert.equal(state.earlyBytes, 0);
  await review.close();
});

Deno.test("reviewer: bounded early evidence loss waits for native terminal and cannot pass", async () => {
  const session = new ScriptedCodexSession();
  const { review, state } = await preparedSession(session);
  session.plan = (scripted) => {
    for (let index = 0; index < 1_000; index++) {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem(`read-${index}`, "inProgress"),
      });
      assert.ok(state.earlyEvents.length <= 256);
      assert.ok(state.earlyBytes <= 256 * 1024);
      assert.equal(state.settled, false);
    }
    finish(scripted);
  };
  const result = await review.start();
  if (!result.ok) assert.fail(result.error.detail);
  assert.equal(result.value.status, "unavailable");
  assert.match(result.value.detail ?? "", /early session buffering/);
  assert.equal(result.value.actual?.terminalOrigin, "runtime");
  assert.equal(result.value.actual?.observedTerminalStatus, "completed");
  assert.equal(result.value.execution, null);
  assert.ok(!session.sent.includes("turn/interrupt"));
  await review.close();
});

Deno.test("reviewer: command identity retention is bounded without ending the session", async () => {
  const session = new ScriptedCodexSession();
  const { review, state } = await preparedSession(session);
  session.live = (scripted) => {
    for (let index = 0; index < 1_000; index++) {
      const identity = { threadId: "thread-1", turnId: scripted.turnId };
      scripted.emit("item/started", {
        ...identity,
        item: commandItem(`read-${index}`, "inProgress"),
      });
      scripted.emit("item/commandExecution/outputDelta", {
        ...identity,
        itemId: `read-${index}`,
        delta: "read output",
      });
      scripted.emit("item/completed", {
        ...identity,
        item: commandItem(`read-${index}`, "completed"),
      });
      assert.ok(state.commandItems.size <= 256);
      assert.equal(state.settled, false);
    }
    finish(scripted);
  };
  const result = await review.start();
  if (!result.ok) assert.fail(result.error.detail);
  assert.equal(result.value.status, "unavailable");
  assert.match(result.value.detail ?? "", /command identity retention/);
  assert.equal(result.value.actual?.observedTerminalStatus, "completed");
  assert.equal(result.value.execution, null);
  assert.ok(!session.sent.includes("turn/interrupt"));
  await review.close();
});

Deno.test("reviewer: a policy violation remains sticky through early evidence eviction", async () => {
  const session = new ScriptedCodexSession();
  const { review, state } = await preparedSession(session);
  session.plan = (scripted) => {
    scripted.emit("item/started", {
      threadId: "thread-1",
      turnId: scripted.turnId,
      item: commandItem("forbidden", "inProgress", { source: "userShell" }),
    });
    for (let index = 0; index < 1_000; index++) {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem(`read-${index}`, "inProgress"),
      });
    }
    finish(scripted);
  };
  const result = await review.start();
  if (!result.ok) assert.fail(result.error.detail);
  assert.equal(result.value.status, "unavailable");
  assert.match(result.value.detail ?? "", /command execution item/);
  assert.equal(result.value.execution, null);
  assert.ok(state.commandItems.size <= 256);
  await review.close();
});

Deno.test("reviewer: truncated native output waits for settlement and a second exit cannot replace it", async (test) => {
  for (const exactReplacement of [false, true]) {
    await test.step(`exact replacement: ${exactReplacement}`, async () => {
      const session = new ProjectedSession();
      const { review, state } = await preparedSession(session);
      session.live = (scripted) => {
        session.emitProjected(JSON.stringify(CLEAN_RESULT));
        assert.equal(state.settled, false);
        assert.equal(state.finalMessage?.text, "");
        assert.equal(state.finalMessage?.truncated, true);
        if (exactReplacement) finish(scripted);
        else scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      const result = await review.start();
      if (!result.ok) assert.fail(result.error.detail);
      assert.equal(
        result.value.status,
        "unavailable",
      );
      assert.equal(result.value.actual?.observedTerminalStatus, "completed");
      assert.ok((result.value.actual?.outputChars ?? 0) >= 20 * 1024 * 1024);
      assert.equal(
        result.value.resultId,
        null,
      );
      await review.close();
    });
  }
});

Deno.test("reviewer: late truncated evidence invalidates tentative clean completion", async () => {
  const session = new ProjectedSession();
  const { review } = await preparedSession(session);
  session.live = (scripted) => finish(scripted);
  session.closeHook = () => session.emitProjected(JSON.stringify(CLEAN_RESULT));
  const result = await review.start();
  if (!result.ok) assert.fail(result.error.detail);
  assert.equal(result.value.status, "clean");
  const closed = await review.close();
  assert.equal(closed.failure, "close_failed");
  assert.equal(finalizeReviewCompletion(result, closed).ok, false);
});
