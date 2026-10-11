/** Hosted hosted-runtime-diagnostics responsibility. */
import { stripVTControlCharacters } from "node:util";
import { EARLY_FAILURE_FRAME_LABELS } from "./hosted-runtime-frame-labels.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { ReplayCommandResultV1 } from "../replay/runtime.ts";
import { parseLocalModelDiagnosticV1 } from "./local.ts";
import {
  MAX_DIAGNOSTIC_LINE_CHARS,
  MAX_HOSTED_DIAGNOSTICS,
} from "./hosted-runtime-identity.ts";
import type {
  HostedModelDiagnosticV1,
  HostedRuntimeEarlyFailureCategoryV1,
  HostedRuntimeEarlyFailureReasonV1,
  HostedRuntimeEarlyFailureV1,
  HostedRuntimeLauncherResultV1,
} from "./hosted-runtime-identity.ts";
import { scanChildStatusRecords } from "./hosted-runtime-status.ts";

/** Bound on the retained stderr prefix inspected for one early-failure summary. */
const MAX_EARLY_FAILURE_STDERR_BYTES = 16 * 1024;

/** Bound on the sanitized frame locations carried by one summary. */
const MAX_EARLY_FAILURE_FRAMES = 6;

/** Bound on one sanitized `basename:line:column` location. */
const MAX_EARLY_FAILURE_FRAME_CHARS = 80;

/**
 * A trailing `basename:line:column` (optionally inside a closing parenthesis)
 * is the only stderr fragment this summary ever reads, and the basename must
 * additionally be one of the closed code-owned labels below. A URL, an absolute
 * host path, a bearer value, a credential-shaped token or any other arbitrary
 * text can therefore never be emitted as a frame label.
 */
const EARLY_FAILURE_FRAME_PATTERN =
  /([A-Za-z0-9._-]+):(\d{1,7}):(\d{1,7})\)?[ \t]*$/;

/** Closed-category classification over patterns only; no stderr text is kept. */
function classifyEarlyChildFailure(
  stderr: string,
): HostedRuntimeEarlyFailureCategoryV1 {
  const value = stderr.toLowerCase();
  if (
    value.includes("cannot find module") ||
    value.includes("module not found")
  ) {
    return "module_not_found";
  }
  if (
    value.includes("permission denied") ||
    value.includes("operation not permitted")
  ) {
    return "permission_denied";
  }
  if (
    value.includes("address already in use") || value.includes("eaddrinuse")
  ) {
    return "address_in_use";
  }
  if (value.includes("unauthorized") || value.includes("401")) {
    return "unauthorized";
  }
  if (value.includes("forbidden") || value.includes("403")) return "forbidden";
  if (
    value.includes("certificate") || value.includes("tls") ||
    value.includes("ssl")
  ) {
    return "tls";
  }
  if (
    value.includes("getaddrinfo") ||
    value.includes("name or service not known") || value.includes("dns")
  ) {
    return "dns";
  }
  if (value.includes("timed out") || value.includes("timeout")) {
    return "timeout";
  }
  if (value.includes("no space left")) return "no_space";
  if (value.includes("syntaxerror")) return "syntax";
  if (value.includes("uncaught") || value.includes("unhandled")) {
    return "uncaught";
  }
  if (
    value.includes("sigkill") || value.includes("sigterm") ||
    value.includes("killed")
  ) {
    return "signalled";
  }
  return "unknown";
}

/**
 * Finite map of exact pre-status throw literals in the deployed child runtime
 * (`ac98dc80f`): the named high-value abort sources only, read from those
 * modules' own constants. Exact payload equality is required; every other
 * message, including credential-shaped, path, URL or arbitrary text, stays
 * null.
 */
const EARLY_FAILURE_REASON_BY_LITERAL: readonly (
  readonly [string, HostedRuntimeEarlyFailureReasonV1]
)[] = [
  [
    "local repair host git command failed; output withheld",
    "local_git_command_failed",
  ],
  [
    "local repair host git command exceeded its bounded output",
    "local_git_output_bound",
  ],
  [
    "committed target setting is not a valid repository slug array",
    "targets_invalid",
  ],
  ["committed target setting lists no repository", "targets_empty"],
  [
    "hosted repair host requires its configured credentials",
    "repair_credentials_unavailable",
  ],
  [
    "hosted repair host could not read an exact controller commit",
    "repair_controller_unavailable",
  ],
  [
    "hosted repair host could not resolve Codex",
    "repair_executable_unavailable",
  ],
  [
    "hosted repair host sessions did not settle",
    "repair_sessions_unsettled",
  ],
  [
    "hosted repair host rejected: SENTINEL_APP_INSTALLATION_ID is not a positive safe integer",
    "repair_installation_scope_invalid",
  ],
  [
    "hosted repair host reached its run deadline before addressing any target",
    "repair_deadline_reached",
  ],
  [
    "historical matrix custody unavailable",
    "historical_custody_unavailable",
  ],
  [
    "C recovery authoritative state unavailable",
    "c_recovery_state_unavailable",
  ],
];

/** Actual Deno uncaught rendering of an Error, TypeError or RangeError. */
const EARLY_FAILURE_UNCAUGHT_ERROR_PATTERN =
  /^error: Uncaught (?:\(in promise\) )?(?:Error|TypeError|RangeError): (.+)$/;

/** Actual Deno uncaught rendering of a literal string throw. */
const EARLY_FAILURE_UNCAUGHT_STRING_PATTERN =
  /^error: Uncaught (?:\(in promise\) )?"(.*)"$/;

/**
 * Closed reason code for one exact known code-owned abort literal, else null.
 * The line must carry the actual Deno uncaught prefix and its captured payload
 * is compared by exact equality against the finite map, so no partial,
 * arbitrary or credential-shaped message can ever become a code.
 */
function earlyChildFailureReason(
  stderr: string,
): HostedRuntimeEarlyFailureReasonV1 | null {
  for (const rawLine of stderr.split("\n")) {
    const line = rawLine.trim();
    const match = EARLY_FAILURE_UNCAUGHT_ERROR_PATTERN.exec(line) ??
      EARLY_FAILURE_UNCAUGHT_STRING_PATTERN.exec(line);
    if (match === null) continue;
    const literal = match[1];
    for (const [text, code] of EARLY_FAILURE_REASON_BY_LITERAL) {
      if (literal === text) return code;
    }
  }
  return null;
}

/** Bounded, deduplicated locations from actual `at ` frames of known files. */
function earlyChildFailureFrames(stderr: string): string[] {
  const frames: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of stderr.split("\n")) {
    if (frames.length >= MAX_EARLY_FAILURE_FRAMES) break;
    const line = rawLine.trim();
    if (!line.startsWith("at ")) continue;
    const match = EARLY_FAILURE_FRAME_PATTERN.exec(line);
    if (match === null) continue;
    // Only code-owned basenames are ever emitted; an unknown or
    // credential-shaped label yields no frame at all (category only).
    if (!EARLY_FAILURE_FRAME_LABELS.has(match[1])) continue;
    const frame = `${match[1]}:${match[2]}:${match[3]}`;
    if (frame.length > MAX_EARLY_FAILURE_FRAME_CHARS) continue;
    if (seen.has(frame)) continue;
    seen.add(frame);
    frames.push(frame);
  }
  return frames;
}

/**
 * Sanitized advisory summary for exactly the genuine early-abort path: a
 * settled, untruncated nonzero child exit whose stdout carried no status record
 * and whose resolved terminal is the honest failure. Any other disposition —
 * success, unavailability, truncated, unsettled, timeout, or a preserved child
 * record — yields null, so the summary can never mint success or replace
 * observed child metadata.
 */
export function earlyChildFailureDiagnostic(
  result: HostedRuntimeLauncherResultV1,
  run: ReplayCommandResultV1,
): HostedRuntimeEarlyFailureV1 | null {
  if (result.status !== "failed" || result.terminal === null) return null;
  if (run.truncated || !run.settled || run.outcome !== "exited") return null;
  if (run.exitCode === null || run.exitCode === 0) return null;
  const scan = scanChildStatusRecords(new TextDecoder().decode(run.stdout));
  if (scan.kind !== "none") return null;
  const retained = new TextDecoder().decode(
    run.stderr.slice(0, MAX_EARLY_FAILURE_STDERR_BYTES),
  );
  // Nothing was retained on the error stream: there is no abort site to
  // summarize, so the existing empty-stderr result stays exactly as it was.
  if (retained.trim().length === 0) return null;
  // Terminal control sequences can wrap or hide the real Deno abort text and
  // its stack frames; strip them from the already-bounded prefix before any
  // classification or frame parsing. Only the stripped text is inspected, so
  // no control sequence can reach a category, frame or reason code.
  const stderr = stripVTControlCharacters(retained);
  return {
    version: "v1",
    kind: "hosted_runtime_early_failure",
    advisory: true,
    exitCode: run.exitCode,
    category: classifyEarlyChildFailure(stderr),
    frames: earlyChildFailureFrames(stderr),
    reasonCode: earlyChildFailureReason(stderr),
  };
}

export function scanChildDiagnostics(
  run: ReplayCommandResultV1,
  execution: HostedExecutionIntentV1,
): HostedModelDiagnosticV1[] {
  if (run.truncated || !run.settled) return [];
  if (run.outcome !== "exited" && run.outcome !== "timed_out") return [];
  const found: HostedModelDiagnosticV1[] = [];
  const stdout = new TextDecoder().decode(run.stdout);
  for (const rawLine of stdout.split("\n")) {
    if (found.length >= MAX_HOSTED_DIAGNOSTICS) break;
    const line = rawLine.trim();
    if (line.length === 0 || line.length > MAX_DIAGNOSTIC_LINE_CHARS) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const diagnostic = parseLocalModelDiagnosticV1(value);
    if (diagnostic === null) continue;
    found.push({
      version: "v1",
      kind: "hosted_model_diagnostic",
      advisory: true,
      execution,
      diagnostic,
    });
  }
  return found;
}

export type ChildStatusScanV1 =
  | { kind: "none" }
  | { kind: "one"; value: unknown }
  | { kind: "uncertain" };

/**
 * Incremental advisory stream over the RETAINED child stdout chunks. Complete
 * lines are strictly re-parsed through the shared allow-list and stamped with
 * the already-verified execution intent, exactly like the final capture scan;
 * a partial line is bounded by the same line limit, an oversized line is
 * discarded through its newline (a parseable-looking suffix is never
 * interpreted), and UTF-8 sequences split across chunks are decoded with the
 * decoder's own carry-over. Malformed, forged, private, incomplete and stderr
 * bytes never produce a summary. Nothing here is evidence: a streamed advisory
 * can precede a later truncation that leaves the final list empty, and it
 * never affects settlement, health, the trusted terminal or the exit status.
 * A throwing sink is swallowed so an advisory can never disturb the run.
 */
export function createHostedDiagnosticStream(
  execution: HostedExecutionIntentV1,
  sink: (diagnostic: HostedModelDiagnosticV1) => void,
): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let partial = "";
  let discarding = false;
  let accepted = 0;
  return (chunk) => {
    if (accepted >= MAX_HOSTED_DIAGNOSTICS) return;
    const text = decoder.decode(chunk, { stream: true });
    let index = 0;
    while (index < text.length) {
      if (discarding) {
        // Only the newline that ends the oversized line resumes parsing; the
        // discarded bytes are never inspected, not even their suffix.
        const newline = text.indexOf("\n", index);
        if (newline < 0) return;
        discarding = false;
        index = newline + 1;
        continue;
      }
      const newline = text.indexOf("\n", index);
      if (newline < 0) {
        const rest = text.slice(index);
        if (partial.length + rest.length > MAX_DIAGNOSTIC_LINE_CHARS) {
          partial = "";
          discarding = true;
        } else {
          partial += rest;
        }
        return;
      }
      const line = `${partial}${text.slice(index, newline)}`.trim();
      partial = "";
      index = newline + 1;
      if (line.length === 0 || line.length > MAX_DIAGNOSTIC_LINE_CHARS) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const diagnostic = parseLocalModelDiagnosticV1(value);
      if (diagnostic === null) continue;
      accepted += 1;
      try {
        sink({
          version: "v1",
          kind: "hosted_model_diagnostic",
          advisory: true,
          execution,
          diagnostic,
        });
      } catch {
        // Advisory only: a throwing sink can never disturb the child run.
      }
      if (accepted >= MAX_HOSTED_DIAGNOSTICS) return;
    }
  };
}
