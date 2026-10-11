import { asFixtureDigest } from "../contracts/brands.ts";
import type {
  CommandId,
  EncryptedArtifactDigest,
  FixtureDigest,
  GitSha,
} from "../contracts/brands.ts";
import { canonicalStringifySha256 } from "../contracts/canonical.ts";
import { expectRestrictedRef } from "../contracts/shared.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { ExpectedFailureV1 } from "./fixture.ts";

/**
 * Fixed trusted verifier identity; the only verifier id a proof may carry.
 * The concrete verifier is the trusted local Deno consumer executor
 * (`GatewayLocalCausalVerifier`); a proof is never produced by a caller
 * supplied oracle or by a model.
 */
export const GATEWAY_CAUSAL_VERIFIER_ID = "gateway-causal-consumer-v1";

/**
 * Fixed trusted-consumer command identity executed by the trusted verifier.
 * This is a protocol constant (like the verifier id), never caller- or
 * model-supplied; the consumer is the committed trusted script invoked with
 * the fixed local Deno protocol, not a target `deno task`.
 */
export const CAUSAL_CONSUMER_COMMAND_ID: CommandId =
  "causal_consumer" as CommandId;

export const PROOF_SCHEME_PREFIX = "fixture://proof/gateway-causal/";
export const FIXTURE_SCHEME_PREFIX = "fixture://gateway-replay/";
export const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/;
/** Frozen gateway incident identity grammar (see adapters/gateway/wire.ts). */
export const GATEWAY_INCIDENT_ID =
  /^provider-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CAPTURE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const TEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
export const MAX_TEST_IDS = 64;
export const MAX_FAILURE_REASON_BYTES = 512;
export const MAX_MATCH_TEXT_BYTES = 512;
export const MAX_MATCH_REGEX_BYTES = 256;

export const PROOF_KEYS = [
  "version",
  "kind",
  "verifier",
  "proofRef",
  "repository",
  "incidentId",
  "captureId",
  "artifactDigest",
  "originalGitSha",
  "fixtureRef",
  "bundleDigest",
  "replayCommandId",
  "testCommandId",
  "consumerCommandId",
  "testIds",
  "expectedFailure",
  "expectedFailureIdentity",
  "originalObservation",
  "sanitizedObservation",
] as const;
export const OBSERVATION_KEYS = [
  "intended",
  "outputDigest",
  "observedTestIds",
  "exitCode",
] as const;
export const EXPECTED_FAILURE_KEYS = ["reason", "match"] as const;
export const MATCH_KEYS = ["kind", "text"] as const;
export const REGEX_MATCH_KEYS = ["kind", "source"] as const;

/**
 * One trusted observation: the concrete consumer actually exited 1 and
 * printed the EXACT fixed safe failure protocol (one
 * `sentinel-replay-test:<id>\n` line per trusted id in order plus the single
 * fixed `sentinel-causal-failure:stream terminated unexpectedly\n` line on
 * stdout, empty stderr). Only fixed safe failure identity plus observed
 * execution bindings cross the proof boundary — never raw output, request or
 * upstream bytes and never a hash of the expected matcher presented as a
 * signature.
 */
export interface CausalExecutionObservationV1 {
  /** The trusted verifier classified this execution as the intended failure. */
  intended: true;
  /**
   * SHA-256 over the exact validated safe consumer failure protocol observed
   * (stdout only; the protocol requires empty stderr): one
   * `sentinel-replay-test:<id>` line per trusted id in order plus the single
   * fixed `sentinel-causal-failure:stream terminated unexpectedly` line.
   * Only those fixed public protocol bytes are ever hashed; arbitrary or
   * private diagnostics are never accepted and never digested. The digest is
   * an observed-execution binding, never a signature identity.
   */
  outputDigest: string;
  /** Test identity actually observed in the consumer output (fixed protocol). */
  observedTestIds: string[];
  /** Observed nonzero exit code of the consumer execution. */
  exitCode: number;
}

/**
 * The narrow trusted causal-proof record. Fully bound: every field is
 * validated and the consuming boundary re-checks every identity it can
 * observe before the proof may suppress `fixture_redacted`.
 */
export interface GatewayCausalProofV1 {
  version: "v1";
  kind: "gateway_causal_proof";
  /** Exact fixed verifier identity (`GATEWAY_CAUSAL_VERIFIER_ID`). */
  verifier: string;
  /** Safe restricted deterministic proof reference (never raw payloads). */
  proofRef: string;
  repository: RepositoryIdentityV1;
  incidentId: string;
  captureId: string;
  /** Authenticated encrypted-artifact digest (distinct from the fixture digest). */
  artifactDigest: EncryptedArtifactDigest;
  /** Original failing Git SHA the capture was recorded at. */
  originalGitSha: GitSha;
  fixtureRef: string;
  bundleDigest: FixtureDigest;
  replayCommandId: CommandId;
  testCommandId: CommandId;
  /** Fixed trusted-consumer command identity (`CAUSAL_CONSUMER_COMMAND_ID`). */
  consumerCommandId: CommandId;
  testIds: string[];
  expectedFailure: ExpectedFailureV1;
  /** Canonical expected-failure identity; a classification label, never an
   * observed execution signature. */
  expectedFailureIdentity: string;
  originalObservation: CausalExecutionObservationV1;
  sanitizedObservation: CausalExecutionObservationV1;
}

/** Identities the consuming boundary re-checks against the proof. */
export interface GatewayCausalProofBoundaryV1 {
  repository: RepositoryIdentityV1;
  /** Optional capture-level identities (composition side only). */
  incidentId?: string;
  captureId?: string;
  artifactDigest?: EncryptedArtifactDigest;
  originalGitSha?: GitSha;
  fixtureRef: string;
  bundleDigest: FixtureDigest;
  replayCommandId: CommandId;
  testCommandId: CommandId;
  testIds: readonly string[];
  expectedFailure: ExpectedFailureV1;
}

/** Strict parse of the fixed gateway fixture-reference grammar. */
export interface GatewayFixtureRefIdentityV1 {
  incidentId: string;
  captureId: string;
  bundleDigest: FixtureDigest;
}

/**
 * Canonical non-secret EXPECTED-FAILURE identity: SHA-256 over the canonical
 * form of `{version, kind, intended: true, reason, matcher}`. This is a
 * classification label for the intended failure configured by the trusted
 * host policy. It is NOT an observed execution signature and it is NOT
 * authentication of an execution: proof observations carry their own
 * non-secret output digests and observed test identity. The consuming
 * boundary re-derives this identity from the resolved fixture's expected
 * failure and demands equality, so a caller/model assertion, a stale proof or
 * a changed matcher/reason can never mask a mismatch.
 */
export async function deriveExpectedFailureIdentity(
  expected: ExpectedFailureV1,
): Promise<string> {
  const matcher = expected.match.kind === "contains"
    ? { kind: "contains", text: expected.match.text }
    : { kind: "regex", source: expected.match.source };
  return await canonicalStringifySha256({
    version: "v1",
    kind: "causal-expected-failure-identity",
    intended: true,
    reason: expected.reason,
    match: matcher,
  });
}

/** Deterministic restricted proof reference for an exact capture/bundle. */
export function gatewayCausalProofRef(
  incidentId: string,
  captureId: string,
  bundleDigest: FixtureDigest,
): string {
  return `${PROOF_SCHEME_PREFIX}${incidentId}/${captureId}/${bundleDigest}`;
}

/** Deterministic parse of the fixed gateway fixture-reference grammar. */
export function gatewayFixtureRefIdentity(
  ref: string,
): GatewayFixtureRefIdentityV1 | null {
  if (typeof ref !== "string" || !ref.startsWith(FIXTURE_SCHEME_PREFIX)) {
    return null;
  }
  const segments = ref.slice(FIXTURE_SCHEME_PREFIX.length).split("/");
  if (segments.length !== 3) return null;
  const [incidentId, captureId, digest] = segments;
  if (incidentId === undefined || captureId === undefined) return null;
  if (digest === undefined || !LOWERCASE_HEX_64.test(digest)) return null;
  if (!GATEWAY_INCIDENT_ID.test(incidentId)) return null;
  if (!CAPTURE_ID_RE.test(captureId)) return null;
  try {
    expectRestrictedRef(ref, "$.fixtureRef");
  } catch {
    return null;
  }
  return {
    incidentId,
    captureId,
    bundleDigest: asFixtureDigest(digest),
  };
}
