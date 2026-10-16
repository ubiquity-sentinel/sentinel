/** Repair loop internals: bounds. */
import type { PortResultV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { MAX_REVIEW_TOTAL_MS } from "../github/codex-reviewer.ts";
import type {
  RepairCycleDepsV1,
  RepairCycleOptionsV1,
  RunBoundsV1,
  StepResultV1,
} from "./loop-types.ts";

// Private finite constants (no new env/secret/CLI surface is introduced).
export const INCIDENT_PAGE_LIMIT = 20;

/** Full structured-review bound (one start through bounded close). */
export const REVIEW_BOUND_MS = MAX_REVIEW_TOTAL_MS;

// Finite incident-scan page bound for the ACTUAL intake consumer. The gateway
// adapter's private readIncident scan enforces its own bounds, but those do
// not protect this pagination loop; a misbehaving producer (empty pages,
// never-terminating cursor, an injected frozen clock that never crosses the
// run deadline) must stop here instead of spinning. Same deterministic bound
// as the adapter's private scan (GATEWAY_MAX_SCAN_PAGES); local constant, no
// cross-module dependency and no new configuration surface.
export const MAX_INCIDENT_SCAN_PAGES = 128;

export const REVIEW_POLL_MS = 15 * 60_000;

export const CHECK_POLL_MS = 5 * 60_000;

export const RELEASE_POLL_MS = 5 * 60_000;

/**
 * Recheck interval for a native GitHub issue prerequisite that could not be
 * verified (closed/absent issue, unknown relations, parent or open native
 * blocker). One hour matches the polling cadence and costs no reservation:
 * the re-read happens on the next hourly poll.
 */
export const ISSUE_PREREQUISITE_RETRY_MS = 60 * 60_000;

/**
 * The one five-minute finalization margin. The entrypoint reserves it OUTSIDE
 * the loop deadline (the cycle receives hardDeadline - this margin) so the
 * mandatory bounded review drain fits before the caller/ceiling hard deadline;
 * per-operation fit checks inside the loop stay conservative.
 */
export const OPERATION_MARGIN_MS = 5 * 60_000;

export const DEFAULT_STEP_LIMIT = 32;

/** Fixed repair job ceiling (plan §4): 120 minutes. */
export const REPAIR_RUN_CEILING_MS = 120 * 60_000;

/** No NEW model work may start after 90 minutes of one run (plan §4). */
export const REPAIR_MODEL_CUTOFF_MS = 90 * 60_000;

export const MAX_OUTPUT_LIMIT_BYTES = 4096;

/**
 * Frozen gateway default model id. It is used ONLY when neither the trusted
 * host input nor the injected implementation port selects a route model: no
 * request ever keeps this literal while another id was actually requested.
 */
export const DEFAULT_MODEL_ID = "gpt-reserve" as const;

/** Private bound for a selectable runtime model id (same rule as the port). */
export const MAX_MODEL_CHARS = 256;

export const REASONING = "max" as const;

/** A nonempty, exactly-trimmed, bounded model id with no control characters. */
export function isSelectableModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_MODEL_CHARS) return false;
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * The route-selected implementation model id this loop submits in its
 * `ModelRunRequestV1`. Precedence: the trusted host input on the deps, then
 * the injected implementation port's own configured route model, then the
 * frozen gateway default. The port still validates that the submitted request
 * equals its configured id, so a disagreement fails closed (unavailable)
 * instead of silently swapping the model behind a receipt.
 */
export function implementationModelId(deps: RepairCycleDepsV1): string {
  if (isSelectableModelId(deps.modelId)) return deps.modelId;
  const injected = deps.model.modelId;
  if (isSelectableModelId(injected)) return injected;
  return DEFAULT_MODEL_ID;
}

export const MATRIX_IMPLEMENTATION_DEFERRED: StepResultV1 = {
  kind: "deferred",
  detail: "implementation admission belongs to the matrix planner",
};

export const MATRIX_ARTIFACT_DEFERRED: StepResultV1 = {
  kind: "deferred",
  detail: "implementation awaits its authenticated matrix artifact",
};

/**
 * A hosted ingest of a legacy record's candidate whose predecessor observation
 * was unavailable: the receipt is not consumed (see `handleModelReceipt`).
 */
export const MATRIX_PREDECESSOR_DEFERRED: StepResultV1 = {
  kind: "deferred",
  detail: "predecessor publication observation unavailable; receipt kept",
};

/**
 * Effective run bounds for one trusted run. The matrix planner and the repair
 * cycle share this exact construction so a planned cell can never run under
 * looser bounds than the run that admitted it.
 *
 * The caller-supplied deadline is clamped to the fixed run ceiling (the
 * stricter of the two always wins), and no NEW model work (implementation
 * start or review request) may start after the 90-minute cutoff. A NaN caller
 * deadline is not a bound at all (every comparison against NaN is false, so it
 * must never bypass the fixed ceiling): it is treated as unbounded and the
 * ceiling governs. The real clock is the wall clock; fakes advance it inside
 * port calls so a step that crosses the cutoff mid-flight still fails closed.
 * A trusted `runStartedAt` from the entrypoint anchors both bounds to the
 * ORIGINAL run start; it is never moved forward by a shortened deadline (a
 * future value is rejected).
 */
export function createRunBounds(
  deps: RepairCycleDepsV1,
  options: RepairCycleOptionsV1,
): RunBoundsV1 {
  const nowAtStart = deps.clock.now();
  const startedAt = options.runStartedAt !== undefined &&
      Number.isSafeInteger(options.runStartedAt) &&
      options.runStartedAt <= nowAtStart
    ? options.runStartedAt
    : nowAtStart;
  const callerDeadline = Number.isNaN(options.deadline)
    ? Number.POSITIVE_INFINITY
    : options.deadline;
  const runDeadline = Math.min(
    callerDeadline,
    startedAt + REPAIR_RUN_CEILING_MS,
  );
  // A trusted `false` from the host startup diagnostic keeps every existing
  // pre-admission guard intact but makes the model cutoff unreachable, so the
  // run can only do deterministic bookkeeping; budgets, records and the real
  // total run deadline are untouched.
  const modelCutoff = options.modelStartsEnabled === false
    ? Number.NEGATIVE_INFINITY
    : startedAt + REPAIR_MODEL_CUTOFF_MS;
  return { runDeadline, modelCutoff };
}

/**
 * Restricted trusted proof ref for an admission whose start was provably
 * never submitted because the run bounds were crossed during preparation.
 */
export function runBoundsProofRef(reservationId: string): string {
  return `artifact://sentinel/run-bounds/${reservationId}`;
}

/**
 * Restricted trusted proof ref for an admission whose start was provably
 * never submitted because the durable GitHub cooldown was discovered during
 * preparation. Same sanitized artifact-reference pattern as the run-bound
 * proof; no new storage/config surface.
 */
export function cooldownProofRef(reservationId: string): string {
  return `artifact://sentinel/github-cooldown/${reservationId}`;
}

// ---------------------------------------------------------------------------
// GitHub cooldown guard: the narrow loop-side check.
// ---------------------------------------------------------------------------

export type GithubCooldownCheckV1 =
  | { kind: "ok" }
  | { kind: "deferred"; detail: string }
  | { kind: "state_error"; detail: string };

/**
 * Narrow shared-gate check for one affected installation. An ordinary
 * rate_limited denial is a NORMAL cooldown deferral (the operation is skipped
 * and no source state is cleared or rewritten); a thrown gate, a latched
 * fault or any other denial kind is a state trust failure (state_error). The
 * injected gate is the exact same instance the trusted host gave the GitHub
 * client/token acquisition and the GitHubPort, so the loop guard prevents a
 * cooling installation from ever reaching a fake port or reserving a model.
 * The gate wait is awaited wall-clock time: AFTER it resolves, an otherwise
 * granted request whose wait crossed the total run deadline is a normal
 * deferral, so no intake/base read or publication/review/merge/closure begins
 * past the bound (a gate fault still retains state_error).
 */
export async function checkGithubCooldown(
  deps: RepairCycleDepsV1,
  repository: RepositoryIdentityV1,
  bounds: RunBoundsV1,
): Promise<GithubCooldownCheckV1> {
  let result: PortResultV1<void>;
  try {
    result = await deps.githubCooldown.beforeRequest(
      repository.installationId,
    );
  } catch {
    return {
      kind: "state_error",
      detail: "github cooldown gate unavailable",
    };
  }
  if (!result.ok) {
    if (result.error.kind === "rate_limited") {
      return { kind: "deferred", detail: "github cooldown active" };
    }
    return {
      kind: "state_error",
      detail: "github cooldown gate denied",
    };
  }
  if (deps.clock.now() >= bounds.runDeadline) {
    return {
      kind: "deferred",
      detail: "github cooldown wait crossed the run deadline",
    };
  }
  return { kind: "ok" };
}
