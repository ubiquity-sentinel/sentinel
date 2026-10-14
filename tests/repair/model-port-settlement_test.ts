/** Cohesive settlement cases for the unchanged model-port facade. */
import assert from "node:assert/strict";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { gitRun, SHA3, testGitEnv } from "../state/helpers.ts";
import {
  CHECKOUT,
  runtimeRequest,
  ScriptedSession,
} from "./model-port-helpers.ts";

Deno.test(
  "model-port: host timeout retains failed accounting with explicit terminal origin, never an observed terminal",
  async () => {
    // The bounded host timeout elapses before any runtime terminal: the run
    // is failed ACCOUNTING with the exact identities and the `host-timeout`
    // origin; the observed terminal status is never fabricated.
    const session = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [],
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      interruptSettlementGraceMs: 20,
    });
    const result = await port.runModel({
      ...runtimeRequest(),
      maxDurationMs: 40,
    });
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "failed");
    assert.equal(result.value.candidate, null);
    assert.equal(
      result.value.error,
      "host timeout without terminal settlement",
    );
    assert.equal(result.value.actual.terminalOrigin, "host-timeout");
    assert.equal(result.value.actual.evidenceKind, "request-runtime");
    assert.equal(result.value.actual.provider, "sentinel-host");
    assert.equal(result.value.actual.threadId, "thread-1");
    assert.equal(result.value.actual.turnId, "turn-1");
    assert.equal(result.value.actual.observedModel, "gpt-reserve");
    assert.equal(result.value.actual.observedReasoning, "max");
    assert.equal(
      result.value.actual.observedTerminalStatus,
      null,
      "a host timeout never claims an observed terminal status",
    );
    assert.equal(session.closeCalls, 1);
  },
);

Deno.test(
  "model-port: a custom verifier never enables a missing model provider",
  async () => {
    // Without an explicit modelProvider the port stays unavailable and no
    // session opens — a callback cannot enable a missing provider.
    for (
      const verifier of [
        undefined,
        () => ({
          provider: "sentinel-host",
          observedModel: "gpt-reserve",
          observedReasoning: "max",
        }),
      ]
    ) {
      let opened = 0;
      const port = new CodexImplementationPort({
        openSession: () => {
          opened++;
          throw new Error("no session may open without an explicit provider");
        },
        checkoutDir: CHECKOUT,
        receiptVerifier: verifier,
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable");
        assert.equal(
          result.error.detail,
          "model receipt unavailable: actual provider model/effort could not be verified at this boundary",
        );
      }
      assert.equal(opened, 0);
    }
  },
);

Deno.test(
  "model-port: an invalid model provider stays unavailable before any session opens",
  async () => {
    for (const provider of ["", "  ", "provider\nname"]) {
      let opened = 0;
      const port = new CodexImplementationPort({
        openSession: () => {
          opened++;
          throw new Error("no session may open with an invalid provider");
        },
        checkoutDir: CHECKOUT,
        modelProvider: provider,
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable");
        assert.equal(
          result.error.detail,
          "model receipt unavailable: configured provider is not a nonempty finite string",
        );
      }
      assert.equal(opened, 0);
    }
  },
);

Deno.test(
  "model-port: loop-stop race preserves the runtime terminal and permits only interrupted no-candidate accounting with the concrete verifier",
  async () => {
    // EXACT correction race: the loop guard owns the stop (steer rejected,
    // early interrupt requested) while the runtime terminal already completed
    // — before the host can return interrupted. The run uses `modelProvider`
    // with the CONCRETE default request/runtime verifier (no injected
    // permissive verifier): the completed terminal is preserved as runtime
    // evidence, no successful output exists, and only interrupted/
    // no-candidate accounting with the sanitized loop-stop marker is allowed.
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "model-port-race-", dir: Deno.cwd() }),
    );
    const home = `${root}/home`;
    await Deno.mkdir(home);
    const env = testGitEnv(home);
    const run = (args: string[]) => gitRun(root, args, env);
    try {
      assert.ok((await run(["init", "-q"])).ok);
      assert.ok(
        (await run(["commit", "-q", "--allow-empty", "-m", "seed"])).ok,
      );
      await Deno.writeTextFile(`${root}/app.ts`, "export const a = 1;\n");
      const failedCommand = {
        type: "commandExecution",
        command: "deno check app.ts",
        cwd: root,
        status: "failed",
        aggregatedOutput: "error: Type checking failed",
        exitCode: 1,
      };
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-reserve",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [
          {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: { ...failedCommand, id: "c1", status: "inProgress" },
            },
          },
          ...[1, 2, 3, 4].map((index) => ({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: { ...failedCommand, id: `c${index}` },
            },
          })),
        ],
        "completed",
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: root,
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
      assert.ok(result.ok, JSON.stringify(result));
      if (!result.ok) return;
      assert.equal(
        result.value.outcome,
        "interrupted",
        "the host-stopped run never produces success accounting",
      );
      assert.equal(result.value.error, "failed_command_loop");
      assert.equal(result.value.candidate, null);
      assert.equal(result.value.actual.evidenceKind, "request-runtime");
      assert.equal(result.value.actual.provider, "sentinel-host");
      assert.equal(result.value.actual.threadId, "thread-1");
      assert.equal(result.value.actual.turnId, "turn-1");
      assert.equal(
        result.value.actual.terminalOrigin,
        "runtime",
        "the actually observed completed runtime terminal is preserved",
      );
      assert.equal(
        result.value.actual.observedTerminalStatus,
        "completed",
        "the completed runtime terminal status survives the own loop stop",
      );
      assert.equal(session.closeCalls, 1);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "model-port: empty/over-bound terminal identities fail closed before the stale comparison; valid bounded unrelated ids stay ignored",
  async () => {
    // Identity bounds are validated BEFORE identity comparison: a malformed
    // empty/over-bound thread or turn id is protocol uncertainty (unavailable)
    // even when unrelated, while a valid bounded unrelated identity is stale
    // and ignored (never protocol uncertainty).
    const cases: {
      label: string;
      params: Record<string, unknown>;
      detail: string;
    }[] = [
      {
        label: "empty thread id",
        params: { threadId: "", turn: { id: "turn-1", status: "completed" } },
        detail: "malformed terminal thread id",
      },
      {
        label: "over-bound unrelated thread id",
        params: {
          threadId: "t".repeat(257),
          turn: { id: "turn-1", status: "completed" },
        },
        detail: "malformed terminal thread id",
      },
      {
        label: "empty turn id",
        params: {
          threadId: "thread-1",
          turn: { id: "", status: "completed" },
        },
        detail: "malformed terminal turn id",
      },
      {
        label: "over-bound unrelated turn id",
        params: {
          threadId: "thread-2",
          turn: { id: "t".repeat(257), status: "completed" },
        },
        detail: "malformed terminal turn id",
      },
    ];
    for (const item of cases) {
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-reserve",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [{ method: "turn/completed", params: item.params }],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, `${item.label}: ${JSON.stringify(result)}`);
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable", item.label);
        assert.equal(result.error.detail, item.detail, item.label);
      }
      assert.equal(session.closeCalls, 1, item.label);
    }
    // Valid bounded UNRELATED thread and turn ids are stale, not malformed:
    // the event is ignored and the run settles as a host-timeout failed
    // receipt with the explicit origin and null observed status.
    const unrelated = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [{
        method: "turn/completed",
        params: {
          threadId: "thread-2",
          turn: { id: "turn-2", status: "completed" },
        },
      }],
    );
    const unrelatedPort = new CodexImplementationPort({
      openSession: () => Promise.resolve(unrelated),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      interruptSettlementGraceMs: 20,
    });
    const unrelatedResult = await unrelatedPort.runModel({
      ...runtimeRequest(),
      maxDurationMs: 40,
    });
    assert.ok(unrelatedResult.ok, JSON.stringify(unrelatedResult));
    if (unrelatedResult.ok) {
      assert.equal(unrelatedResult.value.outcome, "failed");
      assert.equal(
        unrelatedResult.value.error,
        "host timeout without terminal settlement",
      );
      assert.equal(unrelatedResult.value.actual.terminalOrigin, "host-timeout");
      assert.equal(unrelatedResult.value.actual.observedTerminalStatus, null);
    }
    assert.equal(unrelated.closeCalls, 1);
  },
);
