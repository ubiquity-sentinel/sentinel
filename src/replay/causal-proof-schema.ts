import {
  asEncryptedArtifactDigest,
  asFixtureDigest,
  asGitSha,
  isCommandId,
  isEncryptedArtifactDigest,
  isFixtureDigest,
  isGitSha,
} from "../contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { ExpectedFailureV1 } from "./fixture.ts";
import {
  CAPTURE_ID_RE,
  CAUSAL_CONSUMER_COMMAND_ID,
  type CausalExecutionObservationV1,
  deriveExpectedFailureIdentity,
  EXPECTED_FAILURE_KEYS,
  GATEWAY_CAUSAL_VERIFIER_ID,
  GATEWAY_INCIDENT_ID,
  gatewayCausalProofRef,
  type GatewayCausalProofV1,
  gatewayFixtureRefIdentity,
  LOWERCASE_HEX_64,
  MATCH_KEYS,
  MAX_FAILURE_REASON_BYTES,
  MAX_MATCH_REGEX_BYTES,
  MAX_MATCH_TEXT_BYTES,
  MAX_TEST_IDS,
  OBSERVATION_KEYS,
  PROOF_KEYS,
  REGEX_MATCH_KEYS,
  TEST_ID_RE,
} from "./causal-proof-identity.ts";

/**
 * Strict structural proof validation: exact keys, bounded shapes, the fixed
 * verifier identity, the fixed trusted-consumer command identity, restricted
 * refs, internal reference consistency (incident/capture/digest of the
 * fixture ref match the proof fields), the expected proof reference,
 * command/test identities, the expected-failure shape plus its canonical
 * expected-failure identity and both observations as intended failures with
 * observed nonzero exit codes, non-secret output digests and the exact
 * observed test identity. Returns null on any violation; no proof is ever
 * partially trusted.
 */
export async function validateGatewayCausalProof(
  input: unknown,
): Promise<GatewayCausalProofV1 | null> {
  const obj = asRecord(input);
  if (obj === null) return null;
  if (!hasExactKeys(obj, PROOF_KEYS)) return null;
  if (obj.version !== "v1") return null;
  if (obj.kind !== "gateway_causal_proof") return null;
  if (obj.verifier !== GATEWAY_CAUSAL_VERIFIER_ID) return null;

  const repository = asRepositoryIdentity(obj.repository);
  if (repository === null) return null;

  const incidentId = obj.incidentId;
  const captureId = obj.captureId;
  if (typeof incidentId !== "string" || !GATEWAY_INCIDENT_ID.test(incidentId)) {
    return null;
  }
  if (typeof captureId !== "string" || !CAPTURE_ID_RE.test(captureId)) {
    return null;
  }
  const artifactDigest = obj.artifactDigest;
  if (!isEncryptedArtifactDigest(artifactDigest)) return null;
  const originalGitSha = obj.originalGitSha;
  if (!isGitSha(originalGitSha)) return null;
  const fixtureRef = obj.fixtureRef;
  if (typeof fixtureRef !== "string") return null;
  const fixtureIdentity = gatewayFixtureRefIdentity(fixtureRef);
  if (fixtureIdentity === null) return null;
  if (fixtureIdentity.incidentId !== incidentId) return null;
  if (fixtureIdentity.captureId !== captureId) return null;
  const bundleDigest = obj.bundleDigest;
  if (!isFixtureDigest(bundleDigest)) return null;
  if (fixtureIdentity.bundleDigest !== bundleDigest) return null;

  const proofRef = obj.proofRef;
  if (typeof proofRef !== "string") return null;
  if (proofRef !== gatewayCausalProofRef(incidentId, captureId, bundleDigest)) {
    return null;
  }

  const replayCommandId = obj.replayCommandId;
  const testCommandId = obj.testCommandId;
  const consumerCommandId = obj.consumerCommandId;
  if (
    !isCommandId(replayCommandId) || !isCommandId(testCommandId) ||
    !isCommandId(consumerCommandId)
  ) {
    return null;
  }
  if (consumerCommandId !== CAUSAL_CONSUMER_COMMAND_ID) return null;
  const testIds = obj.testIds;
  if (
    !Array.isArray(testIds) || testIds.length === 0 ||
    testIds.length > MAX_TEST_IDS
  ) {
    return null;
  }
  const seen = new Set<string>();
  for (const id of testIds) {
    if (typeof id !== "string" || !TEST_ID_RE.test(id) || seen.has(id)) {
      return null;
    }
    seen.add(id);
  }

  const expectedFailure = parseExpectedFailure(obj.expectedFailure);
  if (expectedFailure === null) return null;
  const expectedFailureIdentity = obj.expectedFailureIdentity;
  if (
    typeof expectedFailureIdentity !== "string" ||
    !LOWERCASE_HEX_64.test(expectedFailureIdentity) ||
    expectedFailureIdentity !==
      await deriveExpectedFailureIdentity(expectedFailure)
  ) {
    return null;
  }

  const originalObservation = parseObservation(obj.originalObservation, seen);
  if (originalObservation === null) return null;
  const sanitizedObservation = parseObservation(
    obj.sanitizedObservation,
    seen,
  );
  if (sanitizedObservation === null) return null;

  return {
    version: "v1",
    kind: "gateway_causal_proof",
    verifier: GATEWAY_CAUSAL_VERIFIER_ID,
    proofRef,
    repository,
    incidentId,
    captureId,
    artifactDigest: asEncryptedArtifactDigest(artifactDigest),
    originalGitSha: asGitSha(originalGitSha),
    fixtureRef,
    bundleDigest: asFixtureDigest(bundleDigest),
    replayCommandId,
    testCommandId,
    consumerCommandId,
    testIds: [...testIds],
    expectedFailure,
    expectedFailureIdentity,
    originalObservation,
    sanitizedObservation,
  };
}

// ---------------------------------------------------------------------------
// Strict structural helpers (no input-derived error text).
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  if (own.length !== keys.length) return false;
  const expected = new Set(keys);
  return own.every((key) => expected.has(key));
}

function asRepositoryIdentity(
  value: unknown,
): RepositoryIdentityV1 | null {
  const obj = asRecord(value);
  if (obj === null) return null;
  if (!hasExactKeys(obj, ["owner", "name", "installationId"])) return null;
  const { owner, name, installationId } = obj;
  if (typeof owner !== "string" || owner.length === 0) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  if (
    typeof installationId !== "number" ||
    !Number.isSafeInteger(installationId) ||
    installationId < 1
  ) {
    return null;
  }
  return { owner, name, installationId };
}

function parseExpectedFailure(
  value: unknown,
): ExpectedFailureV1 | null {
  const obj = asRecord(value);
  if (obj === null) return null;
  if (!hasExactKeys(obj, EXPECTED_FAILURE_KEYS)) return null;
  const reason = obj.reason;
  if (
    typeof reason !== "string" || reason.length === 0 ||
    reason.length > MAX_FAILURE_REASON_BYTES || /[\r\n\t]/.test(reason)
  ) {
    return null;
  }
  const match = asRecord(obj.match);
  if (match === null) return null;
  if (match.kind === "contains") {
    if (!hasExactKeys(match, MATCH_KEYS)) return null;
    const text = match.text;
    if (
      typeof text !== "string" || text.length === 0 ||
      text.length > MAX_MATCH_TEXT_BYTES
    ) {
      return null;
    }
    return { reason, match: { kind: "contains", text } };
  }
  if (match.kind === "regex") {
    if (!hasExactKeys(match, REGEX_MATCH_KEYS)) return null;
    const source = match.source;
    if (
      typeof source !== "string" || source.length === 0 ||
      source.length > MAX_MATCH_REGEX_BYTES
    ) {
      return null;
    }
    try {
      new RegExp(source, "m");
    } catch {
      return null;
    }
    return { reason, match: { kind: "regex", source } };
  }
  return null;
}

/**
 * One observed execution: intended failure, exit code 1, output digest over
 * the exact fixed safe protocol and the EXACT observed test identity (a
 * subset of the proof test identity; the trusted verifier runs the same
 * fixed consumer that prints them). Never a matcher hash presented as an
 * execution signature.
 */
function parseObservation(
  value: unknown,
  proofTestIds: ReadonlySet<string>,
): CausalExecutionObservationV1 | null {
  const obj = asRecord(value);
  if (obj === null) return null;
  if (!hasExactKeys(obj, OBSERVATION_KEYS)) return null;
  if (obj.intended !== true) return null;
  const outputDigest = obj.outputDigest;
  if (
    typeof outputDigest !== "string" || !LOWERCASE_HEX_64.test(outputDigest)
  ) {
    return null;
  }
  const exitCode = obj.exitCode;
  if (
    typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) ||
    exitCode < 1 || exitCode > 255
  ) {
    return null;
  }
  const observedTestIds = obj.observedTestIds;
  if (
    !Array.isArray(observedTestIds) || observedTestIds.length === 0 ||
    observedTestIds.length > MAX_TEST_IDS
  ) {
    return null;
  }
  const observed = new Set<string>();
  for (const id of observedTestIds) {
    if (typeof id !== "string" || !TEST_ID_RE.test(id) || observed.has(id)) {
      return null;
    }
    if (!proofTestIds.has(id)) return null;
    observed.add(id);
  }
  // An observation must carry the trusted test identity actually executed;
  // an empty or partial identity can never be an intended regression run.
  if (!setsEqual(observed, proofTestIds)) return null;
  return {
    intended: true,
    outputDigest,
    observedTestIds: [...observedTestIds],
    exitCode,
  };
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}
