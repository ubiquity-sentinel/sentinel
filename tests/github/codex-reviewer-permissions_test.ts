// codex reviewer permissions_test.

import assert from "node:assert/strict";
import { MAX_JOURNAL_BYTES } from "../../src/github/review-journal.ts";
import {
  ACCOUNT_CONTENT,
  agentMessage,
  CLEAN_RESULT,
  commandItem,
  contains,
  FINDINGS_RESULT,
  makeReviewer,
  prepareRequest,
  PROVIDER,
  ScriptedCodexSession,
  snapshotFixture,
  startReview,
  turnCompleted,
} from "./codex-reviewer-helpers.ts";

Deno.test(
  "reviewer: permission profile binds capabilities, thread permissions and the single turn",
  async () => {
    const session = new ScriptedCodexSession();
    session.threadAck = {
      thread: { id: "thread-1" },
      model: "gpt-reserve",
      modelProvider: PROVIDER,
      reasoningEffort: "max",
      activePermissionProfile: { id: "sentinel-review" },
    };
    session.live = (scripted) => {
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
    const reviewer = makeReviewer(session, {
      permissionProfile: "sentinel-review",
    });
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    assert.deepEqual(
      (session.params[0] as Record<string, unknown>).capabilities,
      {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta",
        ],
      },
      "experimental capabilities are enabled only for a configured profile",
    );
    const threadParams = session.params[1] as Record<string, unknown>;
    assert.equal(threadParams.permissions, "sentinel-review");
    assert.equal(
      "sandbox" in threadParams,
      false,
      "the named profile replaces the legacy sandbox",
    );
    const profileConfig = threadParams.config as Record<string, unknown>;
    assert.equal(
      profileConfig["features.shell_tool"],
      true,
      "the named restricted profile enables the ordinary shell read tool",
    );
    assert.equal(
      profileConfig["features.unified_exec"],
      false,
      "unified exec stays disabled: only one-shot ExecCommandHandler authority",
    );
    assert.equal(profileConfig["features.multi_agent"], false);
    assert.equal(profileConfig["features.apps"], false);
    assert.equal(profileConfig.web_search, "disabled");

    const outcome = await prepared.value.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    const turnParams = session.params[2] as Record<string, unknown>;
    assert.equal(turnParams.permissions, undefined);
    assert.equal(
      "sandboxPolicy" in turnParams,
      false,
      "the trusted profile replaces the legacy readOnly override",
    );
    assert.equal(turnParams.approvalPolicy, undefined);
    assert.equal(session.turnStarts(), 1);
  },
);

Deno.test(
  "reviewer: permission profile missing or wrong acknowledgement fails preparation before any turn",
  async (t) => {
    const cases: [string, Record<string, unknown> | undefined][] = [
      ["missing", undefined],
      ["wrong", { id: "other-profile" }],
    ];
    for (const [label, ack] of cases) {
      await t.step(label, async () => {
        const session = new ScriptedCodexSession();
        session.threadAck = {
          thread: { id: "thread-1" },
          model: "gpt-reserve",
          modelProvider: PROVIDER,
          reasoningEffort: "max",
          ...(ack === undefined ? {} : { activePermissionProfile: ack }),
        };
        const reviewer = makeReviewer(session, {
          permissionProfile: "sentinel-review",
        });
        const prepared = await reviewer.prepare(
          prepareRequest(await snapshotFixture()),
        );
        assert.equal(prepared.ok, false);
        if (prepared.ok) return;
        assert.equal(prepared.error.kind, "unavailable");
        assert.equal(session.turnStarts(), 0);
        assert.equal(session.closed, 1, "the owned session settles");
      });
    }
  },
);

Deno.test(
  "reviewer: missing permission profile refuses before opening any session",
  async () => {
    const session = new ScriptedCodexSession();
    const reviewer = makeReviewer(session, {
      permissionProfile: undefined as unknown as string,
    });
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    assert.equal(prepared.ok, false);
    if (prepared.ok) return;
    assert.equal(prepared.error.kind, "unavailable");
    contains(prepared.error.detail, "permission profile");
    assert.equal(session.opened, 0, "no app-server session is ever opened");
    assert.deepEqual(session.sent, [], "no handshake or turn request is sent");
    assert.equal(session.turnStarts(), 0);
  },
);

Deno.test(
  "reviewer: invalid permission profile opens no session",
  async (t) => {
    const invalidProfiles = [
      "",
      "1bad",
      "bad profile",
      "a".repeat(65),
      "danger-full-access",
      "full-access",
    ];
    for (const profile of invalidProfiles) {
      await t.step(JSON.stringify(profile), async () => {
        const session = new ScriptedCodexSession();
        const reviewer = makeReviewer(session, {
          permissionProfile: profile,
        });
        const prepared = await reviewer.prepare(
          prepareRequest(await snapshotFixture()),
        );
        assert.equal(prepared.ok, false);
        if (prepared.ok) return;
        assert.equal(prepared.error.kind, "unavailable");
        assert.equal(session.opened, 0);
        assert.deepEqual(session.sent, []);
      });
    }
  },
);

Deno.test(
  "reviewer: early output before the turn/start response is buffered and consumed once",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-early",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "clean");
    assert.equal(outcome.resultId, "item-early");
    assert.equal(outcome.execution?.turnId, "turn-1");
    assert.equal(outcome.actual?.terminalOrigin, "runtime");
    assert.equal(outcome.actual?.observedTerminalStatus, "completed");
    assert.equal(outcome.actual?.observedModel, null);
    assert.equal(outcome.actual?.observedReasoning, null);
    assert.equal(outcome.actual?.provider, PROVIDER);
    assert.equal(outcome.actual?.evidenceKind, "native-review");
    assert.equal(outcome.detail, null);
    assert.equal(session.turnStarts(), 1);
  },
);

Deno.test(
  "reviewer: findings keep the full multiline body and bind exact journal types",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-finding",
          JSON.stringify(FINDINGS_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "findings");
    assert.deepEqual(outcome.result, FINDINGS_RESULT);
    assert.equal(
      outcome.result?.findings[0].body,
      FINDINGS_RESULT.findings[0].body,
      "the complete multiline finding body is preserved",
    );
    assert.equal(outcome.resultId, "item-finding");
    const execution = outcome.execution;
    if (execution === null) assert.fail("expected a ready execution binding");
    assert.equal(execution.resultId, "item-finding");
    assert.equal(execution.turnId, "turn-1");
    assert.equal(execution.submittedProvider, PROVIDER);
    assert.deepEqual(execution.actual, outcome.actual);
    assert.equal(JSON.stringify(execution).includes(ACCOUNT_CONTENT), false);
  },
);

Deno.test(
  "reviewer: malformed, contradictory or ambiguous output cannot yield clean",
  async () => {
    const cases: { name: string; text: string; detail: string }[] = [
      {
        name: "prose",
        text: "Looks good to me, no findings.",
        detail: "malformed",
      },
      {
        name: "clean-with-findings",
        text: JSON.stringify({
          ...CLEAN_RESULT,
          findings: FINDINGS_RESULT.findings,
        }),
        detail: "malformed",
      },
      {
        name: "unknown-key",
        text: JSON.stringify({ ...CLEAN_RESULT, extra: true }),
        detail: "malformed",
      },
      {
        name: "truncated",
        text: '{"verdict":"clean","summary":"ok"',
        detail: "malformed",
      },
      {
        name: "out-of-range-priority",
        text: JSON.stringify({
          verdict: "findings",
          summary: "x",
          findings: [{ ...FINDINGS_RESULT.findings[0], priority: 9 }],
        }),
        detail: "malformed",
      },
    ];
    for (const item of cases) {
      const session = new ScriptedCodexSession();
      session.plan = (scripted) => {
        scripted.emit(
          "item/completed",
          agentMessage(scripted.turnId, "item-1", item.text),
        );
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      const outcome = await startReview(session, await snapshotFixture());
      assert.equal(outcome.status, "unavailable", item.name);
      assert.equal(outcome.result, null, item.name);
      assert.equal(outcome.execution, null, item.name);
      contains(outcome.detail ?? "", item.detail, item.name);
    }

    // Duplicate final agent messages are ambiguous, never a clean verdict.
    const duplicate = new ScriptedCodexSession();
    duplicate.plan = (scripted) => {
      const text = JSON.stringify(CLEAN_RESULT);
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", text),
      );
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-2", text),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const ambiguous = await startReview(duplicate, await snapshotFixture());
    assert.equal(ambiguous.status, "unavailable");
    contains(ambiguous.detail ?? "", "ambiguous");

    // Over-bound result output is unavailable, never truncated into a verdict.
    const oversize = JSON.stringify({
      verdict: "findings",
      summary: "oversize",
      findings: Array.from({ length: 10 }, (_, index) => ({
        priority: 1,
        title: `finding ${index}`,
        body: "x".repeat(7000),
        path: "account.ts",
        lineStart: 1,
        lineEnd: 1,
      })),
    });
    assert.ok(oversize.length > MAX_JOURNAL_BYTES);
    const overflow = new ScriptedCodexSession();
    overflow.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", oversize),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const bounded = await startReview(overflow, await snapshotFixture());
    assert.equal(bounded.status, "unavailable");
    contains(bounded.detail ?? "", "bound");
  },
);

Deno.test(
  "reviewer: commentary is not the result and a model-unavailable verdict stays unavailable",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-commentary",
          "I will inspect the diff first.",
          "commentary",
        ),
      );
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
          "final_answer",
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "clean");
    assert.equal(outcome.resultId, "item-final");

    const commentaryOnly = new ScriptedCodexSession();
    commentaryOnly.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-c", "analysis only", "commentary"),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const none = await startReview(commentaryOnly, await snapshotFixture());
    assert.equal(none.status, "unavailable");
    contains(none.detail ?? "", "final agent message");

    const modelUnavailable = new ScriptedCodexSession();
    modelUnavailable.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-u",
          JSON.stringify({
            verdict: "unavailable",
            summary: "insufficient evidence",
            findings: [],
          }),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const correlated = await startReview(
      modelUnavailable,
      await snapshotFixture(),
    );
    assert.equal(correlated.status, "unavailable");
    assert.equal(correlated.execution, null);
    assert.equal(correlated.resultId, "item-u");
    assert.equal(correlated.result?.verdict, "unavailable");
    assert.equal(correlated.actual?.observedTerminalStatus, "completed");
  },
);

Deno.test(
  "reviewer: lost submission and missing turn id invent no terminal identities",
  async () => {
    const lostSession = new ScriptedCodexSession();
    lostSession.turnFailure = true;
    const lostReviewer = makeReviewer(lostSession);
    const lostPrepared = await lostReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!lostPrepared.ok) assert.fail(lostPrepared.error.detail);
    const lost = await lostPrepared.value.start();
    assert.equal(lost.ok, false);
    assert.equal(lostSession.turnStarts(), 1);

    const noIdSession = new ScriptedCodexSession();
    noIdSession.turnResponse = { turn: { status: "inProgress" } };
    const noIdReviewer = makeReviewer(noIdSession);
    const noIdPrepared = await noIdReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!noIdPrepared.ok) assert.fail(noIdPrepared.error.detail);
    const missing = await noIdPrepared.value.start();
    assert.equal(missing.ok, false);
    if (missing.ok) assert.fail("expected rejection");
    contains(missing.error.detail, "turn id");
    assert.equal(noIdSession.turnStarts(), 1);
  },
);

Deno.test(
  "reviewer: off-policy routing, forbidden items and server requests never yield clean",
  async () => {
    const rerouted = new ScriptedCodexSession();
    rerouted.plan = (scripted) => {
      scripted.emit("model/rerouted", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        fromModel: "gpt-reserve",
        toModel: "gpt-reserve",
        reason: "capacity",
      });
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const routing = await startReview(rerouted, await snapshotFixture());
    assert.equal(routing.status, "unavailable");
    contains(routing.detail ?? "", "rerouted off the model Codex resolved");

    // A genuine reroute (gateway failover onto an implementation route) is
    // the substitution the policy forbids: never a verdict.
    const failover = new ScriptedCodexSession();
    failover.plan = (scripted) => {
      scripted.emit("model/rerouted", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        fromModel: "gpt-reserve",
        toModel: "gpt-6-luna",
        reason: "capacity",
      });
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const substituted = await startReview(failover, await snapshotFixture());
    assert.equal(substituted.status, "unavailable");
    contains(substituted.detail ?? "", "rerouted off the model Codex resolved");

    const tool = new ScriptedCodexSession();
    tool.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: { type: "fileChange", id: "edit-1" },
      });
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const forbidden = await startReview(tool, await snapshotFixture());
    assert.equal(forbidden.status, "unavailable");
    contains(forbidden.detail ?? "", "forbidden");

    const mcp = new ScriptedCodexSession();
    mcp.plan = (scripted) => {
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: { type: "mcpToolCall", id: "mcp-1" },
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const forbiddenMcp = await startReview(mcp, await snapshotFixture());
    assert.equal(forbiddenMcp.status, "unavailable");
    contains(forbiddenMcp.detail ?? "", "forbidden");

    const server = new ScriptedCodexSession();
    server.plan = (scripted) => {
      scripted.requestServer("item/commandExecution/requestApproval");
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const requested = await startReview(server, await snapshotFixture());
    assert.equal(requested.status, "unavailable");
    contains(requested.detail ?? "", "server request");

    const failed = new ScriptedCodexSession();
    failed.plan = (scripted) => {
      scripted.emit("turn/completed", turnCompleted(scripted.turnId, "failed"));
    };
    const failedRun = await startReview(failed, await snapshotFixture());
    assert.equal(failedRun.status, "unavailable");
    assert.equal(failedRun.actual?.observedTerminalStatus, "failed");
    assert.equal(failedRun.execution, null);
  },
);

Deno.test(
  "reviewer: correlated shell command start, output deltas and completion permit a clean review",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress", { source: "agent" }),
      });
      scripted.emit("item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        itemId: "cmd-1",
        delta: ACCOUNT_CONTENT,
      });
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed"),
      });
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
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "clean");
    assert.equal(outcome.resultId, "item-final");
    assert.equal(outcome.execution?.turnId, "turn-1");
    assert.equal(outcome.actual?.observedTerminalStatus, "completed");
    assert.equal(session.turnStarts(), 1);
    assert.equal(
      JSON.stringify(outcome).includes(ACCOUNT_CONTENT),
      false,
      "shell output is evidence only and never becomes the review result",
    );
  },
);

Deno.test(
  "reviewer: the unified-exec agent shell sources are accepted and userShell is not",
  async () => {
    // The installed 0.154 protocol enumerates `agent`, `userShell`,
    // `unifiedExecStartup` and `unifiedExecInteraction`. The unified-exec
    // values are the SAME agent shell tool over its persistent-process
    // transport, so a review in which the agent uses it must still complete;
    // a human `userShell` command is not agent evidence and must not.
    for (const source of ["unifiedExecStartup", "unifiedExecInteraction"]) {
      const session = new ScriptedCodexSession();
      session.plan = (scripted) => {
        scripted.emit("item/started", {
          threadId: "thread-1",
          turnId: scripted.turnId,
          item: commandItem("cmd-1", "inProgress", { source }),
        });
        scripted.emit("item/commandExecution/outputDelta", {
          threadId: "thread-1",
          turnId: scripted.turnId,
          itemId: "cmd-1",
          delta: ACCOUNT_CONTENT,
        });
        scripted.emit("item/completed", {
          threadId: "thread-1",
          turnId: scripted.turnId,
          item: commandItem("cmd-1", "completed", { source }),
        });
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
      const outcome = await startReview(session, await snapshotFixture());
      assert.equal(outcome.status, "clean", source);
      assert.equal(outcome.execution?.turnId, "turn-1");
    }

    // A completion that changes the source is still contradictory.
    const mismatched = new ScriptedCodexSession();
    mismatched.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress", {
          source: "unifiedExecStartup",
        }),
      });
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed", { source: "agent" }),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const mismatchRefused = await startReview(
      mismatched,
      await snapshotFixture(),
    );
    assert.equal(mismatchRefused.status, "unavailable");
    contains(mismatchRefused.detail ?? "", "command execution item");

    for (const source of ["userShell", "unifiedExecUnknown"]) {
      const session = new ScriptedCodexSession();
      session.plan = (scripted) => {
        scripted.emit("item/started", {
          threadId: "thread-1",
          turnId: scripted.turnId,
          item: commandItem("cmd-1", "inProgress", { source }),
        });
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      const refused = await startReview(session, await snapshotFixture());
      assert.equal(refused.status, "unavailable", source);
      contains(refused.detail ?? "", "command execution item");
    }
  },
);
