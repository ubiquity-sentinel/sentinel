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
 * - one whole extra layer of string escaping (`{\"binding\":...}`);
 * - raw control characters inside a string (an unescaped line break);
 * - a double quote inside a string that is not followed by a JSON delimiter;
 * - an invalid escape (a lone backslash is kept as a literal backslash);
 * - a trailing comma before a closing brace or bracket.
 *
 * Every candidate goes through the same strict parser (duplicate keys and
 * trailing content still refuse), and the caller keeps every later check: the
 * exact envelope keys, the exact snapshot binding, the strict result shape and
 * the native findings cross-check. A text no rewrite recovers keeps the fixed
 * sanitized `json_syntax` rejection.
 */
import { expectStrictJson, parseJsonStrict } from "./journal-json.ts";

const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** What may follow a string's closing quote in JSON. */
const AFTER_STRING = new Set([",", "}", "]", ":"]);

const CONTROL_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function nextNonSpace(text: string, from: number): string | undefined {
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
      return char;
    }
  }
  return undefined;
}

/** The envelope JSON with one whole layer of string escaping removed. */
function unescapedLayer(text: string): string | null {
  if (!text.trimStart().startsWith('{\\"')) return null;
  try {
    const decoded = parseJsonStrict(`"${text}"`);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

/** Rewrite the string-escaping slips listed above; structure is untouched. */
export function repairedEnvelopeJson(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!inString) {
      if (char === '"') inString = true;
      if (char === ",") {
        const next = nextNonSpace(text, index + 1);
        if (next === "}" || next === "]") continue;
      }
      out += char;
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1];
      if (next !== undefined && VALID_ESCAPES.has(next)) {
        out += char + next;
        index++;
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
      } else {
        out += '\\"';
      }
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20) {
      out += CONTROL_ESCAPES[char] ??
        `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += char;
  }
  return out;
}

/** The deterministic rewrites tried after the strict parse refused `text`. */
export function envelopeRecoveryCandidates(text: string): string[] {
  const candidates = [repairedEnvelopeJson(text)];
  const layer = unescapedLayer(text);
  if (layer !== null) candidates.push(layer, repairedEnvelopeJson(layer));
  return [...new Set(candidates)].filter((candidate) => candidate !== text);
}

/**
 * Strictly parse the envelope JSON, recovering only the escaping slips above.
 * A text no candidate recovers throws the fixed strict-JSON issue at `path`.
 */
export function expectEnvelopeJson(text: string, path: string): unknown {
  try {
    return parseJsonStrict(text);
  } catch { /* try the deterministic rewrites */ }
  for (const candidate of envelopeRecoveryCandidates(text)) {
    try {
      return parseJsonStrict(candidate);
    } catch { /* next rewrite */ }
  }
  return expectStrictJson(text, path);
}
