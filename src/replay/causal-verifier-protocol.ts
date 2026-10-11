import type { RetainedGatewayCaptureV1 } from "../adapters/gateway/decrypt.ts";
import type { CausalExecutionObservationV1 } from "./causal-proof.ts";
import type { ExpectedFailureV1, ReplayFixtureEntryV1 } from "./fixture.ts";
import type { ReplayCommandResultV1 } from "./runtime.ts";

const MAX_TEST_IDS = 64;
const TEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_FAILURE_REASON_BYTES = 512;
/**
 * The ONE supported safe failure protocol for this narrow local consumer:
 * stdout is exactly one `sentinel-replay-test:<id>\n` line per trusted id in
 * trusted order, followed by exactly this single fixed failure line, with
 * empty stderr and exit code 1. The only accepted expected-failure matcher
 * is the fixed contains matcher over `SAFE_CONSUMER_FAILURE_TEXT`; any other
 * matcher is rejected before anything runs, so the classifier never matches
 * arbitrary output content and never hashes anything but the exact
 * validated safe protocol bytes.
 */
const SAFE_CONSUMER_FAILURE_TEXT = "stream terminated unexpectedly";
const SAFE_CONSUMER_FAILURE_LINE =
  `sentinel-causal-failure:${SAFE_CONSUMER_FAILURE_TEXT}`;

export async function classifyObservation(
  run: ReplayCommandResultV1,
  testIds: readonly string[],
): Promise<CausalExecutionObservationV1 | null> {
  if (run.outcome !== "exited" || !run.settled || run.truncated) {
    return null;
  }
  if (run.exitCode !== 1) return null;
  if (run.stderr.byteLength !== 0) return null;
  const expectedStdout = encode(
    testIds.map((id) => `sentinel-replay-test:${id}\n`).join("") +
      `${SAFE_CONSUMER_FAILURE_LINE}\n`,
  );
  if (!bytesEqual(run.stdout, expectedStdout)) return null;
  const outputDigest = await sha256Hex(run.stdout);
  return {
    intended: true,
    outputDigest,
    observedTestIds: [...testIds],
    exitCode: 1,
  };
}
export function exitedOk(result: ReplayCommandResultV1): boolean {
  return result.outcome === "exited" && result.exitCode === 0 &&
    result.settled;
}

/** A consumer run is settled only when it exited and its owned group was
 * proved empty and its streams were bound within the deadline. */
export function runSettled(run: ReplayCommandResultV1): boolean {
  return run.outcome === "exited" && run.settled;
}

/**
 * True when an unfinished run could not be proved clean (the runtime's
 * `timed_out` with `settled: false`): the restricted scratch MUST be
 * preserved. A settled timeout (group empty after termination) is not
 * uncertainty.
 */
export function uncertainRun(run: ReplayCommandResultV1): boolean {
  return run.outcome !== "exited" && !run.settled;
}

export function validTestIds(ids: readonly unknown[]): boolean {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_TEST_IDS) {
    return false;
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !TEST_ID_RE.test(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  return true;
}

export function validExpectedFailure(
  value: unknown,
): value is ExpectedFailureV1 {
  if (value === null || typeof value !== "object") return false;
  const expected = value as ExpectedFailureV1;
  if (
    typeof expected.reason !== "string" || expected.reason.length === 0 ||
    expected.reason.length > MAX_FAILURE_REASON_BYTES ||
    /[\r\n\t]/.test(expected.reason)
  ) {
    return false;
  }
  // The ONLY supported safe expectation for this narrow local consumer is
  // the fixed contains matcher over the exact supported failure text: any
  // arbitrary text or regex matcher is rejected before anything runs, so
  // the classifier below never matches arbitrary output content.
  return expected.match.kind === "contains" &&
    expected.match.text === SAFE_CONSUMER_FAILURE_TEXT;
}

/**
 * The composed bundle must be exactly the two fixed consumer paths; nothing
 * more, nothing less (so the sanitized snapshot is the exact composed bundle
 * and the consumer protocol is fixed).
 */
export function isSafeFixtureEntries(
  entries: readonly ReplayFixtureEntryV1[],
): boolean {
  if (!Array.isArray(entries) || entries.length !== 2) return false;
  const paths = new Set(entries.map((entry) => entry.path));
  return paths.size === 2;
}

export function entryBytes(
  entries: readonly ReplayFixtureEntryV1[],
  path: string,
): Uint8Array | null {
  for (const entry of entries) {
    if (entry.path === path) return entry.bytes;
  }
  return null;
}

export function copyExpectedFailure(
  expected: ExpectedFailureV1,
): ExpectedFailureV1 {
  return expected.match.kind === "contains"
    ? { ...expected, match: { kind: "contains", text: expected.match.text } }
    : { ...expected, match: { kind: "regex", source: expected.match.source } };
}

/** Plain structural copy of the private upstream (canonical-serializable). */
export function plainUpstream(
  upstream: RetainedGatewayCaptureV1["upstream"],
): Record<
  string,
  unknown
> {
  return {
    version: upstream.version,
    attempts: upstream.attempts.map((attempt) => ({
      provider: attempt.provider,
      status: attempt.status,
      content_type: attempt.content_type,
      chunks_base64: [...attempt.chunks_base64],
      terminal: attempt.terminal,
    })),
    attempts_truncated: upstream.attempts_truncated,
    bytes_truncated: upstream.bytes_truncated,
    chunks_truncated: upstream.chunks_truncated,
  };
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** FATAL UTF-8 decode: malformed bytes mean no classification, no write. */
export function decodeFatal(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Git diagnostic decoding (ASCII/hex output; non-fatal on locale text). */
export function decodeGit(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
