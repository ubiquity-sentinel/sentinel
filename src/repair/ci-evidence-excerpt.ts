/**
 * Streaming failing-step segmentation and bounded excerpt selection for one
 * GitHub Actions job log (generic first: no tool-specific knowledge).
 *
 * The scanner reads the log once, in byte chunks of any size, and keeps only
 * bounded state per step: the step's first `STEP_EDGE_CHARS` characters as
 * contiguous lines (its header among them), every line within 40 lines
 * before and 40 after a strong failure marker (3 before and 1 after a weak
 * one), the `STEP_EDGE_CHARS` characters after the step's first strong
 * marker, the last `STEP_EDGE_CHARS` characters for the tail, and the marker
 * positions. A step boundary is a `##[group]Run ...` line or `Post job
 * cleanup.`. A step with a `##[error]` line is a final (failing) step; at
 * most three are kept (the first two and the latest). A log with no
 * `##[error]` falls back to its last step before cleanup, so an unrecognized
 * failure still yields an excerpt.
 *
 * Selection fits each step into a character share. A step that fits is kept
 * whole. Otherwise the header and the tail always; then windows around the
 * strong markers above the tail (the tail is the context of the markers in
 * it) shrinking 40/8, 20/4, 10/2, 3/1, 0/0; if even the bare markers
 * overflow, markers are taken alternately from the first (root cause) and
 * the last (summary). The rest of the share is then filled, nearest first:
 * the markers' after-context, their before-context, the contiguous run after
 * and before the first marker, weak windows (only for an unrecognized
 * failure), and finally the step's start and its end alternately. Omitted
 * spans are marked, so the model sees the excerpt's shape.
 */
import {
  capChars,
  cleanLogLine,
  sanitizeEvidenceLine,
} from "./ci-evidence-sanitize.ts";
import {
  MAX_CI_CHECK_SHARE_CHARS,
  MAX_CI_EVIDENCE_LINE_CHARS,
  MAX_CI_RAW_LINE_CHARS,
} from "./ci-evidence-types.ts";

/** Retained lines per step before only bare markers are kept. */
export const MAX_RETAINED_LINES_PER_STEP = 6_000;
/**
 * Contiguous characters kept at a step's start, after its first strong
 * marker and at its end: a step up to the largest share is kept whole.
 */
export const STEP_EDGE_CHARS = MAX_CI_CHECK_SHARE_CHARS;
/** Most tail lines kept (a step of very short lines). */
export const MAX_TAIL_RING_LINES = 2_000;
const OVERFLOW_MARKERS = 32;
const BEFORE = 40;
const AFTER = 40;
const WEAK_BEFORE = 3;
const WEAK_AFTER = 1;
const HEADER_LINES = 8;
const TAIL_LINES = 30;
const MAX_KEPT_STEPS = 3;
const MAX_HEADER_CHARS = 200;
/** Strong markers (besides `##[error]`) above which a failure is recognized. */
const WEAK_FILL_RECOGNIZED = 2;
const WINDOWS: readonly (readonly [number, number])[] = [
  [40, 8],
  [20, 4],
  [10, 2],
  [3, 1],
  [0, 0],
];

/** Lines that state a failure in any common tool's output. */
const STRONG = new RegExp(
  [
    String.raw`^##\[error\]`,
    String.raw`^!!! FAILED`,
    String.raw`\bFAILED\b`,
    String.raw`^\(fail\)`,
    String.raw`^\s*FAIL\b`,
    String.raw`^--- FAIL`,
    String.raw`^not ok\b`,
    "[✗×✖✕]",
    String.raw`\berror TS\d+`,
    String.raw`^error\[E\d+\]`,
    String.raw`^\s*\d+:\d+\s+error\s`,
    String.raw`npm ERR!`,
    String.raw`\bpanic:`,
    String.raw`^Traceback`,
    String.raw`\bexit(?:ed)? (?:with )?code [1-9]`,
    String.raw`^make(?:\[\d+\])?: \*\*\*`,
    String.raw`Code style issues`,
    String.raw`^\[warn\]`,
    String.raw`\b[1-9]\d* (?:fail|failed|failures|failing|errors?)\b`,
  ].join("|"),
);
/** Lines that often accompany a failure (also printed by passing tests). */
const WEAK =
  /\berror\b|ERR!|\bFAIL|failed|panic|Traceback|Exception|assert|^E {3,}/i;
/** Lines that look like markers but state success or structure. */
const NEGATIVE =
  /^\(pass\)|^\s*0 (?:fail|errors?)\b|\b0 failures\b|^##\[(?:group|endgroup)\]/;
const RUNNER_LOST =
  /The runner has received a shutdown signal|lost communication with the server/;

export function isStrongMarker(clean: string): boolean {
  return STRONG.test(clean) && !NEGATIVE.test(clean);
}

export function isWeakMarker(clean: string): boolean {
  return WEAK.test(clean) && !NEGATIVE.test(clean);
}

/** One scanned step: bounded retained lines keyed by step-relative index. */
export interface CiRetainedStepV1 {
  /** `Run ...` group title, `Set up job` or `Post job cleanup` (sanitized). */
  header: string;
  /** The step's group declares a `shell:` (a `run:` step, not an action). */
  hasShell: boolean;
  /** The step has a `##[error]` line. */
  hasError: boolean;
  /** Relative index of the header group's `##[endgroup]`, or -1. */
  headerEnd: number;
  lineCount: number;
  retainedLines: number;
  lines: ReadonlyMap<number, string>;
  strong: readonly number[];
  weak: readonly number[];
  /** Lines always shown (scan gap markers). */
  pinned: readonly number[];
}

export interface CiScannedLogV1 {
  /** Failing steps (with `##[error]`), or the last step as a fallback. */
  steps: CiRetainedStepV1[];
  runnerLost: boolean;
  totalLines: number;
}

/** Upper bound of a cleaned line's rendered size (sanitizing caps it). */
function renderedSize(clean: string): number {
  return Math.min(clean.length, MAX_CI_EVIDENCE_LINE_CHARS + 6) + 1;
}

interface RingEntry {
  index: number;
  clean: string;
  size: number;
}

/**
 * The step's most recent lines: at least `BEFORE` (marker before-context),
 * otherwise at most `STEP_EDGE_CHARS` rendered characters and
 * `MAX_TAIL_RING_LINES` lines (the tail). Amortized O(1) per line.
 */
class LineRing {
  private items: RingEntry[] = [];
  private start = 0;
  private chars = 0;

  get length(): number {
    return this.items.length - this.start;
  }

  push(entry: RingEntry): void {
    this.items.push(entry);
    this.chars += entry.size;
    while (
      this.length > BEFORE &&
      (this.chars > STEP_EDGE_CHARS || this.length > MAX_TAIL_RING_LINES)
    ) {
      this.chars -= this.items[this.start++].size;
    }
    if (this.start > 1_024 && this.start * 2 > this.items.length) {
      this.items = this.items.slice(this.start);
      this.start = 0;
    }
  }

  /** The last `count` entries, oldest first. */
  recent(count: number): RingEntry[] {
    return this.items.slice(Math.max(this.start, this.items.length - count));
  }

  all(): RingEntry[] {
    return this.items.slice(this.start);
  }

  clear(): void {
    this.items = [];
    this.start = 0;
    this.chars = 0;
  }
}

class StepState {
  header: string;
  hasShell = false;
  hasError = false;
  inGroup: boolean;
  headerEnd = -1;
  lineCount = 0;
  readonly lines = new Map<number, string>();
  readonly strong = new Set<number>();
  readonly weak = new Set<number>();
  readonly pinned: number[] = [];
  private readonly ring = new LineRing();
  private afterUntil = -1;
  private readonly overflow: number[] = [];
  /** Characters left of the step's start and of its first marker's run. */
  private startRoom = STEP_EDGE_CHARS;
  private firstMarkerRoom = 0;

  constructor(header: string, inGroup: boolean) {
    this.header = header;
    this.inGroup = inGroup;
  }

  private retain(index: number, clean: string, marker: boolean): void {
    if (this.lines.has(index)) return;
    if (this.lines.size >= MAX_RETAINED_LINES_PER_STEP) {
      if (!marker) return;
      // Past the bound only bare markers are kept, in a small ring.
      if (this.overflow.length >= OVERFLOW_MARKERS) {
        const evicted = this.overflow.shift()!;
        this.lines.delete(evicted);
        this.strong.delete(evicted);
        this.weak.delete(evicted);
      }
      this.overflow.push(index);
    }
    this.lines.set(index, sanitizeEvidenceLine(clean));
  }

  push(clean: string): void {
    const index = this.lineCount++;
    const size = renderedSize(clean);
    if (this.inGroup) {
      if (clean.startsWith("shell: ")) this.hasShell = true;
      if (clean.startsWith("##[endgroup]")) {
        this.inGroup = false;
        this.headerEnd = index;
      }
    }
    if (clean.startsWith("##[error]")) this.hasError = true;
    if (index < HEADER_LINES || this.startRoom > 0) {
      this.retain(index, clean, false);
      this.startRoom -= size;
    }
    if (isStrongMarker(clean)) {
      for (const entry of this.ring.recent(BEFORE)) {
        if (entry.index >= index - BEFORE) {
          this.retain(entry.index, entry.clean, false);
        }
      }
      this.retain(index, clean, true);
      if (this.lines.has(index)) {
        if (this.strong.size === 0) this.firstMarkerRoom = STEP_EDGE_CHARS;
        this.strong.add(index);
      }
      this.afterUntil = Math.max(this.afterUntil, index + AFTER);
    } else if (isWeakMarker(clean)) {
      for (const entry of this.ring.recent(WEAK_BEFORE)) {
        if (entry.index >= index - WEAK_BEFORE) {
          this.retain(entry.index, entry.clean, false);
        }
      }
      this.retain(index, clean, false);
      if (this.lines.has(index)) this.weak.add(index);
      this.afterUntil = Math.max(this.afterUntil, index + WEAK_AFTER);
    } else if (index <= this.afterUntil) {
      this.retain(index, clean, false);
    }
    if (this.firstMarkerRoom > 0 && !this.strong.has(index)) {
      // The contiguous run after the step's first strong marker.
      this.retain(index, clean, false);
      this.firstMarkerRoom -= size;
    }
    this.ring.push({ index, clean, size });
  }

  /** A scan gap: pinned marker line; context before it is not contiguous. */
  gap(bytes: number): void {
    const index = this.lineCount++;
    this.lines.set(index, `[... ${bytes} bytes not scanned ...]`);
    this.pinned.push(index);
    this.ring.clear();
    this.startRoom = 0;
    this.firstMarkerRoom = 0;
  }

  finish(): CiRetainedStepV1 {
    // The tail is always kept (the ring holds the step's last lines).
    for (const entry of this.ring.all()) {
      if (!this.lines.has(entry.index)) {
        this.lines.set(entry.index, sanitizeEvidenceLine(entry.clean));
      }
    }
    const sorted = (set: Iterable<number>) =>
      [...set].filter((index) => this.lines.has(index)).sort((a, b) => a - b);
    return {
      header: this.header,
      hasShell: this.hasShell,
      hasError: this.hasError,
      headerEnd: this.headerEnd,
      lineCount: this.lineCount,
      retainedLines: this.lines.size,
      lines: this.lines,
      strong: sorted(this.strong),
      weak: sorted(this.weak),
      pinned: [...this.pinned],
    };
  }
}

/** Streaming scanner of one job log (bytes of any chunking, or text). */
export class CiLogScanner {
  private readonly decoder = new TextDecoder("utf-8");
  private partial = "";
  private dropPartial = false;
  private step = new StepState("Set up job", false);
  private readonly failing: CiRetainedStepV1[] = [];
  private last: CiRetainedStepV1 | null = null;
  private runnerLost = false;
  private totalLines = 0;

  pushBytes(bytes: Uint8Array): void {
    this.pushText(this.decoder.decode(bytes, { stream: true }));
  }

  pushText(text: string): void {
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      if (end < 0) {
        this.appendPartial(text.slice(start));
        return;
      }
      this.appendPartial(text.slice(start, end));
      const line = this.partial;
      this.partial = "";
      if (this.dropPartial) this.dropPartial = false;
      else this.line(line);
      start = end + 1;
    }
  }

  /** Bytes skipped between two read ranges; the next line is a fragment. */
  gap(skippedBytes: number): void {
    this.decoder.decode();
    this.partial = "";
    this.dropPartial = true;
    this.step.gap(skippedBytes);
  }

  finish(): CiScannedLogV1 {
    this.pushText(this.decoder.decode());
    if (this.partial.length > 0 && !this.dropPartial) this.line(this.partial);
    this.partial = "";
    this.closeStep();
    const steps = this.failing.length > 0
      ? [...this.failing]
      : this.last === null
      ? []
      : [this.last];
    return { steps, runnerLost: this.runnerLost, totalLines: this.totalLines };
  }

  private appendPartial(text: string): void {
    // A line is cut long before any pattern runs; the rest is dropped.
    const room = MAX_CI_RAW_LINE_CHARS * 2 - this.partial.length;
    if (room > 0) {
      this.partial += text.length > room ? text.slice(0, room) : text;
    }
  }

  private line(raw: string): void {
    this.totalLines++;
    const clean = cleanLogLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (RUNNER_LOST.test(clean) && clean.startsWith("##[error]")) {
      this.runnerLost = true;
    }
    if (
      clean.startsWith("##[group]Run ") || clean.startsWith("Post job cleanup")
    ) {
      this.closeStep();
      const header = clean.startsWith("Post job cleanup")
        ? "Post job cleanup"
        : capChars(
          sanitizeEvidenceLine(clean.slice("##[group]".length)),
          MAX_HEADER_CHARS,
        );
      this.step = new StepState(header, clean.startsWith("##[group]"));
    }
    this.step.push(clean);
  }

  private closeStep(): void {
    const step = this.step.finish();
    if (step.lineCount === 0) return;
    if (step.hasError) {
      // Keep the first two failing steps and the latest one.
      if (this.failing.length < MAX_KEPT_STEPS) this.failing.push(step);
      else this.failing[MAX_KEPT_STEPS - 1] = step;
    }
    if (step.header !== "Post job cleanup" || this.last === null) {
      this.last = step;
    }
  }
}

function omitted(count: number): string {
  return `[... ${count} lines omitted ...]`;
}

/** Render a chosen index set with omission markers between its spans. */
function render(step: CiRetainedStepV1, chosen: ReadonlySet<number>): string {
  const indices = [...chosen].filter((index) => step.lines.has(index)).sort((
    a,
    b,
  ) => a - b);
  const out: string[] = [];
  let previous = -1;
  for (const index of indices) {
    if (index > previous + 1) out.push(omitted(index - previous - 1));
    out.push(step.lines.get(index)!);
    previous = index;
  }
  if (previous < step.lineCount - 1) {
    out.push(omitted(step.lineCount - 1 - previous));
  }
  return out.join("\n");
}

function within(
  step: CiRetainedStepV1,
  indices: readonly number[],
  budget: number,
  fromEnd: boolean,
): number[] {
  const kept: number[] = [];
  let used = 0;
  const ordered = fromEnd ? [...indices].reverse() : indices;
  for (const index of ordered) {
    const size = (step.lines.get(index)?.length ?? 0) + 1;
    if (used + size > budget) break;
    used += size;
    kept.push(index);
  }
  return kept;
}

/** First and last alternately: root cause first, then the summary. */
function alternate(indices: readonly number[]): number[] {
  const order: number[] = [];
  let low = 0;
  let high = indices.length - 1;
  while (low <= high) {
    order.push(indices[low++]);
    if (low <= high) order.push(indices[high--]);
  }
  return order;
}

/**
 * `chosen` plus the longest prefix of `order` (retained, new lines only)
 * whose rendering still fits `share`; `chosen` itself when it does not fit.
 */
function fill(
  step: CiRetainedStepV1,
  chosen: ReadonlySet<number>,
  share: number,
  order: Iterable<number>,
): Set<number> {
  const seen = new Set(chosen);
  const fresh: number[] = [];
  for (const index of order) {
    if (step.lines.has(index) && !seen.has(index)) {
      seen.add(index);
      fresh.push(index);
    }
  }
  const take = (count: number) => {
    const set = new Set(chosen);
    for (let index = 0; index < count; index++) set.add(fresh[index]);
    return set;
  };
  const fits = (count: number) => render(step, take(count)).length <= share;
  if (fresh.length === 0 || !fits(0)) return new Set(chosen);
  if (fits(fresh.length)) return take(fresh.length);
  // Invariant: `low` lines fit and `high` do not.
  let low = 0;
  let high = fresh.length;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return take(low);
}

/** The markers' context nearest first, then the run around the first. */
function* markerContext(
  step: CiRetainedStepV1,
  anchors: readonly number[],
): Generator<number> {
  for (let distance = 1; distance <= AFTER; distance++) {
    for (const marker of anchors) yield marker + distance;
  }
  for (let distance = 1; distance <= BEFORE; distance++) {
    for (const marker of step.strong) yield marker - distance;
  }
  const first = anchors[0];
  if (first === undefined) return;
  for (let index = first + 1; step.lines.has(index); index++) yield index;
  for (let index = first - 1; step.lines.has(index); index--) yield index;
}

/** The step's start and its end alternately, then every other line. */
function* stepEdges(step: CiRetainedStepV1): Generator<number> {
  let forward = 0;
  let backward = step.lineCount - 1;
  let forwardOpen = true;
  let backwardOpen = true;
  while ((forwardOpen || backwardOpen) && forward <= backward) {
    if (forwardOpen) {
      if (step.lines.has(forward)) yield forward++;
      else forwardOpen = false;
    }
    if (backwardOpen && forward <= backward) {
      if (step.lines.has(backward)) yield backward--;
      else backwardOpen = false;
    }
  }
  yield* [...step.lines.keys()].sort((a, b) => a - b);
}

/** The bounded excerpt of one step within `share` characters. */
export function selectStepExcerpt(
  step: CiRetainedStepV1,
  share: number,
): { text: string; kept: number } {
  const keys = [...step.lines.keys()].sort((a, b) => a - b);
  const tailStart = step.lineCount - TAIL_LINES;
  const headerLast = step.headerEnd >= 0 && step.headerEnd < HEADER_LINES
    ? step.headerEnd
    : HEADER_LINES - 1;
  const head = within(
    step,
    keys.filter((index) => index <= headerLast),
    Math.floor(share / 4),
    false,
  );
  const tail = within(
    step,
    keys.filter((index) => index >= tailStart),
    Math.floor(share / 4),
    true,
  );
  const base = new Set<number>([...head, ...tail, ...step.pinned]);
  const fits = (set: ReadonlySet<number>) => render(step, set).length <= share;
  // The tail is the context of the markers in it; windows serve the rest.
  const anchors = step.strong.filter((index) => index < tailStart);
  let chosen: Set<number> | null = null;
  for (const [before, after] of WINDOWS) {
    const set = new Set(base);
    for (const marker of step.strong) {
      set.add(marker);
      if (marker >= tailStart) continue;
      for (let index = marker - before; index <= marker + after; index++) {
        if (step.lines.has(index)) set.add(index);
      }
    }
    if (fits(set)) {
      chosen = set;
      break;
    }
  }
  if (chosen === null) {
    chosen = new Set(base);
    for (const marker of alternate(step.strong)) {
      chosen.add(marker);
      if (!fits(chosen)) {
        chosen.delete(marker);
        break;
      }
    }
  }
  // The rest of the share, nearest the markers first: their after-context
  // (where a failure's detail follows its marker), their before-context and
  // the contiguous run around the first of them.
  chosen = fill(step, chosen, share, markerContext(step, anchors));
  // Weak windows describe an unrecognized failure; beside recognized
  // failure markers they are mostly the noise of passing tests (expected
  // `error:` output), which the strong windows' context already covers
  // where it matters, so a recognized failure gets none.
  const recognized =
    step.strong.filter((index) =>
      !(step.lines.get(index) ?? "").startsWith("##[error]")
    ).length > WEAK_FILL_RECOGNIZED;
  if (!recognized) {
    for (const marker of alternate(step.weak)) {
      const window: number[] = [];
      for (let index = marker - 2; index <= marker + 1; index++) {
        if (step.lines.has(index) && !chosen.has(index)) window.push(index);
      }
      if (window.length === 0) continue;
      for (const index of window) chosen.add(index);
      if (!fits(chosen)) {
        for (const index of window) chosen.delete(index);
        break;
      }
    }
  }
  // Whatever room is left: the step's start and its end, then the rest; a
  // step that fits is kept whole.
  chosen = fill(step, chosen, share, stepEdges(step));
  let text = render(step, chosen);
  if (text.length > share) text = capChars(text, share);
  return {
    text,
    kept: [...chosen].filter((index) => step.lines.has(index)).length,
  };
}

const STEP_SEPARATOR = "\n[... next failing step ...]\n";

/** The bounded excerpt of a scanned log, or null when it has no step. */
export function excerptFromLog(
  log: CiScannedLogV1,
  share: number,
): { text: string; kept: number; total: number } | null {
  if (log.steps.length === 0) return null;
  const each = Math.floor(
    (share - STEP_SEPARATOR.length * (log.steps.length - 1)) /
      log.steps.length,
  );
  const parts = log.steps.map((step) => selectStepExcerpt(step, each));
  return {
    text: parts.map((part) => part.text).join(STEP_SEPARATOR),
    kept: parts.reduce((sum, part) => sum + part.kept, 0),
    total: log.steps.reduce((sum, step) => sum + step.lineCount, 0),
  };
}
