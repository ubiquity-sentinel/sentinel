import assert from "node:assert/strict";
import {
  localCheckoutKey,
  writeLocalModelResult,
} from "../../src/host/local.ts";
import type {
  ModelRunReceiptV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { LOOP_STOP_MARKER } from "../../src/repair/model-port.ts";
import { SHA1, SHA3, T0 } from "../state/helpers.ts";
import {
  captureConsoleLog,
  DUMMY_CHANGED_PATH,
  DUMMY_EVIDENCE_REF,
  DUMMY_INVOCATION,
  DUMMY_ISSUE_BODY,
  DUMMY_MODEL,
  DUMMY_PROVIDER,
  DUMMY_RAW_ERROR,
  DUMMY_REASONING,
  DUMMY_THREAD,
  DUMMY_TURN,
  modelRequest,
  receipt,
  SAFE_DIAGNOSTIC_KEYS,
} from "./local-test-helpers.ts";

Deno.test(
  "local model results: private projection is minimal, unique and mode 0600",
  async () => {
    const stateRoot = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-model-results-",
    });
    const captured = captureConsoleLog();
    try {
      const request = modelRequest();
      const first = await writeLocalModelResult(
        stateRoot,
        request,
        receipt(),
        T0,
      );
      const second = await writeLocalModelResult(
        stateRoot,
        request,
        receipt(),
        T0 + 1,
      );
      assert.notEqual(first, second, "every result keeps a unique filename");
      assert.equal((await Deno.stat(first)).isFile, true);
      assert.equal((await Deno.stat(second)).isFile, true);

      const text = await Deno.readTextFile(first);
      const written = JSON.parse(text) as Record<string, unknown>;
      assert.equal(written.version, "v1");
      assert.equal(written.kind, "local_model_result");
      assert.equal(written.taskId, "issue-42");
      assert.equal(written.base, SHA1);
      assert.deepEqual(written.requested, {
        model: "gpt-reserve",
        reasoning: "max",
        maxDurationMs: 1_200_000,
        maxOutputChars: 400_000,
      });
      assert.equal(written.observedAt, T0);
      assert.equal(written.reason, null);
      assert.deepEqual(written.result, {
        ok: true,
        outcome: "completed",
        actual: {
          provider: "sentinel-host",
          threadId: "thread-1",
          turnId: "turn-1",
          terminalOrigin: "runtime",
          observedTerminalStatus: "completed",
          observedModel: "gpt-reserve",
          observedReasoning: "max",
          durationMs: 1_234,
          outputChars: 100,
        },
        candidate: { head: SHA3, changedPathCount: 1 },
      });

      // The explicit allow-list never serializes request/result payloads,
      // changed paths, raw errors, invocation identity or credentials.
      for (
        const marker of [
          DUMMY_ISSUE_BODY,
          DUMMY_EVIDENCE_REF,
          DUMMY_CHANGED_PATH,
          DUMMY_INVOCATION,
          "dummy-token",
          "checkpointSha",
        ]
      ) {
        assert.equal(
          text.includes(marker),
          false,
          `private projection never serializes ${marker}`,
        );
      }

      // 0600 file, 0700 directories.
      assert.equal((await Deno.stat(first)).mode! & 0o777, 0o600);
      assert.equal((await Deno.stat(second)).mode! & 0o777, 0o600);
      assert.equal(
        (await Deno.stat(`${stateRoot}/model-results`)).mode! & 0o777,
        0o700,
      );
      const key = await localCheckoutKey("issue-42");
      assert.equal(
        (await Deno.stat(`${stateRoot}/model-results/${key}`)).mode! & 0o777,
        0o700,
      );

      // output_limit wins when the actual output exceeds the request bound.
      const limited = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outputChars: 400_001 }),
        T0,
      );
      assert.equal(
        (JSON.parse(await Deno.readTextFile(limited)) as Record<
          string,
          unknown
        >)
          .reason,
        "output_limit",
      );

      // The exact loop-stop marker keeps its own classification.
      const loop = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outcome: "failed", error: LOOP_STOP_MARKER }),
        T0,
      );
      assert.equal(
        (JSON.parse(await Deno.readTextFile(loop)) as Record<string, unknown>)
          .reason,
        "failed_command_loop",
      );

      // A host timeout preserves the observed null terminal status and the
      // raw receipt error is never serialized.
      const timeout = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({
          outcome: "failed",
          terminalOrigin: "host-timeout",
          observedTerminalStatus: null,
          error: DUMMY_RAW_ERROR,
          candidate: false,
        }),
        T0,
      );
      const timeoutText = await Deno.readTextFile(timeout);
      const timeoutWritten = JSON.parse(timeoutText) as Record<string, unknown>;
      assert.equal(timeoutWritten.reason, "host_timeout");
      assert.equal(
        ((timeoutWritten.result as Record<string, unknown>)
          .actual as Record<string, unknown>).observedTerminalStatus,
        null,
      );
      assert.equal(timeoutText.includes(DUMMY_RAW_ERROR), false);

      // Any other non-null receipt error is runtime_error.
      const failed = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outcome: "failed", error: DUMMY_RAW_ERROR }),
        T0,
      );
      const failedText = await Deno.readTextFile(failed);
      assert.equal(
        (JSON.parse(failedText) as Record<string, unknown>).reason,
        "runtime_error",
      );
      assert.equal(failedText.includes(DUMMY_RAW_ERROR), false);

      // A port-level error keeps only its error kind, never its raw detail.
      const unavailable: PortResultV1<ModelRunReceiptV1> = {
        ok: false,
        error: { kind: "unavailable", detail: DUMMY_RAW_ERROR },
      };
      const portFailureText = await Deno.readTextFile(
        await writeLocalModelResult(stateRoot, request, unavailable, T0),
      );
      const portFailure = JSON.parse(portFailureText) as Record<
        string,
        unknown
      >;
      assert.deepEqual(portFailure.result, {
        ok: false,
        errorKind: "unavailable",
      });
      assert.equal(portFailure.reason, "runtime_error");
      assert.equal(portFailureText.includes(DUMMY_RAW_ERROR), false);
    } finally {
      captured.restore();
      await Deno.remove(stateRoot, { recursive: true });
    }
  },
);

Deno.test(
  "local model results: the advisory summary is strict and never leaks private fields",
  async () => {
    const stateRoot = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-model-diagnostics-",
    });
    const captured = captureConsoleLog();
    try {
      const request = modelRequest();
      const taskKey = await localCheckoutKey(request.taskId);
      const summary = (): Record<string, unknown> => {
        const line = captured.lines[captured.lines.length - 1];
        assert.ok(line !== undefined, "expected one advisory summary line");
        const parsed = JSON.parse(line as string) as Record<string, unknown>;
        assert.deepEqual(Object.keys(parsed).sort(), SAFE_DIAGNOSTIC_KEYS);
        return parsed;
      };

      // A receipt failure saves the minimal private report and emits exactly one
      // advisory line carrying only the safe allow-list fields.
      const failedPath = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outcome: "failed", error: DUMMY_RAW_ERROR }),
        T0,
      );
      assert.equal(captured.lines.length, 1);
      assert.deepEqual(summary(), {
        version: "v1",
        kind: "sentinel_model_diagnostic",
        taskKey,
        base: SHA1,
        observedAt: T0,
        outcome: "failed",
        reason: "runtime_error",
        errorKind: null,
        terminalOrigin: "runtime",
        observedTerminalStatus: "completed",
        durationMs: 1_234,
        outputChars: 100,
        candidatePresent: true,
        reasonCode: null,
      });
      const failedPrivate = await Deno.readTextFile(failedPath);
      assert.equal(
        (JSON.parse(failedPrivate) as Record<string, unknown>).kind,
        "local_model_result",
      );
      assert.equal(failedPrivate.includes(DUMMY_RAW_ERROR), false);
      assert.equal((await Deno.stat(failedPath)).mode! & 0o777, 0o600);

      // The output bound and the exact loop marker keep their classifications.
      await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outcome: "failed", outputChars: 400_001 }),
        T0,
      );
      assert.equal(summary().reason, "output_limit");
      assert.equal(summary().outcome, "failed");
      await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outcome: "failed", error: LOOP_STOP_MARKER }),
        T0,
      );
      assert.equal(summary().reason, "failed_command_loop");

      // A host timeout preserves the observed null terminal status and the
      // absence of a candidate.
      await writeLocalModelResult(
        stateRoot,
        request,
        receipt({
          outcome: "failed",
          terminalOrigin: "host-timeout",
          observedTerminalStatus: null,
          error: DUMMY_RAW_ERROR,
          candidate: false,
        }),
        T0,
      );
      assert.deepEqual(summary(), {
        version: "v1",
        kind: "sentinel_model_diagnostic",
        taskKey,
        base: SHA1,
        observedAt: T0,
        outcome: "failed",
        reason: "host_timeout",
        errorKind: null,
        terminalOrigin: "host-timeout",
        observedTerminalStatus: null,
        durationMs: 1_234,
        outputChars: 100,
        candidatePresent: false,
        reasonCode: null,
      });

      // Arbitrary private receipt content (provider, thread/turn identity,
      // observed model/reasoning) never reaches the advisory line, while the
      // private report keeps that identity and still omits the raw error.
      const maliciousPath = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({
          provider: DUMMY_PROVIDER,
          threadId: DUMMY_THREAD,
          turnId: DUMMY_TURN,
          observedModel: DUMMY_MODEL,
          observedReasoning: DUMMY_REASONING,
          error: DUMMY_RAW_ERROR,
        }),
        T0,
      );
      const emittedText = JSON.stringify(summary());
      for (
        const marker of [
          DUMMY_PROVIDER,
          DUMMY_THREAD,
          DUMMY_TURN,
          DUMMY_MODEL,
          DUMMY_REASONING,
          DUMMY_RAW_ERROR,
          DUMMY_ISSUE_BODY,
          DUMMY_EVIDENCE_REF,
          DUMMY_CHANGED_PATH,
          DUMMY_INVOCATION,
          SHA3,
          "checkpointSha",
        ]
      ) {
        assert.equal(
          emittedText.includes(marker),
          false,
          `advisory summary never carries ${marker}`,
        );
      }
      assert.equal(summary().candidatePresent, true);
      const maliciousPrivate = await Deno.readTextFile(maliciousPath);
      for (
        const marker of [
          DUMMY_PROVIDER,
          DUMMY_THREAD,
          DUMMY_TURN,
          DUMMY_MODEL,
          DUMMY_REASONING,
        ]
      ) {
        assert.equal(
          maliciousPrivate.includes(marker),
          true,
          `private report keeps ${marker}`,
        );
      }
      assert.equal(
        maliciousPrivate.includes(DUMMY_RAW_ERROR),
        false,
        "the private report never keeps the raw error",
      );

      // A typed port error keeps only its kind, with a null terminal and
      // counters, and its private report is still saved.
      const portFailure: PortResultV1<ModelRunReceiptV1> = {
        ok: false,
        error: { kind: "unavailable", detail: DUMMY_RAW_ERROR },
      };
      const portPath = await writeLocalModelResult(
        stateRoot,
        request,
        portFailure,
        T0,
      );
      assert.deepEqual(summary(), {
        version: "v1",
        kind: "sentinel_model_diagnostic",
        taskKey,
        base: SHA1,
        observedAt: T0,
        outcome: "port_error",
        reason: "runtime_error",
        errorKind: "unavailable",
        terminalOrigin: null,
        observedTerminalStatus: null,
        durationMs: null,
        outputChars: null,
        candidatePresent: false,
        // DUMMY_RAW_ERROR is not one of our own static strings, so the raw text
        // must map to null rather than becoming a code.
        reasonCode: null,
      });
      assert.equal(
        (await Deno.readTextFile(portPath)).includes(DUMMY_RAW_ERROR),
        false,
        "the private port-error report never keeps the raw error",
      );

      // Malformed counters or enums suppress only the advisory summary; the
      // private 0600 report is still saved unchanged.
      const before = captured.lines.length;
      for (
        const mutate of [
          (actual: Record<string, unknown>) => {
            actual.durationMs = -1;
          },
          (actual: Record<string, unknown>) => {
            actual.outputChars = 1.5;
          },
          (actual: Record<string, unknown>) => {
            actual.terminalOrigin = "made-up";
          },
          (actual: Record<string, unknown>) => {
            actual.observedTerminalStatus = "unknown";
          },
        ]
      ) {
        const broken = receipt();
        assert.equal(broken.ok, true);
        if (!broken.ok) throw new Error("unreachable");
        mutate(broken.value.actual as unknown as Record<string, unknown>);
        const brokenPath = await writeLocalModelResult(
          stateRoot,
          request,
          broken,
          T0,
        );
        assert.equal(
          captured.lines.length,
          before,
          "an invalid projection emits no summary",
        );
        assert.equal((await Deno.stat(brokenPath)).isFile, true);
        assert.equal((await Deno.stat(brokenPath)).mode! & 0o777, 0o600);
        assert.equal(
          (JSON.parse(await Deno.readTextFile(brokenPath)) as Record<
            string,
            unknown
          >).kind,
          "local_model_result",
        );
      }
    } finally {
      captured.restore();
      await Deno.remove(stateRoot, { recursive: true });
    }
  },
);
