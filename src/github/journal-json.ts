// journal json.

import { fail } from "../contracts/validation.ts";
import { STRICT_JSON_ISSUE_MESSAGE } from "./review-result-contracts.ts";

// ---------------------------------------------------------------------------
// Strict JSON (duplicate-key rejecting, full consumption)
// ---------------------------------------------------------------------------

export class JsonSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSyntaxError";
  }
}

export function expectStrictJson(text: string, path: string): unknown {
  try {
    return parseJsonStrict(text);
  } catch {
    // Static sanitized failure; the input is never echoed.
    fail(path, "invalid_value", STRICT_JSON_ISSUE_MESSAGE);
  }
}

export function parseJsonStrict(text: string): unknown {
  const parser = new StrictJsonParser(text);
  const value = parser.parse();
  return value;
}

export class StrictJsonParser {
  private index = 0;
  private readonly length: number;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
    this.length = text.length;
  }

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.length) {
      throw new JsonSyntaxError("unexpected trailing content");
    }
    return value;
  }

  private parseValue(): unknown {
    const char = this.peek();
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"') return this.parseString();
    if (char === "t") {
      this.expectLiteral("true");
      return true;
    }
    if (char === "f") {
      this.expectLiteral("false");
      return false;
    }
    if (char === "n") {
      this.expectLiteral("null");
      return null;
    }
    if (char === "-" || isDigit(char)) return this.parseNumber();
    throw new JsonSyntaxError("expected JSON value");
  }

  private parseObject(): unknown {
    this.expect("{");
    const result: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.index++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        throw new JsonSyntaxError("expected object key");
      }
      const key = this.parseString();
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        // Duplicate keys are never silently resolved to the last value.
        throw new JsonSyntaxError("duplicate object key");
      }
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      const value = this.parseValue();
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      const char = this.peek();
      if (char === "}") {
        this.index++;
        return result;
      }
      if (char !== ",") {
        throw new JsonSyntaxError("expected comma or closing brace");
      }
      this.index++;
    }
  }

  private parseArray(): unknown {
    this.expect("[");
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.index++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue());
      this.skipWhitespace();
      const char = this.peek();
      if (char === "]") {
        this.index++;
        return result;
      }
      if (char !== ",") {
        throw new JsonSyntaxError("expected comma or closing bracket");
      }
      this.index++;
    }
  }

  private parseString(): string {
    this.expect('"');
    let result = "";
    for (;;) {
      if (this.index >= this.length) {
        throw new JsonSyntaxError("unterminated string");
      }
      const char = this.text[this.index];
      if (char === '"') {
        this.index++;
        return result;
      }
      if (char === "\\") {
        this.index++;
        if (this.index >= this.length) {
          throw new JsonSyntaxError("unterminated escape");
        }
        const escape = this.text[this.index++];
        switch (escape) {
          case '"':
            result += '"';
            break;
          case "\\":
            result += "\\";
            break;
          case "/":
            result += "/";
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u": {
            const hex = this.text.slice(this.index, this.index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new JsonSyntaxError("invalid unicode escape");
            }
            this.index += 4;
            result += String.fromCharCode(Number.parseInt(hex, 16));
            break;
          }
          default:
            throw new JsonSyntaxError("invalid string escape");
        }
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 0x20) {
        // A raw control character inside a string is not valid JSON.
        throw new JsonSyntaxError("unescaped control character in string");
      }
      result += char;
      this.index++;
    }
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.text.slice(this.index),
    );
    if (match === null) {
      throw new JsonSyntaxError("invalid number");
    }
    this.index += match[0].length;
    return Number(match[0]);
  }

  private expectLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.index)) {
      throw new JsonSyntaxError("invalid literal");
    }
    this.index += literal.length;
  }

  private skipWhitespace(): void {
    while (this.index < this.length) {
      const char = this.text[this.index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index++;
        continue;
      }
      break;
    }
  }

  private expect(char: string): void {
    if (this.peek() !== char) {
      throw new JsonSyntaxError(`expected "${char}"`);
    }
    this.index++;
  }

  private peek(): string {
    if (this.index >= this.length) {
      throw new JsonSyntaxError("unexpected end of input");
    }
    return this.text[this.index];
  }
}

export function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}
