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
    assert.deepEqual(await checkCodexExecutable(hung, path, 100, 200), {
      codex: "timed_out",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A unique `sleep` argument, so the test finds exactly its own process. */
function sleeper(): string {
  return `4.${String(Math.floor(Math.random() * 1e9)).padStart(9, "1")}`;
}

/** True while a non-zombie process runs exactly `sleep <seconds>`. */
async function sleeping(seconds: string): Promise<boolean> {
  const listed = await new Deno.Command("ps", {
    args: ["-eo", "stat=,args="],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(listed.stdout).split("\n").some((line) => {
    const [stat, ...args] = line.trim().split(/\s+/);
    return stat !== undefined && !stat.startsWith("Z") &&
      args.join(" ") === `sleep ${seconds}`;
  });
}

/** Whether the process stays gone, polled within `ms`. */
async function goneWithin(seconds: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!(await sleeping(seconds))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await sleeping(seconds));
}

const LIMIT = 300;
const GRACE = 400;

/** One check of a temporary `#!/bin/sh` script, timed. */
async function checkScript(body: string): Promise<{
  result: Awaited<ReturnType<typeof checkCodexExecutable>>;
  elapsed: number;
}> {
  const dir = await Deno.makeTempDir({ prefix: "sentinel-codex-bound-" });
  try {
    const file = `${dir}/codex`;
    await Deno.writeTextFile(file, `#!/bin/sh\n${body}\n`);
    await Deno.chmod(file, 0o700);
    const path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    const started = performance.now();
    const result = await checkCodexExecutable(file, path, LIMIT, GRACE);
    return { result, elapsed: performance.now() - started };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("startup preflight: a TERM-trapping codex check returns within its limit and grace", async () => {
  // A wrapper that traps TERM and waits for its (hung) binary.
  const stubborn = sleeper();
  const { result, elapsed } = await checkScript(
    `trap '' TERM\nexec sleep ${stubborn}`,
  );
  assert.deepEqual(result, { codex: "timed_out" });
  // The whole addition to a failing preflight: the limit plus its grace.
  assert.ok(elapsed < LIMIT + GRACE + 300, `${elapsed} ms`);
  assert.equal(await goneWithin(stubborn, 1_000), true, "TERM-trapping child");
});

Deno.test("startup preflight: a timed-out codex check leaves no descendant behind", async () => {
  // A wrapper whose descendant ignores TERM and would outlive the wrapper.
  const orphan = sleeper();
  const { result, elapsed } = await checkScript(
    `/bin/sh -c 'trap "" TERM; exec sleep ${orphan}' &\nwait`,
  );
  assert.deepEqual(result, { codex: "timed_out" });
  assert.ok(elapsed < LIMIT + GRACE + 300, `${elapsed} ms`);
  assert.equal(await goneWithin(orphan, 1_000), true, "no leaked grandchild");
});

Deno.test("startup preflight: a codex check that exits in time leaves no descendant behind", async () => {
  const left = sleeper();
  const { result } = await checkScript(
    `/bin/sh -c 'trap "" TERM; exec sleep ${left}' &\nsleep 0.1\nexit 0`,
  );
  assert.deepEqual(result, { codex: "ok" });
  assert.equal(await goneWithin(left, 1_000), true, "no leftover after exit");
});
