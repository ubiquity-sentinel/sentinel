import type {
  EncryptedArtifactDigest,
  GitSha,
  IncidentFingerprint,
} from "../../contracts/brands.ts";
import type { PortResultV1 } from "../../contracts/ports.ts";
import type { RetainedGatewayCaptureV1 } from "./decrypt-schema.ts";

/** Private authentic index binding; it never changes persisted evidence records. */
export interface GatewayCaptureBindingV1 {
  incidentId: string;
  classificationDigest: IncidentFingerprint;
  captureId: string;
  artifactRef: string;
  ciphertextDigest: EncryptedArtifactDigest;
  originalRevision: GitSha | null;
  capturedAt: number;
  sourceExpiresAt: number;
}

export interface GatewayCaptureBindingReaderV1 {
  readGatewayCaptureBinding(
    incidentId: string,
  ): Promise<PortResultV1<GatewayCaptureBindingV1 | null>>;
}

/** Exact producer classification: JSON insertion order is part of this SHA domain. */
export async function authenticatedClassificationDigest(
  capture: Pick<
    RetainedGatewayCaptureV1,
    "endpoint" | "method" | "clientObservation"
  >,
): Promise<string> {
  const observed = capture.clientObservation;
  let terminal = "unknown";
  if (observed.stream && !observed.framingValid) terminal = "stream_framing";
  else {
    const terminals: Record<string, string> = {
      "http.error": "http_error",
      "response.failed": "response_failed",
      "response.incomplete": "response_incomplete",
      "error": "error",
      "deadline": "deadline",
      "eof": "eof",
    };
    if (
      observed.terminalType !== null &&
      Object.hasOwn(terminals, observed.terminalType)
    ) terminal = terminals[observed.terminalType];
  }
  const endpoint = capture.endpoint.split("?", 1)[0];
  const classification = JSON.stringify({
    endpoint:
      endpoint === "/v1/responses" || endpoint === "/v1/chat/completions"
        ? endpoint
        : "other",
    method: capture.method === "POST" ? "POST" : "other",
    status: observed.status,
    stream: observed.stream,
    completed: observed.completed,
    framing_valid: observed.framingValid,
    terminal,
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(classification),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
