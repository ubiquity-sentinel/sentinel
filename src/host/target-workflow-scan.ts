/**
 * Dependency-free pull_request trigger detection for a target workflow.
 *
 * The cold hosted actions entrypoint reaches this module. It must never pull a
 * YAML package (JSR or otherwise) into that graph, so this scanner proves the
 * `on:` trigger from the small YAML subset workflows actually use: block and
 * flow mappings, flow sequences and block list items, with comments stripped.
 */

/**
 * Strip YAML comments outside quoted scalars. `#` only starts a comment at the
 * start of a line or after whitespace, so a `#` inside a flow scalar stays.
 */
function stripYamlComments(text: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (quote === "'") {
      if (ch === "'") {
        if (text[index + 1] === "'") {
          out += "''";
          index += 1;
          continue;
        }
        quote = null;
      }
      out += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        out += ch;
        if (index + 1 < text.length) {
          out += text[index + 1]!;
          index += 1;
        }
        continue;
      }
      if (ch === '"') quote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#" && (index === 0 || /\s/.test(text[index - 1]!))) {
      while (index < text.length && text[index] !== "\n") index += 1;
      if (index < text.length) out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Unquote a single YAML scalar; only the exact quoted form is unwrapped. */
function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Index of the first `:` outside quotes and nested flow collections. */
function topLevelColon(text: string): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') index += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === ":" && depth === 0) return index;
  }
  return -1;
}

/** Split a flow collection body on top-level commas. */
function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < inner.length; index += 1) {
    const ch = inner[index]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') index += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      items.push(inner.slice(start, index));
      start = index + 1;
    }
  }
  items.push(inner.slice(start));
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

/** Whether a flow collection (or one flow item) names pull_request. */
function flowHasPullRequestV1(text: string): boolean | null {
  const trimmed = text.trim();
  const opening = trimmed[0];
  if (opening !== "[" && opening !== "{") return null;
  const closing = opening === "[" ? "]" : "}";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let end = -1;
  for (let index = 0; index < trimmed.length; index += 1) {
    const ch = trimmed[index]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') index += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  // An unterminated flow sequence cannot prove the trigger.
  if (end === -1 || trimmed[end] !== closing) return null;
  const inner = trimmed.slice(1, end);
  if (opening === "[") {
    return splitFlowItems(inner).some((item) =>
      unquoteYamlScalar(item) === "pull_request"
    );
  }
  return splitFlowItems(inner).some((entry) => {
    const colon = topLevelColon(entry);
    return colon !== -1 &&
      unquoteYamlScalar(entry.slice(0, colon)) === "pull_request";
  });
}

/** Scan the direct children of a bare `on:` mapping/sequence. */
function blockHasPullRequestV1(
  lines: readonly string[],
  start: number,
): boolean {
  let childIndent: number | null = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "---") continue;
    const indent = raw.length - raw.trimStart().length;
    // A new top-level key ends this `on:` block.
    if (indent === 0) break;
    // Only direct children name triggers; a nested `pull_request` input is not
    // an event.
    if (childIndent === null) childIndent = indent;
    if (indent < childIndent) break;
    if (indent > childIndent) continue;
    if (trimmed.startsWith("-")) {
      const item = trimmed.slice(1).trim();
      const flow = flowHasPullRequestV1(item);
      if (flow === true) return true;
      if (/^pull_request(?:\s*$|:|\s)/.test(unquoteYamlScalar(item))) {
        return true;
      }
      continue;
    }
    const colon = topLevelColon(trimmed);
    if (
      colon !== -1 &&
      unquoteYamlScalar(trimmed.slice(0, colon)) === "pull_request"
    ) return true;
  }
  return false;
}

/**
 * Whether a workflow declares the pull_request trigger in any YAML spelling:
 * block mapping (`on:\n  pull_request:`), flow sequence
 * (`on: [push, pull_request]`), flow mapping (`on: {pull_request: {}}`) or a
 * block list item (`- pull_request`). This is a small dependency-free scanner:
 * the cold hosted entrypoint must not pull a YAML package from JSR.
 */
export function workflowHasPullRequestTriggerV1(text: string): boolean {
  const lines = stripYamlComments(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  let sawTrigger = false;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(?:on|"on"|'on')\s*:(.*)$/.exec(lines[index]!);
    if (match === null) continue;
    let rest = match[1]!.trim();
    if (rest === "") {
      if (blockHasPullRequestV1(lines, index)) sawTrigger = true;
      continue;
    }
    // A flow collection may continue on the following indented lines.
    if (rest.startsWith("[") || rest.startsWith("{")) {
      let end = index;
      let flow = flowHasPullRequestV1(rest);
      while (flow === null && end + 1 < lines.length) {
        const next = lines[end + 1]!;
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        end += 1;
        rest += `\n${next}`;
        flow = flowHasPullRequestV1(rest);
      }
      if (flow === true) sawTrigger = true;
      index = end;
      continue;
    }
    if (unquoteYamlScalar(rest) === "pull_request") sawTrigger = true;
  }
  return sawTrigger;
}
