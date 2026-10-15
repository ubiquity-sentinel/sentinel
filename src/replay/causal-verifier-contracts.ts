import type {
  CommandId,
  EncryptedArtifactDigest,
  FixtureDigest,
} from "../contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RetainedGatewayCaptureV1 } from "../adapters/gateway/decrypt.ts";
import type { GatewayCausalProofV1 } from "./causal-proof.ts";
import type { ExpectedFailureV1, ReplayFixtureEntryV1 } from "./fixture.ts";
import type { ReplayIsolationCapabilityV1 } from "./isolation-capability.ts";
import type { ReplayRuntimeV1 } from "./runtime.ts";
import type { BunFrozenReaderBindingV1 } from "./bun-frozen-reader.ts";
import type { ReplayDependencyCacheV1 } from "./dependency-cache.ts";

/** Host-owned exact-source selection; never capture-supplied commands. */
export type GatewayCausalReaderBindingV1 =
  | {
    kind: "deno";
    sourceSha: string;
    denoPath: string;
    dependencyCache?: ReplayDependencyCacheV1;
  }
  | BunFrozenReaderBindingV1;

/**
 * Trusted causal-proof verifier input. The private capture is consumed in
 * trusted process memory; `fixtureEntries` are the EXACT composed sanitized
 * bundle bytes at their fixed paths. Callers must never persist, log or
 * return the raw request/upstream or private sentinel data.
 */
export interface GatewayCausalVerifierInputV1 {
  /** Private authenticated capture (restricted; process memory only). */
  capture: RetainedGatewayCaptureV1;
  repository: RepositoryIdentityV1;
  incidentId: string;
  captureId: string;
  /** Authenticated encrypted-artifact digest of the retained artifact. */
  artifactDigest: EncryptedArtifactDigest;
  fixtureRef: string;
  bundleDigest: FixtureDigest;
  replayCommandId: CommandId;
  testCommandId: CommandId;
  testIds: readonly string[];
  expectedFailure: ExpectedFailureV1;
  /**
   * The exact composed sanitized bundle entries (paths + bytes). Only the
   * entries at the verifier's fixed consumer paths are accepted; the bytes
   * are written verbatim into the sanitized snapshot.
   */
  fixtureEntries: readonly ReplayFixtureEntryV1[];
}

/** Trusted verifier capability: a fully bound proof or no proof at all. */
export interface GatewayCausalVerifierV1 {
  verify(
    input: GatewayCausalVerifierInputV1,
  ): Promise<GatewayCausalProofV1 | null>;
}

// ---------------------------------------------------------------------------
// Trusted constructor inputs (fixed host config; never capture/model argv)
// ---------------------------------------------------------------------------

export interface GatewayLocalCausalVerifierOptionsV1 {
  /** Exact local source repository (read-only; absolute path). */
  sourcePath: string;
  /** Disposable restricted scratch root (absolute). */
  scratchDir: string;
  /** Root-relative fixed trusted consumer script (exists at the original SHA). */
  consumerPath: string;
  /** Root-relative fixed request fixture path the trusted consumer reads. */
  consumerRequestPath: string;
  /** Root-relative fixed upstream fixture path the trusted consumer reads. */
  consumerUpstreamPath: string;
  /** Installed Deno binary (absolute path; trusted host input). */
  denoPath: string;
  /** An explicit registry refuses every source SHA absent from the registry. */
  readerBindings?: readonly GatewayCausalReaderBindingV1[];
  /** Wall-clock bound for one consumer execution. */
  maxDurationMs: number;
  /** Combined retained output bound for one consumer execution. */
  maxOutputBytes: number;
  /**
   * Installed sandbox-exec binary (absolute path). The production value is
   * the fixed /usr/bin/sandbox-exec; injectable only for the missing-sandbox
   * negative path.
   */
  sandboxExecPath?: string;
  /**
   * Optional trusted isolation capability for the LINUX consumer boundary.
   * macOS keeps the fixed embedded sandbox-exec profile and does not require
   * (or consult) this capability. On Linux, an absent or invalid capability is
   * NO proof — before any private filesystem write or consumer execution —
   * and the fixed Deno consumer runs ONLY through the captured, receiver-bound
   * `run` with a read-only checkout.
   */
  isolation?: ReplayIsolationCapabilityV1;
  /**
   * Platform override for deterministic tests; defaults to Deno.build.os.
   * The sandbox boundary exists ONLY on macOS (darwin, fixed sandbox-exec
   * seatbelt profile) and Linux (the injected callable isolation capability);
   * every other platform returns no proof.
   */
  osName?: string;
  /** Process runtime; defaults to the concrete DenoReplayRuntime. */
  runtime?: ReplayRuntimeV1;
}
