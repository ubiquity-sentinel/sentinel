import type { RetainedGatewayCaptureV1 } from "../../src/adapters/gateway/decrypt.ts";
import { asEncryptedArtifactDigest } from "../../src/contracts/brands.ts";
import type {
  CommandId,
  FixtureDigest,
  GitSha,
} from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { GatewayCausalProofV1 } from "../../src/replay/causal-proof.ts";
import {
  CAUSAL_CONSUMER_PATH,
  GatewayLocalCausalVerifier,
  SENTINEL_REPLAY_INPUT_PATH,
} from "../../src/replay/causal-verifier.ts";
import type {
  GatewayCausalVerifierInputV1,
  GatewayLocalCausalVerifierOptionsV1,
} from "../../src/replay/causal-verifier.ts";
import { computeReplayFixtureDigest } from "../../src/replay/fixture.ts";
import type { ExpectedFailureV1 } from "../../src/replay/fixture.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import { TOY_REPOSITORY } from "./helpers.ts";

export const INCIDENT_ID = "provider-00000000-0000-4000-8000-000000000001";
export const CAPTURE_ID = "synthetic-capture-2";
export const ARTIFACT_DIGEST = asEncryptedArtifactDigest("c".repeat(64));
export const TEST_ID = "gateway:stream-termination";
export const TEST_ID_B = "gateway:second-test";
export const REPLAY_COMMAND = "replay" as CommandId;
export const TEST_COMMAND = "test" as CommandId;
export const EXPECTED_FAILURE: ExpectedFailureV1 = {
  reason: "missing completion terminator produces 500",
  match: { kind: "contains", text: "stream terminated unexpectedly" },
};
export const PRIVATE_MARKER = "PRIVATE-SENTINEL-7f3d9c1a";
export const PUBLIC_MARKER = "public-model";
export const ORIGINAL_SHA = "2".repeat(40) as GitSha;
export const OUTPUT_DIGEST = "a1".repeat(32);

export const FIXTURE_DIR =
  `tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}`;
export const REQUEST_PATH = `${FIXTURE_DIR}/request.json`;
export const UPSTREAM_PATH = `${FIXTURE_DIR}/upstream.json`;

/**
 * Exact canonical dispatch metadata bytes for the fixed consumer paths and
 * ordered trusted test ids, written independently of the production builder
 * (canonical key order, no private bytes).
 */
export function expectedDispatchText(
  testIds: readonly string[] = [TEST_ID],
  requestPath: string = REQUEST_PATH,
  upstreamPath: string = UPSTREAM_PATH,
): string {
  return canonicalStringify({
    version: "v1",
    requestPath,
    upstreamPath,
    testIds: [...testIds],
  });
}

/**
 * Source preamble for the committed toy consumers. The ONLY supported input
 * selection is the fixed root dispatch metadata record: a missing, malformed,
 * oversized or differently-selected dispatcher exits 3 (a settled failure the
 * verifier refuses), so a hardcoded fixture read or a missing dispatcher can
 * never satisfy the consumer protocol.
 */
export function dispatchPreamble(
  expectedIds: readonly string[] = [TEST_ID],
): string {
  return `const expectedRequest = "${REQUEST_PATH}";
const expectedUpstream = "${UPSTREAM_PATH}";
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
if (request === null || upstream === null) Deno.exit(9);
`;
}

export function encode(text: string): Uint8Array<ArrayBuffer> {
  // Copy into a fresh ArrayBuffer: RetainedGatewayCaptureV1.body demands a
  // non-shared backing buffer.
  return new Uint8Array(new TextEncoder().encode(text));
}

export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Synthetic capture + composed bundle (public synthetic protocol vocabulary)
// ---------------------------------------------------------------------------

export function makeCapture(
  bodyText =
    `{"model":"synthetic-model","input":"${PRIVATE_MARKER}","stream":true}`,
): RetainedGatewayCaptureV1 {
  return {
    version: 1,
    captureId: CAPTURE_ID,
    fingerprint: "f".repeat(64),
    caseGroupDigest: "g".repeat(64),
    capturedAt: 1_788_811_200_000,
    expiresAt: 1_788_864_000_000,
    requestId: "req-synthetic-1",
    gitSha: ORIGINAL_SHA,
    denoRevision: "synthetic-revision-2",
    endpoint: "/v1/responses",
    method: "POST",
    contentType: "application/json",
    compatibilityHeaders: { accept: "text/event-stream" },
    failureSignature: "synthetic",
    observation: {
      status: 502,
      stream: true,
      completed: false,
      terminalType: null,
      failureKind: "missing_sse_terminal",
      syntheticTerminalType: null,
      providerRoute: "synthetic",
    },
    clientObservation: {
      status: 502,
      stream: true,
      completed: false,
      terminalType: null,
      failureKind: "missing_sse_terminal",
      framingValid: true,
      providerRoute: "synthetic",
    },
    upstream: {
      version: 1,
      attempts: [{
        provider: "chatgpt_codex",
        status: 200,
        content_type: "text/event-stream",
        chunks_base64: [
          "ZGF0YTogIntcInR5cGVcIjpcInJlc3BvbnNlLmNyZWF0ZWRcIn0iXQ==",
        ],
        terminal: "eof",
      }],
      attempts_truncated: false,
      bytes_truncated: false,
      chunks_truncated: false,
    },
    body: encode(bodyText),
  };
}

export function composedRequestBytes(): Uint8Array {
  return encode(JSON.stringify({
    endpoint: "/v1/responses",
    method: "POST",
    contentType: "application/json",
    body: `{"model":"${PUBLIC_MARKER}","input":"fixture text","stream":true}`,
  }));
}

export function composedUpstreamBytes(): Uint8Array {
  return encode(JSON.stringify({
    version: 1,
    attempts: [{
      provider: "chatgpt_codex",
      status: 200,
      content_type: "text/event-stream",
      chunks_base64: [
        "ZGF0YTogIntcInR5cGVcIjpcInJlc3BvbnNlLmNyZWF0ZWRcIn0iXQ==",
      ],
      terminal: "eof",
    }],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  }));
}

export function composedEntries(): { path: string; bytes: Uint8Array }[] {
  return [
    { path: REQUEST_PATH, bytes: composedRequestBytes() },
    { path: UPSTREAM_PATH, bytes: composedUpstreamBytes() },
  ];
}

export async function composedDigest(
  entries: { path: string; bytes: Uint8Array }[],
): Promise<FixtureDigest> {
  return await computeReplayFixtureDigest(entries);
}

/** Verifier input over the synthetic capture + composed bundle. */
export async function verifierInput(
  overrides: Partial<GatewayCausalVerifierInputV1> = {},
): Promise<GatewayCausalVerifierInputV1> {
  const entries = composedEntries();
  const bundleDigest = await composedDigest(entries);
  return {
    capture: makeCapture(),
    repository: TOY_REPOSITORY,
    incidentId: INCIDENT_ID,
    captureId: CAPTURE_ID,
    artifactDigest: ARTIFACT_DIGEST,
    fixtureRef:
      `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${bundleDigest}`,
    bundleDigest,
    replayCommandId: REPLAY_COMMAND,
    testCommandId: TEST_COMMAND,
    testIds: [TEST_ID],
    expectedFailure: EXPECTED_FAILURE,
    fixtureEntries: entries,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scripted process runtime (no real git/deno/sandbox; boundary logic only)
// ---------------------------------------------------------------------------

export interface ConsumerRecord {
  input: ReplayCommandInputV1;
  snapshotText: Record<string, string>;
  /** Realpaths recorded WHILE the snapshot exists (the verifier's verified
   * cleanup removes the task directory before the proof is returned). */
  realCwd: string;
  realDenoDir: string;
}

export class ScriptedRuntime implements ReplayRuntimeV1 {
  readonly runs: ReplayCommandInputV1[] = [];
  readonly consumerRecords: ConsumerRecord[] = [];
  private consumerIndex = 0;
  private readonly shaLine = `${ORIGINAL_SHA}\n`;

  constructor(
    private readonly options: {
      onClone?: (dest: string) => Promise<void>;
      consumer?: (
        input: ReplayCommandInputV1,
        index: number,
      ) => ReplayCommandResultV1;
    } = {},
  ) {}

  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.runs.push(input);
    if (input.executable === "git") {
      if (input.args[0] === "clone") {
        const dest = input.args[input.args.length - 1]!;
        await this.options.onClone?.(dest);
        return exitedResult(0, this.shaLine);
      }
      // rev-parse --verify / checkout / rev-parse HEAD: exact SHA behavior.
      return exitedResult(0, this.shaLine);
    }
    const result = (this.options.consumer ?? (() => exitedResult(1)))(
      input,
      this.consumerIndex,
    );
    this.consumerIndex += 1;
    this.consumerRecords.push({
      input,
      snapshotText: await snapshotText(input.cwd),
      realCwd: await Deno.realPath(input.cwd),
      realDenoDir: await Deno.realPath(input.env.DENO_DIR!),
    });
    return result;
  }
}

export function exitedResult(
  exitCode: number,
  stdout = "",
  stderr = "",
): ReplayCommandResultV1 {
  return {
    outcome: "exited",
    exitCode,
    stdout: encode(stdout),
    stderr: encode(stderr),
    truncated: false,
    settled: true,
    detail: "scripted",
  };
}

export function intendedFailResult(): ReplayCommandResultV1 {
  return exitedResult(
    1,
    `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`,
    "",
  );
}

export function timedOutResult(settled: boolean): ReplayCommandResultV1 {
  return {
    outcome: "timed_out",
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    truncated: false,
    settled,
    detail: "scripted deadline exceeded",
  };
}

export async function snapshotText(
  cwd: string,
): Promise<Record<string, string>> {
  const text: Record<string, string> = {};
  for (
    const path of [SENTINEL_REPLAY_INPUT_PATH, REQUEST_PATH, UPSTREAM_PATH]
  ) {
    try {
      text[path] = decode(await Deno.readFile(`${cwd}/${path}`));
    } catch {
      // absent snapshot file: recorded as missing
    }
  }
  return text;
}

/** Materialize one scripted snapshot checkout at the clone destination. */
export async function materialize(
  dest: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const full = `${dest}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeFile(full, encode(text));
  }
}

/** Standard snapshot: consumer present, fixture paths NOT committed. */
export function consumerFiles(): Record<string, string> {
  return {
    "scripts/replay.ts": `// trusted consumer placeholder (scripted runtime)
console.log("sentinel-replay-test:${TEST_ID}");
`,
  };
}

export interface ScriptedVerifyContextV1 {
  root: string;
  scratchDir: string;
  runtime: ScriptedRuntime;
  consumers: ReplayCommandInputV1[];
  verify(
    input: GatewayCausalVerifierInputV1,
  ): Promise<GatewayCausalProofV1 | null>;
  cleanup(): Promise<void>;
}

export async function scriptedContext(
  options: {
    files?: Record<string, string>;
    onClone?: (dest: string) => Promise<void>;
    consumer?: (
      input: ReplayCommandInputV1,
      index: number,
    ) => ReplayCommandResultV1;
    verifierOptions?: Partial<GatewayLocalCausalVerifierOptionsV1>;
  } = {},
): Promise<ScriptedVerifyContextV1> {
  const root = await Deno.makeTempDir({
    prefix: "causal-verifier-unit-",
    dir: Deno.cwd(),
  });
  const scratchDir = `${root}/scratch`;
  const runtime = new ScriptedRuntime({
    onClone: options.onClone ??
      ((dest) => materialize(dest, options.files ?? consumerFiles())),
    consumer: options.consumer,
  });
  const verifier = new GatewayLocalCausalVerifier({
    sourcePath: root,
    scratchDir,
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: Deno.execPath(),
    sandboxExecPath: Deno.execPath(),
    osName: "darwin",
    maxDurationMs: 15_000,
    maxOutputBytes: 262_144,
    runtime,
  });
  return {
    root,
    scratchDir,
    runtime,
    consumers: runtime.runs,
    verify: (input) => verifier.verify(input),
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

export async function scratchEntries(scratchDir: string): Promise<string[]> {
  try {
    const names: string[] = [];
    for await (const entry of Deno.readDir(scratchDir)) {
      names.push(entry.name);
    }
    return names;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GROUP A: constructor binding and fail-closed validation (no execution)
// ---------------------------------------------------------------------------

export const EXPECTED_MARKER_LINE = `sentinel-replay-test:${TEST_ID}\n`;
export const EXPECTED_FAIL_LINE =
  `sentinel-causal-failure:stream terminated unexpectedly\n`;
