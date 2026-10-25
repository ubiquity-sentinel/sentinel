/**
 * The v1 expression and context-reference rules of the backup CI planner
 * (docs/backup-ci-spec.md §5). Pure.
 *
 * - `checkTemplate`: every `${{ }}` in a `run`, `with`, `env`, `name`,
 *   `working-directory` or `shell` value may use only the allowlisted
 *   contexts, functions and literals. `secrets.*`/`vars.*` refuse as
 *   `secrets_or_vars`, `github.token` as `token`, anything else unknown as
 *   `expression_context`. Dynamic property access (`a[b]`) and object
 *   filters (`a.*`) are refused: they cannot be checked.
 * - `stepCondition`: a step `if:` is absent or only status functions with
 *   `!`, `&&`, `||` and parentheses.
 * - `runTextReference`: `run:` text naming an event, ref, actor or token
 *   variable, or `ACT` as a variable.
 * - `BACKUP_CI_CONTEXT_GREP`: the POSIX ERE the trusted job runs with
 *   `git grep` over tracked source for environment reads of those values.
 *
 * GitHub context and function names are case-insensitive; matrix axes,
 * step ids and output names are checked as written.
 */
import type { BackupCiUnsupportedV1 } from "../src/contracts/backup-ci.ts";

type Refusal = Extract<
  BackupCiUnsupportedV1,
  "expression_context" | "secrets_or_vars" | "token"
>;

const FUNCTIONS = new Set([
  "contains",
  "startswith",
  "endswith",
  "format",
  "join",
  "tojson",
  "fromjson",
  "hashfiles",
]);
const STATUS_FUNCTIONS = new Set(["success", "failure", "always", "cancelled"]);
const GITHUB_KEYS = new Set([
  "workspace",
  "repository",
  "repository_owner",
  "server_url",
  "api_url",
  "run_id",
  "run_number",
  "run_attempt",
  "job",
  "action_path",
]);
const RUNNER_KEYS = new Set(["os", "arch", "temp", "tool_cache"]);
const STRATEGY_KEYS = new Set(["job-index", "job-total"]);
/** Environment names an `env.<NAME>` read may not use (act sets them). */
const ENV_DENIED = /^(?:ACT|GITHUB_.*|RUNNER_.*)$/i;

type Token =
  | { kind: "ident"; text: string }
  | { kind: "string" | "number"; text: string }
  | { kind: "punct"; text: string };

const PUNCT = [
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "<",
  ">",
  "!",
  "(",
  ")",
  "[",
  "]",
  ",",
  ".",
  "*",
];

/** Tokens of one expression body, or null when it does not tokenize. */
export function tokenizeExpression(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= source.length) return null;
        if (source[j] === "'") {
          if (source[j + 1] === "'") {
            text += "'";
            j += 2;
            continue;
          }
          break;
        }
        text += source[j++];
      }
      tokens.push({ kind: "string", text });
      i = j + 1;
      continue;
    }
    const number =
      /^(?:0x[0-9a-fA-F]+|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/
        .exec(source.slice(i));
    if (number !== null && (c !== "-" || /[0-9]/.test(source[i + 1] ?? ""))) {
      tokens.push({ kind: "number", text: number[0] });
      i += number[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(i));
    if (ident !== null) {
      tokens.push({ kind: "ident", text: ident[0] });
      i += ident[0].length;
      continue;
    }
    const punct = PUNCT.find((p) => source.startsWith(p, i));
    if (punct === undefined) return null;
    tokens.push({ kind: "punct", text: punct });
    i += punct.length;
  }
  return tokens;
}

/** The bodies of every `${{ }}` in `text`, or null when one is unterminated. */
export function expressionBodies(text: string): string[] | null {
  const bodies: string[] = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf("${{", at);
    if (start < 0) return bodies;
    let i = start + 3;
    let inString = false;
    for (;;) {
      if (i >= text.length) return null;
      const c = text[i];
      if (inString) {
        if (c === "'" && text[i + 1] === "'") i += 2;
        else {
          if (c === "'") inString = false;
          i++;
        }
        continue;
      }
      if (c === "'") {
        inString = true;
        i++;
        continue;
      }
      if (text.startsWith("}}", i)) break;
      i++;
    }
    bodies.push(text.slice(start + 3, i));
    at = i + 2;
  }
}

/** Whether a context chain (root plus property names) is allowlisted. */
function chainVerdict(chain: string[]): Refusal | null {
  const [root, ...props] = chain;
  const r = root.toLowerCase();
  if (r === "secrets" || r === "vars") return "secrets_or_vars";
  const p = props.map((x) => x.toLowerCase());
  switch (r) {
    case "matrix":
      return props.length === 1 ? null : "expression_context";
    case "steps":
      if (props.length === 2 && (p[1] === "outcome" || p[1] === "conclusion")) {
        return null;
      }
      return props.length === 3 && p[1] === "outputs"
        ? null
        : "expression_context";
    case "env":
      return props.length === 1 && !ENV_DENIED.test(props[0])
        ? null
        : "expression_context";
    case "runner":
      return props.length === 1 && RUNNER_KEYS.has(p[0])
        ? null
        : "expression_context";
    case "github":
      if (props.length >= 1 && p[0] === "token") return "token";
      return props.length === 1 && GITHUB_KEYS.has(p[0])
        ? null
        : "expression_context";
    case "strategy":
      return props.length === 1 && STRATEGY_KEYS.has(p[0])
        ? null
        : "expression_context";
    case "job":
      return props.length === 1 && p[0] === "status"
        ? null
        : "expression_context";
    default:
      return "expression_context";
  }
}

/**
 * The refusal of one expression body, or null when every context access,
 * function and literal is allowlisted. `allowStatus` admits the status
 * functions (conditions only).
 */
export function checkExpression(
  body: string,
  allowStatus = false,
): Refusal | null {
  const tokens = tokenizeExpression(body);
  if (tokens === null || tokens.length === 0) return "expression_context";
  let worst: Refusal | null = null;
  const note = (r: Refusal | null) => {
    if (r === null) return;
    if (worst === null || rank(r) > rank(worst)) worst = r;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "punct" && token.text === "*") {
      note("expression_context");
      continue;
    }
    if (token.kind !== "ident") continue;
    const previous = tokens[i - 1];
    if (previous?.kind === "punct" && previous.text === ".") continue;
    const next = tokens[i + 1];
    if (next?.kind === "punct" && next.text === "(") {
      const name = token.text.toLowerCase();
      if (
        !FUNCTIONS.has(name) && !(allowStatus && STATUS_FUNCTIONS.has(name))
      ) note("expression_context");
      continue;
    }
    if (["true", "false", "null"].includes(token.text)) continue;
    const chain = [token.text];
    let j = i + 1;
    for (;;) {
      const dot = tokens[j];
      if (dot?.kind === "punct" && dot.text === ".") {
        const property = tokens[j + 1];
        if (property?.kind !== "ident") {
          note("expression_context");
          break;
        }
        chain.push(property.text);
        j += 2;
        continue;
      }
      if (dot?.kind === "punct" && dot.text === "[") {
        const inner = tokens[j + 1];
        const close = tokens[j + 2];
        if (
          inner?.kind === "string" && close?.kind === "punct" &&
          close.text === "]" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(inner.text)
        ) {
          chain.push(inner.text);
          j += 3;
          continue;
        }
        note("expression_context");
      }
      break;
    }
    note(chainVerdict(chain));
    i = j - 1;
  }
  return worst;
}

function rank(r: Refusal): number {
  return r === "secrets_or_vars" ? 3 : r === "token" ? 2 : 1;
}

/** The refusal of a template string's `${{ }}` uses, or null. */
export function checkTemplate(value: unknown): Refusal | null {
  if (typeof value !== "string") return null;
  const bodies = expressionBodies(value);
  if (bodies === null) return "expression_context";
  let worst: Refusal | null = null;
  for (const body of bodies) {
    const refusal = checkExpression(body);
    if (refusal !== null && (worst === null || rank(refusal) > rank(worst))) {
      worst = refusal;
    }
  }
  return worst;
}

/**
 * A step condition's class: absent is `none`, only status functions with
 * `!`, `&&`, `||` and parentheses is `status_only`, anything else null.
 */
export function stepCondition(
  value: unknown,
): "none" | "status_only" | null {
  if (value === undefined) return "none";
  if (typeof value !== "string") return null;
  let body = value.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(body);
  if (wrapped !== null) body = wrapped[1];
  if (body.includes("${{")) return null;
  const tokens = tokenizeExpression(body);
  if (tokens === null || tokens.length === 0) return null;
  let expectOperand = true;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (expectOperand) {
      if (t.kind === "punct" && t.text === "!") continue;
      if (t.kind === "punct" && t.text === "(") {
        depth++;
        continue;
      }
      if (
        t.kind === "ident" && STATUS_FUNCTIONS.has(t.text.toLowerCase()) &&
        tokens[i + 1]?.text === "(" && tokens[i + 2]?.text === ")"
      ) {
        i += 2;
        expectOperand = false;
        continue;
      }
      return null;
    }
    if (t.kind === "punct" && t.text === ")" && depth > 0) {
      depth--;
      continue;
    }
    if (t.kind === "punct" && (t.text === "&&" || t.text === "||")) {
      expectOperand = true;
      continue;
    }
    return null;
  }
  return !expectOperand && depth === 0 ? "status_only" : null;
}

/** Variables a `run:` script may not name (§5). */
export const BACKUP_CI_RUN_DENIED = [
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_BASE_REF",
  "GITHUB_HEAD_REF",
  "GITHUB_ACTOR",
  "GITHUB_TRIGGERING_ACTOR",
  "GITHUB_TOKEN",
] as const;

const RUN_DENIED = new RegExp(
  `(?<![A-Za-z0-9_])(?:${BACKUP_CI_RUN_DENIED.join("|")})(?![A-Za-z0-9_])`,
);
const RUN_ACT =
  /(?:\$\{?[#!]?|\benv\.|\bprintenv\s+|getenv\(\s*["']|env\[\s*["'])ACT(?![A-Za-z0-9_])/;

/** Whether `run:` text references an event, ref, actor or token value. */
export function runTextReference(text: string): boolean {
  return RUN_DENIED.test(text) || RUN_ACT.test(text);
}

/** Variables tracked source may not read (§5, the tree rule). */
export const BACKUP_CI_TREE_DENIED = [
  "ACT",
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_BASE_REF",
  "GITHUB_HEAD_REF",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_ACTOR",
] as const;

/**
 * POSIX ERE for `git grep -E`: `process.env.X`, `env.X`, `env["X"]`,
 * `Deno.env.get("X")`, `getenv("X")`, `$X` and `${X` of a denied name.
 */
export const BACKUP_CI_CONTEXT_GREP =
  `(env[.]|env[[]["']|Deno[.]env[.]get[(]["']|getenv[(]["']|[$][{]?)(${
    BACKUP_CI_TREE_DENIED.join("|")
  })([^A-Za-z0-9_]|$)`;
