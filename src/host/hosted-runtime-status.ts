/** Hosted hosted-runtime-status responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { parseHostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { tryParse } from "../contracts/validation.ts";
import type { ChildStatusScanV1 } from "./hosted-runtime-diagnostics.ts";
import {
  ACCEPTED_CHILD_LOGINS,
  HOSTED_TERMINAL_LOOKING,
  isNonNegativeSafeInteger,
  MAX_DETAIL_CHARS,
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
