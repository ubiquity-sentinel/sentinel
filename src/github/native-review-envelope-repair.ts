/**
 * Bounded recovery of the native review envelope's JSON.
 *
 * Codex 0.154.0 runs review mode without an output schema
 * (`final_output_json_schema: None`) and carries Sentinel's envelope inside
 * the reviewer's free-text `overall_explanation`, so the reviewer escapes the
 * envelope's JSON by hand. A missed or doubled escape left about one review in
 * three unparseable on 2026-10-24 (`json_syntax`). This module retries the
 * strict parse on a few deterministic rewrites of those slips:
 *
 * - one whole extra layer of string escaping (`{\"binding\":...}`, with JSON
 *   whitespace, raw or escaped, allowed around its opening brace), itself
 *   decoded tolerantly so a second slip inside it is still rewritten;
 * - raw control characters inside a string (an unescaped line break);
 * - a double quote inside an object member's string value that no JSON
 *   delimiter follows;
 * - an invalid escape, `\u` without four hex digits included (kept as a
 *   literal backslash);
 * - a trailing comma before a closing brace or bracket.
 *
 * An unescaped quote inside an array element is ambiguous (it can split one
 * element into two or merge two into one, and nothing cross-checks the
 * elements), so a text that needs that rewrite is not recovered.
 *
 * The one closing brace of the outermost object the reviewer left off
 * (2026-11-17, PR 418) is the last rewrite, tried on the text as written and
 * on nothing else: `text + "}"` must parse strictly, so every other container
 * was closed by the reviewer's own text, no string or value is cut and the
 * whole text was consumed; and the closed object must carry every contract
 * key, the envelope exactly `binding` and `result` and the result `verdict`,
 * `summary`, `findings` and `taskAcceptance`. Any text that continued it into
 * a valid envelope could only have added that brace (another key would be a
 * duplicate or unknown), so nothing it held is lost. A text cut inside a
 * finding, between findings, inside a string or before a contract key keeps
 * the `json_syntax` rejection.
 *
 * Every candidate goes through the same strict parser (duplicate keys and
 * trailing content still refuse), and the caller keeps every later check: the
 * exact envelope keys, the exact snapshot binding, the strict result shape and
 * the native findings cross-check. A text no rewrite recovers keeps the fixed
 * sanitized `json_syntax` rejection.
 */
import { expectStrictJson, parseJsonStrict } from "./journal-json.ts";
import { REVIEW_RESULT_OUTPUT_SCHEMA } from "./review-result-contracts.ts";

const SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/** What may follow a string's closing quote in JSON. */
const AFTER_STRING = new Set([",", "}", "]", ":"]);

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * An escaped layer's opening: `{` and its first key's escaped quote, with JSON
 * whitespace before and after the brace either raw or escaped once (`\n`,
 * `\r`, `\t`), as a pretty-printed envelope escaped once more begins.
 */
const ESCAPED_LAYER_OPENING =
  /^(?:[ \t\n\r]|\\[nrt])*\{(?:[ \t\n\r]|\\[nrt])*\\"/;

const CONTROL_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** Thrown inside the rewrite when the only rewrite would be ambiguous. */
class AmbiguousRepair extends Error {}

function nextNonSpace(text: string, from: number): string | undefined {
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
      return char;
    }
  }
  return undefined;
}

/** The escape starting at `index` (a backslash), or null when invalid. */
function validEscape(text: string, index: number): string | null {
  const next = text[index + 1];
  if (next === undefined) return null;
  if (SIMPLE_ESCAPES.has(next)) return text.slice(index, index + 2);
  if (next === "u" && HEX4.test(text.slice(index + 2, index + 6))) {
    return text.slice(index, index + 6);
  }
  return null;
}

function controlEscape(char: string): string {
  return CONTROL_ESCAPES[char] ??
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * The envelope JSON with one whole layer of string escaping removed. The layer
 * is decoded tolerantly: a raw control character, an invalid escape or a raw
 * double quote (a purely doubled layer has none) is an inner slip, kept for
 * the structural rewrite below.
 */
function unescapedLayer(text: string): string | null {
  if (!ESCAPED_LAYER_OPENING.test(text.trimStart())) return null;
  let body = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      const escape = validEscape(text, index);
      if (escape !== null) {
        body += escape;
        index += escape.length - 1;
      } else {
        body += "\\\\";
      }
      continue;
    }
    if (char === '"') {
      body += '\\"';
      continue;
    }
    body += char.charCodeAt(0) < 0x20 ? controlEscape(char) : char;
  }
  try {
    const decoded = parseJsonStrict(`"${body}"`);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite the string-escaping slips listed above; structure is untouched.
 * Throws `AmbiguousRepair` when an array element needs the quote rewrite.
 */
function repairStrings(text: string): string {
  let out = "";
  let inString = false;
  // Open containers, innermost last; a string directly inside an array is an
  // element, never an object member.
  const containers: string[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!inString) {
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") containers.push(char);
      else if (char === "}" || char === "]") containers.pop();
      else if (char === ",") {
        const next = nextNonSpace(text, index + 1);
        if (next === "}" || next === "]") continue;
      }
      out += char;
      continue;
    }
    if (char === "\\") {
      const escape = validEscape(text, index);
      if (escape !== null) {
        out += escape;
        index += escape.length - 1;
      } else {
        out += "\\\\";
      }
      continue;
    }
    if (char === '"') {
      const next = nextNonSpace(text, index + 1);
      if (next === undefined || AFTER_STRING.has(next)) {
        inString = false;
        out += char;
      } else if (containers.at(-1) === "[") {
        throw new AmbiguousRepair();
      } else {
        out += '\\"';
      }
      continue;
    }
    out += char.charCodeAt(0) < 0x20 ? controlEscape(char) : char;
  }
  return out;
}

/** The structural rewrite of `text`, or null when it would be ambiguous. */
export function repairedEnvelopeJson(text: string): string | null {
  try {
    return repairStrings(text);
  } catch (error) {
    if (error instanceof AmbiguousRepair) return null;
    throw error;
  }
}

/** The deterministic rewrites tried after the strict parse refused `text`. */
export function envelopeRecoveryCandidates(text: string): string[] {
  const candidates: (string | null)[] = [repairedEnvelopeJson(text)];
  const layer = unescapedLayer(text);
  if (layer !== null) candidates.push(layer, repairedEnvelopeJson(layer));
  return [
    ...new Set(
      candidates.filter((candidate): candidate is string =>
        candidate !== null && candidate !== text
      ),
    ),
  ];
}

/** The envelope keys the caller checks exactly (`native-review-result.ts`). */
const ENVELOPE_KEYS: readonly string[] = ["binding", "result"];

/** Every key the result contract the reviewer is given requires. */
const RESULT_KEYS: readonly string[] = REVIEW_RESULT_OUTPUT_SCHEMA.required;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The outermost object closed with one brace, or the closed reason it is not
 * a candidate: `refused` (the closed text does not parse strictly),
 * `envelope_keys` (its keys are not exactly the envelope's) or `result_keys`
 * (its result is not an object carrying every contract key).
 */
export type OutermostCloseV1 =
  | { closer: "refused" | "envelope_keys" | "result_keys" }
  | { closer: "parsed"; value: unknown };

export function closedOutermostObject(text: string): OutermostCloseV1 {
  let value: unknown;
  try {
    value = parseJsonStrict(text + "}");
  } catch {
    return { closer: "refused" };
  }
  const keys = isRecord(value) ? Object.keys(value) : [];
  if (
    !isRecord(value) || keys.length !== ENVELOPE_KEYS.length ||
    !ENVELOPE_KEYS.every((key) => keys.includes(key))
  ) return { closer: "envelope_keys" };
  const result = value.result;
  if (
    !isRecord(result) || !RESULT_KEYS.every((key) => Object.hasOwn(result, key))
  ) return { closer: "result_keys" };
  return { closer: "parsed", value };
}

/** A parsed envelope, and whether it needed a rewrite to parse. */
export interface EnvelopeJsonV1 {
  value: unknown;
  recovered: boolean;
}

/**
 * Strictly parse the envelope JSON, recovering only the slips above. A text
 * no candidate recovers throws the fixed strict-JSON issue at `path`.
 */
export function expectEnvelopeJson(text: string, path: string): EnvelopeJsonV1 {
  try {
    return { value: parseJsonStrict(text), recovered: false };
  } catch { /* try the deterministic rewrites */ }
  for (const candidate of envelopeRecoveryCandidates(text)) {
    try {
      return { value: parseJsonStrict(candidate), recovered: true };
    } catch { /* next rewrite */ }
  }
  // Only a text the string rewrites leave unchanged can close: the strict
  // parser consumed all of it, so it holds no slip they rewrite.
  const closed = closedOutermostObject(text);
  if (closed.closer === "parsed") {
    return { value: closed.value, recovered: true };
  }
  return { value: expectStrictJson(text, path), recovered: false };
}
