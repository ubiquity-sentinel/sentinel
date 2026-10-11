import type { CommandId } from "../../../src/contracts/brands.ts";
import {
  baseMetadata,
  CAPTURE_ID_V2,
  CAPTURED_AT_V2,
  craftWireCapture,
  decodeStandardBase64,
  GIT_SHA,
  INDEX_PATH,
  standardBase64,
  TEXT_ENCODER,
  v2Attempt,
  v2Upstream,
} from "./replay-composition-fixtures.ts";
import type { GatewayCausalProofV1 } from "../../../src/replay/causal-proof.ts";
import type {
  GatewayCausalVerifierInputV1,
  GatewayCausalVerifierV1,
} from "../../../src/adapters/gateway/replay-composition.ts";
import {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
} from "../../../src/replay/causal-proof.ts";
import { asGitSha } from "../../../src/contracts/brands.ts";
import {
  INCIDENT_A,
  jsonResponse,
  makeIndexPage,
  makeIndexRow,
  makeReplayPage,
} from "./helpers.ts";
import { artifactRef } from "../../../src/adapters/gateway/incident-adapter.ts";
import type { RepositoryConfigV1 } from "../../../src/contracts/repository-config.ts";
import { parseRepositoryConfigV1 } from "../../../src/contracts/repository-config.ts";
import { TOY_REPOSITORY } from "../../replay/helpers.ts";

// ---------------------------------------------------------------------------
// Trusted causal-proof verifier capability (plan 01): a fully bound proof is
// attached to the resolved fixture (which stays redacted) and is the ONLY
// condition that suppresses fixture_redacted at the replay boundary.
// ---------------------------------------------------------------------------

export const PRIVATE_MARKER = "PRIVATE-CAPTURE-MARKER-7f3d9c1a";
export const VERIFIER_TEST_COMMAND = "test" as CommandId;

/** Deterministic local restricted oracle: no completion terminator = failure. */
function oracleFails(
  upstream: { attempts: readonly { chunks_base64: readonly string[] }[] },
): boolean {
  const chunk = upstream.attempts[0]?.chunks_base64[0];
  if (chunk === undefined) return false;
  const text = new TextDecoder().decode(decodeStandardBase64(chunk));
  return !(text.includes("response.completed") || text.includes("[DONE]"));
}

/**
 * Trusted test verifier: consumes the private captured request (private
 * marker present), asserts the sanitized fixture never carries it, runs the
 * same local restricted oracle over the original capture and the sanitized
 * fixture entries and returns a fully bound proof with observed execution
 * bindings (nonzero exit, exact observed test identity, output digest) kept
 * SEPARATE from the canonical expected-failure identity (or a mutated proof
 * for negative cases). Returns only observed bindings; the raw bytes stay
 * inside the verifier.
 */
export function trustedVerifier(
  mutate: (proof: GatewayCausalProofV1) => GatewayCausalProofV1 | null = (
    proof,
  ) => proof,
  options: { requirePrivateMarker?: boolean } = {},
): GatewayCausalVerifierV1 {
  return {
    async verify(input: GatewayCausalVerifierInputV1) {
      const privateText = new TextDecoder().decode(input.capture.body);
      const fixtureText = input.fixtureEntries
        .map((entry) => new TextDecoder().decode(entry.bytes))
        .join("\n");
      if (
        options.requirePrivateMarker !== false &&
        !privateText.includes(PRIVATE_MARKER)
      ) {
        return null;
      }
      if (fixtureText.includes(PRIVATE_MARKER)) return null;
      if (!oracleFails(input.capture.upstream)) return null;
      const fixtureUpstream = parseFixtureUpstream(input.fixtureEntries);
      if (fixtureUpstream === null || !oracleFails(fixtureUpstream)) {
        return null;
      }
      const expectedFailureIdentity = await deriveExpectedFailureIdentity(
        input.expectedFailure,
      );
      const observation = {
        intended: true as const,
        outputDigest: "b1".repeat(32),
        observedTestIds: [...input.testIds],
        exitCode: 1,
      };
      const proof: GatewayCausalProofV1 = {
        version: "v1",
        kind: "gateway_causal_proof",
        verifier: GATEWAY_CAUSAL_VERIFIER_ID,
        proofRef: gatewayCausalProofRef(
          input.incidentId,
          input.captureId,
          input.bundleDigest,
        ),
        repository: input.repository,
        incidentId: input.incidentId,
        captureId: input.captureId,
        artifactDigest: input.artifactDigest,
        originalGitSha: asGitSha(input.capture.gitSha),
        fixtureRef: input.fixtureRef,
        bundleDigest: input.bundleDigest,
        replayCommandId: input.replayCommandId,
        testCommandId: input.testCommandId,
        consumerCommandId: CAUSAL_CONSUMER_COMMAND_ID,
        testIds: [...input.testIds],
        expectedFailure: input.expectedFailure,
        expectedFailureIdentity,
        originalObservation: observation,
        sanitizedObservation: { ...observation },
      };
      return mutate(proof);
    },
  };
}

/** Parse the composed upstream entry (must exist as the fixed protocol). */
function parseFixtureUpstream(
  entries: readonly { path: string; bytes: Uint8Array }[],
): { attempts: readonly { chunks_base64: readonly string[] }[] } | null {
  const entry = entries.find((candidate) =>
    candidate.path.endsWith("/upstream.json")
  );
  if (entry === undefined) return null;
  try {
    return JSON.parse(new TextDecoder().decode(entry.bytes));
  } catch {
    return null;
  }
}

/** One crafted private-marker capture served over the real producer wire. */
export async function craftedCausalResponder(
  keyBytes: Uint8Array<ArrayBuffer>,
  bodyText: string,
): Promise<(url: URL) => Response> {
  const upstream = v2Upstream({
    attempts: [v2Attempt({
      provider: "chatgpt_codex",
      status: 200,
      content_type: "text/event-stream",
      chunks_base64: [
        standardBase64(TEXT_ENCODER.encode(
          'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        )),
      ],
      terminal: "eof",
    })],
  });
  const crafted = await craftWireCapture(
    keyBytes,
    baseMetadata({ upstream }),
    TEXT_ENCODER.encode(bodyText),
  );
  return (url: URL) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([
        makeIndexRow({
          incident_id: INCIDENT_A,
          fingerprint: crafted.manifest.fingerprint as string,
          failing_revision: GIT_SHA,
          provenance: {
            endpoint: "https://ai.ubq.fi",
            captured_at_ms: CAPTURED_AT_V2,
            captured_by: "gateway",
          },
          evidence_ref: {
            ref: artifactRef(INCIDENT_A, CAPTURE_ID_V2),
            digest: crafted.digest,
          },
          evidence_expires_at_ms: crafted.manifest.expires_at_ms as number,
        }),
      ]));
    }
    return jsonResponse(makeReplayPage({
      manifest: crafted.manifest,
      chunks: crafted.chunks,
    }));
  };
}

/** Minimal credential-free target repo with replay/test scripts over the
 * composed gateway fixture entry paths. */
export function causalReplayConfig(): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: TOY_REPOSITORY,
    baseBranch: "main",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: {
        replay: {
          executable: "deno",
          args: ["task", "replay"],
          maxDurationMs: 30000,
          maxOutputBytes: 262144,
        },
        test: {
          executable: "deno",
          args: ["task", "test"],
          maxDurationMs: 30000,
          maxOutputBytes: 262144,
        },
      },
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

export function causalScript(pass: boolean): string {
  return `const base = "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_V2}";` +
    ` const request = JSON.parse(await Deno.readTextFile(base + "/request.json"));` +
    ` const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json"));` +
    ` const body = JSON.parse(request.body);` +
    ` if (body.model !== "synthetic-model") Deno.exit(1);` +
    ` if (!upstream.attempts.every((a) => a.terminal === "eof")) Deno.exit(1);` +
    ` console.log("sentinel-replay-test:gateway:complete-upstream");` +
    (pass
      ? ""
      : ` console.log("completed without the expected failure"); Deno.exit(1);`);
}
