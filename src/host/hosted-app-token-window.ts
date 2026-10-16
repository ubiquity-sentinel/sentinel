/**
 * Conservative validity window of the ONE App installation token a hosted
 * repair job mints at its start.
 *
 * GitHub expires an installation token one hour after it is created, while the
 * repair job may run for two. The App private key never reaches the runtime
 * (only the protected mint step reads it), so the token cannot be renewed in
 * flight. Instead the workflow records the runner instant immediately BEFORE
 * the mint step (a lower bound on the mint), the trusted launcher derives the
 * instant before which the token is certainly valid, and the runtime clamps
 * its one absolute run deadline to it, so no GitHub operation is planned past
 * that instant and the remaining work defers to the next run's fresh token.
 */

/** Workflow-recorded epoch milliseconds immediately before the repair mint. */
export const APP_TOKEN_MINTED_NOT_BEFORE_ENV =
  "SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE";

/** Child key: epoch milliseconds before which the App token is certainly valid. */
export const APP_TOKEN_NOT_AFTER_ENV = "SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER";

/**
 * GitHub's one-hour installation-token lifetime minus two minutes. The run
 * deadline derived from this window already keeps in-flight work inside it:
 * every target cycle's loop stops planning GitHub work `OPERATION_MARGIN_MS`
 * (five minutes) before the deadline, and no later target's preparation (an
 * authenticated clone or fetch) begins inside that margin either, so a step,
 * Git push or fetch begun just before it settles within its own bounded
 * timeout (at most two minutes); the mandatory review drain that runs up to
 * the deadline issues only bounded HTTP requests (`DEFAULT_HTTP_DEADLINE_MS`,
 * 30 seconds). The two minutes absorb that last request's latency; the mint
 * bound itself is a lower bound, so the token's real expiry is never earlier
 * than one hour after it.
 */
export const APP_TOKEN_SAFE_WINDOW_MS = 58 * 60 * 1000;

/**
 * The bound and the launcher clock are the same runner's wall clock, read
 * seconds apart; one minute absorbs a small clock step between the two reads
 * without letting a garbled or forged far-future bound stretch the window.
 */
export const APP_TOKEN_CLOCK_TOLERANCE_MS = 60 * 1000;

const STATIC_WINDOW = "hosted App token window is malformed";

/** Positive decimal epoch milliseconds only; never a sign, space or exponent. */
function parseEpochMs(text: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Launcher side: the child's not-after instant derived from the workflow's
 * recorded mint lower bound. Absent or blank means no window (legacy). A
 * malformed bound, or one later than the launcher's own clock beyond the
 * clock tolerance (a lower bound on a mint that already happened cannot lie
 * in the future), throws instead of guessing a window.
 */
export function deriveAppTokenNotAfterV1(
  mintedNotBefore: string | undefined,
  now: number,
): number | undefined {
  if (mintedNotBefore === undefined || mintedNotBefore === "") return undefined;
  const bound = parseEpochMs(mintedNotBefore);
  if (bound === null || bound > now + APP_TOKEN_CLOCK_TOLERANCE_MS) {
    throw new Error(STATIC_WINDOW);
  }
  return bound + APP_TOKEN_SAFE_WINDOW_MS;
}

/**
 * Runtime side: the forwarded not-after instant. Absent or blank means no
 * window, exactly as before; a malformed value throws before any setup.
 */
export function parseAppTokenNotAfterV1(
  text: string | undefined,
): number | undefined {
  if (text === undefined || text === "") return undefined;
  const value = parseEpochMs(text);
  if (value === null) throw new Error(STATIC_WINDOW);
  return value;
}
