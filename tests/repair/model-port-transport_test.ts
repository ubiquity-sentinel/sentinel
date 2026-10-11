/** Cohesive transport cases for the unchanged model-port facade. */
import assert from "node:assert/strict";
import type {
  CodexProtocolError,
  CodexServerNotificationV1,
  CodexServerRequestV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";
import { CodexSubprocessSession } from "../../src/repair/codex-transport.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { runtimeRequest } from "./model-port-helpers.ts";

// ---------------------------------------------------------------------------
// Real-subprocess fatal-visibility regression (getFailure seam).
// ---------------------------------------------------------------------------

/**
 * Fake app-server (real subprocess): answers the port protocol and, on the
 * `test/emit` handshake, writes ONE bounded stdout write containing the
 * trigger response, a schema-complete successful command item, the matching
 * completed terminal and the requested trailing corrupt frame. The write
 * happens only after the consumer registered (the wrapper sends the handshake
 * from inside onNotification), so the valid terminal is delivered before the
 * deterministic malformed/overflow/truncated stream corruption.
 */
function corruptAppServerCode(cwd: string): string {
  return `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffer = "";
const line = (value) => Deno.stdout.writeSync(encoder.encode(value + "\\n"));
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk);
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const text = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (text === "") continue;
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      continue;
    }
    if (frame === null || typeof frame !== "object" || frame.id === undefined) {
      continue;
    }
    const method = typeof frame.method === "string" ? frame.method : "";
    if (method === "initialize") {
      line(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { userAgent: "codex-app-server/0.153.4" } }));
      continue;
    }
    if (method === "thread/start") {
      line(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { thread: { id: "thread-1" }, model: "gpt-reserve", reasoningEffort: "max", modelProvider: "sentinel-host" } }));
      continue;
    }
    if (method === "turn/start") {
      line(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { turn: { id: "turn-1" } } }));
      continue;
    }
    if (method === "test/emit") {
      const corrupt = frame.params && frame.params.corrupt;
      const item = {
        id: "ok-cmd-1",
        type: "commandExecution",
        status: "completed",
        exitCode: 0,
        command: "deno check src/app.ts",
        cwd: ${JSON.stringify(cwd)},
        commandActions: [{ type: "unknown", command: "deno check src/app.ts" }],
      };
      const frames = [
        { jsonrpc: "2.0", id: frame.id, result: {} },
        { jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item } },
        { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", durationMs: 1 } } },
        corrupt === "malformed"
          ? "this is not json"
          : corrupt === "overflow"
          ? "o".repeat(513)
          : "stream ends here",
      ].map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\\n");
      // ONE stdout write: the trailing corrupt frame is unterminated for the
      // truncated variant; the child then closes stdout (EOF => unterminated
      // frame) and KEEPS RUNNING, so the bounded close waits on the live
      // child's TERM/KILL instead of canceling the pump before the EOF fail.
      Deno.stdout.writeSync(encoder.encode(frames + (corrupt === "truncated" ? "" : "\\n")));
      if (corrupt === "truncated") Deno.stdout.close();
      continue;
    }
    line(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }));
  }
}
`;
}

/**
 * Real-subprocess wrapper for the corruption regression: it registers the
 * transport listener first and only then sends the `test/emit` handshake, so
 * the corrupt burst is deterministically written AFTER notification
 * registration (request/response handshake, no sleeps).
 */
class PostRegistrationSession implements CodexSessionV1 {
  constructor(
    private readonly inner: CodexSubprocessSession,
    private readonly corrupt: "malformed" | "overflow" | "truncated",
  ) {}

  open(): void {
    this.inner.open();
  }

  send(method: string, params: unknown): Promise<unknown> {
    return this.inner.send(method, params);
  }

  notify(method: string, params?: unknown): void {
    this.inner.notify(method, params);
  }

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.inner.onNotification(handler);
    void this.inner.send("test/emit", { corrupt: this.corrupt }).catch(() => {
      // Test-only handshake; its late rejection at close is never an
      // unhandled rejection.
    });
  }

  onServerRequest(handler: (request: CodexServerRequestV1) => void): void {
    this.inner.onServerRequest(handler);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  isSettled(): boolean {
    return this.inner.isSettled();
  }

  getFailure(): CodexProtocolError | null {
    return this.inner.getFailure();
  }
}

Deno.test(
  "model-port: lazy session open is idempotent and a closed session fails closed at the open boundary",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "sentinel-model-open-" });
    // The child is an immediate exit only: it proves the owned transport
    // boundary without any JSON-RPC, network or model work.
    const makeSession = () =>
      new CodexSubprocessSession({
        command: [Deno.execPath(), "eval", "Deno.exit(0)"],
        cwd: dir,
        env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
        operationDeadlineMs: 30_000,
      });
    try {
      // A session closed before it was ever opened must not respawn.
      const closedEarly = makeSession();
      await closedEarly.close();
      assert.throws(
        () => closedEarly.open(),
        /transport already closed/,
        "never-opened closed session rejects a later open",
      );

      // Opening twice is idempotent (a trusted host pre-open plus the model
      // port's lazy boundary), and a closed session fails closed at open:
      // no silent no-op while its child handle is still set.
      const session = makeSession();
      session.open();
      session.open();
      await session.close();
      assert.throws(
        () => session.open(),
        /transport already closed/,
        "opened-then-closed session rejects a later open",
      );
      let rejected = false;
      try {
        await session.send("late", {});
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true, "send after close still fails closed");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "model-port: real transport corruption after notification registration never yields a verified completed or host-timeout receipt",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "sentinel-model-corrupt-" });
    try {
      for (
        const corrupt of ["malformed", "overflow", "truncated"] as const
      ) {
        const inner = new CodexSubprocessSession({
          command: [Deno.execPath(), "eval", corruptAppServerCode(dir)],
          cwd: dir,
          env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
          operationDeadlineMs: 30_000,
          closeTermGraceMs: 300,
          closeKillSettleMs: 700,
          // Small line bound keeps the whole corrupt burst in one bounded
          // read: the overflow frame is just over the bound, never multi-MB.
          maxLineBytes: 512,
        });
        const session = new PostRegistrationSession(inner, corrupt);
        const port = new CodexImplementationPort({
          openSession: () => Promise.resolve(session),
          checkoutDir: dir,
          modelProvider: "sentinel-host",
          interruptSettlementGraceMs: 100,
        });
        const result = await port.runModel(runtimeRequest());
        assert.ok(!result.ok, `${corrupt}: ${JSON.stringify(result)}`);
        if (!result.ok) {
          assert.equal(result.error.kind, "unavailable", corrupt);
          assert.equal(result.error.detail, "malformed_line", corrupt);
        }
        assert.notEqual(
          session.getFailure(),
          null,
          `${corrupt}: the transport observed the fatal stream error`,
        );
        assert.equal(
          session.isSettled(),
          true,
          `${corrupt}: the owned process group fully settled`,
        );
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "model-port: genuine no-terminal no-fatal transport timeout keeps host-timeout failed accounting with null observed status",
  async () => {
    const dir = await Deno.makeTempDir({
      prefix: "sentinel-model-no-terminal-",
    });
    try {
      const session = new CodexSubprocessSession({
        command: [Deno.execPath(), "eval", corruptAppServerCode(dir)],
        cwd: dir,
        env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
        operationDeadlineMs: 30_000,
        closeTermGraceMs: 300,
        closeKillSettleMs: 700,
      });
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: dir,
        modelProvider: "sentinel-host",
        interruptSettlementGraceMs: 100,
      });
      const result = await port.runModel({
        ...runtimeRequest(),
        maxDurationMs: 300,
      });
      assert.ok(result.ok, JSON.stringify(result));
      if (result.ok) {
        assert.equal(result.value.outcome, "failed");
        assert.equal(
          result.value.error,
          "host timeout without terminal settlement",
        );
        assert.equal(result.value.candidate, null);
        assert.equal(result.value.actual.terminalOrigin, "host-timeout");
        assert.equal(result.value.actual.observedTerminalStatus, null);
      }
      assert.equal(
        session.getFailure(),
        null,
        "a healthy transport never manufactures a fatal error",
      );
      assert.equal(
        session.isSettled(),
        true,
        "the owned process group fully settled",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);
