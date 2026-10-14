/** Shared fake sessions and schema fixtures; this module registers no tests. */
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { ModelRunRequestV1 } from "../../src/contracts/ports.ts";
import type {
  CodexServerNotificationV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";
import type { ActualSessionEvidenceV1 } from "../../src/repair/model-port.ts";
import { REPO, SHA1 } from "../state/helpers.ts";

export const CHECKOUT = "/tmp/sentinel-model-checkout";

/**
 * Schema-shaped completed file-change item per the installed ThreadItem
 * schema: required changes/id/status/type, status exactly `completed`, and a
 * nonempty changes array with the required path/kind/diff fields.
 */
export const SCHEMA_FILE_CHANGE_ITEM = {
  type: "fileChange",
  status: "completed",
  changes: [{
    path: "src/app.ts",
    kind: { type: "update" },
    diff: "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
  }],
};

/** Recording fake CodexSessionV1; emits one terminal turn/completed event. */
export class FakeCodexSession implements CodexSessionV1 {
  readonly sent: { method: string; params: unknown }[] = [];
  openCalls = 0;
  closeCalls = 0;
  closed = false;
  private notifications:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;
  private turnStarted = false;

  constructor(
    /**
     * Configured `activePermissionProfile` acknowledgement; undefined omits
     * the field entirely (the legacy thread acknowledgement).
     */
    private readonly activePermissionProfile?: Record<string, unknown>,
  ) {}

  open(): void {
    this.openCalls++;
  }

  send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    switch (method) {
      case "initialize":
        return Promise.resolve({ userAgent: "codex-app-server/0.153.4" });
      case "thread/start": {
        const ack: Record<string, unknown> = {
          thread: { id: "thread-1" },
          model: "gpt-reserve",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        };
        if (this.activePermissionProfile !== undefined) {
          ack.activePermissionProfile = this.activePermissionProfile;
        }
        return Promise.resolve(ack);
      }
      case "turn/start":
        this.turnStarted = true;
        return Promise.resolve({ turn: { id: "turn-1" } });
      case "turn/interrupt":
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  }

  notify(method: string, params?: unknown): void {
    this.sent.push({ method, params: params ?? {} });
  }

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notifications = handler;
    if (this.turnStarted) {
      // The real app-server emits the terminal event only after the listener
      // is registered inside awaitSettlement; the fake mirrors that order.
      // A completed run needs genuine correlated output evidence: one
      // successful file-change item for the exact thread/turn, delivered
      // before the terminal event.
      queueMicrotask(() => {
        this.notifications?.({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { ...SCHEMA_FILE_CHANGE_ITEM, id: "ok-output" },
          },
        });
        this.notifications?.({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", durationMs: 5 },
          },
        });
      });
    }
  }

  onServerRequest(): void {}

  close(): Promise<void> {
    this.closeCalls++;
    this.closed = true;
    return Promise.resolve();
  }
}

export class ThrowingNotificationSession extends FakeCodexSession {
  override onNotification(
    _handler: (event: CodexServerNotificationV1) => void,
  ): void {
    throw new Error("synthetic registration failure");
  }
}

/**
 * Emits the three reasoning-stream notifications the initialize request opts
 * out of before the scripted terminal. With `breach` one delta is large enough
 * that the existing output bound must still interrupt the turn even though the
 * port never consumes these methods.
 */
export class ReasoningStreamSession extends FakeCodexSession {
  constructor(private readonly breach: boolean) {
    super();
  }

  override onNotification(
    handler: (event: CodexServerNotificationV1) => void,
  ): void {
    super.onNotification(handler);
    const delta = this.breach ? "r".repeat(4_096) : "thinking";
    handler({
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "thread-1", turnId: "turn-1", delta },
    });
    handler({
      method: "item/reasoning/summaryPartAdded",
      params: { threadId: "thread-1", turnId: "turn-1", summaryIndex: 0 },
    });
    handler({
      method: "item/reasoning/textDelta",
      params: { threadId: "thread-1", turnId: "turn-1", delta },
    });
    if (this.breach) {
      // The output bound already requested the interrupt; report the runtime
      // terminal the real app-server sends for an interrupted turn. The
      // queued successful completion is ignored once evidence stopped.
      handler({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted", durationMs: 1 },
        },
      });
    }
  }
}

/**
 * Scripted fake session: acknowledges the configured thread/turn identity
 * and delivers the registered event script in wire order at registration.
 */
export class ScriptedSession implements CodexSessionV1 {
  readonly sent: { method: string; params: unknown }[] = [];
  closeCalls = 0;
  private notifications:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;

  constructor(
    private readonly threadAck: Record<string, unknown>,
    private readonly turnAck: Record<string, unknown>,
    private readonly events: { method: string; params: unknown }[],
    private readonly interruptTerminalStatus?:
      | "completed"
      | "interrupted"
      | "failed",
    /**
     * Optional post-terminal close script: the port awaits `close()`, so
     * events emitted here (synchronously or after awaited ticks) arrive after
     * the terminal settlement but before the port captures final evidence.
     */
    private readonly closeScript?: (
      emit: (method: string, params: unknown) => void,
    ) => void | Promise<void>,
  ) {}

  open(): void {}

  send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    switch (method) {
      case "initialize":
        return Promise.resolve({ userAgent: "codex-app-server/0.153.4" });
      case "thread/start":
        return Promise.resolve(this.threadAck);
      case "turn/start":
        return Promise.resolve(this.turnAck);
      case "turn/interrupt":
        if (this.interruptTerminalStatus !== undefined) {
          // Race the interrupt with a runtime terminal event for the exact
          // thread/turn (mirrors the real app-server event order).
          this.notifications?.({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: this.interruptTerminalStatus,
                durationMs: 1,
              },
            },
          });
        }
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  }

  notify(): void {}

  onServerRequest(): void {}

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notifications = handler;
    for (const event of this.events) handler(event);
  }

  /** Deliver one event through the registered handler, as the transport would. */
  emit(method: string, params: unknown): void {
    this.notifications?.({ method, params });
  }

  async close(): Promise<void> {
    this.closeCalls++;
    if (this.closeScript !== undefined) {
      await this.closeScript((method, params) => this.emit(method, params));
    }
  }
}

/** One genuine schema-shaped correlated file-change output item for the exact thread/turn. */
export const SUCCESS_ITEM = {
  method: "item/completed",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { ...SCHEMA_FILE_CHANGE_ITEM, id: "ok-output" },
  },
};

export const COMPLETED_TERMINAL = {
  method: "turn/completed",
  params: {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed", durationMs: 5 },
  },
};

export function requestRuntimeEvidence(
  overrides: Partial<ActualSessionEvidenceV1> = {},
): ActualSessionEvidenceV1 {
  return {
    invocationId: "invoke-1",
    requestedModel: "gpt-reserve",
    requestedProvider: "sentinel-host",
    requestedEffort: "max",
    threadId: "thread-1",
    turnId: "turn-1",
    threadModel: "gpt-reserve",
    threadModelProvider: "sentinel-host",
    threadEffort: "max",
    reroutes: [],
    terminal: { status: "completed", error: null, durationMs: 5 },
    terminalOrigin: "runtime",
    loopStopped: false,
    resultItems: [{ itemId: "ok-1", type: "fileChange" }],
    outputChars: 42,
    ...overrides,
  };
}

/** A completed-run model request as the loop submits it. */
export function runtimeRequest(
  overrides: Partial<ModelRunRequestV1> = {},
): ModelRunRequestV1 {
  return {
    taskId: asWorkItemId("issue-runtime"),
    repository: { ...REPO },
    base: SHA1,
    issue: null,
    evidence: [],
    model: "gpt-reserve",
    reasoning: "max",
    maxDurationMs: 5_000,
    maxOutputChars: 10_000,
    ...overrides,
  };
}
