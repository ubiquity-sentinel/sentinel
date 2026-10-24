/** Production consumer proof: notifications precede the turn/start response. */
import assert from "node:assert/strict";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { CodexSubprocessSession } from "../../src/repair/codex-transport.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { verifyMatrixReceiptV1 } from "../../src/host/matrix-identity.ts";
import { SHA3 } from "../state/helpers.ts";
import {
  runtimeRequest,
  SCHEMA_FILE_CHANGE_ITEM,
} from "./model-port-helpers.ts";

type Scenario = "large" | "forged-only" | "late-reroute" | "evidence-overflow";

function serverCode(scenario: Scenario): string {
  return `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let observedChars = 0;
const write = (frame) => {
  const bytes = encoder.encode(JSON.stringify(frame) + "\\n");
  for (let offset = 0; offset < bytes.length;) {
    offset += Deno.stdout.writeSync(bytes.subarray(offset));
  }
};
const event = (method, params) => {
  observedChars += JSON.stringify(params).length;
  write({ jsonrpc: "2.0", method, params });
};
const terminal = (threadId) => event("turn/completed", {
  threadId, turn: { id: "turn-1", status: "completed", durationMs: 5 }
});
const reroute = (turnId) => event("model/rerouted", {
  threadId: "thread-1", turnId, fromModel: "gpt-reserve", toModel: "other-model",
  reason: "server overload"
});
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk);
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (frame.id === undefined) continue;
    let result = {};
    if (frame.method === "initialize") result = { userAgent: "codex-app-server/0.153.4" };
    if (frame.method === "thread/start") result = {
      thread: { id: "thread-1" }, model: "gpt-reserve", reasoningEffort: "max",
      modelProvider: "sentinel-host"
    };
    if (frame.method === "turn/start") {
      const delta = "x".repeat(32 * 1024);
      const count = ${scenario === "large" ? 1152 : 12};
      for (let index = 0; index < count; index++) {
        event("item/commandExecution/outputDelta", {
          threadId: "thread-1", turnId: "turn-1", itemId: "noise", delta
        });
        if (index === 5) { terminal("forged-thread"); reroute("forged-turn"); }
      }
      // One projected output field proves original-volume metadata survives
      // custody and replay, independently from the transport queue pressure.
      event("item/commandExecution/outputDelta", {
        threadId: "thread-1", turnId: "turn-1", itemId: "noise",
        delta: "y".repeat(2 * 1024 * 1024)
      });
      if (${JSON.stringify(scenario)} === "evidence-overflow") {
        for (let index = 0; index < 300; index++) {
          event("item/completed", {
            threadId: "thread-1", turnId: "turn-1",
            item: { id: "message-" + index, type: "agentMessage", text: delta }
          });
        }
      }
      event("item/completed", {
        threadId: ${
    JSON.stringify(scenario === "forged-only" ? "forged-thread" : "thread-1")
  },
        turnId: "turn-1", item: { ...${
    JSON.stringify(SCHEMA_FILE_CHANGE_ITEM)
  }, id: "output" }
      });
      terminal("thread-1");
      if (${JSON.stringify(scenario)} === "late-reroute") {
        // The real terminal resolves settlement midway through replay. This
        // later exact-identity reroute must still veto receipt publication.
        event("item/commandExecution/outputDelta", {
          threadId: "thread-1", turnId: "turn-1", delta
        });
        reroute("turn-1");
      }
      result = { turn: { id: "turn-1" }, observedChars };
    }
    write({ jsonrpc: "2.0", id: frame.id, result });
  }
}
`;
}

export async function runScenario(scenario: Scenario) {
  const dir = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-early-notifications-",
  });
  const request = runtimeRequest({
    ...createLocalRepositoryConfig().sessionBound!,
    maxDurationMs: 60_000,
  });
  const session = new CodexSubprocessSession({
    command: [Deno.execPath(), "eval", serverCode(scenario)],
    cwd: dir,
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    operationDeadlineMs: 60_000,
  });
  const originalSend = session.send.bind(session);
  let observedChars = 0;
  let interrupts = 0;
  session.send = async (method, params) => {
    if (method === "turn/interrupt") interrupts++;
    const response = await originalSend(method, params);
    if (method === "turn/start") {
      observedChars = (response as { observedChars: number }).observedChars;
    }
    return response;
  };
  let retainedEvidenceBytes = 0;
  (globalThis as unknown as { gc?: () => void }).gc?.();
  const before = Deno.memoryUsage().heapUsed;
  let peak = before;
  // Bounded custody is about LIVE memory: with `--expose-gc` (the fresh
  // probe process) each sample first collects garbage, so the peak no longer
  // depends on when V8 happens to collect the streamed output it already
  // released (CI measured 33.7-35 MB against the 32 MiB bound before this).
  // Buffering the whole >38 MiB stream would still be live at a sample.
  const collect = (globalThis as unknown as { gc?: () => void }).gc;
  const sampler = setInterval(() => {
    collect?.();
    peak = Math.max(peak, Deno.memoryUsage().heapUsed);
  }, 25);
  const port = new CodexImplementationPort({
    openSession: () => Promise.resolve(session),
    checkoutDir: dir,
    modelProvider: "sentinel-host",
    checkout: {
      resolve: () =>
        Promise.resolve({
          head: SHA3,
          checkpointSha: null,
          changedPaths: ["src/app.ts"],
        }),
    },
    receiptVerifier: (evidence) => {
      retainedEvidenceBytes = JSON.stringify(evidence).length;
      return {
        provider: "sentinel-host",
        observedModel: request.model,
        observedReasoning: "max",
      };
    },
  });
  try {
    const result = await port.runModel(request);
    assert.equal(interrupts, 0, "volume never requests an interrupt");
    assert.equal(session.isSettled(), true);
    assert.equal(session.getFailure(), null);
    return {
      result,
      observedChars,
      request,
      retainedEvidenceBytes,
      heapGrowth: peak - before,
    };
  } finally {
    clearInterval(sampler);
    await session.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function runLargeScenarioInFreshProcess() {
  const probe = [
    `import { runScenario } from ${JSON.stringify(import.meta.url)};`,
    'console.log(JSON.stringify(await runScenario("large")));',
  ].join("\n");
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--v8-flags=--expose-gc",
      "--allow-read=.,/usr,/bin," + Deno.execPath(),
      "--allow-run",
      "--allow-write",
      "--allow-env=PATH,NODE_V8_COVERAGE",
      probe,
    ],
    cwd: Deno.cwd(),
    clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `heap probe failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return JSON.parse(new TextDecoder().decode(result.stdout).trim()) as Awaited<
    ReturnType<typeof runScenario>
  >;
}

Deno.test("model early notifications: >32 MiB before turn/start response completes with bounded custody", async () => {
  const run = await runLargeScenarioInFreshProcess();
  assert.ok(run.result.ok, JSON.stringify(run.result));
  if (!run.result.ok) return;
  assert.equal(run.result.value.outcome, "completed");
  assert.equal(run.result.value.candidate?.head, SHA3);
  assert.ok(run.observedChars > 38 * 1024 * 1024);
  assert.equal(run.result.value.actual.outputChars, run.observedChars);
  assert.equal(
    verifyMatrixReceiptV1(run.result.value, run.request, "sentinel-host"),
    true,
  );
  assert.ok(run.retainedEvidenceBytes < 4_000);
  assert.ok(run.heapGrowth < 32 * 1024 * 1024, `heap growth ${run.heapGrowth}`);
});

Deno.test("model early notifications: foreign terminal and output never authorize a candidate", async () => {
  const run = await runScenario("forged-only");
  assert.equal(run.result.ok, false, JSON.stringify(run.result));
  if (run.result.ok) return;
  assert.equal(run.result.error.kind, "unavailable");
  assert.equal(run.retainedEvidenceBytes, 0);
});

Deno.test("model early notifications: exact reroute after replayed terminal vetoes receipt", async () => {
  const run = await runScenario("late-reroute");
  assert.equal(run.result.ok, false, JSON.stringify(run.result));
  if (run.result.ok) return;
  assert.equal(run.result.error.kind, "unavailable");
  assert.equal(run.retainedEvidenceBytes, 0);
});

Deno.test("model early notifications: exhausted proof storage waits for the real terminal without interrupting", async () => {
  const run = await runScenario("evidence-overflow");
  assert.equal(run.result.ok, false, JSON.stringify(run.result));
  if (run.result.ok) return;
  assert.equal(run.result.error.kind, "unavailable");
  assert.equal(run.retainedEvidenceBytes, 0);
});
