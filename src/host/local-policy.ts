import {
  type EncryptedArtifactV1,
  type IncidentAdapter,
  type IncidentPageV1,
  type IsolatedReplayResultV1,
  portError,
  type PortResultV1,
  type ReplayPort,
  type ReplayRunRequestV1,
} from "../contracts/ports.ts";
import type { IncidentEvidenceV1 } from "../contracts/incident.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  HOSTED_CONTROLLER_DEPLOYMENT,
  HOSTED_CONTROLLER_REMOTE,
  HOSTED_CONTROLLER_SELF,
} from "../contracts/hosted-controller-deployment.ts";

/** Fixed local target identity (explicit no-App owner credential scope). */
export const LOCAL_REPOSITORY: RepositoryIdentityV1 = HOSTED_CONTROLLER_SELF;

export const REMOTE_URL = HOSTED_CONTROLLER_REMOTE;

export const API_BASE_URL = "https://api.github.com";

export const API_USER_URL = "https://api.github.com/user";

/** The one fixed base branch of the local repository configuration. */
export const LOCAL_BASE_BRANCH = HOSTED_CONTROLLER_DEPLOYMENT.sourceBranch;

/** Local default; hosted Actions supplies the public UOS gateway explicitly. */
export const DEFAULT_UOS_BASE_URL = "http://127.0.0.1:8000/v1";

export const GIT_TIMEOUT_MS = 120_000;

export const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

export const RUN_DEADLINE_MS = 3_600_000;

export const STEP_LIMIT = 64;

export const SESSION_DEADLINE_MS = 1_500_000;

export const REVIEW_SESSION_DEADLINE_MS = 1_200_000;

/** Applied runtime implementation model identity (route-selected default). */
export const DEFAULT_IMPLEMENTATION_MODEL = "gpt-reserve";

/** Default isolated client provider name (the primary gateway provider). */
export const DEFAULT_PROVIDER_NAME = "uos";

export const IMPLEMENTATION_REASONING = "max";

/** Private bound for a selectable implementation model id. */
export const MAX_MODEL_CHARS = 256;

/** A provider name safe as a TOML bare key and `model_providers` table name. */
export const PROVIDER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const UNAVAILABLE_DETAIL = "local target does not provide this capability";

export const STATIC_INVALID_OPTIONS =
  "local repair host rejected: host options are invalid";

export const STATIC_INVALID_CONTROLLER =
  "local repair host rejected: controller SHA is not an exact lowercase 40-hex commit SHA";

export const STATIC_ORPHAN =
  "local repair host refused: a prior run left an active session marker; orphan recovery is not reclaimed by time or process guess";

export const STATIC_UNSETTLED =
  "local repair host failed: owned model sessions did not settle; the session marker was retained";

export const STATIC_GIT_FAILED =
  "local repair host git command failed; output withheld";

export const STATIC_GIT_BOUND =
  "local repair host git command exceeded its bounded output";

export const STATIC_GITHUB_LOGIN =
  "local repair host rejected: authenticated GitHub login is unavailable";

export const STATIC_MODEL_INPUT =
  "local repair host rejected: model request is invalid";

export const STATIC_CHECKOUT =
  "local repair host rejected: isolated model checkout is unavailable";

export const STATIC_IMPORT =
  "local repair host failed: candidate objects could not be imported into the trusted source repository";

export const STATIC_MODEL_RESULT =
  "local repair host failed: the private model result receipt could not be persisted; no candidate was imported";

export const STATIC_LOCAL_CANDIDATE =
  "local candidate objects are unavailable for the exact task and head";

export const STATIC_RECEIPT_DIAGNOSTIC =
  "local model diagnostic persistence failed; the trusted completed receipt is preserved without a durability claim";

export const STATIC_MARKER =
  "local repair host failed: the session marker could not be cleared";

export const STATIC_LOCAL_PROVIDER =
  "local Codex client rejected: the route provider name is not a valid bare provider name";

export const STATIC_GITHUB_REPOSITORY =
  "GitHub port rejected: the composed repository identity is invalid";

// ---------------------------------------------------------------------------
// Unsupported capability ports (never successful empty fixtures)
// ---------------------------------------------------------------------------

/** Static unavailable result for every unsupported port call. */
export function unavailable<Value>(): PortResultV1<Value> {
  return portError("unavailable", UNAVAILABLE_DETAIL);
}

export const unavailableIncidents: IncidentAdapter = {
  listUnresolvedIncidents: (_cursor, _limit) =>
    Promise.resolve(unavailable<IncidentPageV1>()),
  readIncident: (_incidentId) =>
    Promise.resolve(unavailable<IncidentEvidenceV1 | null>()),
  readArtifact: (_ref, _maxBytes) =>
    Promise.resolve(unavailable<EncryptedArtifactV1 | null>()),
};

export const unavailableReplay: ReplayPort = {
  runReplay: (_request: ReplayRunRequestV1) =>
    Promise.resolve(unavailable<IsolatedReplayResultV1>()),
};
