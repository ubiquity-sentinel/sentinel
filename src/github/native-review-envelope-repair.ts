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
 * - one whole extra layer of string escaping (`{\"binding\":...}`), itself
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
 * Every candidate goes through the same strict parser (duplicate keys and
 * trailing content still refuse), and the caller keeps every later check: the
 * exact envelope keys, the exact snapshot binding, the strict result shape and
 * the native findings cross-check. A text no rewrite recovers keeps the fixed
 * sanitized `json_syntax` rejection.
 */
import { fail } from "../contracts/validation.ts";
import { expectStrictJson, parseJsonStrict } from "./journal-json.ts";
import { STRICT_JSON_ISSUE_MESSAGE } from "./review-result-contracts.ts";

const SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/** What may follow a string's closing quote in JSON. */
const AFTER_STRING = new Set([",", "}", "]", ":"]);

const HEX4 = /^[0-9a-fA-F]{4}$/;

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
  if (!text.trimStart().startsWith('{\\"')) return null;
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

/** A parsed envelope, and whether it needed a rewrite to parse. */
export interface EnvelopeJsonV1 {
  value: unknown;
  recovered: boolean;
}

/**
 * Strictly parse the envelope JSON, recovering only the escaping slips above.
 * A text no candidate recovers throws the fixed strict-JSON issue at `path`.
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
  return { value: expectStrictJson(text, path), recovered: false };
}

/**
 * Throw the fixed strict-JSON issue at `path`: a recovered envelope that a
 * later check refuses was still an escaping failure, so it keeps the
 * `json_syntax` category rather than the shape the rewrite produced.
 */
export function refuseAsJsonSyntax(path: string): never {
  fail(path, "invalid_value", STRICT_JSON_ISSUE_MESSAGE);
}
