import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { ExpectedFailureV1 } from "./fixture.ts";
import type {
  GatewayCausalProofBoundaryV1,
  GatewayCausalProofV1,
} from "./causal-proof-identity.ts";
import { validateGatewayCausalProof } from "./causal-proof-schema.ts";

/**
 * Trusted causal-proof boundary (plan 01).
 *
 * Structural sanitization and causal verification stay SEPARATE. A redacted
 * fixture remains `redacted: true` for provenance/privacy forever; the
 * `fixture_redacted` limitation may only be suppressed at the replay
 * consuming boundary after a fully bound trusted causal proof establishes
 * that the original captured request and the sanitized fixture produced the
 * SAME intended failure at the same original Git SHA under the configured
 * trusted oracle. This module owns the narrow proof type, its strict
 * structural validator and the canonical expected-failure identity; it never
 * accepts an unbound boolean, caller/model-supplied success, a stale proof,
 * a mismatched identity or matching nonzero exits alone.
 *
 * The proof binds, at minimum: version/kind and the fixed verifier identity;
 * a safe restricted proof reference; the exact repository
 * owner/name/installation identity; the incident id and capture id; the
 * authenticated encrypted-artifact digest; the original Git SHA; the exact
 * fixture reference and the actual bundle digest; the trusted replay command
 * id, the trusted target-test command id and the fixed trusted-consumer
 * command identity; the exact test-id list; the exact expected-failure
 * matcher/reason plus its canonical identity; and, per execution, the
 * OBSERVED execution evidence: the observed exit code 1, the observed test
 * identity actually printed by the consumer, the observed digest of the
 * exact fixed safe consumer output protocol (stdout only, empty stderr) and
 * the intended-failure classification.
 *
 * The expected-failure identity is a canonical classification label derived
 * from the configured reason+matcher. It is NOT an observed execution
 * signature and it is NOT authentication of any execution: the observations
 * carry observed-output digests of what the consumer actually printed. The
 * consumer protocol is the EXACT fixed safe failure protocol (one
 * `sentinel-replay-test:<id>\n` line per trusted id in order plus the single
 * fixed `sentinel-causal-failure:stream terminated unexpectedly\n` line on
 * stdout, empty stderr, exit code 1), so those digests are computed only
 * over validated fixed public protocol bytes — arbitrary or private
 * diagnostics are never accepted and never hashed. Raw private output,
 * request or upstream bytes never enter a proof and never leave the trusted
 * verifier boundary: only fixed safe failure identity after exact-protocol
 * classification plus observed execution bindings (exit code, test identity,
 * output digest) cross this boundary.
 *
 * The fixture-reference grammar is the fixed gateway replay protocol
 * (`fixture://gateway-replay/<incidentId>/<captureId>/<bundleDigest>`); the
 * proof reference is the sibling restricted grammar
 * (`fixture://proof/gateway-causal/<incidentId>/<captureId>/<bundleDigest>`).
 * Both are deterministic, non-secret and never carry raw payloads.
 */

export {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
  gatewayFixtureRefIdentity,
} from "./causal-proof-identity.ts";
export type {
  CausalExecutionObservationV1,
  GatewayCausalProofBoundaryV1,
  GatewayCausalProofV1,
  GatewayFixtureRefIdentityV1,
} from "./causal-proof-identity.ts";
export { validateGatewayCausalProof } from "./causal-proof-schema.ts";

/** Exact boundary binding: every observable identity must match exactly. */
export function gatewayCausalProofMatches(
  proof: GatewayCausalProofV1,
  boundary: GatewayCausalProofBoundaryV1,
): boolean {
  if (!sameRepositoryIdentity(proof.repository, boundary.repository)) {
    return false;
  }
  if (
    boundary.incidentId !== undefined &&
    proof.incidentId !== boundary.incidentId
  ) {
    return false;
  }
  if (
    boundary.captureId !== undefined && proof.captureId !== boundary.captureId
  ) {
    return false;
  }
  if (
    boundary.artifactDigest !== undefined &&
    proof.artifactDigest !== boundary.artifactDigest
  ) {
    return false;
  }
  if (
    boundary.originalGitSha !== undefined &&
    proof.originalGitSha !== boundary.originalGitSha
  ) {
    return false;
  }
  if (proof.fixtureRef !== boundary.fixtureRef) return false;
  if (proof.bundleDigest !== boundary.bundleDigest) return false;
  if (proof.replayCommandId !== boundary.replayCommandId) return false;
  if (proof.testCommandId !== boundary.testCommandId) return false;
  if (!sameStringArray(proof.testIds, boundary.testIds)) return false;
  if (!sameExpectedFailure(proof.expectedFailure, boundary.expectedFailure)) {
    return false;
  }
  return true;
}

/**
 * One trusted end-to-end proof check used by the trusted composition and the
 * replay consuming boundary: strict structural validation plus the exact
 * caller-observed boundary. Returns the proof only when BOTH hold.
 */
export async function bindGatewayCausalProof(
  input: unknown,
  boundary: GatewayCausalProofBoundaryV1,
): Promise<GatewayCausalProofV1 | null> {
  const parsed = await validateGatewayCausalProof(input);
  if (parsed === null) return null;
  return gatewayCausalProofMatches(parsed, boundary) ? parsed : null;
}

function sameRepositoryIdentity(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

function sameStringArray(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameExpectedFailure(
  a: ExpectedFailureV1,
  b: ExpectedFailureV1,
): boolean {
  if (a.reason !== b.reason) return false;
  if (a.match.kind !== b.match.kind) return false;
  if (a.match.kind === "contains") {
    return b.match.kind === "contains" && a.match.text === b.match.text;
  }
  return b.match.kind === "regex" && a.match.source === b.match.source;
}
