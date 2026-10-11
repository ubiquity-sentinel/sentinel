import assert from "node:assert/strict";
import type { FixtureDigest, GitSha } from "../../src/contracts/brands.ts";
import type {
  PortResultV1,
  ReplayRunRequestV1,
} from "../../src/contracts/ports.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
} from "../../src/replay/causal-proof.ts";
import type { GatewayCausalProofV1 } from "../../src/replay/causal-proof.ts";
import { computeReplayFixtureDigest } from "../../src/replay/fixture.ts";
import type { ResolvedFixtureV1 } from "../../src/replay/fixture.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import type { ReplayPortOptions } from "../../src/replay/port.ts";
import { TOY_REPOSITORY, toyOptions } from "./helpers.ts";
import {
  ARTIFACT_DIGEST,
  CAPTURE_ID,
  encode,
  EXPECTED_FAILURE,
  INCIDENT_ID,
  OUTPUT_DIGEST,
  REPLAY_COMMAND,
  REQUEST_PATH,
  TEST_COMMAND,
  TEST_ID,
  UPSTREAM_PATH,
} from "./causal-verifier-helpers.ts";

export const here = new URL(import.meta.url);
if (here.protocol !== "file:") throw new Error("expected a file: test module");
export const testsDir = decodeURIComponent(here.pathname).replace(
  /\/causal-boundary-helpers\.ts$/,
  "",
);

export function gatewayEntries(): { path: string; bytes: Uint8Array }[] {
  return [
    {
      path: REQUEST_PATH,
      bytes: encode(JSON.stringify({
        endpoint: "/v1/responses",
        method: "POST",
        contentType: "application/json",
        body:
          '{"model":"synthetic-model","input":"fixture text","stream":true}',
      })),
    },
    {
      path: UPSTREAM_PATH,
      bytes: encode(JSON.stringify({
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
      })),
    },
  ];
}

export function observation(): GatewayCausalProofV1["originalObservation"] {
  return {
    intended: true,
    outputDigest: OUTPUT_DIGEST,
    observedTestIds: [TEST_ID],
    exitCode: 1,
  };
}

export async function buildProof(
  bundleDigest: FixtureDigest,
  originalGitSha: GitSha,
  overrides: Partial<GatewayCausalProofV1> = {},
): Promise<GatewayCausalProofV1> {
  const fixtureRef =
    `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${bundleDigest}`;
  const proof: GatewayCausalProofV1 = {
    version: "v1",
    kind: "gateway_causal_proof",
    verifier: GATEWAY_CAUSAL_VERIFIER_ID,
    proofRef: gatewayCausalProofRef(INCIDENT_ID, CAPTURE_ID, bundleDigest),
    repository: TOY_REPOSITORY,
    incidentId: INCIDENT_ID,
    captureId: CAPTURE_ID,
    artifactDigest: ARTIFACT_DIGEST,
    originalGitSha,
    fixtureRef,
    bundleDigest,
    replayCommandId: REPLAY_COMMAND,
    testCommandId: TEST_COMMAND,
    consumerCommandId: CAUSAL_CONSUMER_COMMAND_ID,
    testIds: [TEST_ID],
    expectedFailure: EXPECTED_FAILURE,
    expectedFailureIdentity: await deriveExpectedFailureIdentity(
      EXPECTED_FAILURE,
    ),
    originalObservation: observation(),
    sanitizedObservation: observation(),
    ...overrides,
  };
  return proof;
}

export async function gatewayBundle(
  originalGitSha: GitSha,
  proofOverrides: Partial<GatewayCausalProofV1> = {},
): Promise<{ bundle: ResolvedFixtureV1; digest: FixtureDigest; ref: string }> {
  const entries = gatewayEntries();
  const digest = await computeReplayFixtureDigest(entries);
  const ref = `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${digest}`;
  const bundle: ResolvedFixtureV1 = {
    testIds: [TEST_ID],
    expectedFailure: EXPECTED_FAILURE,
    entries,
    provenance: {
      sanitized: true,
      sanitizer: "gateway-structural-v1",
      provenanceRef: ref,
      redacted: true,
      note:
        "gateway capture redacted; re-encoded to a fixed protocol vocabulary",
    },
    causalProof: await buildProof(digest, originalGitSha, proofOverrides),
  };
  return { bundle, digest, ref };
}

/** Config whose "test" command runs one credential-free deno eval script. */
export function evalConfig(
  script: string,
  maxOutputBytes = 262_144,
): RepositoryConfigV1 {
  const command = {
    executable: "deno",
    args: ["eval", "--allow-read=.", script],
    maxDurationMs: 15_000,
    maxOutputBytes,
  };
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: TOY_REPOSITORY,
    baseBranch: "main",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: { replay: command, test: command },
    },
    protectedPaths: ["src/"],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: null,
    sessionBound: null,
    retention: null,
    stabilityPolicy: null,
  });
}

export const FAIL_SCRIPT =
  `const base = "tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}"; const request = JSON.parse(await Deno.readTextFile(base + "/request.json")); const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json")); if (request.endpoint !== "/v1/responses") Deno.exit(9); if (!upstream.attempts.every((a) => a.terminal === "eof")) Deno.exit(9); console.log("sentinel-replay-test:${TEST_ID}"); console.log("stream terminated unexpectedly"); Deno.exit(1);`;

export const PASS_SCRIPT =
  `const base = "tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}"; const request = JSON.parse(await Deno.readTextFile(base + "/request.json")); const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json")); if (request.endpoint !== "/v1/responses") Deno.exit(9); if (!upstream.attempts.every((a) => a.terminal === "eof")) Deno.exit(9); console.log("sentinel-replay-test:${TEST_ID}");`;

export async function withFixture<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({
    prefix: ".causal-proof-tmp-",
    dir: testsDir,
  });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

export function assertPortOk<T>(result: PortResultV1<T>): T {
  assert.ok(result.ok, `expected port ok, got ${JSON.stringify(result)}`);
  return result.value;
}

export function runRequest(
  bundle: ResolvedFixtureV1,
  ref: string,
  digest: FixtureDigest,
  revision: GitSha,
  overrides: Record<string, unknown> = {},
): ReplayRunRequestV1 {
  return {
    taskId: "incident:toy-0001" as WorkItemId,
    repository: TOY_REPOSITORY,
    revision,
    commandId: TEST_COMMAND,
    fixtureRef: ref,
    fixtureDigest: digest,
    testIds: bundle.testIds,
    outputLimitBytes: 262_144,
    ...overrides,
  } as ReplayRunRequestV1;
}

export function portWith(
  toyRoot: string,
  scratchDir: string,
  bundle: ResolvedFixtureV1,
  overrides: Partial<ReplayPortOptions> = {},
): ReplayPortImpl {
  return new ReplayPortImpl({
    ...toyOptions(toyRoot, scratchDir, overrides),
    fixtures: {
      resolveFixture: () => Promise.resolve({ ok: true, value: bundle }),
    },
    ...overrides,
  });
}
