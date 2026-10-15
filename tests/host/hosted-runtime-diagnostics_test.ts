/** Hosted hosted-runtime-diagnostics_test responsibility. */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portError } from "../../src/contracts/ports.ts";
import { HOSTED_RUNTIME_FAILED_DETAIL } from "../../src/host/hosted-runtime.ts";
import { emitLocalModelDiagnostic } from "../../src/host/local-model-diagnostic.ts";
import { parseLocalModelDiagnosticV1 } from "../../src/host/local.ts";
import { CodexProtocolError } from "../../src/repair/codex-transport.ts";
import { unavailableFor } from "../../src/repair/model-port-policy.ts";
import { captureConsoleLog, modelRequest } from "./local-test-helpers.ts";
import {
  childLine,
  diagnosticLine,
  exited,
  launch,
  makeRig,
  OBSERVED_BASE,
  runtimeDiagnosticLine,
  SAFE_DIAGNOSTIC,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

Deno.test("hosted runtime: advisory summaries are wrapper-stamped, bounded and never change health or terminal", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    const safe = diagnosticLine();

    // One valid child summary beside a healthy child record: the summary is
    // copied only through the strict allow-list and stamped with the exact
    // verified launch execution.
    rig.process.child = exited(`${safe}\n${healthy}\n`);
    let result = await launch(rig);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal?.outcome, "healthy");
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
    assert.equal(result.diagnostics.length, 1);
    const advisory = result.diagnostics[0];
    assert.ok(advisory !== undefined);
    if (advisory === undefined) throw new Error("unreachable");
    assert.deepEqual(Object.keys(advisory).sort(), [
      "advisory",
      "diagnostic",
      "execution",
      "kind",
      "version",
    ]);
    assert.equal(advisory.version, "v1");
    assert.equal(advisory.kind, "hosted_model_diagnostic");
    assert.equal(advisory.advisory, true);
    assert.equal(
      canonicalStringify(advisory.execution),
      canonicalStringify(rig.execution),
    );
    assert.deepEqual(advisory.diagnostic, SAFE_DIAGNOSTIC);
    const serialized = JSON.stringify(result.diagnostics);
    for (
      const marker of [
        "local_model_result",
        "sentinel_model_result",
        "provider",
        "threadId",
        "turnId",
        "errorDetail",
        "observedModel",
        "invocationId",
        'errorKind":"unavailable',
      ]
    ) {
      assert.equal(serialized.includes(marker), false, marker);
    }

    // A settled nonzero exit keeps its existing failed terminal and still
    // carries the advisory; the advisory never rewrites the failure.
    rig.process.child = exited(`${safe}\n`, 3);
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.outcome, "failed");
    assert.equal(result.terminal?.startupReady, false);
    assert.equal(result.terminal?.baseSha, null);
    assert.equal(result.diagnostics.length, 1);

    // A settled timeout beside a valid child record is unchanged and keeps its
    // observed startup flag and base while the advisory is still attached.
    rig.process.child = exited(
      `${safe}\n${
        childLine(rig.execution, {
          outcome: { status: "source_error", detail: "source unavailable" },
        })
      }\n`,
      0,
      { outcome: "timed_out", exitCode: null, settled: true },
    );
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
    assert.equal(result.diagnostics.length, 1);

    // Absent diagnostics keep the bounded empty default.
    rig.process.child = exited(`${healthy}\n`);
    result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.deepEqual(result.diagnostics, []);

    // The accepted list is bounded at 64 summaries.
    rig.process.child = exited(
      `${Array.from({ length: 70 }, () => safe).join("\n")}\n${healthy}\n`,
    );
    result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.equal(result.diagnostics.length, 64);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: early child failure diagnostic is sanitized, bounded and advisory", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const fakeSecret = "sentinel-fake-secret-7c1d9f42ab";
    const hostile = [
      "error: Uncaught (in promise) Error: fixture abort",
      "    at main (file:///home/runner/work/sentinel/src/host/hosted-runtime.ts:42:7)",
      "    at async file:///home/runner/work/sentinel/src/repair/loop.ts:9:3",
      // Code-owned basenames added after the 2026-10-10 uncaught repair
      // failure: the innermost throw site must survive, not just the host path.
      "    at async file:///home/runner/work/sentinel/src/repair/transitions.ts:5:7",
      "    at async file:///home/runner/work/sentinel/src/repair/attempt-policy.ts:9:11",
      // A basename that is not code-owned is still dropped entirely.
      "    at async file:///home/runner/work/sentinel/src/secret/not-ours.ts:1:1",
      // Credential-shaped and unknown labels inside real `at ` frame shapes
      // must never be emitted as frame labels.
      `    at ${fakeSecret}:11:12`,
      `    at ${fakeSecret}.ts:13:14`,
      `    at file:///private/${fakeSecret}.ts:15:16`,
      `    at https://example.invalid/private?token=${fakeSecret}:17:18`,
      `Authorization: Bearer ${fakeSecret}`,
      `https://operator-marker-zz:${fakeSecret}@example.invalid/private?token=${fakeSecret}`,
      `SENTINEL_SUPERVISOR_TOKEN=${fakeSecret}`,
    ].join("\n") + "\n";
    const stderr = new TextEncoder().encode(hostile);
    const forbidden = [
      fakeSecret,
      `${fakeSecret}.ts`,
      "private?token",
      "Bearer",
      "Authorization",
      "example.invalid",
      "/home/runner",
      "operator-marker-zz",
      "SENTINEL_SUPERVISOR_TOKEN",
    ];

    // The genuine early-abort path: a settled nonzero exit with no status
    // record keeps its existing failed terminal and gains only the sanitized
    // advisory summary.
    rig.process.child = exited("", 7, { stderr });
    let result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.outcome, "failed");
    assert.equal(result.terminal?.startupReady, false);
    assert.equal(result.terminal?.baseSha, null);
    assert.equal(result.terminal?.settled, true);
    assert.equal(result.diagnostics.length, 0);
    const early = result.earlyFailure;
    assert.ok(early);
    assert.equal(early.kind, "hosted_runtime_early_failure");
    assert.equal(early.advisory, true);
    assert.equal(early.exitCode, 7);
    assert.equal(early.category, "uncaught");
    assert.deepEqual(early.frames, [
      "hosted-runtime.ts:42:7",
      "loop.ts:9:3",
      "transitions.ts:5:7",
      "attempt-policy.ts:9:11",
    ]);
    assert.equal(early.reasonCode, null);
    assert.equal(result.detail, HOSTED_RUNTIME_FAILED_DETAIL);
    const serialized = JSON.stringify(result);
    for (const marker of forbidden) {
      assert.equal(serialized.includes(marker), false, marker);
    }
    assert.ok(serialized.length < 4096, "the advisory stays bounded");

    // Arbitrary stderr text without a recognizable frame is never copied: only
    // the closed category survives.
    rig.process.child = exited("", 1, {
      stderr: new TextEncoder().encode(
        `error: Cannot find module 'x'\nSENTINEL_SUPERVISOR_TOKEN=${fakeSecret}\n`,
      ),
    });
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.earlyFailure?.category, "module_not_found");
    assert.deepEqual(result.earlyFailure?.frames, []);
    assert.equal(result.earlyFailure?.reasonCode, null);
    assert.equal(JSON.stringify(result).includes(fakeSecret), false);

    // A zero exit with no status record is unattestable: neither success nor
    // an early-abort advisory may be minted.
    rig.process.child = exited("", 0, { stderr });
    result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);
    assert.equal(result.earlyFailure, undefined);

    // An unsettled nonzero exit is uncertain: no terminal, no advisory.
    rig.process.child = exited("", 7, { stderr, settled: false });
    result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);
    assert.equal(result.earlyFailure, undefined);

    // A truncated capture is uncertain: no advisory either.
    rig.process.child = exited("", 7, { stderr, truncated: true });
    result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(result.earlyFailure, undefined);

    // A genuine child record beside a nonzero exit keeps its observed metadata:
    // the early-abort advisory never replaces a preserved child result.
    rig.process.child = exited(
      `${
        childLine(rig.execution, {
          outcome: { status: "source_error", detail: "source unavailable" },
        })
      }\n`,
      3,
      { stderr },
    );
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
    assert.equal(result.earlyFailure, undefined);

    // A healthy run never carries the advisory.
    rig.process.child = exited(`${childLine(rig.execution)}\n`, 0, { stderr });
    result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.equal(result.earlyFailure, undefined);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: ANSI-wrapped early diagnostics recover frames and known reason codes", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const ansi = (text: string) => `\u001b[31m${text}\u001b[0m`;
    const fakeSecret = "sentinel-fake-secret-7c1d9f42ab";

    // ANSI style sequences wrap the real abort line and its frames: the
    // stripped text must recover the closed category and code-owned frames,
    // and no control sequence may survive into the advisory.
    rig.process.child = exited("", 9, {
      stderr: new TextEncoder().encode(
        [
          ansi("error: Uncaught (in promise) Error: fixture abort"),
          ansi(
            "    at main (file:///home/runner/work/sentinel/src/host/hosted-runtime.ts:42:7)",
          ),
          ansi(
            "    at async file:///home/runner/work/sentinel/src/repair/loop.ts:9:3",
          ),
        ].join("\n") + "\n",
      ),
    });
    let result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.outcome, "failed");
    const early = result.earlyFailure;
    assert.ok(early);
    assert.equal(early.category, "uncaught");
    assert.deepEqual(early.frames, [
      "hosted-runtime.ts:42:7",
      "loop.ts:9:3",
    ]);
    assert.equal(early.reasonCode, null);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("\u001b"), false);
    assert.equal(serialized.includes("fixture abort"), false);
    assert.equal(serialized.includes("/home/runner"), false);

    // Exact known code-owned pre-status literals behind the real Deno
    // Error/TypeError/RangeError and literal-string prefixes map to their
    // closed codes; the raw message text is never copied.
    const known = [
      {
        stderr:
          "error: Uncaught (in promise) Error: hosted repair host sessions did not settle",
        code: "repair_sessions_unsettled",
        literal: "hosted repair host sessions did not settle",
      },
      {
        stderr:
          "error: Uncaught TypeError: hosted repair host could not resolve Codex",
        code: "repair_executable_unavailable",
        literal: "hosted repair host could not resolve Codex",
      },
      {
        stderr:
          "error: Uncaught RangeError: committed target setting lists no repository",
        code: "targets_empty",
        literal: "committed target setting lists no repository",
      },
      {
        stderr:
          'error: Uncaught (in promise) "local repair host git command failed; output withheld"',
        code: "local_git_command_failed",
        literal: "local repair host git command failed; output withheld",
      },
      {
        stderr:
          "error: Uncaught (in promise) Error: C recovery authoritative state unavailable",
        code: "c_recovery_state_unavailable",
        literal: "C recovery authoritative state unavailable",
      },
    ] as const;
    for (const { stderr, code, literal } of known) {
      rig.process.child = exited("", 7, {
        stderr: new TextEncoder().encode(`${ansi(stderr)}\n`),
      });
      result = await launch(rig);
      assert.equal(result.earlyFailure?.reasonCode, code, stderr);
      const text = JSON.stringify(result);
      assert.equal(text.includes(literal), false, literal);
      assert.equal(text.includes("\u001b"), false);
    }

    // Unknown secret-bearing Error and literal-string throws, URL/path labels
    // and near-miss known text stay null and fully redacted.
    for (
      const hostile of [
        `error: Uncaught (in promise) Error: failed at https://example.invalid/private?token=${fakeSecret}`,
        `error: Uncaught (in promise) "${fakeSecret} literal"`,
        `error: Uncaught (in promise) Error: ${fakeSecret}\n    at ${fakeSecret}.ts:1:2`,
        `error: Uncaught (in promise) Error: historical matrix custody unavailable (${fakeSecret})`,
      ]
    ) {
      rig.process.child = exited("", 7, {
        stderr: new TextEncoder().encode(`${hostile}\n`),
      });
      result = await launch(rig);
      assert.equal(result.earlyFailure?.reasonCode, null, hostile);
      const text = JSON.stringify(result);
      assert.equal(text.includes(fakeSecret), false);
      assert.equal(text.includes("example.invalid"), false);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: malformed, oversized, unknown-field or forged advisory inputs are ignored", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    const forgedWrapper = JSON.stringify({
      version: "v1",
      kind: "hosted_model_diagnostic",
      advisory: true,
      execution: rig.execution,
      diagnostic: JSON.parse(diagnosticLine()),
    });
    const oversized = diagnosticLine().replace("{", `{${" ".repeat(2_100)}`);
    assert.ok(oversized.length > 2_048);
    for (
      const bad of [
        '{"kind":"sentinel_model_diagnostic"}',
        diagnosticLine({ provider: "private-marker" }),
        diagnosticLine({ execution: rig.execution }),
        diagnosticLine({ kind: "model_diagnostic" }),
        diagnosticLine({ outcome: "port_error" }),
        diagnosticLine({ errorKind: "unavailable" }),
        diagnosticLine({ reason: "made_up" }),
        // reasonCode must be one of the runtime's own fixed literals, or null.
        // Arbitrary text, an unknown literal, a non-string, or a code on a
        // settled record are all refused, so no raw text can ever be echoed.
        diagnosticLine({ reasonCode: "raw-error-marker" }),
        diagnosticLine({ reasonCode: "made-up-code" }),
        diagnosticLine({ reasonCode: 7 }),
        oversized,
        forgedWrapper,
      ]
    ) {
      rig.process.child = exited(`${bad}\n${healthy}\n`);
      const result = await launch(rig);
      assert.equal(result.status, "healthy", bad.slice(0, 80));
      assert.equal(result.terminal?.outcome, "healthy", bad.slice(0, 80));
      assert.deepEqual(result.diagnostics, [], bad.slice(0, 80));
    }

    // A malformed object-looking line is never ignored beside a complete
    // record: the unchanged status scan refuses it as uncertain, so even a
    // following healthy record can never create terminal proof or an advisory.
    rig.process.child = exited(
      `{"kind":"sentinel_model_diagnostic","version":"v1"\n${healthy}\n`,
    );
    const malformed = await launch(rig);
    assert.equal(malformed.status, "unavailable");
    assert.equal(malformed.terminal, null);
    assert.deepEqual(malformed.diagnostics, []);

    // An unrecognized line alone never creates terminal proof or an advisory.
    rig.process.child = exited(`${diagnosticLine({ extra: "x" })}\n`, 0);
    const alone = await launch(rig);
    assert.equal(alone.status, "unavailable");
    assert.equal(alone.terminal, null);
    assert.deepEqual(alone.diagnostics, []);

    // Truncated, unsettled or unspawned captures yield no advisory at all and
    // cannot improve or create terminal proof.
    for (
      const run of [
        exited(`${diagnosticLine()}\n${healthy}\n`, 0, { truncated: true }),
        exited(`${diagnosticLine()}\n${healthy}\n`, 0, { settled: false }),
        exited(`${diagnosticLine()}\n`, 0, {
          outcome: "timed_out",
          exitCode: null,
          settled: false,
        }),
        exited(`${diagnosticLine()}\n`, 0, {
          outcome: "spawn_failed",
          exitCode: null,
        }),
      ]
    ) {
      rig.process.child = run;
      const result = await launch(rig);
      assert.equal(result.terminal, null, JSON.stringify(run));
      assert.deepEqual(result.diagnostics, [], JSON.stringify(run));
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: an installed-runtime advisory keeps its static reason code and refuses any other", async () => {
  // Decoder contract first: the installed pinned runtime emits the required
  // `reasonCode`, either one of its own static seam codes or null.
  const known = runtimeDiagnosticLine("model_checkout_unavailable");
  const knownParsed = parseLocalModelDiagnosticV1(JSON.parse(known));
  assert.deepEqual(knownParsed, JSON.parse(known), known);

  const nullCode = runtimeDiagnosticLine(null);
  const nullParsed = parseLocalModelDiagnosticV1(JSON.parse(nullCode));
  assert.deepEqual(nullParsed, JSON.parse(nullCode), nullCode);

  // A diagnostic missing its required static reason-code key is refused.
  const missingCode = JSON.parse(diagnosticLine());
  delete missingCode.reasonCode;
  assert.equal(parseLocalModelDiagnosticV1(missingCode), null);

  // Only the exact allow-listed static literals are codes: a raw error or provider
  // string, an unknown word, a near-miss code, an empty string and a code on
  // a settled record are all still refused.
  for (
    const refused of [
      runtimeDiagnosticLine("hosted-fixture-raw-error-marker"),
      runtimeDiagnosticLine("unavailable"),
      runtimeDiagnosticLine("model_checkout_unavailable_v2"),
      runtimeDiagnosticLine(""),
      diagnosticLine({ reasonCode: "model_checkout_unavailable" }),
      diagnosticLine({ reasonCode: "not_a_static_code" }),
      runtimeDiagnosticLine("model_checkout_unavailable").replace(
        '"errorKind":"unavailable"',
        '"errorKind":"made_up"',
      ),
      diagnosticLine({ reasonCode: null, candidatePresent: "true" }),
    ]
  ) {
    assert.equal(
      parseLocalModelDiagnosticV1(JSON.parse(refused)),
      null,
      refused,
    );
  }

  // One real launcher call: the known code survives into the stamped advisory
  // and health and terminal are unchanged.
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(`${known}\n${childLine(rig.execution)}\n`);
    const result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.equal(result.terminal?.outcome, "healthy");
    assert.equal(result.diagnostics.length, 1);
    assert.deepEqual(result.diagnostics[0]?.diagnostic, JSON.parse(known));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: emitted closed protocol codes survive the strict launcher without exposing messages", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const request = modelRequest();
    const raw =
      "Authorization: Bearer secret-fixture https://private.invalid/?key=secret-fixture";
    const emit = (detail: string): string => {
      const captured = captureConsoleLog();
      try {
        const result = portError("unavailable", detail);
        const original = structuredClone(result);
        emitLocalModelDiagnostic(
          request,
          result,
          rig.clock.now(),
          "c".repeat(64),
        );
        assert.deepEqual(
          result,
          original,
          "advisory emission preserves the port error",
        );
        assert.equal(captured.lines.length, 1);
        return captured.lines[0];
      } finally {
        captured.restore();
      }
    };
    const cases: [CodexProtocolError["detail"], string][] = [
      ["malformed_line", "codex_malformed_line"],
      ["unexpected_frame", "codex_unexpected_frame"],
      ["unknown_request_id", "codex_unknown_request_id"],
      ["server_error", "codex_server_error"],
      ["timeout_without_terminal", "codex_timeout_without_terminal"],
      ["child_exited_without_terminal", "codex_child_exited_without_terminal"],
      ["stream_output_bound_exceeded", "codex_stream_output_bound_exceeded"],
      ["operation_deadline", "codex_operation_deadline"],
    ];
    let lastLine = "";
    for (const [detail, code] of cases) {
      const failure = unavailableFor(new CodexProtocolError(detail, raw));
      assert.equal(failure.kind, "unavailable");
      assert.equal(failure.detail, detail);
      const line = emit(failure.detail);
      assert.equal(line.includes("secret-fixture"), false);
      assert.equal(JSON.parse(line).reasonCode, code);
      rig.process.child = exited(`${line}\n${childLine(rig.execution)}\n`);
      const result = await launch(rig);
      assert.equal(result.status, "healthy");
      assert.equal(result.terminal?.outcome, "healthy");
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0]?.diagnostic.reasonCode, code);
      assert.deepEqual(result.diagnostics[0]?.execution, rig.execution);
      assert.equal(result.diagnostics[0]?.diagnostic.errorKind, "unavailable");
      lastLine = line;
    }
    // Diagnostics do not turn an existing failed child into a success.
    rig.process.child = exited(`${lastLine}\n`, 3);
    const failed = await launch(rig);
    assert.equal(failed.status, "failed");
    assert.equal(failed.terminal?.outcome, "failed");
    assert.equal(
      failed.diagnostics[0]?.diagnostic.reasonCode,
      "codex_operation_deadline",
    );

    for (
      const detail of [
        raw,
        `server_error ${raw}`,
        `operation_deadline\n${raw}`,
        "unknown_protocol_detail",
        unavailableFor(new Error(raw)).detail,
      ]
    ) {
      const line = emit(detail);
      assert.equal(JSON.parse(line).reasonCode, null);
      assert.equal(line.includes("secret-fixture"), false);
      rig.process.child = exited(`${line}\n${childLine(rig.execution)}\n`);
      const result = await launch(rig);
      assert.equal(result.status, "healthy");
      assert.equal(result.diagnostics[0]?.diagnostic.reasonCode, null);
      assert.equal(
        JSON.stringify(result.diagnostics).includes("secret-fixture"),
        false,
      );
    }
    for (
      const forged of [
        raw,
        `codex_server_error ${raw}`,
        "codex_unknown_protocol_detail",
      ]
    ) {
      rig.process.child = exited(
        `${runtimeDiagnosticLine(forged)}\n${childLine(rig.execution)}\n`,
      );
      const result = await launch(rig);
      assert.equal(result.status, "healthy");
      assert.deepEqual(result.diagnostics, []);
    }
  } finally {
    await rig.cleanup();
  }
});
