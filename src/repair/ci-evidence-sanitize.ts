/**
 * Sanitizing for CI failure evidence. Every line is cut to a raw bound before
 * any pattern runs, cleaned by a single linear character pass (timestamps,
 * ANSI CSI/OSC escapes, control, bidi and zero-width characters), rewritten
 * to repository-relative paths, redacted and capped. Every pattern below is a
 * simple character-class run or anchored literal with no nested quantifier,
 * so each runs in linear time on its bounded line.
 *
 * Redaction targets credential shapes (GitHub tokens, bearer/authorization
 * values, provider keys, JWTs, signed URL parameters, key=value secrets and
 * long mixed base64 runs). It never touches 40/64-hex commit or digest SHAs,
 * ordinary paths or prose; GitHub's own `***` masks are kept as they are.
 */
import {
  MAX_CI_EVIDENCE_LINE_CHARS,
  MAX_CI_RAW_LINE_CHARS,
} from "./ci-evidence-types.ts";

/** The replacement for every redacted value. */
export const REDACTED = "[REDACTED]";

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

function droppedCodePoint(code: number): boolean {
  return (code < 0x20 && code !== 0x09) || code === 0x7f ||
    (code >= 0x80 && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ||
    code === 0x2028 || code === 0x2029 || code === 0xfeff;
}

/**
 * One raw log line without its timestamp, escapes and control characters, at
 * most `MAX_CI_RAW_LINE_CHARS` long. Not redacted: marker detection only.
 */
export function cleanLogLine(raw: string): string {
  let line = raw.length > MAX_CI_RAW_LINE_CHARS * 2
    ? raw.slice(0, MAX_CI_RAW_LINE_CHARS * 2)
    : raw;
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
  const stamp = TIMESTAMP.exec(line);
  if (stamp !== null) line = line.slice(stamp[0].length);
  let out = "";
  for (let index = 0; index < line.length; index++) {
    const code = line.charCodeAt(index);
    if (code === 0x1b) {
      const next = line.charCodeAt(index + 1);
      if (next === 0x5b) {
        // CSI: parameters and intermediates, then one final byte @..~.
        index += 2;
        while (index < line.length) {
          const byte = line.charCodeAt(index);
          if (byte >= 0x40 && byte <= 0x7e) break;
          index++;
        }
      } else if (next === 0x5d) {
        // OSC: up to BEL or ESC \ (an unterminated one ends the line).
        index += 2;
        while (index < line.length) {
          const byte = line.charCodeAt(index);
          if (byte === 0x07) break;
          if (byte === 0x1b && line.charCodeAt(index + 1) === 0x5c) {
            index++;
            break;
          }
          index++;
        }
      } else {
        index++;
      }
      continue;
    }
    if (code === 0x09) {
      out += "  ";
      continue;
    }
    if (droppedCodePoint(code)) continue;
    out += line[index];
    if (out.length > MAX_CI_RAW_LINE_CHARS) break;
  }
  return capChars(out, MAX_CI_RAW_LINE_CHARS);
}

/** Hosted runner checkout prefixes (`<root>/work/<repo>/<repo>/`). */
const WORKSPACE = /\/(?:home|Users)\/runner\/work\/([^/\s]+)\/\1\//g;

interface RedactionV1 {
  pattern: RegExp;
  /** Replacement for one match (and its groups), or null to keep it. */
  replace: (match: string, groups: readonly string[]) => string | null;
}

const hasDigit = (text: string) => /\d/.test(text);
const hasLetter = (text: string) => /[A-Za-z]/.test(text);

/** Case transitions of a long base64 run: random data switches constantly. */
function looksRandomBase64(run: string): boolean {
  if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/\d/.test(run)) {
    return false;
  }
  let transitions = 0;
  let previous = "";
  for (const char of run) {
    const kind = char >= "A" && char <= "Z"
      ? "U"
      : char >= "a" && char <= "z"
      ? "L"
      : char >= "0" && char <= "9"
      ? "D"
      : "";
    if (kind !== "" && previous !== "" && kind !== previous) transitions++;
    if (kind !== "") previous = kind;
  }
  return transitions * 3 >= run.length;
}

const REDACTIONS: readonly RedactionV1[] = [
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
    replace: () => REDACTED,
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replace: () => REDACTED,
  },
  {
    pattern:
      /(\bauthorization\b\s*[:=]\s*(?:(?:bearer|token|basic)\s+)?|\bbearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace: (_match, [prefix, token]) =>
      hasDigit(token) ? prefix + REDACTED : null,
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replace: (match) => hasDigit(match) ? REDACTED : null,
  },
  {
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    replace: () => REDACTED,
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => REDACTED,
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => REDACTED,
  },
  {
    pattern: /([?&](?:sig|se|st|ske|skt|skoid|sktid|sv)=)[^&\s"'<>]+/g,
    replace: (_match, [prefix]) => prefix + REDACTED,
  },
  {
    pattern:
      /\b((?:token|secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{12,})/gi,
    replace: (_match, [prefix, value]) =>
      hasDigit(value) && hasLetter(value) ? prefix + REDACTED : null,
  },
  {
    pattern: /[A-Za-z0-9+/]{40,}={0,2}/g,
    replace: (match) => looksRandomBase64(match) ? REDACTED : null,
  },
];

/** Replace credential-shaped values; `count` is the number replaced. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const redaction of REDACTIONS) {
    out = out.replace(
      redaction.pattern,
      (match: string, ...rest: unknown[]) => {
        // Arguments after the match: the groups, then offset and input.
        const groups = rest.slice(0, -2).map((item) =>
          typeof item === "string" ? item : ""
        );
        const replaced = redaction.replace(match, groups);
        if (replaced === null) return match;
        count++;
        return replaced;
      },
    );
  }
  return { text: out, count };
}

/** Cut to `max` characters without splitting a surrogate pair. */
export function capChars(text: string, max: number, marker = ""): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end) + marker;
}

/** A cleaned line made repository-relative, redacted and capped. */
export function sanitizeEvidenceLine(clean: string): string {
  const relative = clean.replace(WORKSPACE, "");
  return capChars(
    redactSecrets(relative).text,
    MAX_CI_EVIDENCE_LINE_CHARS,
    " [...]",
  );
}

/** Untrusted multi-line text (annotations, check output) for the fence. */
export function sanitizeEvidenceText(raw: string, maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (used >= maxChars) break;
    const clean = sanitizeEvidenceLine(cleanLogLine(line));
    lines.push(clean);
    used += clean.length + 1;
  }
  return capChars(lines.join("\n"), maxChars);
}
