/** Hosted hosted-runtime-status responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { parseHostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { tryParse } from "../contracts/validation.ts";
import type { ReplayCommandResultV1 } from "../replay/runtime.ts";
import { isModelBoundaryReasonCode } from "../repair/model-port-diagnostics.ts";
import type { ChildStatusScanV1 } from "./hosted-runtime-diagnostics.ts";
import {
  ACCEPTED_CHILD_LOGINS,
  HOSTED_TERMINAL_LOOKING,
  isNonNegativeSafeInteger,
  MAX_DETAIL_CHARS,
  MAX_DIAGNOSTIC_LINE_CHARS,
  MAX_REVIEW_COMMAND_REFUSALS,
  MAX_REVIEW_TERMINAL_ADVISORIES,
} from "./hosted-runtime-identity.ts";
import type {
  ReviewCommandItemRefusalsV1,
  ReviewCommandItemRefusalV1,
  ReviewTerminalAdvisoriesV1,
  ReviewTerminalAdvisoryV1,
} from "./hosted-runtime-identity.ts";

/**
 * A child status record is one whole JSON line carrying a `status` property.
 * More than one, any malformed attempt at one, or any attempted
 * `hosted_runtime_terminal` record, is uncertain: the child can never attest
 * the wrapper's own terminal kind.
 */
export function scanChildStatusRecords(stdout: string): ChildStatusScanV1 {
  let found: unknown = null;
  let count = 0;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (HOSTED_TERMINAL_LOOKING.test(line)) return { kind: "uncertain" };
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // Any object-looking line that is not COMPLETE JSON is ambiguous
      // structured output, never ignored beside a valid record: a truncated
      // key, value or tail may hide a second record. Plain non-object text
      // noise is still skipped.
      if (line.startsWith("{")) return { kind: "uncertain" };
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    // ANY own status property is a top-level attempt: a false/null/number
    // status is rejected by the strict child parser, never skipped as noise.
    // The one exception is the runtime's exact refused-command advisory,
    // which can never parse as a child result.
    if (!Object.hasOwn(record, "status")) continue;
    if (isRefusedCommandItemAdvisory(record)) continue;
    count += 1;
    if (count === 1) found = record;
  }
  if (count === 0) return { kind: "none" };
  if (count > 1) return { kind: "uncertain" };
  return { kind: "one", value: found };
}

/**
 * The installed runtime's bounded reviewer advisory
 * (`reportRefusedCommandItem` in src/github/reviewer-session-state.ts) carries
 * the refused item's own `status`. Counting it made every run with one refused
 * reviewer command unavailable beside a valid record. Only the exact event and
 * key set is skipped; its keys exclude every child-result key but `status`, so
 * it can neither hide nor become a child record.
 */
const REFUSED_COMMAND_ITEM_KEYS = [
  "event",
  "site",
  "type",
  "status",
  "idBounded",
  "commandBounded",
  "commandChars",
  "hasActions",
  "cwdMatches",
  "source",
  "provenance",
  "pluginId",
  "scriptPath",
  "knownItem",
] as const;

function isRefusedCommandItemAdvisory(
  record: Record<string, unknown>,
): boolean {
  return record.event === "sentinel_review_command_item_refused" &&
    hasExactKeys(record, REFUSED_COMMAND_ITEM_KEYS);
}

/**
 * The only text a refused-command string field may carry into the job log:
 * closed allow-lists of the runtime's own site names and item types and of the
 * Codex app-server's command-execution status and source enums. Any other
 * value, including model- or Codex-controlled text, becomes "other".
 */
const REFUSAL_SITES: ReadonlySet<string> = new Set([
  "start",
  "duplicate-start",
  "completion",
  "completion-mismatch",
]);
const REFUSAL_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "other",
]);
const REFUSAL_STATUSES: ReadonlySet<string> = new Set([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);
const REFUSAL_SOURCES: ReadonlySet<string> = new Set([
  "agent",
  "userShell",
  "unifiedExecStartup",
  "unifiedExecInteraction",
]);

const REFUSAL_FLAG_KEYS = [
  "idBounded",
  "commandBounded",
  "hasActions",
  "cwdMatches",
  "knownItem",
] as const;

function refusalToken(value: string, allowed: ReadonlySet<string>): string {
  return allowed.has(value) ? value : "other";
}

function isPresence(value: unknown): value is "absent" | "present" {
  return value === "absent" || value === "present";
}

/**
 * Strict re-parse of one runtime refused-command advisory: the exact event and
 * key set, booleans, closed enums, a non-negative count or null. A value of any
 * other type refuses the whole line; a string field outside its closed
 * allow-list is kept only as "other". The result is rebuilt field by field, so
 * nothing the child printed is ever echoed.
 */
export function parseReviewCommandItemRefusal(
  value: unknown,
): ReviewCommandItemRefusalV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!isRefusedCommandItemAdvisory(record)) return null;
  const { site, type, status, source, commandChars, provenance } = record;
  if (typeof site !== "string" || typeof type !== "string") return null;
  if (status !== null && typeof status !== "string") return null;
  if (source !== null && typeof source !== "string") return null;
  if (!REFUSAL_FLAG_KEYS.every((key) => typeof record[key] === "boolean")) {
    return null;
  }
  if (commandChars !== null && !isNonNegativeSafeInteger(commandChars)) {
    return null;
  }
  if (provenance !== "agent-origin" && provenance !== "refused") return null;
  if (!isPresence(record.pluginId) || !isPresence(record.scriptPath)) {
    return null;
  }
  return {
    event: "sentinel_review_command_item_refused",
    site: refusalToken(site, REFUSAL_SITES),
    type: refusalToken(type, REFUSAL_TYPES),
    status: status === null ? null : refusalToken(status, REFUSAL_STATUSES),
    idBounded: record.idBounded as boolean,
    commandBounded: record.commandBounded as boolean,
    commandChars,
    hasActions: record.hasActions as boolean,
    cwdMatches: record.cwdMatches as boolean,
    source: source === null ? null : refusalToken(source, REFUSAL_SOURCES),
    provenance,
    pluginId: record.pluginId,
    scriptPath: record.scriptPath,
    knownItem: record.knownItem as boolean,
  };
}

/**
 * Every accepted refused-command advisory of one complete settled child
 * capture, capped at MAX_REVIEW_COMMAND_REFUSALS with the rest only counted.
 * Null when none was accepted. It never reads or affects the child record.
 */
export function scanReviewCommandItemRefusals(
  run: ReplayCommandResultV1,
): ReviewCommandItemRefusalsV1 | null {
  if (run.truncated || !run.settled) return null;
  if (run.outcome !== "exited" && run.outcome !== "timed_out") return null;
  const refusals: ReviewCommandItemRefusalV1[] = [];
  let dropped = 0;
  for (const rawLine of new TextDecoder().decode(run.stdout).split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const refusal = parseReviewCommandItemRefusal(value);
    if (refusal === null) continue;
    if (refusals.length < MAX_REVIEW_COMMAND_REFUSALS) refusals.push(refusal);
    else dropped += 1;
  }
  return refusals.length === 0 ? null : { refusals, dropped };
}

/**
 * The job-log lines for one capped advisory set: each refusal re-validated and
 * re-serialized in the runtime emitter's fixed key order, then one
 * dropped-count summary when the cap was reached. Neither line carries a
 * `kind`, so no job-log evidence scanner ever reads it.
 */
export function reviewCommandItemRefusalLines(
  advisories: ReviewCommandItemRefusalsV1,
): string[] {
  const lines: string[] = [];
  let dropped = isNonNegativeSafeInteger(advisories.dropped)
    ? advisories.dropped
    : 0;
  for (const candidate of advisories.refusals) {
    const refusal = parseReviewCommandItemRefusal(candidate);
    if (refusal === null) continue;
    if (lines.length >= MAX_REVIEW_COMMAND_REFUSALS) {
      dropped += 1;
      continue;
    }
    lines.push(JSON.stringify(Object.fromEntries(
      REFUSED_COMMAND_ITEM_KEYS.map((key) => [key, refusal[key]]),
    )));
  }
  if (dropped > 0) {
    lines.push(JSON.stringify({
      event: "sentinel_review_command_item_refusals_dropped",
      printed: lines.length,
      dropped,
    }));
  }
  return lines;
}

const REVIEW_TERMINAL_KEYS = [
  "event",
  "ownerRunId",
  "requestId",
  "invocationId",
  "threadId",
  "turnId",
  "terminalStatus",
  "durationMs",
  "errorPresent",
  "errorCode",
  "httpStatusCode",
] as const;
const REVIEW_TERMINAL_IDS = [
  "ownerRunId",
  "requestId",
  "invocationId",
  "threadId",
  "turnId",
] as const;

/** Exact closed observational fields only; never echo a child-authored object. */
export function parseReviewTerminalAdvisory(
  value: unknown,
): ReviewTerminalAdvisoryV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.event !== "sentinel_review_terminal" ||
    !hasExactKeys(record, REVIEW_TERMINAL_KEYS) ||
    !REVIEW_TERMINAL_IDS.every((key) =>
      typeof record[key] === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(record[key] as string)
    )
  ) return null;
  const {
    terminalStatus,
    durationMs,
    errorPresent,
    errorCode,
    httpStatusCode,
  } = record;
  if (
    terminalStatus !== "completed" && terminalStatus !== "failed" &&
    terminalStatus !== "interrupted"
  ) return null;
  if (durationMs !== null && !isNonNegativeSafeInteger(durationMs)) return null;
  if (typeof errorPresent !== "boolean") return null;
  if (
    errorPresent ? !isModelBoundaryReasonCode(errorCode) : errorCode !== null
  ) {
    return null;
  }
  if (
    httpStatusCode !== null &&
    (!errorPresent || !isNonNegativeSafeInteger(httpStatusCode) ||
      httpStatusCode > 65_535)
  ) return null;
  return Object.fromEntries(
    REVIEW_TERMINAL_KEYS.map((key) => [key, record[key]]),
  ) as unknown as ReviewTerminalAdvisoryV1;
}

/** Only complete settled captures can supply capped run-bound terminal advisories. */
export function scanReviewTerminalAdvisories(
  run: ReplayCommandResultV1,
  execution: HostedExecutionIntentV1,
): ReviewTerminalAdvisoriesV1 | null {
  if (run.truncated || !run.settled) return null;
  if (run.outcome !== "exited" && run.outcome !== "timed_out") return null;
  const terminals: ReviewTerminalAdvisoryV1[] = [];
  let dropped = 0;
  for (const line of new TextDecoder().decode(run.stdout).split("\n")) {
    if (
      line.length > MAX_DIAGNOSTIC_LINE_CHARS || !line.trim().startsWith("{")
    ) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const terminal = parseReviewTerminalAdvisory(value);
    if (terminal === null || terminal.ownerRunId !== execution.id) continue;
    if (terminals.length < MAX_REVIEW_TERMINAL_ADVISORIES) {
      terminals.push(terminal);
    } else dropped += 1;
  }
  return terminals.length === 0 ? null : { terminals, dropped };
}

/** Revalidate every field at the final printer; no arbitrary stdout pass-through. */
export function reviewTerminalAdvisoryLines(
  advisories: ReviewTerminalAdvisoriesV1,
): string[] {
  const lines: string[] = [];
  let dropped = isNonNegativeSafeInteger(advisories.dropped)
    ? advisories.dropped
    : 0;
  for (const candidate of advisories.terminals) {
    const terminal = parseReviewTerminalAdvisory(candidate);
    if (terminal === null) continue;
    if (lines.length < MAX_REVIEW_TERMINAL_ADVISORIES) {
      lines.push(JSON.stringify(terminal));
    } else dropped += 1;
  }
  if (dropped > 0) {
    lines.push(JSON.stringify({
      event: "sentinel_review_terminals_dropped",
      printed: lines.length,
      dropped,
    }));
  }
  return lines;
}

export interface ChildStatusV1 {
  /** Observed child startup flag; never derived from the wrapper outcome. */
  startupReady: boolean;
  /** Observed base SHA when it is a valid GitSha, else null. */
  baseSha: GitSha | null;
  /** The child reported a healthy-shaped successful outcome. */
  healthy: boolean;
  /**
   * The child's own closed state_error/source_error status and bounded authored
   * detail, or null for every healthy-shaped status. It never carries raw
   * stderr and can never change terminal, health, settlement or exit status.
   */
  failure: { status: "state_error" | "source_error"; detail: string } | null;
}

const CHILD_RESULT_KEYS = [
  "status",
  "outcome",
  "controllerSha",
  "baseSha",
  "login",
  "startupReady",
  "ciApproval",
  "execution",
] as const;

/**
 * Strict validation of the one printed `ActionsRepairHostResultV1` record. A
 * structurally invalid, foreign or mismatched record is null (uncertain); a
 * structurally valid record whose child reported an explicit failure maps to
 * failed. Health additionally requires the valid observed base SHA.
 */
export function parseChildStatus(
  value: unknown,
  execution: HostedExecutionIntentV1,
): ChildStatusV1 | null {
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, CHILD_RESULT_KEYS)) return null;
  if (record.status !== "ran") return null;
  const parsedExecution = tryParse(
    parseHostedExecutionIntentV1,
    record.execution,
  );
  if (!parsedExecution.ok) return null;
  if (
    canonicalStringify(parsedExecution.value) !== canonicalStringify(execution)
  ) {
    return null;
  }
  if (record.controllerSha !== execution.revision) return null;
  if (
    typeof record.login !== "string" ||
    !ACCEPTED_CHILD_LOGINS.includes(record.login)
  ) {
    return null;
  }
  if (typeof record.startupReady !== "boolean") return null;
  if (!isCiApproval(record.ciApproval)) return null;
  if (typeof record.baseSha !== "string") return null;
  const outcome = record.outcome;
  if (
    typeof outcome !== "object" || outcome === null || Array.isArray(outcome)
  ) {
    return null;
  }
  const status = (outcome as Record<string, unknown>).status;
  if (!isChildOutcome(outcome, status)) return null;

  const failure = status === "state_error" || status === "source_error"
    ? {
      status: status as "state_error" | "source_error",
      detail: (outcome as Record<string, unknown>).detail as string,
    }
    : null;
  return {
    startupReady: record.startupReady,
    baseSha: isGitSha(record.baseSha) ? record.baseSha : null,
    healthy: record.startupReady === true &&
      (status === "idle" || status === "margin" || status === "step_limit"),
    failure,
  };
}

function isChildOutcome(value: unknown, status: unknown): boolean {
  if (typeof status !== "string") return false;
  const record = value as Record<string, unknown>;
  if (status === "step_limit") {
    return hasExactKeys(record, ["status", "steps"]) &&
      isNonNegativeSafeInteger(record.steps);
  }
  if (
    status === "idle" || status === "margin" || status === "state_error" ||
    status === "source_error"
  ) {
    return hasExactKeys(record, ["status", "detail"]) &&
      typeof record.detail === "string" && record.detail.length > 0 &&
      record.detail.length <= MAX_DETAIL_CHARS;
  }
  return false;
}

function isCiApproval(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["approved", "pending", "unavailable"])) {
    return false;
  }
  return isNonNegativeSafeInteger(record.approved) &&
    isNonNegativeSafeInteger(record.pending) &&
    isNonNegativeSafeInteger(record.unavailable);
}

export function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(record);
  return own.length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key));
}
