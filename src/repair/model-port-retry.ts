/**
 * Gateway HTTP 429 resilience for one admitted model session.
 *
 * The port's single failover (primary model, then the failover model on the
 * same gateway) is not enough when a burst of cells reaches the gateway in the
 * same second: both attempts are throttled within a second while cells that
 * reach the model 30-90 s later succeed. After BOTH are throttled, and only
 * then, this module retries with bounded exponential backoff, alternating the
 * primary and the failover model, inside the SAME admission (no new charge)
 * and inside the session's remaining time budget. The jitter is derived from
 * the request identity (never `Math.random`), so a rerun of one task backs off
 * identically while sibling cells spread out.
 *
 * It also owns the one predicate that decides "provider throttled the whole
 * turn": the port uses it to start the failover/backoff, and the trusted
 * receipt consumers use it to settle a throttled run as transient
 * infrastructure instead of a no-progress model outcome.
 */
import type {
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { readModelBoundaryDiagnostic } from "./model-port-diagnostics.ts";
import { isRateLimitMessage, LOOP_STOP_MARKER } from "./model-port-policy.ts";

/** Retries after the throttled primary and failover attempts (never more). */
export const RATE_LIMIT_RETRY_LIMIT = 4;
/** First backoff floor; each later retry doubles it before the jitter. */
export const RATE_LIMIT_RETRY_BASE_DELAY_MS = 20_000;
/** No single backoff ever waits longer than this. */
export const RATE_LIMIT_RETRY_MAX_DELAY_MS = 120_000;
/**
 * Working window a retry must still have before the session bound once its
 * backoff has elapsed (capped by the session bound itself); a retry that could
 * only start a session the bound would cut off at once is not started.
 */
export const RATE_LIMIT_RETRY_MIN_WINDOW_MS = 120_000;

/**
 * Whether `receipt` is a whole failed runtime turn the provider throttled
 * (HTTP 429): a trusted failed receipt with an observed runtime terminal, no
 * candidate, not the host's own loop stop, whose provider error names rate
 * limiting or whose private structured CodexErrorInfo (readable only with the
 * exact request the receipt was produced for) carries HTTP 429 or the
 * rate-limit tag. Quota/usage limits, overload, timeouts, interrupts and
 * every other failure never qualify. A sanitized receipt projection (an
 * exported matrix receipt) carries neither signal and never qualifies.
 */
export function isProviderThrottledReceiptV1(
  receipt: ModelRunReceiptV1,
  request?: ModelRunRequestV1,
): boolean {
  if (
    receipt.outcome !== "failed" || receipt.candidate !== null ||
    receipt.actual.terminalOrigin !== "runtime" ||
    receipt.actual.observedTerminalStatus !== "failed" ||
    receipt.error === LOOP_STOP_MARKER
  ) return false;
  const diagnostic = request === undefined
    ? null
    : readModelBoundaryDiagnostic(receipt, request);
  // A definite structured HTTP status is authoritative over the prose: a
  // message that merely mentions rate limiting never reclassifies it.
  if (diagnostic !== null && diagnostic.httpStatusCode !== null) {
    return diagnostic.interruptCause === "none" &&
      (diagnostic.httpStatusCode === 429 ||
        diagnostic.errorCode === "model_rate_limit_exceeded");
  }
  if (
    diagnostic !== null && diagnostic.interruptCause === "none" &&
    diagnostic.errorCode === "model_rate_limit_exceeded"
  ) return true;
  return isRateLimitMessage(receipt.error);
}

/** {@link isProviderThrottledReceiptV1} over a port result. */
export function isProviderThrottledResultV1(
  result: PortResultV1<ModelRunReceiptV1>,
  request?: ModelRunRequestV1,
): boolean {
  return result.ok && isProviderThrottledReceiptV1(result.value, request);
}

/** FNV-1a (32-bit): deterministic, synchronous and dependency-free. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Backoff before retry `retryIndex` (0-based): the exponential floor
 * `base * 2^index` plus a deterministic jitter of up to one more floor,
 * derived from the exact task identity, capped at the maximum delay.
 * Retry 0 waits 20-40 s, retry 1 40-80 s, retry 2 80-120 s, retry 3 120 s.
 */
export function rateLimitRetryDelayMs(
  request: Pick<ModelRunRequestV1, "taskId" | "base" | "repository">,
  retryIndex: number,
): number {
  const floor = RATE_LIMIT_RETRY_BASE_DELAY_MS * 2 ** retryIndex;
  const repository = request.repository;
  const identity = [
    `${repository.owner}/${repository.name}#${repository.installationId}`,
    request.taskId,
    request.base,
    String(retryIndex),
  ].join("\n");
  const unit = fnv1a32(identity) / 0x1_0000_0000;
  return Math.min(
    RATE_LIMIT_RETRY_MAX_DELAY_MS,
    floor + Math.floor(unit * floor),
  );
}

/**
 * The session-budget anchor: the trusted caller's model start boundary when it
 * is a finite instant at or before `entered`, else `entered` itself (a later
 * or malformed anchor can never extend the budget).
 */
export function sessionBudgetAnchorV1(
  entered: number,
  anchor: number | undefined,
): number {
  return typeof anchor === "number" && Number.isFinite(anchor) &&
      anchor <= entered
    ? anchor
    : entered;
}

export interface RateLimitRetryInputV1 {
  /** The caller's validated request (names the primary model). */
  request: ModelRunRequestV1;
  /** Primary then failover model id; retries alternate starting with [0]. */
  models: readonly [string, string];
  /**
   * Absolute end of the session budget (session start + the request's
   * duration bound). No backoff and no retry window ever extends past it, so
   * the admission's own run-deadline fit still holds.
   */
  budgetEndsAt: number;
  /** The throttled failover result that opened the loop. */
  last: PortResultV1<ModelRunReceiptV1>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * One fresh self-consistent attempt that requests exactly `model` (its
   * receipt is certified by the verifier bound to that model) and whose
   * session is bounded to `windowMs`.
   */
  attempt(
    model: string,
    windowMs: number,
  ): Promise<PortResultV1<ModelRunReceiptV1>>;
}

/**
 * The window of the single immediate failover attempt after a throttled
 * primary: what remains of the session budget, never more than the request's
 * bound, or null when less than the minimum useful window (the retry minimum,
 * or half of a shorter bound) remains. The failover is then not started, so
 * the admission's run-deadline fit holds.
 */
export function failoverWindowMsV1(
  bound: number,
  budgetEndsAt: number,
  now: number,
): number | null {
  if (
    !Number.isSafeInteger(bound) || bound <= 0 ||
    !Number.isFinite(budgetEndsAt) || !Number.isFinite(now)
  ) return null;
  const windowMs = Math.min(bound, budgetEndsAt - now);
  const minWindowMs = Math.min(
    RATE_LIMIT_RETRY_MIN_WINDOW_MS,
    Math.floor(bound / 2),
  );
  return windowMs > 0 && windowMs >= minWindowMs ? Math.floor(windowMs) : null;
}

/**
 * Bounded retry after a throttled primary AND failover. Returns the first
 * result that is not provider throttling (success or any other failure, which
 * is never retried), or the last throttled result once the retry limit or the
 * session budget is reached.
 */
export async function retryRateLimitedV1(
  input: RateLimitRetryInputV1,
): Promise<PortResultV1<ModelRunReceiptV1>> {
  const { request } = input;
  const bound = request.maxDurationMs;
  if (
    !Number.isSafeInteger(bound) || bound <= 0 ||
    !Number.isFinite(input.budgetEndsAt)
  ) return input.last;
  const minWindowMs = Math.min(RATE_LIMIT_RETRY_MIN_WINDOW_MS, bound);
  let last = input.last;
  for (let index = 0; index < RATE_LIMIT_RETRY_LIMIT; index++) {
    const delayMs = rateLimitRetryDelayMs(request, index);
    if (input.now() + delayMs + minWindowMs > input.budgetEndsAt) break;
    const model = input.models[index % 2];
    console.error(
      `[sentinel] model gateway still rate limited (429); retry ` +
        `${index + 1}/${RATE_LIMIT_RETRY_LIMIT} with ${model} after ` +
        `${delayMs} ms backoff`,
    );
    try {
      await input.sleep(delayMs);
    } catch {
      break;
    }
    const windowMs = Math.min(bound, input.budgetEndsAt - input.now());
    if (!(windowMs >= minWindowMs)) break;
    last = await input.attempt(model, Math.floor(windowMs));
    if (!isProviderThrottledResultV1(last, request)) return last;
  }
  return last;
}
