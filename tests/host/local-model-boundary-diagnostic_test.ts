import assert from "node:assert/strict";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import type { CodexSessionV1 } from "../../src/repair/codex-transport.ts";
import {
  localCheckoutKey,
  LocalCheckoutModelPort,
  LocalSessionTracker,
  parseLocalModelDiagnosticV1,
} from "../../src/host/local.ts";
import { ScriptedSession } from "../repair/model-port-helpers.ts";
import { readModelBoundaryDiagnostic } from "../../src/repair/model-port-diagnostics.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { captureConsoleLog, modelRequest } from "./local-test-helpers.ts";
import { FakeClock } from "../repair/helpers.ts";
import { gitRun, T0, testGitEnv } from "../state/helpers.ts";
import {
  childLine,
  exited,
  launch,
  makeRig,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

const RAW_MARKER = "sentinel-synthetic-private-error-marker";

class ScriptedTracker extends LocalSessionTracker {
  constructor(private readonly scripted: CodexSessionV1) {
    super();
  }

  override open<Session extends CodexSessionV1>(
    _factory: () => Session,
  ): Session {
    return super.open(() => this.scripted) as Session;
  }
}

async function localCase(
  errorInfo: unknown,
  options: { provider?: string; unsettled?: boolean; lateReroute?: boolean } =
    {},
) {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: ".", prefix: "sentinel-boundary-" }),
  );
  const source = `${root}/source`;
  await Deno.mkdir(source);
  const env = testGitEnv(`${root}/git-home`);
  for (
    const args of [["init", "-q"], ["config", "user.name", "test"], [
      "config",
      "user.email",
      "test@example.invalid",
    ]]
  ) {
    const result = await gitRun(source, args, env);
    assert.equal(result.ok, true, result.stderr);
  }
  await Deno.writeTextFile(`${source}/app.ts`, "export const value = 1;\n");
  assert.equal((await gitRun(source, ["add", "."], env)).ok, true);
  assert.equal((await gitRun(source, ["commit", "-qm", "base"], env)).ok, true);
  const base = (await gitRun(source, ["rev-parse", "HEAD"], env)).stdout
    .trim() as GitSha;
  const session = new ScriptedSession(
    {
      thread: { id: "thread-1" },
      model: "gpt-reserve",
      reasoningEffort: "max",
      modelProvider: options.provider ?? "uos",
      activePermissionProfile: { id: "sentinel-local" },
    },
    { turn: { id: "turn-1" } },
    [{
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "failed",
          durationMs: 123_422,
          error: {
            message: RAW_MARKER,
            additionalDetails: `https://example.invalid/${RAW_MARKER}`,
            codexErrorInfo: errorInfo,
          },
        },
      },
    }],
    undefined,
    options.lateReroute
      ? (emit) => {
        emit("model/rerouted", {
          threadId: "thread-1",
          turnId: "turn-1",
          fromModel: "gpt-reserve",
          toModel: "unapproved-model",
          reason: "synthetic",
        });
      }
      : undefined,
  );
  if (options.unsettled) Object.assign(session, { isSettled: () => false });
  const request = { ...modelRequest(), base };
  const tracker = new ScriptedTracker(session);
  const port = new LocalCheckoutModelPort({
    stateRoot: `${root}/state`,
    sourcePath: source,
    scratch: `${root}/scratch`,
    trustedPath: "/usr/bin:/bin",
    codexExecutable: "/nonexistent/sentinel-test-codex",
    denoExecutable: Deno.execPath(),
    modelToken: "synthetic-test-token",
    tracker,
    clock: new FakeClock(T0),
  });
  return { root, request, port, session, tracker };
}

Deno.test("model boundary: closed error reaches real local private result and hosted advisory", async () => {
  const ctx = await localCase({
    responseStreamDisconnected: { httpStatusCode: 502 },
  });
  const captured = captureConsoleLog();
  const rig = await makeRig();
  try {
    const result = await ctx.port.runModel(ctx.request);
    assert.ok(result.ok, result.ok ? "" : result.error.detail);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.value.outcome, "failed");
    assert.equal(result.value.candidate, null);
    assert.equal(ctx.session.closeCalls, 1);
    const nativeText = JSON.stringify(result.value);
    assert.equal(Object.hasOwn(result.value, "boundaryDiagnostic"), false);
    const key = await localCheckoutKey(ctx.request.taskId);
    const resultDir = `${ctx.root}/state/model-results/${key}`;
    const files = Array.fromAsync(Deno.readDir(resultDir));
    const [file] = await files;
    assert.ok(file !== undefined);
    const privateText = await Deno.readTextFile(`${resultDir}/${file.name}`);
    const written = JSON.parse(privateText);
    assert.equal(
      written.boundaryDiagnostic?.errorCode,
      "model_response_stream_disconnected",
    );
    assert.equal(written.boundaryDiagnostic?.httpStatusCode, 502);
    assert.equal(written.boundaryDiagnostic?.interruptCause, "none");
    assert.equal(privateText.includes(RAW_MARKER), false);
    const diagnostic = parseLocalModelDiagnosticV1(
      JSON.parse(captured.lines[0]),
    );
    assert.ok(diagnostic !== null);
    assert.equal(diagnostic.reasonCode, "model_response_stream_disconnected");
    await seedRelease(rig);
    rig.process.child = exited(
      `${captured.lines[0]}\n${childLine(rig.execution)}\n`,
    );
    const hosted = await launch(rig);
    assert.equal(hosted.status, "healthy");
    assert.equal(
      hosted.diagnostics[0]?.diagnostic.reasonCode,
      "model_response_stream_disconnected",
    );
    assert.equal(
      JSON.stringify(hosted.diagnostics).includes(RAW_MARKER),
      false,
    );
    assert.equal(JSON.stringify(result.value), nativeText);
  } finally {
    captured.restore();
    await ctx.tracker.settleAll();
    await Deno.remove(ctx.root, { recursive: true });
    await rig.cleanup();
  }
});

Deno.test("model boundary: unknown malformed and message-only errors stay closed and redacted", async () => {
  const cases = [
    undefined,
    null,
    "futureError",
    { responseStreamDisconnected: "private" },
    { responseStreamDisconnected: { httpStatusCode: RAW_MARKER } },
    { responseStreamDisconnected: { httpStatusCode: -1 } },
    { responseStreamDisconnected: {}, httpConnectionFailed: {} },
  ];
  for (const errorInfo of cases) {
    const ctx = await localCase(errorInfo);
    const captured = captureConsoleLog();
    try {
      const result = await ctx.port.runModel(ctx.request);
      assert.ok(result.ok, result.ok ? "" : result.error.detail);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.value.outcome, "failed");
      assert.equal(result.value.error, RAW_MARKER);
      const diagnostic = parseLocalModelDiagnosticV1(
        JSON.parse(captured.lines[0]),
      );
      assert.ok(diagnostic !== null);
      assert.equal(diagnostic.reasonCode, "model_unknown");
      assert.equal(diagnostic.boundaryDiagnostic?.httpStatusCode, null);
      assert.equal(JSON.stringify(diagnostic).includes(RAW_MARKER), false);
      assert.equal(
        parseLocalModelDiagnosticV1({
          ...diagnostic,
          boundaryDiagnostic: {
            ...diagnostic.boundaryDiagnostic,
            raw: RAW_MARKER,
          },
        }),
        null,
      );
    } finally {
      captured.restore();
      await ctx.tracker.settleAll();
      await Deno.remove(ctx.root, { recursive: true });
    }
  }
});

Deno.test("model boundary: receipt side channel rejects clones other attempts and changed identity", async () => {
  const ctx = await localCase("unauthorized");
  const captured = captureConsoleLog();
  try {
    const result = await ctx.port.runModel(ctx.request);
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(
      readModelBoundaryDiagnostic(result.value, ctx.request)?.errorCode,
      "model_unauthorized",
    );
    assert.equal(
      readModelBoundaryDiagnostic({ ...result.value }, ctx.request),
      null,
    );
    assert.equal(
      readModelBoundaryDiagnostic(
        JSON.parse(JSON.stringify(result.value)),
        ctx.request,
      ),
      null,
    );
    assert.equal(
      readModelBoundaryDiagnostic(result.value, {
        ...ctx.request,
        taskId: asWorkItemId("other-attempt"),
      }),
      null,
    );
    assert.equal(
      readModelBoundaryDiagnostic(result.value, {
        ...ctx.request,
        maxOutputChars: 1,
      }),
      null,
    );
    result.value.actual.threadId = "changed-thread";
    assert.equal(readModelBoundaryDiagnostic(result.value, ctx.request), null);
  } finally {
    captured.restore();
    await ctx.tracker.settleAll();
    await Deno.remove(ctx.root, { recursive: true });
  }
});

Deno.test("model boundary: unverified unsettled and late-rerouted sessions never attach diagnostics", async () => {
  for (
    const options of [{ provider: "wrong-provider" }, { unsettled: true }, {
      lateReroute: true,
    }]
  ) {
    const ctx = await localCase("unauthorized", options);
    const captured = captureConsoleLog();
    try {
      const result = await ctx.port.runModel(ctx.request);
      assert.equal(result.ok, false);
      const diagnostic = parseLocalModelDiagnosticV1(
        JSON.parse(captured.lines[0]),
      );
      assert.ok(diagnostic !== null);
      assert.equal(diagnostic.outcome, "port_error");
      assert.equal(Object.hasOwn(diagnostic, "boundaryDiagnostic"), false);
      if (!result.ok) assert.equal(result.error.kind, "unavailable");
    } finally {
      captured.restore();
      await ctx.tracker.settleAll();
      await Deno.remove(ctx.root, { recursive: true });
    }
  }
});

Deno.test("model boundary: advisory observer failure preserves native failed receipt and private result", async () => {
  const ctx = await localCase("unauthorized");
  const originalLog = console.log;
  try {
    console.log = () => {
      throw new Error(RAW_MARKER);
    };
    const result = await ctx.port.runModel(ctx.request);
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.value.outcome, "failed");
    assert.equal(result.value.error, RAW_MARKER);
    const key = await localCheckoutKey(ctx.request.taskId);
    const files = await Array.fromAsync(
      Deno.readDir(`${ctx.root}/state/model-results/${key}`),
    );
    const text = await Deno.readTextFile(
      `${ctx.root}/state/model-results/${key}/${files[0].name}`,
    );
    assert.equal(
      JSON.parse(text).boundaryDiagnostic.errorCode,
      "model_unauthorized",
    );
    assert.equal(text.includes(RAW_MARKER), false);
  } finally {
    console.log = originalLog;
    await ctx.tracker.settleAll();
    await Deno.remove(ctx.root, { recursive: true });
  }
});

Deno.test("model boundary: host duration and output interrupts carry independent declared causes", async () => {
  for (const cause of ["duration_limit", "output_limit"] as const) {
    const request = {
      ...modelRequest(),
      maxDurationMs: cause === "duration_limit" ? 5 : 5_000,
      maxOutputChars: cause === "output_limit" ? 10 : 400_000,
    };
    const session = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      cause === "output_limit"
        ? [{
          method: "item/agentMessage/delta",
          params: { delta: "x".repeat(100) },
        }]
        : [],
      "interrupted",
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: "/nonexistent/unused-failed-checkout",
      modelProvider: "sentinel-host",
      interruptSettlementGraceMs: 1,
    });
    const result = await port.runModel(request);
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.value.outcome, "interrupted");
    const diagnostic = readModelBoundaryDiagnostic(result.value, request);
    assert.equal(diagnostic?.interruptCause, cause);
    assert.equal(diagnostic?.maxDurationMs, request.maxDurationMs);
    assert.equal(diagnostic?.maxOutputChars, request.maxOutputChars);
    assert.equal(diagnostic?.interruptSettlementGraceMs, 1);
    assert.equal(diagnostic?.errorCode, "model_unknown");
    assert.equal(result.value.actual.observedTerminalStatus, "interrupted");
    assert.equal(Object.hasOwn(result.value, "boundaryDiagnostic"), false);
  }
});
