import type {
  RetainedGatewayCaptureV1,
  RetainedGatewayUpstreamV1,
} from "./decrypt.ts";
import type { GatewaySanitizerPolicyV1 } from "./sanitize.ts";
import { isPlainObject } from "./sanitize-protocol-vocabulary.ts";

/** Fixed invalid-policy detail; never echoes host policy content. */
export const POLICY_ERROR_DETAIL = "Invalid gateway sanitizer policy";
/** Fixed unavailable detail; never echoes capture content or exceptions. */
export const UNAVAILABLE_DETAIL = "Gateway replay cannot be sanitized";

/** Fixed lowercase header names the replay sanitizer may emit. */
const ALLOWED_HEADER_NAMES: readonly string[] = [
  "accept",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "originator",
  "user-agent",
  "x-codex-client-version",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
];

const ALLOWED_HEADER_SET: ReadonlySet<string> = new Set<string>(
  ALLOWED_HEADER_NAMES,
);

/** One policy header value list: 1..32 printable ASCII strings 1..256 chars. */
const MIN_POLICY_HEADER_VALUES = 1;
const MAX_POLICY_HEADER_VALUES = 32;
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]{1,256}$/;
/** Captured identity bounds: nonempty, at most 256 characters. */
const MAX_CAPTURE_ID_LENGTH = 256;
/** Exact original request body bytes: at least 1, at most 32 MiB. */
const MAX_BODY_BYTES = 33554432;
const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/;
const LOWERCASE_HEX_40 = /^[0-9a-f]{40}$/;
/** Defensive structural cap for JSON snapshots (protocol depth is 32). */
const MAX_SNAPSHOT_DEPTH = 64;

/** Validated, independently copied host policy; no input references. */
export interface SanitizerPolicySnapshotV1 {
  publicModels: string[];
  publicHeaders: Record<string, string[]>;
}

/**
 * Validated capture fields consumed by this API. Identity, header and body
 * values are copied; the single `upstream` read is stored once and handed to
 * the synchronous bounded transform and then to its snapshot before any
 * await, so the transform and the hash always agree on one value.
 */
interface CaptureSnapshotV1 {
  captureId: string;
  fingerprint: string;
  caseGroupDigest: string;
  gitSha: string;
  endpoint: "/v1/responses" | "/v1/chat/completions";
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
  upstream: RetainedGatewayUpstreamV1;
}

/** Reject an own-key descriptor that is not an enumerable data descriptor. */
function assertOwnDataDescriptor(
  value: object,
  key: PropertyKey,
  kind: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) throw new TypeError(`unreadable ${kind}`);
  if ("get" in descriptor || "set" in descriptor) {
    throw new TypeError(`accessor ${kind}`);
  }
  if (!descriptor.enumerable) throw new TypeError(`non-enumerable ${kind}`);
}

/** True for a canonical dense array index within the array length. */
function isDenseArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length &&
    String(index) === key;
}

/**
 * Independently copy a JSON-safe value without ever invoking accessors:
 * symbol keys, accessors, non-enumerable keys, cycles, sparse arrays,
 * non-plain prototypes and non-JSON values are rejected up front.
 */
export function snapshotValue(value: unknown): unknown {
  return snapshotValueAt(value, 0, new Set<object>());
}

function snapshotValueAt(
  value: unknown,
  depth: number,
  seen: Set<object>,
): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("non-finite number in snapshot");
    }
    return value;
  }
  if (type !== "object") throw new TypeError("non-JSON value in snapshot");
  const object = value as object;
  if (depth > MAX_SNAPSHOT_DEPTH) throw new TypeError("snapshot too deep");
  if (seen.has(object)) throw new TypeError("cyclic snapshot");
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const array = object as unknown[];
      for (const key of Reflect.ownKeys(array)) {
        if (key === "length") continue;
        if (typeof key !== "string") {
          throw new TypeError("symbol array key in snapshot");
        }
        if (!isDenseArrayIndex(key, array.length)) {
          throw new TypeError("non-index array key in snapshot");
        }
        assertOwnDataDescriptor(array, key, "array element");
      }
      const out: unknown[] = [];
      for (let i = 0; i < array.length; i += 1) {
        if (!(i in array)) throw new TypeError("sparse array in snapshot");
        out.push(snapshotValueAt(array[i], depth + 1, seen));
      }
      return out;
    }
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("non-plain object in snapshot");
    }
    const record = object as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== "string") {
        throw new TypeError("symbol key in snapshot");
      }
      assertOwnDataDescriptor(record, key, "property");
      out[key] = snapshotValueAt(record[key], depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/** Copy and structurally validate the trusted host policy. */
export function snapshotPolicy(
  policy: GatewaySanitizerPolicyV1,
): SanitizerPolicySnapshotV1 {
  const snapshot = snapshotValue(policy);
  if (!isPlainObject(snapshot)) throw new TypeError("policy is not a record");
  const record = snapshot as Record<string, unknown>;
  const publicModels = record.publicModels;
  if (!Array.isArray(publicModels)) {
    throw new TypeError("policy models are not an array");
  }
  const models: string[] = [];
  for (const model of publicModels) {
    if (typeof model !== "string") {
      throw new TypeError("policy model is not a string");
    }
    models.push(model);
  }
  const publicHeaders = record.publicHeaders;
  if (!isPlainObject(publicHeaders)) {
    throw new TypeError("policy headers are not a record");
  }
  const headers: Record<string, string[]> = {};
  for (const key of Reflect.ownKeys(publicHeaders)) {
    if (typeof key !== "string") {
      throw new TypeError("policy header key is not a string");
    }
    if (!ALLOWED_HEADER_SET.has(key)) {
      throw new TypeError("policy header name is not allowed");
    }
    const values = (publicHeaders as Record<string, unknown>)[key];
    if (
      !Array.isArray(values) || values.length < MIN_POLICY_HEADER_VALUES ||
      values.length > MAX_POLICY_HEADER_VALUES
    ) {
      throw new TypeError("policy header value list is out of bounds");
    }
    const literals: string[] = [];
    for (const value of values) {
      if (typeof value !== "string" || !HEADER_VALUE_PATTERN.test(value)) {
        throw new TypeError("policy header value is invalid");
      }
      literals.push(value);
    }
    headers[key] = literals;
  }
  return { publicModels: models, publicHeaders: headers };
}

/** True when the MIME base type (case-insensitive) is application/json. */
function isApplicationJson(contentType: string): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return base === "application/json";
}

/**
 * Exact fields this API consumes from a retained capture, in read order. The
 * own descriptor of every required field is validated to be an enumerable
 * data descriptor before that field is read; unrelated private capture
 * fields are never inspected.
 */
const CAPTURE_CONSUMED_FIELDS: readonly string[] = [
  "version",
  "captureId",
  "fingerprint",
  "caseGroupDigest",
  "gitSha",
  "endpoint",
  "method",
  "contentType",
  "compatibilityHeaders",
  "body",
  "upstream",
];

/** Copy and defensively validate every capture field this API consumes. */
export function snapshotCapture(
  capture: RetainedGatewayCaptureV1,
): CaptureSnapshotV1 {
  if (typeof capture !== "object" || capture === null) {
    throw new TypeError("capture is not an object");
  }
  // Validate the own descriptor of every consumed field before reading it:
  // an accessor (even with undefined get/set), a missing own descriptor or a
  // non-enumerable own field is rejected, so no getter/proxy trap can run.
  for (const key of CAPTURE_CONSUMED_FIELDS) {
    assertOwnDataDescriptor(capture, key, `capture ${key}`);
  }
  if (capture.version !== 1) throw new TypeError("unsupported capture version");
  const captureId = capture.captureId;
  if (
    typeof captureId !== "string" || captureId.length < 1 ||
    captureId.length > MAX_CAPTURE_ID_LENGTH
  ) {
    throw new TypeError("invalid capture id");
  }
  const fingerprint = capture.fingerprint;
  if (typeof fingerprint !== "string" || !LOWERCASE_HEX_64.test(fingerprint)) {
    throw new TypeError("invalid fingerprint");
  }
  const caseGroupDigest = capture.caseGroupDigest;
  if (
    typeof caseGroupDigest !== "string" ||
    !LOWERCASE_HEX_64.test(caseGroupDigest)
  ) {
    throw new TypeError("invalid case group digest");
  }
  const gitSha = capture.gitSha;
  if (typeof gitSha !== "string" || !LOWERCASE_HEX_40.test(gitSha)) {
    throw new TypeError("invalid git sha");
  }
  const endpoint = capture.endpoint;
  if (endpoint !== "/v1/responses" && endpoint !== "/v1/chat/completions") {
    throw new TypeError("invalid endpoint");
  }
  if (capture.method !== "POST") throw new TypeError("invalid method");
  const contentType = capture.contentType;
  if (typeof contentType !== "string" || !isApplicationJson(contentType)) {
    throw new TypeError("invalid content type");
  }
  const body = capture.body;
  if (
    !(body instanceof Uint8Array) || body.length < 1 ||
    body.length > MAX_BODY_BYTES
  ) {
    throw new TypeError("invalid body");
  }
  const headersSnapshot = snapshotValue(capture.compatibilityHeaders);
  if (!isPlainObject(headersSnapshot)) {
    throw new TypeError("capture headers are not a record");
  }
  const headers: Record<string, string> = {};
  for (const key of Reflect.ownKeys(headersSnapshot)) {
    if (typeof key !== "string") {
      throw new TypeError("capture header key is not a string");
    }
    const value = (headersSnapshot as Record<string, unknown>)[key];
    if (typeof value !== "string") {
      throw new TypeError("capture header value is not a string");
    }
    headers[key] = value;
  }
  // The upstream value is read exactly once here; the same stored value is
  // handed to the synchronous bounded transform and then its snapshot.
  const upstream = capture.upstream;
  return {
    captureId,
    fingerprint,
    caseGroupDigest,
    gitSha,
    endpoint,
    headers,
    body: body.slice(),
    upstream,
  };
}

/**
 * Fatal UTF-8 decode, JSON parse, plain-object root and the protocol field
 * checks the fixture semantics depend on. The existing protocol sanitizer
 * performs the structural transform afterwards.
 */
export function parseRequest(
  body: Uint8Array,
  endpoint: "/v1/responses" | "/v1/chat/completions",
): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new TypeError("request body is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("request body is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new TypeError("request body is not a plain object");
  }
  const request = parsed;
  if (typeof request.model !== "string") {
    throw new TypeError("request model is not a string");
  }
  if (endpoint === "/v1/responses") {
    if (typeof request.input !== "string" && !Array.isArray(request.input)) {
      throw new TypeError("responses input is not a string or array");
    }
  } else if (!Array.isArray(request.messages)) {
    throw new TypeError("chat messages are not an array");
  }
  return request;
}

/**
 * Copy only captured headers whose value is exactly a trusted policy literal;
 * unknown, unapproved or non-matching headers are omitted. The emitted value
 * is the trusted literal, never the captured string directly.
 */
export function projectHeaders(
  captured: Readonly<Record<string, string>>,
  allowed: Readonly<Record<string, readonly string[]>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ALLOWED_HEADER_NAMES) {
    if (!Object.hasOwn(captured, name)) continue;
    const literals = allowed[name];
    if (literals === undefined) continue;
    const value = captured[name];
    for (const literal of literals) {
      if (literal === value) {
        out[name] = literal;
        break;
      }
    }
  }
  return out;
}
