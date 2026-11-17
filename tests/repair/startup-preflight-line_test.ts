/**
 * The startup preflight's failure reason reaches the hosted job log only as
 * its text-free line: the launcher's advisory scan re-emits the strictly
 * re-parsed closed line and never the preflight's bounded error text, a path
 * or a forged line; the child-status scan never counts it; the post-failure
 * `codex --version` check tells a missing, non-executable or failing
 * executable apart. Temporary scripts only; no Codex, model or network.
 */
import assert from "node:assert/strict";
import {
  checkCodexExecutable,
  preflightErrorCategory,
} from "../../src/host/actions-preflight.ts";
import { scanChildStatusRecords } from "../../src/host/hosted-runtime-status.ts";
import { CodexProtocolError } from "../../src/repair/codex-transport.ts";
import { scanStepLines } from "../../src/repair/step-line.ts";
import { parseStartupPreflightLine } from "../../src/repair/startup-preflight-line.ts";

const CLOSED = {
  kind: "sentinel_startup_preflight",
  pass: false,
  stage: "initialize",
  errorCode: "deadline",
  codex: "exited",
  exitCode: 1,
  elapsedMs: 20_113,
};

Deno.test("startup preflight line: only the closed failure line is re-emitted, rebuilt", () => {
  const free = JSON.stringify({
    kind: "sentinel_startup_preflight",
    pass: false,
    stage: "initialize",
    error: "codex session operation deadline exceeded at /home/runner/x",
  });
  const resolved = JSON.stringify({
    kind: "sentinel_startup_preflight",
    stage: "resolve_codex",
    codexExecutable: "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
  });
  const forged = [
    { ...CLOSED, error: "free text" },
    { ...CLOSED, path: "/home/runner" },
    { ...CLOSED, stage: "initialize: Missing optional dependency" },
    { ...CLOSED, errorCode: "Missing optional dependency" },
    { ...CLOSED, codex: "ok" },
    { ...CLOSED, exitCode: 0 },
    { ...CLOSED, exitCode: 256 },
    { ...CLOSED, exitCode: "1" },
    { ...CLOSED, elapsedMs: -1 },
    { ...CLOSED, elapsedMs: 1.5 },
    { ...CLOSED, pass: true },
    { ...CLOSED, status: "ran" },
    (({ exitCode: _code, ...rest }) => rest)(CLOSED),
  ].map((line) => JSON.stringify(line));
  const plain = { ...CLOSED, codex: "not_found" } as Record<string, unknown>;
  delete plain.exitCode;
  const stdout = [
    resolved,
    free,
    ...forged,
    JSON.stringify(CLOSED),
    JSON.stringify(plain),
    '{"kind":"sentinel_startup_preflight","pass":true}',
  ].join("\n");
  const lines = scanStepLines(stdout);
  assert.deepEqual(lines, [CLOSED, plain]);
  // What the launcher prints is the rebuilt object, never the child's bytes.
  const printed = lines.map((line) => JSON.stringify(line)).join("\n");
  for (
    const text of ['"error"', "runner", "codex.js", "Missing", "free", "status"]
  ) {
    assert.equal(printed.includes(text), false, text);
  }
  assert.equal(parseStartupPreflightLine(JSON.parse(free)), null);
});

Deno.test("startup preflight line: the child-status scan never counts it", () => {
  const record = '{"status":"ran","outcome":null}';
  const scan = scanChildStatusRecords(
    [JSON.stringify(CLOSED), record, JSON.stringify(CLOSED)].join("\n"),
  );
  assert.equal(scan.kind, "one");
  assert.equal(scanChildStatusRecords(JSON.stringify(CLOSED)).kind, "none");
});

Deno.test("startup preflight: the closed error category never reads the message", () => {
  const deadline = new CodexProtocolError("operation_deadline", "any text");
  const gone = new CodexProtocolError("child_exited_without_terminal", "x");
  assert.equal(preflightErrorCategory("initialize", deadline), "deadline");
  assert.equal(preflightErrorCategory("open", gone), "spawn_failed");
  assert.equal(preflightErrorCategory("initialize", gone), "child_exited");
  assert.equal(
    preflightErrorCategory(
      "initialize",
      new CodexProtocolError("server_error", ""),
    ),
    "server_error",
  );
  assert.equal(
    preflightErrorCategory("client", new Deno.errors.NotFound("a path")),
    "io",
  );
  assert.equal(
    preflightErrorCategory("client", new Error("deadline")),
    "other",
  );
});

Deno.test("startup preflight: the post-failure codex check tells a missing, non-executable or failing executable apart", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sentinel-codex-check-" });
  try {
    const path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    const script = async (name: string, body: string, mode: number) => {
      const file = `${dir}/${name}`;
      await Deno.writeTextFile(file, `#!/bin/sh\n${body}\n`);
      await Deno.chmod(file, mode);
      return file;
    };
    // A wrapper whose native binary is missing exits non-zero at once.
    const wrapper = await script("wrapper", "exit 1", 0o700);
    const healthy = await script("healthy", "exit 0", 0o700);
    const plain = await script("plain", "exit 0", 0o600);
    const hung = await script("hung", "exec sleep 30", 0o700);
    assert.deepEqual(await checkCodexExecutable(null, path), {
      codex: "not_run",
    });
    assert.deepEqual(await checkCodexExecutable(`${dir}/absent`, path), {
      codex: "not_found",
    });
    assert.deepEqual(await checkCodexExecutable(plain, path), {
      codex: "not_executable",
    });
    assert.deepEqual(await checkCodexExecutable(wrapper, path), {
      codex: "exited",
      exitCode: 1,
    });
    assert.deepEqual(await checkCodexExecutable(healthy, path), {
      codex: "ok",
    });
    assert.deepEqual(await checkCodexExecutable(hung, path, 100), {
      codex: "timed_out",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
