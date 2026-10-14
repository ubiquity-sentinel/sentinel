import assert from "node:assert/strict";
import type {
  CommandId,
  FixtureDigest,
  GitSha,
  WorkItemId,
} from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portOk, type ReplayRunRequestV1 } from "../../src/contracts/ports.ts";
import { SENTINEL_REPLAY_INPUT_PATH } from "../../src/replay/causal-verifier.ts";
import { computeReplayFixtureDigest } from "../../src/replay/fixture.ts";
import type { ResolvedFixtureV1 } from "../../src/replay/fixture.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import {
  commitWith,
  gitRun,
  revParse,
  testGitEnv,
  TOY_REPOSITORY,
  toyOptions,
} from "./helpers.ts";
import { text } from "./port-helpers.ts";

export const GATEWAY_INCIDENT = "provider-00000000-0000-4000-8000-0000000000aa";
export const GATEWAY_CAPTURE = "synthetic-capture-2";
export const GATEWAY_TEST_ID = "gateway:stream-termination";
export const GATEWAY_TEST_ID_B = "gateway:second-test";
export const GATEWAY_DIR =
  `tests/fixtures/gateway-replay/${GATEWAY_INCIDENT}/${GATEWAY_CAPTURE}`;
export const GATEWAY_REQUEST_PATH = `${GATEWAY_DIR}/request.json`;
export const GATEWAY_UPSTREAM_PATH = `${GATEWAY_DIR}/upstream.json`;

export const GATEWAY_REQUEST_TEXT = JSON.stringify({
  endpoint: "/v1/responses",
  method: "POST",
  contentType: "application/json",
  body: JSON.stringify({
    model: "synthetic-model",
    input: "hello",
    stream: true,
  }),
});

export const GATEWAY_UPSTREAM_TEXT = JSON.stringify({
  version: 1,
  attempts: [{
    provider: "chatgpt_codex",
    status: 200,
    content_type: "text/event-stream",
    chunks_base64: [btoa('data: {"type":"response.created"}\n\n')],
    terminal: "eof",
  }],
  attempts_truncated: false,
  bytes_truncated: false,
  chunks_truncated: false,
});

export const GATEWAY_DENO_JSON = JSON.stringify(
  {
    tasks: {
      replay: "deno run --allow-read=. scripts/replay.ts",
      test: "deno test --allow-read=. tests/",
    },
  },
  null,
  2,
) + "\n";

/** Independent expectation of the exact canonical dispatch metadata bytes. */
export function gatewayDispatchText(
  testIds: readonly string[] = [GATEWAY_TEST_ID],
): string {
  return canonicalStringify({
    version: "v1",
    requestPath: GATEWAY_REQUEST_PATH,
    upstreamPath: GATEWAY_UPSTREAM_PATH,
    testIds: [...testIds],
  });
}

/** Toy gateway handler: original 502s on an incomplete recorded stream. */
export function gatewayAppSource(kind: "original" | "fixed"): string {
  const outcome = kind === "original"
    ? `const completed = chunkText.includes('"type":"response.completed"') ||
    chunkText.includes("[DONE]");
  if (!completed) {
    return { status: 502, body: "stream terminated unexpectedly", completed: false };
  }`
    : `// CANDIDATE FIX: the recorded stream is complete without a separate
  // terminator; tolerate the missing completion event.`;
  return `/** Toy gateway stream handler (${kind}). */
export function handleStreamTrace(
  _request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean } {
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) => c.charCodeAt(0)),
  );
  ${outcome}
  return { status: 200, body: JSON.stringify({ payload: chunkText.slice(0, 80) }), completed: true };
}
`;
}

/**
 * Committed trusted consumer: it selects its inputs EXCLUSIVELY through the
 * fixed root dispatch metadata record and verifies that the record names the
 * exact expected request/upstream paths and the exact ordered trusted ids. A
 * missing, malformed or differently-selected dispatcher exits 3 (settled,
 * non-intended), so a missing dispatcher can never pass.
 */
export function gatewayConsumerSource(
  expectedIds: readonly string[] = [GATEWAY_TEST_ID],
): string {
  return `import { handleStreamTrace } from "../src/app.ts";
const expectedRequest = "${GATEWAY_REQUEST_PATH}";
const expectedUpstream = "${GATEWAY_UPSTREAM_PATH}";
const expectedIds = ${JSON.stringify(expectedIds)};
const dispatchBytes = await Deno.readFile("${SENTINEL_REPLAY_INPUT_PATH}");
if (dispatchBytes.byteLength > 16 * 1024) Deno.exit(3);
const dispatch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dispatchBytes));
if (dispatch.version !== "v1") Deno.exit(3);
if (Object.keys(dispatch).sort().join(",") !== "requestPath,testIds,upstreamPath,version") Deno.exit(3);
if (dispatch.requestPath !== expectedRequest) Deno.exit(3);
if (dispatch.upstreamPath !== expectedUpstream) Deno.exit(3);
if (JSON.stringify(dispatch.testIds) !== JSON.stringify(expectedIds)) Deno.exit(3);
const request = JSON.parse(await Deno.readTextFile(dispatch.requestPath));
const upstream = JSON.parse(await Deno.readTextFile(dispatch.upstreamPath));
const outcome = handleStreamTrace(request, upstream);
for (const id of expectedIds) console.log("sentinel-replay-test:" + id);
if (outcome.status === 502) {
  console.error("stream terminated unexpectedly");
  Deno.exit(1);
}
if (outcome.status === 200) Deno.exit(0);
console.error("unsupported outcome");
Deno.exit(2);
`;
}

/** Permanent regression test: the same dispatch-driven input selection. */
export function gatewayRegressionSource(
  expectedIds: readonly string[] = [GATEWAY_TEST_ID],
): string {
  return `import assert from "node:assert/strict";
import { handleStreamTrace } from "../src/app.ts";

Deno.test("gateway: recorded stream termination regression", async () => {
  const expectedRequest = "${GATEWAY_REQUEST_PATH}";
  const expectedUpstream = "${GATEWAY_UPSTREAM_PATH}";
  const dispatchBytes = await Deno.readFile("${SENTINEL_REPLAY_INPUT_PATH}");
  assert.ok(dispatchBytes.byteLength <= 16 * 1024);
  const dispatch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dispatchBytes));
  assert.equal(dispatch.version, "v1");
  assert.deepEqual(Object.keys(dispatch).sort(), ["requestPath", "testIds", "upstreamPath", "version"]);
  assert.equal(dispatch.requestPath, expectedRequest);
  assert.equal(dispatch.upstreamPath, expectedUpstream);
  assert.deepEqual(dispatch.testIds, ${JSON.stringify(expectedIds)});
  const request = JSON.parse(await Deno.readTextFile(dispatch.requestPath));
  const upstream = JSON.parse(await Deno.readTextFile(dispatch.upstreamPath));
  const outcome = handleStreamTrace(request, upstream);
  assert.equal(outcome.status, 200, "expected 200 but got " + outcome.status + ": " + outcome.body);
  for (const id of ${JSON.stringify(expectedIds)}) {
    console.log("sentinel-replay-test:" + id);
  }
});
`;
}

export interface GatewayToyV1 {
  root: string;
  env: Record<string, string>;
  originalSha: GitSha;
  cleanup(): Promise<void>;
}

export async function makeGatewayToy(
  root: string,
  expectedIds: readonly string[] = [GATEWAY_TEST_ID],
): Promise<GatewayToyV1> {
  await Deno.mkdir(root, { recursive: true });
  const env = testGitEnv(`${root}/home`);
  await Deno.mkdir(`${root}/home`, { recursive: true });
  const init = await gitRun(root, ["init", "-q", "-b", "main"], env);
  assert.ok(init.ok, `gateway toy init failed: ${init.stderr}`);
  await commitWith(root, env, {
    "deno.json": GATEWAY_DENO_JSON,
    "src/app.ts": gatewayAppSource("original"),
    "scripts/replay.ts": gatewayConsumerSource(expectedIds),
    "tests/regression_test.ts": gatewayRegressionSource(expectedIds),
  }, "gateway toy original: recorded stream termination produces 502");
  const originalSha = await revParse(root, env);
  return {
    root,
    env,
    originalSha,
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

export async function commitGatewayCandidate(
  toy: GatewayToyV1,
  extra: Record<string, string> = {},
): Promise<GitSha> {
  return await commitWith(toy.root, toy.env, {
    "src/app.ts": gatewayAppSource("fixed"),
    [GATEWAY_REQUEST_PATH]: GATEWAY_REQUEST_TEXT,
    [GATEWAY_UPSTREAM_PATH]: GATEWAY_UPSTREAM_TEXT,
    ...extra,
  }, "gateway toy candidate: fix + permanent recorded fixture");
}

export async function gatewayBundle(
  testIds: readonly string[] = [GATEWAY_TEST_ID],
  entries?: { path: string; bytes: Uint8Array }[],
): Promise<{ bundle: ResolvedFixtureV1; digest: FixtureDigest; ref: string }> {
  const bundleEntries = entries ?? [
    { path: GATEWAY_REQUEST_PATH, bytes: text.encode(GATEWAY_REQUEST_TEXT) },
    { path: GATEWAY_UPSTREAM_PATH, bytes: text.encode(GATEWAY_UPSTREAM_TEXT) },
  ];
  const digest = await computeReplayFixtureDigest(bundleEntries);
  const ref =
    `fixture://gateway-replay/${GATEWAY_INCIDENT}/${GATEWAY_CAPTURE}/${digest}`;
  const bundle: ResolvedFixtureV1 = {
    testIds: [...testIds],
    expectedFailure: {
      reason: "recorded stream termination produces 502",
      match: { kind: "contains", text: "stream terminated unexpectedly" },
    },
    entries: bundleEntries,
    provenance: {
      sanitized: true,
      sanitizer: "toy-sanitizer",
      provenanceRef: "fixture://provenance/toy/gateway",
      redacted: false,
      note: "synthetic recorded gateway fixture; no credentials",
    },
  };
  return { bundle, digest, ref };
}

export function gatewayPort(
  toyRoot: string,
  scratchDir: string,
  bundle: ResolvedFixtureV1,
): ReplayPortImpl {
  return new ReplayPortImpl({
    ...toyOptions(toyRoot, scratchDir),
    fixtures: { resolveFixture: () => Promise.resolve(portOk(bundle)) },
  });
}

export function gatewayRequest(
  bundle: ResolvedFixtureV1,
  ref: string,
  digest: FixtureDigest,
  revision: GitSha,
  overrides: Record<string, unknown> = {},
): ReplayRunRequestV1 {
  return {
    taskId: "incident:gateway-0001" as WorkItemId,
    repository: TOY_REPOSITORY,
    revision,
    commandId: "replay" as CommandId,
    fixtureRef: ref,
    fixtureDigest: digest,
    testIds: bundle.testIds,
    outputLimitBytes: 262_144,
    ...overrides,
  } as ReplayRunRequestV1;
}
