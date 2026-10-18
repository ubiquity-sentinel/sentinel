/** Incremental JSON framing: bound retained evidence, never aggregate output. */
export const CODEX_OUTPUT_PATHS = [
  "delta",
  "item.text",
  "item.aggregatedOutput",
  "item.summary",
  "item.content",
  "item.result",
  "item.output",
  "item.error.message",
  "item.changes[].diff",
  "item.contentItems",
  "item.revisedPrompt",
  "item.review",
  "message",
  "error.message",
  "turn.error.message",
  "unobservedParams",
] as const;
export type CodexOutputPathV1 = typeof CODEX_OUTPUT_PATHS[number];
export function isCodexOutputPathV1(
  value: unknown,
): value is CodexOutputPathV1 {
  return typeof value === "string" &&
    (CODEX_OUTPUT_PATHS as readonly string[]).includes(value);
}
export interface CodexOutputVolumeV1 {
  observedParamsChars: number;
  truncatedOutputPaths: readonly CodexOutputPathV1[];
}
export interface ProjectedCodexFrame {
  value: unknown;
  outputVolume?: CodexOutputVolumeV1;
}
const OUTPUT_CHARS = 64 * 1024;
const KNOWN_METHODS = new Set([
  "item/started",
  "item/completed",
  "turn/completed",
  "model/rerouted",
  "item/commandExecution/outputDelta",
  "thread/compacted",
]);
type Container = {
  kind: "object" | "array";
  path: string;
  value: Record<string, unknown> | unknown[];
  state: "keyOrEnd" | "key" | "colon" | "valueOrEnd" | "value" | "commaOrEnd";
  key: string;
  skip: boolean;
  output: CodexOutputPathV1 | null;
  chars: number;
  retainedStart: number;
};
type Token = {
  kind: "string" | "number" | "literal";
  path: string;
  key: boolean;
  text: string;
  escape: boolean;
  unicode: string | null;
  output: CodexOutputPathV1 | null;
  numberState: string;
  literal: string;
  length: number;
};

/**
 * This lexer validates discarded values too, including string escapes, number
 * grammar and container separators. Only closed output slots may lose evidence.
 * IDs, routing, approvals and terminal state are never projected. Deeply nested
 * data remains a protocol-depth violation; the stack itself cannot grow forever.
 */
export class CodexJsonFrame {
  private stack: Container[] = [];
  private token: Token | null = null;
  private value: unknown;
  private done = false;
  private retained = 0;
  private retainedOutput = 0;
  private paramsActive = false;
  private paramsChars = 0;
  private truncated = new Set<CodexOutputPathV1>();

  constructor(private readonly maxControlChars: number) {}

  get empty(): boolean {
    return !this.done && this.stack.length === 0 && this.token === null;
  }

  push(char: string): void {
    if (
      this.paramsActive && !(this.token?.path === "params" &&
        this.token.kind !== "string" && /^[\x20\t\r,}\]]$/.test(char))
    ) {
      this.paramsChars = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.paramsChars + 1,
      );
    }
    for (const container of this.stack) {
      if (
        container.output !== null && ++container.chars > OUTPUT_CHARS &&
        !container.skip
      ) {
        container.skip = true;
        container.value = container.kind === "array" ? [] : {};
        this.truncated.add(container.output);
      }
    }
    if (this.token !== null) {
      if (this.consumeToken(char)) return;
    }
    this.syntax(char);
  }

  finish(): ProjectedCodexFrame | null {
    if (this.token !== null && this.token.kind !== "string") this.finishToken();
    if (this.empty) return null;
    if (!this.done || this.stack.length !== 0 || this.token !== null) {
      throw new Error("unterminated JSON frame");
    }
    const record = object(this.value);
    if (this.truncated.size > 0) {
      if (
        record === null || typeof record.method !== "string" || "id" in record
      ) {
        throw new Error("oversized control frame");
      }
      for (const path of this.truncated) {
        if (!projectionAllowed(record, path)) {
          throw new Error("oversized control field");
        }
      }
    }
    return {
      value: this.value,
      ...(this.truncated.size === 0 ? {} : {
        outputVolume: {
          observedParamsChars: this.paramsChars,
          truncatedOutputPaths: [...this.truncated],
        },
      }),
    };
  }

  private syntax(char: string): void {
    if (/^[\x20\t\r]$/.test(char)) return;
    const parent = this.stack.at(-1);
    if (parent?.state === "colon") {
      if (char !== ":") throw new Error("missing JSON colon");
      parent.state = "value";
      return;
    }
    if (parent?.state === "commaOrEnd") {
      if (char === ",") {
        parent.state = parent.kind === "object" ? "key" : "value";
        return;
      }
      if (char === (parent.kind === "object" ? "}" : "]")) {
        this.endContainer();
        return;
      }
      throw new Error("missing JSON separator");
    }
    if (parent?.state === "keyOrEnd" || parent?.state === "key") {
      if (char === "}" && parent.state === "keyOrEnd") {
        this.endContainer();
        return;
      }
      if (char !== '"') throw new Error("invalid JSON key");
      this.startToken("string", "", true);
      return;
    }
    if (parent?.state === "valueOrEnd" && char === "]") {
      this.endContainer();
      return;
    }
    if (this.done) throw new Error("trailing JSON data");
    const path = valuePath(parent);
    if (path === "params") {
      this.paramsActive = true;
      this.paramsChars++;
    }
    if (char === "{" || char === "[") {
      if (this.stack.length >= 128) {
        throw new Error("JSON protocol depth exceeded");
      }
      const retainedStart = this.retained;
      this.charge(8);
      const kind = char === "{" ? "object" : "array";
      this.stack.push({
        kind,
        path,
        value: kind === "object" ? {} : [],
        state: kind === "object" ? "keyOrEnd" : "valueOrEnd",
        key: "",
        skip: this.skipping(),
        output: outputPath(path),
        chars: 1,
        retainedStart,
      });
    } else if (char === '"') this.startToken("string", path, false);
    else if (char === "t" || char === "f" || char === "n") {
      this.startToken("literal", path, false);
      this.token!.literal = char === "t"
        ? "true"
        : char === "f"
        ? "false"
        : "null";
      this.consumeToken(char);
    } else if (char === "-" || /[0-9]/.test(char)) {
      this.startToken("number", path, false);
      this.consumeToken(char);
    } else throw new Error("invalid JSON value");
  }

  private startToken(kind: Token["kind"], path: string, key: boolean): void {
    this.charge(8);
    this.token = {
      kind,
      path,
      key,
      text: "",
      escape: false,
      unicode: null,
      output: key
        ? null
        : path === "params"
        ? "unobservedParams"
        : outputPath(path),
      numberState: "start",
      literal: "",
      length: 0,
    };
  }

  private consumeToken(char: string): boolean {
    const token = this.token!;
    if (token.kind === "string") {
      if (token.output === null) this.charge(1);
      if (token.unicode !== null) {
        if (!/^[0-9a-fA-F]$/.test(char)) {
          throw new Error("invalid JSON unicode escape");
        }
        token.unicode += char;
        if (token.unicode.length === 4) {
          this.append(String.fromCharCode(Number.parseInt(token.unicode, 16)));
          token.unicode = null;
        }
        return true;
      }
      if (token.escape) {
        token.escape = false;
        if (char === "u") token.unicode = "";
        else {
          const escapes: Record<string, string> = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (!(char in escapes)) throw new Error("invalid JSON string escape");
          this.append(escapes[char]);
        }
        return true;
      }
      if (char === "\\") {
        token.escape = true;
        return true;
      }
      if (char === '"') {
        this.finishToken();
        return true;
      }
      if (char.charCodeAt(0) < 32) {
        throw new Error("invalid JSON string control");
      }
      this.append(char);
      return true;
    }
    if (/^[\x20\t\r,}\]]$/.test(char)) {
      this.finishToken();
      return false;
    }
    if (token.kind === "literal") {
      if (char !== token.literal[token.length]) {
        throw new Error("invalid JSON literal");
      }
      token.length++;
    } else {
      token.numberState = nextNumber(token.numberState, char);
      this.append(char);
    }
    return true;
  }

  private append(char: string): void {
    const token = this.token!;
    if (this.skipping()) return;
    if (token.output !== null) {
      if (this.retainedOutput + char.length > OUTPUT_CHARS) {
        this.truncated.add(token.output);
        return;
      }
      this.retainedOutput += char.length;
    } else if (token.kind !== "string") this.charge(char.length);
    if (!this.skipping()) token.text += char;
  }

  private finishToken(): void {
    const token = this.token!;
    if (
      token.kind === "number" &&
      !["zero", "int", "fraction", "exponent"].includes(token.numberState)
    ) throw new Error("invalid JSON number");
    if (token.kind === "literal" && token.length !== token.literal.length) {
      throw new Error("invalid JSON literal");
    }
    this.token = null;
    if (token.key) {
      const parent = this.stack.at(-1)!;
      parent.key = this.skipping() ? "" : token.text;
      parent.state = "colon";
    } else {this.complete(
        token.path,
        token.output === "unobservedParams" &&
          this.truncated.has("unobservedParams")
          ? null
          : token.kind === "string"
          ? token.text
          : token.kind === "number"
          ? Number(token.text)
          : JSON.parse(token.literal),
      );}
  }

  private endContainer(): void {
    const container = this.stack.pop()!;
    this.complete(container.path, container.skip ? null : container.value);
  }

  private complete(path: string, value: unknown): void {
    const parent = this.stack.at(-1);
    if (parent === undefined) {
      this.value = value;
      this.done = true;
    } else {
      if (!this.skipping()) {
        if (parent.kind === "array") (parent.value as unknown[]).push(value);
        else {Object.defineProperty(parent.value, parent.key, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
          });}
      }
      parent.state = "commaOrEnd";
    }
    if (path === "params") this.paramsActive = false;
  }

  private skipping(): boolean {
    return this.stack.some((entry) => entry.skip);
  }
  private charge(amount: number): void {
    if (this.skipping()) return;
    this.retained += amount;
    if (this.retained <= this.maxControlChars) return;
    const params = this.stack.find((entry) => entry.path === "params");
    if (params === undefined) {
      throw new Error("JSON control field bound exceeded");
    }
    params.skip = true;
    this.retained = params.retainedStart;
    params.value = {};
    this.truncated.clear();
    this.truncated.add("unobservedParams");
    if (this.token !== null) this.token.text = "";
  }
}
/** Paths are parser state, not copies of arbitrary untrusted property names. */
function valuePath(parent: Container | undefined): string {
  if (parent === undefined) return "";
  if (parent.path === "#" || parent.key.length > 64) return "#";
  const path = parent.kind === "array"
    ? parent.path + "[]"
    : (parent.path ? parent.path + "." : "") + parent.key;
  if (path === "params") return path;
  return CODEX_OUTPUT_PATHS.some((slot) => {
      const target = "params." + slot;
      return target === path || target.startsWith(path + ".") ||
        target.startsWith(path + "[]");
    })
    ? path
    : "#";
}
function outputPath(path: string): CodexOutputPathV1 | null {
  const relative = path.startsWith("params.") ? path.slice(7) : "";
  return isCodexOutputPathV1(relative) && relative !== "unobservedParams"
    ? relative
    : null;
}
function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function projectionAllowed(
  frame: Record<string, unknown>,
  path: CodexOutputPathV1,
): boolean {
  const method = frame.method as string;
  if (path === "unobservedParams") return !KNOWN_METHODS.has(method);
  const item = object(object(frame.params)?.item);
  if (path === "item.text") {
    return item?.type === "agentMessage" || item?.type === "plan";
  }
  if (path === "item.aggregatedOutput") {
    return item?.type === "commandExecution";
  }
  if (path === "item.summary" || path === "item.content") {
    return item?.type === "reasoning" || item?.type === "mcpToolCall";
  }
  if (path === "item.result") {
    return item?.type === "mcpToolCall" || item?.type === "imageGeneration";
  }
  if (path === "item.output" || path === "item.error.message") {
    return item?.type === "mcpToolCall";
  }
  if (path === "item.changes[].diff") return item?.type === "fileChange";
  if (path === "item.contentItems") return item?.type === "dynamicToolCall";
  if (path === "item.revisedPrompt") return item?.type === "imageGeneration";
  if (path === "item.review") {
    return item?.type === "enteredReviewMode" ||
      item?.type === "exitedReviewMode";
  }
  if (path === "turn.error.message") return method === "turn/completed";
  if (path === "error.message") return method === "error";
  if (path === "message") return method === "item/mcpToolCall/progress";
  return method.startsWith("item/") &&
    (method.endsWith("Delta") || method.endsWith("/delta"));
}
function nextNumber(state: string, char: string): string {
  if (state === "start" && char === "-") return "sign";
  if ((state === "start" || state === "sign") && char === "0") return "zero";
  if ((state === "start" || state === "sign") && /^[1-9]$/.test(char)) {
    return "int";
  }
  if (
    (state === "int" || state === "fraction" || state === "exponent") &&
    /^[0-9]$/.test(char)
  ) return state;
  if ((state === "zero" || state === "int") && char === ".") return "dot";
  if (state === "dot" && /^[0-9]$/.test(char)) return "fraction";
  if (["zero", "int", "fraction"].includes(state) && /^[eE]$/.test(char)) {
    return "e";
  }
  if (state === "e" && /^[+-]$/.test(char)) return "esign";
  if ((state === "e" || state === "esign") && /^[0-9]$/.test(char)) {
    return "exponent";
  }
  throw new Error("invalid JSON number");
}
