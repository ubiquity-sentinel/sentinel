import type {
  CommandId,
  EncryptedArtifactDigest,
  FixtureDigest,
  GitSha,
  WorkItemId,
} from "./brands.ts";
import type { IncidentEvidenceV1, IncidentSummaryV1 } from "./incident.ts";
import type { ReplayLimitationV1 } from "./replay-result.ts";
import type { IncidentCoverageV1, RepositoryIdentityV1 } from "./shared.ts";
import type { PortResultV1 } from "./ports.ts";

// ---------------------------------------------------------------------------
// IncidentAdapter (m02): unresolved discovery, incident evidence and bounded
// retrieval of restricted encrypted artifacts.
// ---------------------------------------------------------------------------

export interface IncidentPageV1 {
  items: IncidentSummaryV1[];
  /**
   * Coverage of the discovery scan that produced this page, independent of
   * whether items is empty: an empty page may be incomplete coverage, and a
   * failed source read is never a successful empty page.
   */
  coverage: IncidentCoverageV1;
  /** Cursor of the next page; null when pagination was exhausted. */
  nextCursor: string | null;
}

export interface EncryptedArtifactV1 {
  ref: string;
  digest: EncryptedArtifactDigest;
  sizeBytes: number;
  expiresAt: number;
  /** Canonical base64 ciphertext; never plaintext evidence. */
  ciphertextBase64: string;
}

export interface IncidentAdapter {
  listUnresolvedIncidents(
    cursor: string | null,
    limit: number,
  ): Promise<PortResultV1<IncidentPageV1>>;
  readIncident(
    incidentId: string,
  ): Promise<PortResultV1<IncidentEvidenceV1 | null>>;
  /**
   * null means the artifact is gone/expired (evidence_expired blocker), which
   * is distinct from a transport failure (ok:false, unavailable).
   */
  readArtifact(
    ref: string,
    maxBytes: number,
  ): Promise<PortResultV1<EncryptedArtifactV1 | null>>;
}

// ---------------------------------------------------------------------------
// ReplayPort (m03): one exact isolated validation run against the configured
// command; the module orchestrates before/after and writes ReplayResultV1.
// ---------------------------------------------------------------------------

export interface ReplayRunRequestV1 {
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  /** Exact checkout revision; never selected by time or list order. */
  revision: GitSha;
  /** Trusted credential-free configured command (never model-supplied). */
  commandId: CommandId;
  fixtureRef: string;
  fixtureDigest: FixtureDigest;
  testIds: string[];
  outputLimitBytes: number;
}

export interface IsolatedReplayResultV1 {
  outcome: "passed" | "failed" | "unavailable";
  exitCode: number | null;
  output: {
    stdoutDigest: FixtureDigest | null;
    stderrDigest: FixtureDigest | null;
    truncated: boolean;
  } | null;
  /** null unless the run failed; "intended" says whether it failed for the expected reason. */
  failure: { intended: boolean; reason: string } | null;
  limitations: ReplayLimitationV1[];
  startedAt: number;
  endedAt: number;
}

export interface ReplayPort {
  runReplay(
    request: ReplayRunRequestV1,
  ): Promise<PortResultV1<IsolatedReplayResultV1>>;
}

// ---------------------------------------------------------------------------
// ImplementationPort (m04): bounded pinned model session with a secret-free
// checkout; the receipt records trusted request/runtime evidence — the exact
// submitted provider/model/effort configuration bound to the exact
// invocation/thread/turn and runtime routing/terminal events — never the CLI
// label alone and never a backend-observed provider attestation. A model
// candidate is a locally validated commit; only the trusted GitHub writer
// publishes it.
// ---------------------------------------------------------------------------
