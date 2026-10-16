/**
 * Repair loop internals: bounded base-refresh failure accounting.
 *
 * Every failed execution of one exact base-refresh intent is recorded on that
 * same intent with a closed kind and detail, and the record blocks terminally
 * after MAX_BASE_REFRESH_FAILURES consecutive failures. The one exception is a
 * genuine authentication failure of THIS job's GitHub credential, which is a
 * per-job condition and persists nothing.
 */
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import { CHECK_POLL_MS } from "./loop-bounds.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  clearIntent,
  markTerminalBlocked,
  setIntent,
  setWait,
} from "./transitions.ts";

/**
 * Consecutive failed executions of one exact base-refresh intent that are
 * tolerated before the record blocks. The intent is re-armed at most
 * MAX_BASE_REFRESH_FAILURES - 1 times, so no refresh can hold a slot in a
 * silent `unavailable` loop forever.
 */
export const MAX_BASE_REFRESH_FAILURES = 3;

/** Closed failure details stored in the bounded base-refresh failure record. */
export const BASE_REFRESH_CAPABILITY_DETAIL =
  "base refresh port is unavailable";

export const BASE_REFRESH_PR_OBSERVATION_DETAIL =
  "own pull request could not be observed";

export const BASE_REFRESH_UNPREPARED_DETAIL =
  "prepared candidate could not be generated";

export const BASE_REFRESH_BASE_READ_DETAIL =
  "configured base could not be observed";

export const BASE_REFRESH_PRESERVE_DETAIL = "candidate could not be preserved";

export const BASE_REFRESH_REF_READ_DETAIL =
  "candidate ref could not be observed";

export const BASE_REFRESH_PUSH_DETAIL = "prepared candidate was not published";

export const BASE_REFRESH_FOREIGN_HEAD_DETAIL =
  "candidate ref carries an unrelated head";

/**
 * Closed suffix of a counted `auth_failed` that is NOT a credential failure
 * (a 403 permission refusal). It keeps that terminal block distinct from the
 * exact credential-expiry blockers older runtimes wrote, which the launcher
 * may re-admit; a permission refusal stays a visible terminal block.
 */
const BASE_REFRESH_PERMISSION_SUFFIX = " (permission refused)";

/**
 * Static deferral detail for a refresh whose GitHub credential was refused.
 * The repair job's installation token is short-lived and can expire mid-job,
 * so a genuine authentication failure describes this job's credential, never
 * the pull request, branch or base: it is not a failed execution.
 */
const BASE_REFRESH_AUTH_DEFERRED =
  "base refresh deferred: GitHub credential unavailable for this job";

/**
 * The exact `auth_failed` details that are a genuine failure of this job's
 * credential: the REST client's 401 (also used when its auth provider
 * throws), a refused installation-token exchange, and an unavailable host
 * credential closure. The REST client ALSO maps every non-rate-limit 403 to
 * `auth_failed` ("GitHub API request was forbidden"): that is a lasting
 * permission refusal, never a credential expiry, and is not listed here.
 */
const GITHUB_CREDENTIAL_FAILURE_DETAILS: ReadonlySet<string> = new Set([
  "GitHub API authentication failed",
  "installation token request was rejected",
  "provider credentials are unavailable",
]);

/**
 * One failed base-refresh port call. `detail` is the closed constant that is
 * persisted; `portDetail` is the original port error detail, consulted in
 * memory only to classify an `auth_failed` and never stored.
 */
export interface BaseRefreshFailureV1 {
  kind: string;
  detail: string;
  portDetail?: string;
}

/** True only for a genuine authentication failure of this job's credential. */
function isCredentialFailure(failure: BaseRefreshFailureV1): boolean {
  return failure.kind === "auth_failed" &&
    failure.portDetail !== undefined &&
    GITHUB_CREDENTIAL_FAILURE_DETAILS.has(failure.portDetail);
}

/**
 * One failed execution of the exact base-refresh intent.
 *
 * The bounded failure record is written with the SAME intent — same key, same
 * observedBase, same persisted prepared result — so the state ref alone shows
 * why the refresh cannot finish: only the closed port error kind and a closed
 * detail constant are stored, never raw upstream text. The wait is re-armed
 * only while the consecutive failure count is under MAX_BASE_REFRESH_FAILURES;
 * at the bound the intent is cleared and the record blocks with the classified
 * message, so a livelocked refresh becomes a visible blocker instead of an
 * endless `unavailable` wait. Target, counters, evidence and reviews are
 * preserved.
 *
 * A genuine authentication failure of this job's credential (see
 * `isCredentialFailure`) is the one exception: it persists NOTHING (no
 * failure attempt, no wait, no blocker) and returns a bounded deferral. The
 * cycle skips the record for the rest of this job, and the next job's fresh
 * credential resumes the exact durable intent (including an already
 * persisted prepared result), so a credential expiry never accumulates toward
 * the terminal block. Every other `auth_failed` counts, with the closed
 * permission suffix on its detail.
 */
export function failBaseRefresh(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  intent: IncompleteOperationV1,
  failure: BaseRefreshFailureV1,
): Promise<StepResultV1> {
  if (isCredentialFailure(failure)) {
    return Promise.resolve({
      kind: "deferred",
      detail: BASE_REFRESH_AUTH_DEFERRED,
    });
  }
  const detail = failure.kind === "auth_failed"
    ? `${failure.detail}${BASE_REFRESH_PERMISSION_SUFFIX}`
    : failure.detail;
  const at = deps.clock.now();
  const attempts = (intent.failure?.attempts ?? 0) + 1;
  if (attempts >= MAX_BASE_REFRESH_FAILURES) {
    return persistWork(
      deps,
      context,
      clearIntent(
        markTerminalBlocked(
          record,
          "other",
          `base refresh failed ${attempts} consecutive times: ${failure.kind} ${detail}`,
          at,
        ),
        at,
      ),
    );
  }
  return persistWork(
    deps,
    context,
    setWait(
      setIntent(
        record,
        {
          ...intent,
          failure: { kind: failure.kind, detail, atMs: at, attempts },
        },
        at,
      ),
      { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
      at,
    ),
  );
}
