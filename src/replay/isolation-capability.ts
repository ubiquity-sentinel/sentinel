import type { ReplayCommandInputV1, ReplayCommandResultV1 } from "./runtime.ts";
import type { ReplayCheckoutAccessV1 } from "./isolation.ts";

/**
 * Trusted isolation capability/attestation for the restricted execution host
 * that actually runs target-controlled commands. The production host wiring
 * injects this object; a target command is never run without it. This is the
 * smallest constructor capability Wave C needs.
 */
export interface ReplayIsolationAttestationV1 {
  version: "v1";
  /** Identity of the restricted execution host. */
  host: string;
  /**
   * True only when the host provides a real OS restricted execution boundary
   * (sandbox/container) around command execution. clearEnv is NOT a sandbox.
   */
  restrictedExecution: boolean;
  /** Non-secret description of the boundary (sandbox type, memory/FS scope). */
  boundary: string;
  /** Deterministic restricted reference to the host attestation record. */
  attestationRef: string;
}

/**
 * The ACTUAL restricted-execution boundary for one target-controlled command.
 * `access` selects the checkout mount mode: read-write for real replays whose
 * tests create temporary files in the disposable checkout, read-only for
 * private causal snapshots. Implementations enforce the boundary themselves;
 * the port never rewrites argv, bounds or result handling.
 */
export type ReplayIsolationRunnerV1 = (
  input: ReplayCommandInputV1,
  access: ReplayCheckoutAccessV1,
) => Promise<ReplayCommandResultV1>;

export interface ReplayIsolationCapabilityV1 {
  attestation: ReplayIsolationAttestationV1;
  /**
   * Callable restricted-execution boundary that ACTUALLY runs target
   * commands. A descriptive (boolean) attestation alone is never sufficient:
   * target-controlled code runs only through this captured, receiver-bound
   * function, and a later mutation or accessor can never replace it.
   */
  run: ReplayIsolationRunnerV1;
}

/**
 * Validate ONE untrusted whole-capability candidate and return a sanitized
 * snapshot: a plain attestation record (hostile accessors/proxies never leak
 * and later mutations are not observed) plus the `run` property captured
 * EXACTLY ONCE and bound to the capability receiver (so a class method keeps
 * its `this` and a changing getter cannot swap the validated function).
 *
 * Every fault — non-record, missing/empty fields, a false/missing
 * `restrictedExecution`, a missing/non-callable `run`, a throwing getter or a
 * hostile proxy trap — is the SAME null (the caller maps it to its own static
 * non-echoing TypeError). Nothing caller-controlled is ever returned or
 * thrown.
 */
export function validateReplayIsolationCapability(
  capability: unknown,
): ReplayIsolationCapabilityV1 | null {
  const record = capability as Record<string, unknown>;
  let attestationValue: unknown;
  let runValue: unknown;
  try {
    // The shape probe itself is guarded: Array.isArray on a revoked Proxy
    // throws a raw TypeError, which must still be the same static null.
    if (
      typeof capability !== "object" || capability === null ||
      Array.isArray(capability)
    ) {
      return null;
    }
    // One read per property; a hostile accessor fault is contained here.
    attestationValue = record.attestation;
    runValue = record.run;
  } catch {
    return null;
  }
  const attestation = snapshotReplayIsolationAttestation(attestationValue);
  if (attestation === null || typeof runValue !== "function") return null;
  let bound: unknown;
  try {
    // Bind through the prototype so a hostile function `bind` accessor is
    // never consulted, and bind to the capability receiver so a class method
    // sees its own instance.
    bound = Function.prototype.bind.call(runValue, capability);
  } catch {
    return null;
  }
  if (typeof bound !== "function") return null;
  return { attestation, run: bound as ReplayIsolationRunnerV1 };
}

/** One-read-per-field attestation snapshot; null unless the exact v1 shape. */
function snapshotReplayIsolationAttestation(
  value: unknown,
): ReplayIsolationAttestationV1 | null {
  const record = value as Record<string, unknown>;
  try {
    // The shape probe is guarded for the same reason as the whole-capability
    // validator: Array.isArray on a revoked Proxy throws a raw TypeError.
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const version = record.version;
    const restrictedExecution = record.restrictedExecution;
    const host = record.host;
    const boundary = record.boundary;
    const attestationRef = record.attestationRef;
    if (
      version !== "v1" ||
      restrictedExecution !== true ||
      typeof host !== "string" || host.length === 0 ||
      typeof boundary !== "string" || boundary.length === 0 ||
      typeof attestationRef !== "string" || attestationRef.length === 0
    ) {
      return null;
    }
    return {
      version: "v1",
      host,
      boundary,
      attestationRef,
      restrictedExecution: true,
    };
  } catch {
    return null;
  }
}
