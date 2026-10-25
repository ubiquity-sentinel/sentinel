/**
 * Log neutralization of target output (docs/backup-ci-spec.md §10.5) and of
 * the trusted failure excerpt (§9.2 step 6). Pure.
 *
 * Every line the untrusted leg prints from the target job goes through
 * `BackupCiLogSanitizer`: workflow commands are stopped for the whole stream
 * (`::stop-commands::<128-bit random token>` before it, `::<token>::` after),
 * and every rendered line is additionally neutralized, so even a command
 * that guessed the token cannot run:
 *
 * - each line is `│ [<stepIndex>] <msg>` (never starting with `::` or `##[`);
 * - every `::` becomes `:\u200b:` and every `##[` becomes `#\u200b#[`;
 * - ANSI escapes other than SGR colors and every other C0/C1 control
 *   character are removed;
 * - a line is split into chunks of at most 4 KiB, each with the prefix;
 * - the stream is capped at 4 MiB, followed by one truncation notice.
 *
 * The trusted ingest re-applies `neutralizeLogText` to the lines it keeps
 * for a receipt excerpt (`backupCiExcerpt`), so an excerpt never carries a
 * control sequence or a workflow command, and is bounded to 8 KiB.
 */
import { BACKUP_CI_MAX_EXCERPT_BYTES } from "../src/contracts/backup-ci.ts";

export const BACKUP_CI_LOG_CHUNK_BYTES = 4096;
export const BACKUP_CI_LOG_CAP_BYTES = 4 * 2 ** 20;
export const BACKUP_CI_LOG_TRUNCATED =
  "│ [-] sentinel-backup-ci: target output truncated at 4 MiB";
const ZWSP = "\u200b";
const encoder = new TextEncoder();

/** Escape sequences: CSI (SGR kept), OSC, and two-byte ESC sequences. */
const ESCAPES =
  // deno-lint-ignore no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]?|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_]?)/g;
// deno-lint-ignore no-control-regex
const SGR = /^\x1b\[[0-9;]*m$/;
/** C0 (but tab and the ESC of a kept SGR), DEL and C1 controls. */
// deno-lint-ignore no-control-regex
const CONTROLS = /[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f-\x9f\u2028\u2029]/g;

/** An ESC that does not start a kept SGR sequence. */
// deno-lint-ignore no-control-regex
const LONE_ESC = /\x1b(?!\[[0-9;]*m)/g;

/** A fresh 128-bit hex token for `::stop-commands::`. */
export function stopCommandsToken(
  bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): string {
  if (bytes.length !== 16) throw new Error("stop token needs 16 bytes");
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One line of target text with controls removed and commands escaped. */
export function neutralizeLogText(text: string): string {
  const stripped = text
    .replace(ESCAPES, (sequence) => SGR.test(sequence) ? sequence : "")
    .replace(LONE_ESC, "")
    .replace(CONTROLS, "");
  return stripped.replace(/:(?=:)/g, `:${ZWSP}`).replace(
    /#(?=#\[)/g,
    `#${ZWSP}`,
  );
}

/** Splits `text` into chunks of at most `max` UTF-8 bytes (code points kept). */
export function chunkUtf8(text: string, max: number): string[] {
  const chunks: string[] = [];
  if (text.length * 3 <= max) return [text];
  let current = "";
  let size = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    const width = point < 0x80
      ? 1
      : point < 0x800
      ? 2
      : point < 0x10000
      ? 3
      : 4;
    if (size + width > max && current.length > 0) {
      chunks.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += width;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

/**
 * Streams target lines to `write` as neutralized, prefixed, chunked and
 * capped log lines between a stop-commands pair.
 */
export class BackupCiLogSanitizer {
  private written = 0;
  private truncated = false;
  private open = false;

  constructor(
    private readonly token: string,
    private readonly write: (line: string) => void,
  ) {
    if (!/^[0-9a-f]{32}$/.test(token)) throw new Error("invalid stop token");
  }

  begin(): void {
    if (this.open) return;
    this.open = true;
    this.write(`::stop-commands::${this.token}`);
  }

  /** One target line; `stepIndex` null for output outside any planned step. */
  line(stepIndex: number | null, message: string): void {
    if (!this.open) this.begin();
    if (this.truncated) return;
    const prefix = `│ [${stepIndex === null ? "-" : String(stepIndex)}] `;
    const prefixBytes = encoder.encode(prefix).length;
    for (
      const chunk of chunkUtf8(
        neutralizeLogText(message),
        BACKUP_CI_LOG_CHUNK_BYTES,
      )
    ) {
      const size = prefixBytes + encoder.encode(chunk).length + 1;
      if (this.written + size > BACKUP_CI_LOG_CAP_BYTES) {
        this.truncated = true;
        this.write(BACKUP_CI_LOG_TRUNCATED);
        return;
      }
      this.written += size;
      this.write(`${prefix}${chunk}`);
    }
  }

  end(): void {
    if (!this.open) this.begin();
    this.write(`::${this.token}::`);
    this.open = false;
  }
}

/**
 * The receipt excerpt of one failing step: the target lines the leg logged
 * with that step's prefix (already stripped by the caller), neutralized
 * again, keeping the last lines that fit in 8 KiB with one cut notice.
 */
export function backupCiExcerpt(
  lines: readonly string[],
  max: number = BACKUP_CI_MAX_EXCERPT_BYTES,
): string {
  const kept: string[] = [];
  const notice = "[... earlier lines cut ...]";
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = chunkUtf8(neutralizeLogText(lines[i]), 512)[0];
    const width = encoder.encode(line).length + 1;
    if (size + width + encoder.encode(notice).length + 1 > max) {
      kept.unshift(notice);
      break;
    }
    kept.unshift(line);
    size += width;
  }
  return kept.join("\n");
}
