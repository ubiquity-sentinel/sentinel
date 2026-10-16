/** Internal finite bounds, protocol validation and static error policy. */
import { CodexProtocolError } from "./codex-transport.ts";

/** Max model task prompt characters (private finite bound). */
export const MAX_PROMPT_CHARS = 32_000;
/** Max issue body characters carried into the session (private finite bound). */
export const MAX_ISSUE_BODY_CHARS = 8_000;
/** Expected checkpoint ref on the model checkout, if the model recorded one. */
export const CHECKPOINT_REF = "refs/sentinel/checkpoint";

/** Sanitized loop-stop marker recorded through the receipt error path. */
export const LOOP_STOP_MARKER = "failed_command_loop" as const;

/** Fixed corrective steer text: trusted fixed prose plus a sanitized digest. */
export const STEER_TEXT =
  "The last commands produced the same verified failure. Inspect the saved " +
  "failure evidence and change your approach; repeating the failing command " +
  "will be stopped.";

/**
 * Nonlocal-only steer: focused repository tests remain allowed. The exact local
 * host scope suppresses this sentence so the owner's local-iteration directive
 * is never contradicted by an older tests-allowed instruction.
 */
export const FOCUSED_TESTS_ALLOWED =
  " Focused repository tests and the necessary source context they need " +
  "remain allowed.";

// Private finite bounds for the observation pipeline (no new config surface).
export const MAX_ITEM_ID_CHARS = 256;
export const MAX_COMMAND_CHARS = 4096;
export const MAX_CWD_CHARS = 4096;
export const MAX_OUTPUT_CHARS = 64 * 1024; // 64Ki characters; larger output is inconclusive
export const MAX_PENDING_OBSERVATIONS = 16;
export const MAX_UNIQUE_ITEM_IDS = 1024;
export const MAX_ACTIVE_COMMAND_IDS = 16;
/** Settle deadline from ANY interrupt: grace from the request, never the old ceiling. */
export const SETTLE_GRACE_MS_EXTRA = 1;
/** Bound for thread/turn/reroute identity strings; larger identities are never accepted. */
export const MAX_ID_CHARS = 256;
/** Bound for the configured provider name (nonempty finite string). */
export const MAX_PROVIDER_CHARS = 256;
/** Bounded complete correlated routing events retained, oldest first. */
export const MAX_REROUTES = 16;
/** Bounded correlated successful output items retained. */
export const MAX_RESULT_ITEMS = 8;
/** Private bound for one file-change change path (nonempty per schema). */
export const MAX_FILE_CHANGE_PATH_CHARS = 1024;
/** Private bound for one file-change diff text (presence only; never stored). */
export const MAX_FILE_CHANGE_DIFF_CHARS = 256 * 1024;
/** Private bound for changes entries inside one file-change item. */
export const MAX_CHANGES_PER_ITEM = 256;
/** Private bound for one command item's best-effort parsed actions array. */
export const MAX_COMMAND_ACTIONS = 64;
/**
 * The frozen default (gateway) runtime model id used only when the caller does
 * not configure a route-selected id; no fallback is ever synthesized.
 */
export const DEFAULT_MODEL_ID = "gpt-reserve";
/** The frozen runtime reasoning effort; no fallback is ever synthesized. */
export const REQUIRED_REASONING_EFFORT = "max";
/** Private bound for a configured/requested runtime model id. */
export const MAX_MODEL_CHARS = 256;
/**
 * Trusted named permission profile: a host-defined name only. Built-in
 * full-access mode identifiers are never accepted as a named profile binding.
 */
export const PERMISSION_PROFILE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const BUILTIN_FULL_ACCESS_PERMISSION_PROFILE_IDS = new Set([
  "full-access",
  "danger-full-access",
]);

/** A nonempty bounded identity (thread/turn/reroute/id strings). */
export function isBoundedId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_CHARS;
}

/**
 * Schema-shaped completed file-change output proof per the installed
 * ThreadItem schema: status is exactly `completed` and `changes` is a nonempty
 * bounded array whose entries carry the required `path` (nonempty bounded),
 * `kind` ({type: add|delete|update}) and `diff` (bounded string) fields.
 * Failed/declined/missing-status/empty-or-malformed changes can never prove
 * output.
 */
export function hasValidCompletedChanges(
  item: Record<string, unknown>,
): boolean {
  if (item.status !== "completed") return false;
  const changes = item.changes;
  if (!Array.isArray(changes) || changes.length === 0) return false;
  if (changes.length > MAX_CHANGES_PER_ITEM) return false;
  for (const raw of changes) {
    const change = raw as Record<string, unknown> | null;
    if (typeof change !== "object" || change === null) return false;
    const path = change.path;
    if (
      typeof path !== "string" || path.trim().length === 0 ||
      path.length > MAX_FILE_CHANGE_PATH_CHARS
    ) {
      return false;
    }
    const kind = change.kind as Record<string, unknown> | null;
    if (typeof kind !== "object" || kind === null) return false;
    if (
      kind.type !== "add" && kind.type !== "delete" && kind.type !== "update"
    ) {
      return false;
    }
    const diff = change.diff;
    if (typeof diff !== "string" || diff.length > MAX_FILE_CHANGE_DIFF_CHARS) {
      return false;
    }
  }
  return true;
}

/** A bounded string that is neither empty nor whitespace-only. */
export function isNonemptyBounded(value: string, maxChars: number): boolean {
  return value.trim().length > 0 && value.length <= maxChars;
}

/**
 * Schema-shaped successful command-execution output proof per the installed
 * ThreadItem/CommandAction schema: status exactly `completed`, exit code
 * exactly 0, nonempty bounded `command` and `cwd`, a required bounded
 * `commandActions` array (empty is supported) whose members obey the
 * installed CommandAction oneOf — read requires type/command/name/path;
 * listFiles type/command with an optional string|null path; search
 * type/command with optional string|null path/query; unknown type/command —
 * and any supplied optional aggregatedOutput/durationMs/source fields within
 * their supported types/bounds (absent optional fields keep their schema
 * defaults). Missing/invalid command/cwd/actions and malformed optional
 * fields can never prove output; failed-command-loop classification is
 * untouched by this proof gate.
 */
export function hasValidCommandExecution(
  item: Record<string, unknown>,
): boolean {
  if (item.status !== "completed" || item.exitCode !== 0) return false;
  const command = item.command;
  if (
    typeof command !== "string" ||
    !isNonemptyBounded(command, MAX_COMMAND_CHARS)
  ) {
    return false;
  }
  const cwd = item.cwd;
  if (typeof cwd !== "string" || !isNonemptyBounded(cwd, MAX_CWD_CHARS)) {
    return false;
  }
  const actions = item.commandActions;
  if (!Array.isArray(actions) || actions.length > MAX_COMMAND_ACTIONS) {
    return false;
  }
  for (const raw of actions) {
    if (!isValidCommandAction(raw)) return false;
  }
  // Optional supplied fields: schema-typed and bounded when present; nothing
  // not supplied is invented.
  const output = item.aggregatedOutput;
  if (output !== undefined && output !== null) {
    if (typeof output !== "string" || output.length > MAX_OUTPUT_CHARS) {
      return false;
    }
  }
  const durationMs = item.durationMs;
  if (durationMs !== undefined && durationMs !== null) {
    if (
      typeof durationMs !== "number" ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 0
    ) return false;
  }
  const source = item.source;
  if (
    source !== undefined && source !== "agent" &&
    source !== "userShell" && source !== "unifiedExecStartup" &&
    source !== "unifiedExecInteraction"
  ) {
    return false;
  }
  return true;
}

/** One CommandAction member of the installed schema, with exact required fields. */
export function isValidCommandAction(raw: unknown): boolean {
  const action = raw as Record<string, unknown> | null;
  if (typeof action !== "object" || action === null) return false;
  const command = action.command;
  if (
    typeof command !== "string" ||
    !isNonemptyBounded(command, MAX_COMMAND_CHARS)
  ) {
    return false;
  }
  const optionalText = (value: unknown): boolean =>
    value === undefined || value === null ||
    (typeof value === "string" && isNonemptyBounded(value, MAX_COMMAND_CHARS));
  switch (action.type) {
    case "read": {
      const name = action.name;
      const path = action.path;
      return typeof name === "string" &&
        isNonemptyBounded(name, MAX_COMMAND_CHARS) &&
        typeof path === "string" &&
        isNonemptyBounded(path, MAX_CWD_CHARS);
    }
    case "listFiles":
      return optionalText(action.path);
    case "search":
      return optionalText(action.path) && optionalText(action.query);
    case "unknown":
      return true;
    default:
      return false;
  }
}

/**
 * A configured/requested runtime model id must be a nonempty bounded string
 * with no control characters and no leading/trailing whitespace; anything else
 * is rejected before any session or model work begins, so a malformed route
 * selection can never reach a thread request or a receipt.
 */
export function isValidModelId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_MODEL_CHARS) return false;
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * The configured provider must be a nonempty finite string with no control
 * characters and no leading/trailing whitespace; anything else is rejected
 * before any session or model work begins.
 */
export function isValidProvider(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PROVIDER_CHARS) return false;
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * A configured named permission profile must be a valid host-defined name and
 * never a built-in full-access mode identifier.
 */
export function isValidPermissionProfile(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!PERMISSION_PROFILE_PATTERN.test(value)) return false;
  return !BUILTIN_FULL_ACCESS_PERMISSION_PROFILE_IDS.has(value.toLowerCase());
}

/** Exact existing typed `unavailable` detail for the unverified-receipt boundary. */
export const UNAVAILABLE_RECEIPT_DETAIL =
  "model receipt unavailable: actual provider model/effort could not be verified at this boundary";

/** Static fail-closed detail: requested model/effort is not the route model/max. */
export const MODEL_POLICY_DETAIL =
  "model receipt unavailable: requested runtime model/effort is not the configured route model/max";

/** Static fail-closed detail: configured provider is not a nonempty finite string. */
export const PROVIDER_POLICY_DETAIL =
  "model receipt unavailable: configured provider is not a nonempty finite string";

/** Static fail-closed detail: configured permission profile is not a valid name. */
export const PERMISSION_PROFILE_POLICY_DETAIL =
  "model receipt unavailable: configured permission profile is not a valid named profile";

/** Static fail-closed detail: completed run produced no correlated output evidence. */
export const OUTPUT_EVIDENCE_DETAIL =
  "model receipt unavailable: completed run has no correlated output evidence";

/** Static fail-closed detail: terminal replay identity is missing/over bound. */
export const IDENTITY_POLICY_DETAIL =
  "model receipt unavailable: session identity is missing or over bound";

/** Static fail-closed detail: an additional verifier contradicted the core. */
export const RECEIPT_MISMATCH_DETAIL =
  "model receipt mismatch: verifier values differ from the validated request/runtime evidence";

/**
 * Static sanitized accounting error for a host timeout: the host's own bounds
 * elapsed before any runtime terminal evidence, so the receipt is failed
 * ACCOUNTING only — it never claims an observed terminal (the observed status
 * stays null and the terminal origin is `host-timeout`).
 */
export const HOST_TIMEOUT_ACCOUNTING_ERROR =
  "host timeout without terminal settlement";

export const DEFAULT_INTERRUPT_SETTLEMENT_GRACE_MS = 30_000;

export function requireRecord(
  value: unknown,
  method: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new CodexProtocolError(
      "malformed_line",
      `${method} response missing payload`,
    );
  }
  return value as Record<string, unknown>;
}

export function unavailableFor(
  error: unknown,
): { kind: "unavailable"; detail: string } {
  const detail = error instanceof CodexProtocolError
    ? error.detail
    : "codex session unavailable";
  return { kind: "unavailable", detail };
}

/**
 * Whether a provider error message signals HTTP 429 rate limiting.
 * Case-insensitive; matches the status code and common phrasings. Kept
 * narrow on purpose: quota/billing wording is NOT a rate limit.
 */
export function isRateLimitMessage(error: string | null): boolean {
  if (error === null || error.length === 0) return false;
  const lower = error.toLowerCase();
  return lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("ratelimit") ||
    lower.includes("too many requests");
}
