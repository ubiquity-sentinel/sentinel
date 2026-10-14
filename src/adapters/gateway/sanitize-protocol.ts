import type { ProtocolSanitizer } from "./sanitize-protocol-vocabulary.ts";
import {
  EFFORT_SET,
  FINISH_REASON_SET,
  FIXTURE_ARGUMENTS,
  FIXTURE_ID_PREFIX,
  FIXTURE_NAME_PREFIX,
  FIXTURE_TEXT,
  FORMAT_SET,
  isPlainObject,
  MAX_ARRAY_ITEMS,
  MAX_DEPTH,
  MAX_NODES,
  OBJECT_KIND_SET,
  POLICY_ERROR,
  ROLE_SET,
  STATUS_SET,
  SUMMARY_SET,
  TOOL_CHOICE_SET,
  TYPE_SET,
  UNSUPPORTED_ERROR,
  validatePublicModelAllowlist,
} from "./sanitize-protocol-vocabulary.ts";

/**
 * Create a protocol sanitizer for the given public model allowlist. The
 * factory holds private encounter-order ID/name maps shared across sanitize
 * calls, and the aggregate visited-node budget is per factory.
 */
export function createProtocolSanitizer(
  publicModels: readonly string[],
): ProtocolSanitizer {
  try {
    validatePublicModelAllowlist(publicModels);

    const models = new Set<string>(publicModels);
    const ids = new Map<string, string>();
    const names = new Map<string, string>();
    let nextId = 0;
    let nextName = 0;
    let visited = 0;

    const fail = (): never => {
      throw new Error(UNSUPPORTED_ERROR);
    };

    /** Applies the per-factory node budget and depth gate to one visited value. */
    const touch = (depth: number): void => {
      if (visited >= MAX_NODES || depth > MAX_DEPTH) fail();
      visited += 1;
    };

    /** Encounter-order placeholder for a non-empty identifier string. */
    const mapId = (value: string): string => {
      if (value.length === 0) return "";
      const existing = ids.get(value);
      if (existing !== undefined) return existing;
      nextId += 1;
      const mapped = `${FIXTURE_ID_PREFIX}${nextId}`;
      ids.set(value, mapped);
      return mapped;
    };

    /** Encounter-order placeholder for a non-empty name string. */
    const mapName = (value: string): string => {
      if (value.length === 0) return "";
      const existing = names.get(value);
      if (existing !== undefined) return existing;
      nextName += 1;
      const mapped = `${FIXTURE_NAME_PREFIX}${nextName}`;
      names.set(value, mapped);
      return mapped;
    };

    type Handler = (
      value: unknown,
      depth: number,
      path: Set<object>,
    ) => unknown;

    /**
     * Generic value walk: null, strings become "fixture text", numbers become
     * 0, booleans are preserved, arrays are rebuilt item by item and plain
     * objects are rebuilt through the fixed key table.
     */
    const walkValue = (
      value: unknown,
      depth: number,
      path: Set<object>,
    ): unknown => {
      touch(depth);
      if (value === null) return null;
      if (typeof value === "string") {
        return value.length === 0 ? "" : FIXTURE_TEXT;
      }
      if (typeof value === "number") {
        return Number.isFinite(value) ? 0 : fail();
      }
      if (typeof value === "boolean") return value;
      if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY_ITEMS) fail();
        if (path.has(value)) fail();
        path.add(value);
        const out: unknown[] = [];
        for (const item of value) out.push(walkValue(item, depth + 1, path));
        path.delete(value);
        return out;
      }
      if (isPlainObject(value)) {
        if (path.has(value)) fail();
        path.add(value);
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(KEY_HANDLERS, key)) fail();
          const handler = KEY_HANDLERS[key];
          out[key] = handler(value[key], depth + 1, path);
        }
        path.delete(value);
        return out;
      }
      return fail();
    };

    /** model: only an allowlist member is copied; other values are rejected. */
    const handlerModel: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "string") return fail();
      return models.has(value) ? value : fail();
    };

    /** id/item_id/call_id/tool_call_id: deterministic encounter-order IDs. */
    const handlerId: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "string") return fail();
      return mapId(value);
    };

    /** name: deterministic encounter-order name placeholders. */
    const handlerName: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "string") return fail();
      return mapName(value);
    };

    /** Boolean-only keys (stream/store/parallel_tool_calls). */
    const handlerBoolean: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "boolean") return fail();
      return value;
    };

    /** Strict free text: string only, replaced by the fixed placeholder. */
    const handlerText: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "string") return fail();
      return value.length === 0 ? "" : FIXTURE_TEXT;
    };

    /** Free text or optional null (code/param/refusal). */
    const handlerTextOrNull: Handler = (value, depth) => {
      touch(depth);
      if (value === null) return null;
      if (typeof value !== "string") return fail();
      return value.length === 0 ? "" : FIXTURE_TEXT;
    };

    /** Free text, known-key object, or null (message/delta/error/detail/text). */
    const handlerTextOrObject: Handler = (value, depth, path) => {
      if (value === null) {
        touch(depth);
        return null;
      }
      if (typeof value === "string") {
        touch(depth);
        return value.length === 0 ? "" : FIXTURE_TEXT;
      }
      if (isPlainObject(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** input: free text or array of protocol items. */
    const handlerInput: Handler = (value, depth, path) => {
      if (typeof value === "string") {
        touch(depth);
        return value.length === 0 ? "" : FIXTURE_TEXT;
      }
      if (Array.isArray(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** content: free text, array of parts, or null. */
    const handlerContent: Handler = (value, depth, path) => {
      if (value === null) {
        touch(depth);
        return null;
      }
      if (typeof value === "string") {
        touch(depth);
        return value.length === 0 ? "" : FIXTURE_TEXT;
      }
      if (Array.isArray(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** Array-only keys (messages/choices/tools/top_logprobs/output). */
    const handlerArrayOnly: Handler = (value, depth, path) => {
      if (!Array.isArray(value)) return fail();
      return walkValue(value, depth, path);
    };

    /** Array or null (tool_calls/annotations). */
    const handlerArrayOrNull: Handler = (value, depth, path) => {
      if (value === null) {
        touch(depth);
        return null;
      }
      if (!Array.isArray(value)) return fail();
      return walkValue(value, depth, path);
    };

    /** Object-only keys (reasoning/usage/details/response/item/part/function). */
    const handlerObjectOnly: Handler = (value, depth, path) => {
      if (value === null || !isPlainObject(value)) return fail();
      return walkValue(value, depth, path);
    };

    /** Object or null (logprobs). */
    const handlerObjectOrNull: Handler = (value, depth, path) => {
      if (value === null) {
        touch(depth);
        return null;
      }
      if (!isPlainObject(value)) return fail();
      return walkValue(value, depth, path);
    };

    /** Preserved numeric request controls within the allowed closed range. */
    const handlerRange =
      (min: number, max: number): Handler => (value, depth) => {
        touch(depth);
        if (
          typeof value !== "number" || !Number.isFinite(value) || value < min ||
          value > max
        ) {
          return fail();
        }
        return value;
      };

    /** Preserved nonnegative safe integers (token counts and indices). */
    const handlerSafeInt = (max: number): Handler => (value, depth) => {
      touch(depth);
      if (
        typeof value !== "number" || !Number.isSafeInteger(value) ||
        value < 0 ||
        value > max
      ) {
        return fail();
      }
      return value;
    };

    /** Timing/usage numbers retain the number type but become 0. */
    const handlerZero: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "number" || !Number.isFinite(value)) return fail();
      return 0;
    };

    /** bytes: array of integers 0..255; each value is replaced with 0. */
    const handlerBytes: Handler = (value, depth, path) => {
      touch(depth);
      if (!Array.isArray(value)) return fail();
      if (value.length > MAX_ARRAY_ITEMS) return fail();
      if (path.has(value)) fail();
      path.add(value);
      const out: number[] = [];
      for (const byte of value) {
        touch(depth + 1);
        if (
          typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 ||
          byte > 255
        ) {
          return fail();
        }
        out.push(0);
      }
      path.delete(value);
      return out;
    };

    /** Fixed literal-set enum; null only where the protocol allows it. */
    const handlerEnum =
      (values: ReadonlySet<string>, allowNull: boolean): Handler =>
      (value, depth) => {
        touch(depth);
        if (value === null) return allowNull ? null : fail();
        if (typeof value !== "string") return fail();
        return values.has(value) ? value : fail();
      };

    /** finish_reason: fixed set or null. */
    const handlerFinishReason: Handler = (value, depth) => {
      touch(depth);
      if (value === null) return null;
      if (typeof value !== "string") return fail();
      return FINISH_REASON_SET.has(value) ? value : fail();
    };

    /** tool_choice: string enum or an object using only known keys. */
    const handlerToolChoice: Handler = (value, depth, path) => {
      if (typeof value === "string") {
        touch(depth);
        return TOOL_CHOICE_SET.has(value) ? value : fail();
      }
      if (isPlainObject(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** format: string enum or an object using only known keys. */
    const handlerFormat: Handler = (value, depth, path) => {
      if (typeof value === "string") {
        touch(depth);
        return FORMAT_SET.has(value) ? value : fail();
      }
      if (isPlainObject(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** summary: string enum, or known-key object/array of summary parts. */
    const handlerSummary: Handler = (value, depth, path) => {
      if (typeof value === "string") {
        touch(depth);
        return SUMMARY_SET.has(value) ? value : fail();
      }
      if (
        value === null || typeof value === "number" ||
        typeof value === "boolean"
      ) return fail();
      if (Array.isArray(value) || isPlainObject(value)) {
        return walkValue(value, depth, path);
      }
      return fail();
    };

    /** arguments: stringified arguments become "{}"; objects use known keys. */
    const handlerArguments: Handler = (value, depth, path) => {
      if (typeof value === "string") {
        touch(depth);
        return FIXTURE_ARGUMENTS;
      }
      if (isPlainObject(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** Fixed key table; an unlisted key (own or inherited) is rejected. */
    const KEY_HANDLERS: Record<string, Handler> = {
      model: handlerModel,
      input: handlerInput,
      messages: handlerArrayOnly,
      instructions: handlerText,
      stream: handlerBoolean,
      store: handlerBoolean,
      temperature: handlerRange(0, 2),
      top_p: handlerRange(0, 1),
      max_tokens: handlerSafeInt(1_000_000),
      max_completion_tokens: handlerSafeInt(1_000_000),
      max_output_tokens: handlerSafeInt(1_000_000),
      parallel_tool_calls: handlerBoolean,
      reasoning: handlerObjectOnly,
      effort: handlerEnum(EFFORT_SET, false),
      summary: handlerSummary,
      text: handlerTextOrObject,
      format: handlerFormat,
      type: handlerEnum(TYPE_SET, false),
      role: handlerEnum(ROLE_SET, false),
      content: handlerContent,
      output: handlerArrayOnly,
      id: handlerId,
      item_id: handlerId,
      call_id: handlerId,
      tool_call_id: handlerId,
      name: handlerName,
      arguments: handlerArguments,
      tools: handlerArrayOnly,
      tool_choice: handlerToolChoice,
      tool_calls: handlerArrayOrNull,
      function: handlerObjectOnly,
      refusal: handlerTextOrNull,
      annotations: handlerArrayOrNull,
      object: handlerEnum(OBJECT_KIND_SET, false),
      choices: handlerArrayOnly,
      index: handlerSafeInt(8192),
      finish_reason: handlerFinishReason,
      message: handlerTextOrObject,
      delta: handlerTextOrObject,
      status: handlerEnum(STATUS_SET, false),
      error: handlerTextOrObject,
      code: handlerTextOrNull,
      param: handlerTextOrNull,
      detail: handlerTextOrObject,
      response: handlerObjectOnly,
      item: handlerObjectOnly,
      part: handlerObjectOnly,
      output_index: handlerSafeInt(8192),
      content_index: handlerSafeInt(8192),
      sequence_number: handlerSafeInt(8192),
      created: handlerZero,
      created_at: handlerZero,
      usage: handlerObjectOnly,
      input_tokens: handlerZero,
      output_tokens: handlerZero,
      total_tokens: handlerZero,
      prompt_tokens: handlerZero,
      completion_tokens: handlerZero,
      input_tokens_details: handlerObjectOnly,
      output_tokens_details: handlerObjectOnly,
      prompt_tokens_details: handlerObjectOnly,
      completion_tokens_details: handlerObjectOnly,
      cached_tokens: handlerZero,
      reasoning_tokens: handlerZero,
      incomplete_details: handlerObjectOnly,
      reason: handlerText,
      logprobs: handlerObjectOrNull,
      token: handlerText,
      bytes: handlerBytes,
      top_logprobs: handlerArrayOnly,
    };

    return {
      sanitize(value: unknown): unknown {
        // Root must be a plain object; scalar/array bodies are unsupported.
        try {
          if (!isPlainObject(value)) fail();
          return walkValue(value, 1, new Set<object>());
        } catch {
          // A traversal, accessor or proxy exception is normalized to the
          // fixed unsupported-input error; details are never echoed.
          throw new Error(UNSUPPORTED_ERROR);
        }
      },
    };
  } catch {
    // An unexpected construction-phase exception (invalid policy type or
    // iterator) is normalized to the fixed policy error; details are never
    // echoed.
    throw new Error(POLICY_ERROR);
  }
}
