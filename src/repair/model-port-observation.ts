/** Conservative command parsing and content-bound repeated-failure observations. */
import { checkoutContentCheckpoint } from "./checkout-content.ts";
import type { FailedCommandObservation } from "./failed-command-loop.ts";

/** Bounded capture of one completed command item, taken at receipt time. */
export interface CapturedObservationV1 {
  /** Progress generation at receipt (starts and edits advance it). */
  receivedGeneration: number;
  /** Steering-ack state at receipt; async work must not relabel pre-ack items. */
  receivedSteerAcked: boolean;
  /** Other commands were still active at receipt; the item is never counted. */
  receivedOthersActive: boolean;
  /** Exact bounded item id; unidentifiable completions are discarded at receipt. */
  itemId: string;
  command: string | null;
  cwd: string | null;
  status: string | null;
  output: string | null;
  exitCode: number | null;
}

interface NormalizedObservationV1 {
  inconclusive: boolean;
  command: string | null;
  cwd: string | null;
  exitCode: number | null;
  outputDigest: string | null;
  checkpoint: string | null;
}

type CommandClassV1 =
  | "deno_check"
  | "deno_lint"
  | "deno_test"
  | "rg_grep"
  | "unknown";

/** Deno diagnostic line: `error: ...` or `error (rule): ...` / `error[rule]: ...`. */
const DIAGNOSTIC_LINE = /^\s*error(?:\s*\([^)\n]*\)|\[[^\]\n]*\])?\s*:/m;

/** A literal single-quoted `/bin/bash -lc` or `/bin/zsh -lc` command wrapper. */
const LITERAL_WRAPPER = /^\/bin\/(?:bash|zsh) -lc '([^']*)'$/;

/** One simple-command token: a literal word or a balanced double-quoted word. */
const LITERAL_TOKEN_SRC = "[A-Za-z0-9_.,@%+=:/\\-]+";
const QUOTED_TOKEN_SRC = '"[^"\\r\\n\\\\$`]+"';

/**
 * Conservative full-string simple-command syntax applied to BOTH bare commands
 * and literal wrapped commands: only literal (or balanced double-quoted) words
 * with no substitutions, operators, pipeline/compound syntax, escape
 * sequences or unbalanced quoting can classify as a deno check/lint command.
 */
const SIMPLE_COMMAND = new RegExp(
  `^(?:${LITERAL_TOKEN_SRC}|${QUOTED_TOKEN_SRC})` +
    `(?: +(?:${LITERAL_TOKEN_SRC}|${QUOTED_TOKEN_SRC}))*$`,
);

function classifyCommand(rawCommand: string): CommandClassV1 {
  const wrapper = LITERAL_WRAPPER.exec(rawCommand);
  const inner = wrapper !== null ? wrapper[1] : rawCommand;
  if (!SIMPLE_COMMAND.test(inner)) return "unknown";
  const tokens = tokenizeCommand(inner);
  if (tokens.length === 0) return "unknown";
  if (tokens[0] === "deno") {
    switch (tokens[1]) {
      case "check":
        return "deno_check";
      case "lint":
        return "deno_lint";
      case "test":
        return "deno_test";
      default:
        return "unknown";
    }
  }
  if (tokens[0] === "rg" || tokens[0] === "grep") {
    return "rg_grep";
  }
  return "unknown";
}

/** Simple token split that keeps double-quoted arguments as one token. */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of command.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
    } else if (ch === " " && !quoted) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function hasRealDiagnostics(output: string): boolean {
  return DIAGNOSTIC_LINE.test(output);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Normalize one completed command observation for the EXACT thread/turn.
 * Returns an inconclusive record when any metadata is missing, over-bound,
 * untrusted (symlink/outside/absent cwd), unknown-command or otherwise not a
 * certified repeated failure; such evidence breaks the repeated sequence and
 * is never counted. Only potentially conclusive failure commands are hashed
 * against a trusted checkout-content checkpoint (never a truncated output).
 */
export async function normalizeObservation(
  job: CapturedObservationV1,
  checkoutDir: string,
): Promise<NormalizedObservationV1> {
  const inconclusive = (): NormalizedObservationV1 => ({
    inconclusive: true,
    command: null,
    cwd: null,
    exitCode: null,
    outputDigest: null,
    checkpoint: null,
  });
  if (
    job.command === null || job.cwd === null || job.status === null ||
    job.output === null || job.exitCode === null ||
    !Number.isInteger(job.exitCode)
  ) {
    return inconclusive();
  }
  // Declined and non-terminal statuses are not completed failures.
  if (job.status !== "completed" && job.status !== "failed") {
    return inconclusive();
  }
  const classification = classifyCommand(job.command);
  if (
    classification !== "deno_check" && classification !== "deno_lint"
  ) {
    // Unknown commands, successful reads, rg/grep no-match and deno
    // test/replay (expected baseline phases unknown) are inconclusive.
    return inconclusive();
  }
  if (job.exitCode === 0) return inconclusive();
  if (!hasRealDiagnostics(job.output)) return inconclusive();

  const cwd = await normalizedCheckoutCwd(job.cwd, checkoutDir);
  if (cwd === null) return inconclusive();
  // Hash the FULL bounded output only; a larger or missing output stays
  // inconclusive and is never hashed truncated.
  const outputDigest = await sha256Hex(job.output);
  const checkpoint = await checkoutContentCheckpoint(checkoutDir);
  if (checkpoint === null) return inconclusive();
  return {
    inconclusive: false,
    command: job.command,
    cwd,
    exitCode: job.exitCode,
    outputDigest,
    checkpoint,
  };
}

/**
 * Resolve cwd to inside the real checkout. The raw absolute normalized path
 * must equal its own real path (a symlink alias is rejected, never accepted
 * as an uncertain path identity), and that real path must stay inside the
 * checkout root normalized to its real path; outside/alias/absent is null.
 */
async function normalizedCheckoutCwd(
  cwd: string,
  checkoutDir: string,
): Promise<string | null> {
  try {
    const raw = normalizeAbsolutePath(cwd);
    if (raw === null) return null;
    const real = await Deno.realPath(raw);
    const root = await Deno.realPath(checkoutDir);
    if (real !== root && !real.startsWith(`${root}/`)) return null;
    if (raw !== real) return null;
    return real === root ? "." : real.slice(root.length + 1);
  } catch {
    return null;
  }
}

/** Collapse `.`/`..` of an absolute path without resolving symlinks. */
function normalizeAbsolutePath(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

/** Inconclusive guard observation: breaks the sequence, never counts. */
export function inconclusiveObservation(
  threadId: string,
  turnId: string,
  job: CapturedObservationV1,
): FailedCommandObservation {
  return {
    threadId,
    turnId,
    itemId: job.itemId ?? "",
    command: job.command ?? "",
    cwd: "",
    exitCode: 0,
    outputDigest: "",
    checkpoint: "",
    conclusiveFailure: false,
  };
}
