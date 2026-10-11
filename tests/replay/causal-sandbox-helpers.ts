import assert from "node:assert/strict";
import type { RetainedGatewayCaptureV1 } from "../../src/adapters/gateway/decrypt.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GatewayCausalProofV1 } from "../../src/replay/causal-proof.ts";
import {
  CAUSAL_CONSUMER_PATH,
  GatewayLocalCausalVerifier,
} from "../../src/replay/causal-verifier.ts";
import type { GatewayCausalVerifierInputV1 } from "../../src/replay/causal-verifier.ts";
import { LinuxReplayIsolation } from "../../src/replay/isolation.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import { commitSymlink, commitWith, gitRun, testGitEnv } from "./helpers.ts";
import {
  dispatchPreamble,
  makeCapture,
  REQUEST_PATH,
  TEST_ID,
  UPSTREAM_PATH,
  verifierInput,
} from "./causal-verifier-helpers.ts";

export const darwinOnly = Deno.build.os !== "darwin";

/**
 * The REAL trusted consumer: it calls the actual toy handler with the actual
 * input from the fixed fixture paths and emits the EXACT supported safe
 * failure protocol — one `sentinel-replay-test:<id>` line, then the single
 * fixed `sentinel-causal-failure:stream terminated unexpectedly` line on
 * stdout with empty stderr, exit 1 — ONLY for the intended outcome (502,
 * incomplete, exact failure body). Status 200 prints only the test ids and
 * exits 0; every other outcome emits only a fixed "unsupported causal
 * outcome" diagnostic and exits 2. Raw outcome.body is never printed.
 */
export function causalConsumerSource(): string {
  return `import { handleStreamTrace } from "../src/app.ts";
${dispatchPreamble()}
const outcome = handleStreamTrace(request, upstream);
console.log("sentinel-replay-test:${TEST_ID}");
if (outcome.status === 502 && outcome.completed === false && outcome.body === "stream terminated unexpectedly") {
  console.log("sentinel-causal-failure:stream terminated unexpectedly");
  Deno.exit(1);
}
if (outcome.status === 200) Deno.exit(0);
console.error("sentinel-causal-failure:unsupported causal outcome");
Deno.exit(2);
`;
}

export function causalConsumerApp(): string {
  return `/** Toy gateway stream handler (original). */
export function handleStreamTrace(
  request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  const req = request as { body?: string };
  let input = "";
  try {
    const parsed = JSON.parse(req.body ?? "{}") as { input?: unknown };
    input = typeof parsed.input === "string" ? parsed.input : "";
  } catch {
    // malformed request body: treated as no input
  }
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) =>
      c.charCodeAt(0)
    ),
  );
  const completed = chunkText.includes('"type":"response.completed"') ||
    chunkText.includes("[DONE]");
  if (input.includes("PRIVATE-TRIGGER-4c9b1e27") || !completed) {
    return {
      status: 502,
      body: "stream terminated unexpectedly",
      completed: false,
      payload: "",
    };
  }
  return {
    status: 200,
    body: JSON.stringify({ payload: chunkText.slice(0, 80) }),
    completed: true,
    payload: chunkText.slice(0, 80),
  };
}
`;
}

/** One denied operation attempted by the consumer BEFORE any marker. If the
 * boundary is broken the operation succeeds and the consumer emits the
 * EXACT valid safe failure protocol so the verifier would prove it and the
 * negative test fails. */
export function denialConsumerSource(operation: string): string {
  return `${dispatchPreamble()}
${operation}
console.log("sentinel-replay-test:${TEST_ID}");
console.log("sentinel-causal-failure:stream terminated unexpectedly");
Deno.exit(1);
`;
}

/**
 * One attempted sibling snapshot/cache read with the FIXED denial protocol:
 * only an ACTUAL permission denial (Deno NotCapable/PermissionDenied, or the
 * equivalent OS denial) is the intended denial and exits 2 with a fixed
 * synthetic denial marker; a missing file or any other error exits 3 with a
 * different fixed marker so the negative test fails; a read that SUCCEEDS
 * emits the exact valid safe failure protocol (exit 1) so the verifier
 * returns a proof and the negative test fails. The attempting execution is
 * chosen by snapshot (derived from Deno.cwd(), never env), so a
 * sanitized->original attempt still lets the original run emit the valid
 * protocol first and the sanitized execution actually happens. The target is
 * derived from Deno.cwd() (never Deno.env): the sibling snapshot/cache of
 * the current run at the verifier's fixed task layout.
 */
export function siblingDenialConsumerSource(
  attemptInOriginal: boolean,
  siblingRelative: string,
): string {
  const attemptGuard = attemptInOriginal ? "inOriginal" : "!inOriginal";
  return `import { handleStreamTrace } from "../src/app.ts";
${dispatchPreamble()}
const inOriginal = Deno.cwd().endsWith("/original");
if (${attemptGuard}) {
  try {
    await Deno.readTextFile(Deno.cwd() + "/${siblingRelative}");
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable || error instanceof Deno.errors.PermissionDenied) {
      console.log("sentinel-causal-failure:denied");
      Deno.exit(2);
    }
    console.log("sentinel-causal-failure:unexpected-read-error");
    Deno.exit(3);
  }
  console.log("sentinel-replay-test:${TEST_ID}");
  console.log("sentinel-causal-failure:stream terminated unexpectedly");
  Deno.exit(1);
}
const outcome = handleStreamTrace(request, upstream);
console.log("sentinel-replay-test:${TEST_ID}");
if (outcome.status === 502 && outcome.completed === false && outcome.body === "stream terminated unexpectedly") {
  console.log("sentinel-causal-failure:stream terminated unexpectedly");
  Deno.exit(1);
}
if (outcome.status === 200) Deno.exit(0);
console.error("sentinel-causal-failure:unsupported causal outcome");
Deno.exit(2);
`;
}

export interface CausalToyV1 {
  root: string;
  env: Record<string, string>;
  sha: GitSha;
  cleanup(): Promise<void>;
}

/**
 * Real outside-of-snapshot module targets: VALID TS/JSON files that exist in
 * the SOURCE repo tree. When the boundary holds the import is denied; when a
 * boundary is broken the module loads and the consumer would print the
 * marker + intended failure, which the tests then reject (no proof).
 */
export async function outsideModuleTargets(root: string): Promise<void> {
  await Deno.writeTextFile(
    `${root}/outside.ts`,
    "export const forbidden = 1;\n",
  );
  await Deno.writeTextFile(
    `${root}/outside.json`,
    JSON.stringify({ forbidden: 1 }),
  );
  await Deno.mkdir(`${root}/outside`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/outside/app.ts`,
    "export const forbidden = 1;\n",
  );
}

export async function makeCausalRepo(
  prefix: string,
  consumerFor: (root: string) => string,
  extra: { "src/app.ts"?: string; symlinkSrc?: boolean } = {},
): Promise<CausalToyV1> {
  const root = await Deno.makeTempDir({
    prefix: `sentinel-causal-verifier-${prefix}-`,
    dir: Deno.cwd(),
  });
  const env = testGitEnv(`${root}/home`);
  await Deno.mkdir(`${root}/home`, { recursive: true });
  await outsideModuleTargets(root);
  const init = await gitRun(root, ["init", "-q", "-b", "main"], env);
  assert.ok(init.ok, `toy init failed: ${init.stderr}`);
  const files: Record<string, string> = {
    "deno.json": JSON.stringify(
      {
        tasks: {
          replay: "deno run --allow-read=tests/,src/ scripts/replay.ts",
          test: "deno test --allow-read=tests/,src/ tests/",
        },
      },
      null,
      2,
    ) + "\n",
    "scripts/replay.ts": consumerFor(root),
    "src/app.ts": extra["src/app.ts"] ?? causalConsumerApp(),
  };
  let sha = await commitWith(root, env, files, "toy original: causal consumer");
  if (extra.symlinkSrc) {
    // src/ becomes a gitlink symlink pointing at a REAL directory outside
    // the snapshot; the checkout reproduces the symlink (no test-process
    // symlink permission needed).
    sha = await commitSymlink(root, env, "src", `${root}/outside`);
  }
  return {
    root,
    env,
    sha,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

export function concreteVerifier(
  toy: CausalToyV1,
  scratchDir: string,
  runtime?: ReplayRuntimeV1,
): GatewayLocalCausalVerifier {
  return new GatewayLocalCausalVerifier({
    sourcePath: toy.root,
    scratchDir,
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: Deno.execPath(),
    maxDurationMs: 60_000,
    maxOutputBytes: 262_144,
    ...(runtime === undefined ? {} : { runtime }),
  });
}

export async function realVerify(
  toy: CausalToyV1,
  scratchDir: string,
  overrides: Partial<GatewayCausalVerifierInputV1> = {},
  runtime?: ReplayRuntimeV1,
): Promise<GatewayCausalProofV1 | null> {
  const verifier = concreteVerifier(toy, scratchDir, runtime);
  const input = await verifierInput({
    ...overrides,
    capture: {
      ...makeCapture(),
      gitSha: toy.sha,
      ...(overrides.capture ?? {}),
    },
  });
  return await verifier.verify(input);
}

export function completedUpstream(): RetainedGatewayCaptureV1["upstream"] {
  const chunk =
    'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n';
  return {
    version: 1,
    attempts: [{
      provider: "chatgpt_codex",
      status: 200,
      content_type: "text/event-stream",
      chunks_base64: [btoa(chunk)],
      terminal: "eof",
    }],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  };
}

export const linuxOnly = Deno.build.os !== "linux";

export interface LinuxIsolationRunRecord {
  input: ReplayCommandInputV1;
  access: "read-only" | "read-write";
  result: ReplayCommandResultV1;
}

/**
 * The REAL `LinuxReplayIsolation` wrapped so the ACTUAL runner invocations
 * are recorded. Every call is delegated to the concrete boundary, so no fake
 * isolation result can stand in for the real bubblewrap execution.
 */
export function recordingLinuxIsolation(scratchDir: string) {
  const real = new LinuxReplayIsolation(scratchDir);
  const runs: LinuxIsolationRunRecord[] = [];
  const isolation = {
    attestation: real.attestation,
    run: async (
      input: ReplayCommandInputV1,
      access: "read-only" | "read-write",
    ): Promise<ReplayCommandResultV1> => {
      const result = await real.run(input, access);
      runs.push({ input, access, result });
      return result;
    },
  };
  return { isolation, runs };
}
