/**
 * Gateway protocol JSON sanitizer — phase 1 (transform only).
 *
 * Converts common Responses and Chat Completions request, JSON-response and
 * SSE event payload shapes into an independent, fixed-vocabulary JSON value:
 *
 * - Only the literal keys in PROTOCOL_KEYS are ever emitted. An unknown key —
 *   including a key inherited from Object.prototype — makes the whole
 *   sanitize call fail (never echoed, never flattened, never claimed as
 *   universal sanitization).
 * - Enum values are restricted to the exported finite literal sets. An enum
 *   string outside its set makes the whole sanitize call fail; it is never
 *   copied as a value. Non-string enum inputs are rejected.
 * - Free strings become the fixed placeholder "fixture text" (empty stays
 *   empty), id/item_id/call_id/tool_call_id become sequential encounter-order
 *   fixture_id_N values and name strings become fixture_name_N values,
 *   deterministic per factory and stable across sanitize calls. Raw text is
 *   never hashed into a public identifier and source lengths are not exposed.
 * - Numeric request controls in range are preserved; private timing, usage and
 *   logprob numbers are replaced with 0; byte arrays are zeroed; booleans are
 *   preserved.
 * - Typed keys reject wrong types; scalar keys reject object/array values.
 * - Limits: max depth 32, max 8192 aggregate visited nodes per factory (shared
 *   across sanitize calls), max 1024 items per array, no cycles.
 * - Unsupported input fails with the fixed UNSUPPORTED_ERROR text, which never
 *   echoes values, keys or paths. The allowlist policy is validated at
 *   construction and fails with the fixed POLICY_ERROR text.
 *
 * Phase 1 deliberately has no capture, decryption, SSE unwrapping, provenance
 * or hash, header or output API and defines no sanitizer success/equivalence
 * attestation; Phase 3 adds that replay sanitization API without weakening
 * the rule.
 *
 * Phase 2 adds sanitizeRecordedUpstream: a captured upstream trace is
 * re-encoded attempt by attempt with the same fixed vocabulary and a shared
 * per-factory ID map; SSE/JSON bodies are transformed, rechunked to the
 * original chunk capacities, and failures use a fixed error text that never
 * echoes input.
 *
 * Phase 3 adds sanitizeGatewayReplay: an authenticated retained capture is
 * converted into a bounded public replay fixture (request plus upstream) and
 * restricted provenance. Request and upstream are sanitized through one
 * protocol factory (request first), so ID placeholders link across both;
 * only captured header values that exactly match trusted host policy
 * literals are copied and unknown/unapproved captured headers are omitted.
 * The transform is structural only and attests no equivalence: real
 * before/after validation of the fixture against the original request and
 * upstream behavior is required in the replay module before any fixture is
 * trusted (hence equivalence "unverified").
 */

import type {
  RetainedGatewayCaptureV1,
  RetainedGatewayUpstreamV1,
} from "./decrypt.ts";
import type { PortResultV1 } from "../../contracts/ports.ts";
import type { SanitizerPolicySnapshotV1 } from "./sanitize-snapshot.ts";
import {
  parseRequest,
  POLICY_ERROR_DETAIL,
  projectHeaders,
  snapshotCapture,
  snapshotPolicy,
  snapshotValue,
  UNAVAILABLE_DETAIL,
} from "./sanitize-snapshot.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../../contracts/canonical.ts";
import { portError, portOk } from "../../contracts/ports.ts";
import type { ProtocolSanitizer } from "./sanitize-protocol-vocabulary.ts";
import { createProtocolSanitizer } from "./sanitize-protocol.ts";
import { sanitizeRecordedUpstream } from "./sanitize-upstream.ts";
export type { ProtocolRole } from "./sanitize-protocol-vocabulary.ts";
export { PROTOCOL_ROLES } from "./sanitize-protocol-vocabulary.ts";
export type { ProtocolObjectKind } from "./sanitize-protocol-vocabulary.ts";
export { PROTOCOL_OBJECT_KINDS } from "./sanitize-protocol-vocabulary.ts";
export type { ProtocolStatus } from "./sanitize-protocol-vocabulary.ts";
export { PROTOCOL_STATUSES } from "./sanitize-protocol-vocabulary.ts";
export type { ProtocolEffort } from "./sanitize-protocol-vocabulary.ts";
export { PROTOCOL_EFFORTS } from "./sanitize-protocol-vocabulary.ts";
export type { ProtocolSummary } from "./sanitize-protocol-vocabulary.ts";
export { PROTOCOL_SUMMARIES } from "./sanitize-protocol-vocabulary.ts";
export type { ProtocolFinishReason } from "./sanitize-protocol-vocabulary.ts";
export { PROTOCOL_FINISH_REASONS } from "./sanitize-protocol-vocabulary.ts";
export type { ProtocolToolChoice } from "./sanitize-protocol-vocabulary.ts";
export { PROTOCOL_TOOL_CHOICES } from "./sanitize-protocol-vocabulary.ts";
export type { ProtocolFormat } from "./sanitize-protocol-vocabulary.ts";
export { PROTOCOL_FORMATS } from "./sanitize-protocol-vocabulary.ts";
export type { ProtocolType } from "./sanitize-protocol-vocabulary.ts";
export { PROTOCOL_TYPES } from "./sanitize-protocol-vocabulary.ts";
export type { ProtocolKey } from "./sanitize-protocol-vocabulary.ts";
export { PROTOCOL_KEYS } from "./sanitize-protocol-vocabulary.ts";
export type { ProtocolSanitizer } from "./sanitize-protocol-vocabulary.ts";
export { createProtocolSanitizer } from "./sanitize-protocol.ts";
export { sanitizeRecordedUpstream } from "./sanitize-upstream.ts";
// ---------------------------------------------------------------------------
// Phase 3: authenticated gateway replay sanitization. A retained decrypt
// capture is converted into a bounded public replay fixture (request plus
// upstream) plus restricted provenance with the same fixed-vocabulary
// sanitizer. Policy is trusted fixed host code; headers are copied only when
// the captured value is exactly a trusted policy literal.
// ---------------------------------------------------------------------------

/** Trusted fixed host policy for replay sanitization (never capture-derived). */
export interface GatewaySanitizerPolicyV1 {
  publicModels: readonly string[];
  publicHeaders: Readonly<Record<string, readonly string[]>>;
}

/** The public request header of a replay fixture. */
export interface GatewaySanitizedRequestV1 {
  endpoint: "/v1/responses" | "/v1/chat/completions";
  method: "POST";
  contentType: "application/json";
  compatibilityHeaders: Readonly<Record<string, string>>;
  body: string;
}

/** The minimal public replay fixture: request plus transformed upstream. */
export interface SanitizedGatewayFixtureV1 {
  version: 1;
  request: GatewaySanitizedRequestV1;
  upstream: RetainedGatewayUpstreamV1;
}

/**
 * Restricted provenance binding the fixture to the authenticated source
 * identity. Never public: it carries the source capture identity, source
 * shas, the exact source body digest, the canonical original upstream digest
 * and the canonical public fixture digest, and attests no equivalence or
 * coverage. No canonical request digest is part of the contract.
 */
export interface GatewayRestrictedProvenanceV1 {
  sanitizer: "gateway-structural-v1";
  redacted: true;
  equivalence: "unverified";
  sourceCaptureId: string;
  sourceGitSha: string;
  sourceFingerprint: string;
  sourceCaseGroupDigest: string;
  sourceRequestDigest: string;
  sourceUpstreamDigest: string;
  payloadDigest: string;
}

/** Result of sanitizing one authenticated retained gateway capture. */
export interface SanitizedGatewayReplayV1 {
  fixture: SanitizedGatewayFixtureV1;
  restrictedProvenance: GatewayRestrictedProvenanceV1;
}

/** Lowercase hex encoding of a digest byte array. */
function toLowerHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Sanitize one authenticated retained gateway capture into a minimal public
 * replay fixture with restricted provenance.
 *
 * Policy is trusted host code and is validated first (fixed model allowlist
 * plus the fixed header-name allowlist and literal bounds); an unknown
 * header name, an invalid policy or a bad model allowlist is an `invalid`
 * result with a static detail. The capture is validated defensively and every
 * consumed value (body bytes, identities, headers, upstream) is copied before
 * the first await; the upstream trace is bounded by the accepted synchronous
 * upstream sanitizer before its canonical snapshot is hashed. Request and
 * upstream are sanitized through the same protocol factory, request first,
 * so encounter-order ID placeholders link across both. Any unexpected input,
 * parser or hash problem is a static `unavailable` result; no raw exception
 * and no captured content ever escapes and no input is mutated.
 */
export async function sanitizeGatewayReplay(
  capture: RetainedGatewayCaptureV1,
  policy: GatewaySanitizerPolicyV1,
): Promise<PortResultV1<SanitizedGatewayReplayV1>> {
  let policySnapshot: SanitizerPolicySnapshotV1;
  try {
    policySnapshot = snapshotPolicy(policy);
    // Canonical snapshot proof: reject non-JSON values, accessors, symbol or
    // non-enumerable keys and cycles in the host policy before use.
    canonicalStringify(policySnapshot);
  } catch {
    return portError("invalid", POLICY_ERROR_DETAIL);
  }

  let protocol: ProtocolSanitizer;
  try {
    protocol = createProtocolSanitizer(policySnapshot.publicModels);
  } catch {
    return portError("invalid", POLICY_ERROR_DETAIL);
  }

  try {
    // All consumed inputs are copied before the first await below.
    const snapshot = snapshotCapture(capture);
    const request = parseRequest(snapshot.body, snapshot.endpoint);

    // Request first, then upstream, sharing one per-factory ID map so the
    // fixture IDs link the request to the upstream trace.
    const sanitizedRequest = protocol.sanitize(request);
    const sanitizedUpstream = sanitizeRecordedUpstream(
      snapshot.upstream,
      protocol,
    );

    // The synchronous upstream transform above validates and bounds the
    // trace; only now is the same single upstream value snapshotted and
    // canonicalized, so the transform and the hash cannot diverge.
    const upstreamSnapshot = snapshotValue(snapshot.upstream);
    canonicalStringify(snapshot.headers);
    canonicalStringify(upstreamSnapshot);

    const fixture: SanitizedGatewayFixtureV1 = {
      version: 1,
      request: {
        endpoint: snapshot.endpoint,
        method: "POST",
        contentType: "application/json",
        compatibilityHeaders: projectHeaders(
          snapshot.headers,
          policySnapshot.publicHeaders,
        ),
        body: canonicalStringify(sanitizedRequest),
      },
      upstream: sanitizedUpstream,
    };

    // Digests: the source request digest binds the exact original request
    // body bytes, the source upstream digest binds the canonical original
    // upstream snapshot and the payload digest binds the canonical public
    // fixture. No canonical request digest is part of the contract.
    const bodyDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", snapshot.body),
    );
    const sourceRequestDigest = toLowerHex(bodyDigest);
    const sourceUpstreamDigest = await canonicalStringifySha256(
      upstreamSnapshot,
    );
    const payloadDigest = await canonicalStringifySha256(fixture);

    const restrictedProvenance: GatewayRestrictedProvenanceV1 = {
      sanitizer: "gateway-structural-v1",
      redacted: true,
      equivalence: "unverified",
      sourceCaptureId: snapshot.captureId,
      sourceGitSha: snapshot.gitSha,
      sourceFingerprint: snapshot.fingerprint,
      sourceCaseGroupDigest: snapshot.caseGroupDigest,
      sourceRequestDigest,
      sourceUpstreamDigest,
      payloadDigest,
    };

    return portOk({ fixture, restrictedProvenance });
  } catch {
    // No raw exception crosses this boundary: every unexpected input,
    // validation, parser or digest failure is a static unavailable result.
    return portError("unavailable", UNAVAILABLE_DETAIL);
  }
}
