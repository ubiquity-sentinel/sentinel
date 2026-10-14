/** Cohesive output cases for the unchanged model-port facade. */
import assert from "node:assert/strict";
import type { CodexServerNotificationV1 } from "../../src/repair/codex-transport.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { SHA3 } from "../state/helpers.ts";
import {
  CHECKOUT,
  COMPLETED_TERMINAL,
  runtimeRequest,
  ScriptedSession,
} from "./model-port-helpers.ts";

Deno.test(
  "model-port: invalid file-change/agent output events never prove output even with a permissive verifier",
  async () => {
    // Each case delivers only invalid output events for the exact thread/turn
    // followed by a completed runtime terminal. A permissive injected verifier
    // is present, yet the completed run must stay unavailable (no output,
    // no candidate): failed/declined/missing-status/empty-or-malformed
    // changes and blank/unsupported agent content cannot prove output.
    const invalidEvents: CodexServerNotificationV1[] = [
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "fc-1", type: "fileChange" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-2",
            type: "fileChange",
            status: "failed",
            changes: [{
              path: "src/app.ts",
              kind: { type: "update" },
              diff: "x",
            }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-3",
            type: "fileChange",
            status: "declined",
            changes: [{
              path: "src/app.ts",
              kind: { type: "update" },
              diff: "x",
            }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-4",
            type: "fileChange",
            status: "inProgress",
            changes: [{
              path: "src/app.ts",
              kind: { type: "update" },
              diff: "x",
            }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-5",
            type: "fileChange",
            status: "completed",
            changes: [],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-6",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "src/app.ts", diff: "x" }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-7",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "src/app.ts", kind: "update", diff: "x" }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "am-1",
            type: "agentMessage",
            content: "fallback content",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "am-2", type: "agentMessage", text: "   " },
        },
      },
    ];
    for (const event of invalidEvents) {
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-reserve",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [event, COMPLETED_TERMINAL],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
        checkout: {
          resolve: () =>
            Promise.resolve({
              head: SHA3,
              checkpointSha: null,
              changedPaths: ["src/app.ts"],
            }),
        },
        receiptVerifier: () => ({
          provider: "sentinel-host",
          observedModel: "gpt-reserve",
          observedReasoning: "max",
        }),
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable");
        assert.equal(
          result.error.detail,
          "model receipt unavailable: completed run has no correlated output evidence",
        );
      }
      assert.equal(session.closeCalls, 1);
    }
  },
);

Deno.test(
  "model-port: schema-malformed command-execution output never proves output even with a permissive verifier",
  async () => {
    // Each case delivers one completed/exitCode-0 command item with missing/
    // invalid command/cwd/actions (or malformed optional fields) followed by a
    // completed runtime terminal: the item can never prove output, so the
    // completed run stays unavailable and produces no candidate. The
    // failed-command-loop classification behavior of these items is untouched.
    const base = {
      id: "cmd-x",
      type: "commandExecution",
      status: "completed",
      exitCode: 0,
      command: "deno check src/app.ts",
      cwd: "/tmp/checkout",
      commandActions: [{ type: "unknown", command: "deno check src/app.ts" }],
    };
    const invalidItems: Record<string, unknown>[] = [
      { ...base, id: "cmd-missing-command", command: undefined },
      { ...base, id: "cmd-empty-command", command: "" },
      { ...base, id: "cmd-whitespace-command", command: "   " },
      { ...base, id: "cmd-overbound-command", command: "c".repeat(4097) },
      { ...base, id: "cmd-missing-cwd", cwd: undefined },
      { ...base, id: "cmd-empty-cwd", cwd: "" },
      { ...base, id: "cmd-overbound-cwd", cwd: "c".repeat(4097) },
      { ...base, id: "cmd-missing-actions", commandActions: undefined },
      { ...base, id: "cmd-nonarray-actions", commandActions: {} },
      {
        ...base,
        id: "cmd-overbound-actions",
        commandActions: Array.from({ length: 65 }, () => ({
          type: "unknown",
          command: "x",
        })),
      },
      { ...base, id: "cmd-action-missing-command", commandActions: [{}] },
      {
        ...base,
        id: "cmd-action-unknown-type",
        commandActions: [{
          type: "walk",
          command: "x",
        }],
      },
      {
        ...base,
        id: "cmd-read-missing-name-path",
        commandActions: [{
          type: "read",
          command: "cat src/app.ts",
        }],
      },
      {
        ...base,
        id: "cmd-read-bad-path",
        commandActions: [{
          type: "read",
          command: "cat src/app.ts",
          name: "read-file",
          path: 42,
        }],
      },
      {
        ...base,
        id: "cmd-list-bad-path",
        commandActions: [{
          type: "listFiles",
          command: "ls",
          path: 7,
        }],
      },
      {
        ...base,
        id: "cmd-search-bad-query",
        commandActions: [{
          type: "search",
          command: "rg x",
          query: {},
        }],
      },
      { ...base, id: "cmd-bad-optional-output", aggregatedOutput: 42 },
      { ...base, id: "cmd-bad-optional-duration", durationMs: "5" },
      { ...base, id: "cmd-negative-duration", durationMs: -1 },
      { ...base, id: "cmd-bad-optional-source", source: "root" },
      { ...base, id: "cmd-nonzero-exit", exitCode: 1 },
      { ...base, id: "cmd-noncompleted-status", status: "failed", exitCode: 0 },
    ];
    for (const item of invalidItems) {
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-reserve",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [{
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item,
          },
        }, COMPLETED_TERMINAL],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
        receiptVerifier: () => ({
          provider: "sentinel-host",
          observedModel: "gpt-reserve",
          observedReasoning: "max",
        }),
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(
        !result.ok,
        `${String(item.id)}: ${JSON.stringify(result)}`,
      );
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable", String(item.id));
        assert.equal(
          result.error.detail,
          "model receipt unavailable: completed run has no correlated output evidence",
          String(item.id),
        );
      }
      assert.equal(session.closeCalls, 1, String(item.id));
    }
  },
);

Deno.test(
  "model-port: a schema-complete successful command item proves output and produces the candidate",
  async () => {
    const schemaCompleteItem = {
      id: "cmd-ok",
      type: "commandExecution",
      status: "completed",
      exitCode: 0,
      command: "deno check src/app.ts",
      cwd: "/tmp/checkout",
      commandActions: [
        { type: "unknown", command: "deno check src/app.ts" },
        {
          type: "read",
          command: "cat src/app.ts",
          name: "read-file",
          path: "/tmp/checkout/src/app.ts",
        },
        { type: "listFiles", command: "ls src" },
        {
          type: "search",
          command: "rg todo src",
          path: "/tmp/checkout/src",
          query: "todo",
        },
      ],
      aggregatedOutput: "checked",
      durationMs: 5,
      source: "agent",
    };
    const session = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [{
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: schemaCompleteItem,
        },
      }, COMPLETED_TERMINAL],
    );
    // The schema also supports an empty (bounded) commandActions array: it is
    // still a schema-complete successful command item.
    const emptyActionsSession = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [{
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            ...schemaCompleteItem,
            id: "cmd-ok-empty",
            commandActions: [],
          },
        },
      }, COMPLETED_TERMINAL],
    );
    for (
      const [name, fixture] of [
        ["schema-valid actions", session],
        ["empty actions", emptyActionsSession],
      ] as const
    ) {
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(fixture),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
        checkout: {
          resolve: () =>
            Promise.resolve({
              head: SHA3,
              checkpointSha: null,
              changedPaths: ["src/app.ts"],
            }),
        },
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(result.ok, `${name}: ${JSON.stringify(result)}`);
      if (!result.ok) continue;
      assert.equal(result.value.outcome, "completed", name);
      assert.equal(result.value.candidate?.head, SHA3, name);
      assert.equal(
        result.value.actual.observedTerminalStatus,
        "completed",
        name,
      );
      assert.equal(fixture.closeCalls, 1, name);
    }
  },
);
