/** Structural role enum for messages, parts and items. */
export type ProtocolRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";
/** Finite set of protocol role strings. */
export const PROTOCOL_ROLES: readonly ProtocolRole[] = [
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
];

/** Structural object-kind enum. */
export type ProtocolObjectKind =
  | "response"
  | "chat.completion"
  | "chat.completion.chunk"
  | "list";
/** Finite set of protocol object-kind strings. */
export const PROTOCOL_OBJECT_KINDS: readonly ProtocolObjectKind[] = [
  "response",
  "chat.completion",
  "chat.completion.chunk",
  "list",
];

/** Status enum for responses, items and requests. */
export type ProtocolStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";
/** Finite set of protocol status strings. */
export const PROTOCOL_STATUSES: readonly ProtocolStatus[] = [
  "queued",
  "in_progress",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
];

/** Reasoning effort enum. */
export type ProtocolEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
/** Finite set of reasoning effort strings. */
export const PROTOCOL_EFFORTS: readonly ProtocolEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

/** Summary mode enum. */
export type ProtocolSummary = "auto" | "concise" | "detailed";
/** Finite set of summary mode strings. */
export const PROTOCOL_SUMMARIES: readonly ProtocolSummary[] = [
  "auto",
  "concise",
  "detailed",
];

/** Finish-reason enum (null is allowed where the protocol permits it). */
export type ProtocolFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call";
/** Finite set of finish-reason strings. */
export const PROTOCOL_FINISH_REASONS: readonly ProtocolFinishReason[] = [
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "function_call",
];

/** Tool-choice string enum; the object form uses only known keys. */
export type ProtocolToolChoice = "auto" | "none" | "required";
/** Finite set of tool-choice strings. */
export const PROTOCOL_TOOL_CHOICES: readonly ProtocolToolChoice[] = [
  "auto",
  "none",
  "required",
];

/** Response-format enum; the object form uses only known keys. */
export type ProtocolFormat = "text" | "json_object" | "json_schema";
/** Finite set of response-format strings. */
export const PROTOCOL_FORMATS: readonly ProtocolFormat[] = [
  "text",
  "json_object",
  "json_schema",
];

/**
 * Type enum for parts/items, Responses event types and error types. No
 * wildcard prefix acceptance: a string outside this finite list is rejected.
 */
export type ProtocolType =
  | "message"
  | "input_text"
  | "output_text"
  | "text"
  | "refusal"
  | "function"
  | "function_call"
  | "function_call_output"
  | "reasoning"
  | "summary_text"
  | "json_object"
  | "json_schema"
  | "invalid_request_error"
  | "server_error"
  | "rate_limit_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "response.created"
  | "response.in_progress"
  | "response.completed"
  | "response.failed"
  | "response.incomplete"
  | "response.queued"
  | "response.output_item.added"
  | "response.output_item.done"
  | "response.content_part.added"
  | "response.content_part.done"
  | "response.output_text.delta"
  | "response.output_text.done"
  | "response.refusal.delta"
  | "response.refusal.done"
  | "response.function_call_arguments.delta"
  | "response.function_call_arguments.done"
  | "response.reasoning_summary_part.added"
  | "response.reasoning_summary_part.done"
  | "response.reasoning_summary_text.delta"
  | "response.reasoning_summary_text.done"
  | "error";
/** Finite set of protocol type strings. */
export const PROTOCOL_TYPES: readonly ProtocolType[] = [
  "message",
  "input_text",
  "output_text",
  "text",
  "refusal",
  "function",
  "function_call",
  "function_call_output",
  "reasoning",
  "summary_text",
  "json_object",
  "json_schema",
  "invalid_request_error",
  "server_error",
  "rate_limit_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.queued",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "error",
];

/** Literal keys the sanitizer can emit. */
export type ProtocolKey =
  | "model"
  | "input"
  | "messages"
  | "instructions"
  | "stream"
  | "store"
  | "temperature"
  | "top_p"
  | "max_tokens"
  | "max_completion_tokens"
  | "max_output_tokens"
  | "parallel_tool_calls"
  | "reasoning"
  | "effort"
  | "summary"
  | "text"
  | "format"
  | "type"
  | "role"
  | "content"
  | "output"
  | "id"
  | "item_id"
  | "call_id"
  | "tool_call_id"
  | "name"
  | "arguments"
  | "tools"
  | "tool_choice"
  | "tool_calls"
  | "function"
  | "refusal"
  | "annotations"
  | "object"
  | "choices"
  | "index"
  | "finish_reason"
  | "message"
  | "delta"
  | "status"
  | "error"
  | "code"
  | "param"
  | "detail"
  | "response"
  | "item"
  | "part"
  | "output_index"
  | "content_index"
  | "sequence_number"
  | "created"
  | "created_at"
  | "usage"
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "prompt_tokens"
  | "completion_tokens"
  | "input_tokens_details"
  | "output_tokens_details"
  | "prompt_tokens_details"
  | "completion_tokens_details"
  | "cached_tokens"
  | "reasoning_tokens"
  | "incomplete_details"
  | "reason"
  | "logprobs"
  | "token"
  | "bytes"
  | "top_logprobs";
/** Finite set of literal keys the sanitizer can emit. */
export const PROTOCOL_KEYS: readonly ProtocolKey[] = [
  "model",
  "input",
  "messages",
  "instructions",
  "stream",
  "store",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "parallel_tool_calls",
  "reasoning",
  "effort",
  "summary",
  "text",
  "format",
  "type",
  "role",
  "content",
  "output",
  "id",
  "item_id",
  "call_id",
  "tool_call_id",
  "name",
  "arguments",
  "tools",
  "tool_choice",
  "tool_calls",
  "function",
  "refusal",
  "annotations",
  "object",
  "choices",
  "index",
  "finish_reason",
  "message",
  "delta",
  "status",
  "error",
  "code",
  "param",
  "detail",
  "response",
  "item",
  "part",
  "output_index",
  "content_index",
  "sequence_number",
  "created",
  "created_at",
  "usage",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "prompt_tokens",
  "completion_tokens",
  "input_tokens_details",
  "output_tokens_details",
  "prompt_tokens_details",
  "completion_tokens_details",
  "cached_tokens",
  "reasoning_tokens",
  "incomplete_details",
  "reason",
  "logprobs",
  "token",
  "bytes",
  "top_logprobs",
];

/** A per-factory protocol JSON sanitizer. */
export interface ProtocolSanitizer {
  /** Returns an independent sanitized copy; rejects unsupported input. */
  sanitize(value: unknown): unknown;
}

/** Fixed placeholder for redacted free strings. */
export const FIXTURE_TEXT = "fixture text";
/** Fixed placeholder replacing stringified tool arguments. */
export const FIXTURE_ARGUMENTS = "{}";
/** Prefix for encounter-order identifier placeholders. */
export const FIXTURE_ID_PREFIX = "fixture_id_";
/** Prefix for encounter-order name placeholders. */
export const FIXTURE_NAME_PREFIX = "fixture_name_";
/** Fixed error text for unsupported input; never echoes values/keys/paths. */
export const UNSUPPORTED_ERROR = "Unsupported protocol value";
/** Fixed error text for an invalid public model allowlist. */
export const POLICY_ERROR = "Invalid public model allowlist";
/** Maximum nesting depth. */
export const MAX_DEPTH = 32;
/** Maximum aggregate visited nodes per factory (shared across calls). */
export const MAX_NODES = 8192;
/** Maximum items per array. */
export const MAX_ARRAY_ITEMS = 1024;

/** Public model identifier: 1..128 ASCII characters, alphanumeric start. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const ROLE_SET: ReadonlySet<string> = new Set<string>(PROTOCOL_ROLES);
export const OBJECT_KIND_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_OBJECT_KINDS,
);
export const STATUS_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_STATUSES,
);
export const EFFORT_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_EFFORTS,
);
export const SUMMARY_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_SUMMARIES,
);
export const FINISH_REASON_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_FINISH_REASONS,
);
export const TOOL_CHOICE_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_TOOL_CHOICES,
);
export const FORMAT_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_FORMATS,
);
export const TYPE_SET: ReadonlySet<string> = new Set<string>(PROTOCOL_TYPES);

/**
 * Validate the public model allowlist: 1..128 distinct identifiers matching
 * MODEL_PATTERN. An invalid policy throws the fixed POLICY_ERROR.
 */
export function validatePublicModelAllowlist(
  publicModels: readonly string[],
): void {
  if (!Array.isArray(publicModels)) throw new Error(POLICY_ERROR);
  const distinct = new Set<string>(publicModels);
  const valid = publicModels.length >= 1 &&
    publicModels.length <= 128 &&
    distinct.size === publicModels.length &&
    publicModels.every((model) =>
      typeof model === "string" && MODEL_PATTERN.test(model)
    );
  if (!valid) throw new Error(POLICY_ERROR);
}

/** True for a plain JSON object (Object.prototype or null prototype). */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
