/**
 * Mapping of GitHub CI wire values to sanitized, bounded CI failure evidence
 * fields (generation 81). Every string that leaves here was cleaned,
 * repository-relative, redacted and capped; it is still untrusted text that
 * only the fenced evidence section carries.
 */
import type { AnnotationWireV1 } from "./client-ci-evidence-wire.ts";
import {
  capChars,
  cleanLogLine,
  sanitizeEvidenceLine,
  sanitizeEvidenceText,
} from "../repair/ci-evidence-sanitize.ts";
import {
  type CiAnnotationV1,
  type CiCheckEvidenceV1,
  type CiEvidenceReasonV1,
  MAX_CI_ANNOTATIONS,
  MAX_CI_OUTPUT_CHARS,
} from "../repair/ci-evidence-types.ts";

const NAME_CHARS = 200;
const LEVEL_ORDER = ["failure", "warning", "notice"];

/** One untrusted name or label: one line, sanitized, at most 200 chars. */
export function evidenceText(text: string): string {
  return capChars(sanitizeEvidenceLine(cleanLogLine(text)), NAME_CHARS);
}

export function statusReason(
  status: number,
  actions: boolean,
): CiEvidenceReasonV1 {
  if (status === 401 || status === 403) {
    return actions ? "forbidden_actions_read" : "forbidden";
  }
  if (status === 404) return "not_found";
  if (status === 410) return "expired";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

export function annotation(note: AnnotationWireV1): CiAnnotationV1 {
  return {
    path: evidenceText(note.path),
    startLine: note.startLine,
    endLine: note.endLine,
    level: evidenceText(note.level),
    title: evidenceText(note.title),
    message: sanitizeEvidenceText(note.message, 400).replace(/\n/g, " "),
  };
}

export function baseCheck(
  checkName: string,
  conclusion: string,
  app: string | null,
): CiCheckEvidenceV1 {
  return {
    name: evidenceText(checkName),
    conclusion: evidenceText(conclusion),
    app: app === null ? null : evidenceText(app),
    workflow: null,
    job: null,
    failingSteps: [],
    classification: "candidate",
    classificationReason: "",
    annotations: [],
    excerpt: null,
    excerptLines: null,
    hints: [],
    output: null,
    unavailable: null,
    truncatedScan: false,
  };
}

export function output(
  title: string,
  summary: string,
  text: string,
): CiCheckEvidenceV1["output"] {
  const cleanTitle = evidenceText(title);
  const cleanSummary = sanitizeEvidenceText(summary, MAX_CI_OUTPUT_CHARS / 2);
  const cleanText = sanitizeEvidenceText(
    text,
    Math.max(0, MAX_CI_OUTPUT_CHARS - cleanTitle.length - cleanSummary.length),
  );
  return { title: cleanTitle, summary: cleanSummary, text: cleanText };
}

/** At most `MAX_CI_ANNOTATIONS`, failures first, otherwise in API order. */
export function failuresFirst(
  notes: readonly AnnotationWireV1[],
): CiAnnotationV1[] {
  const rank = (level: string) => {
    const index = LEVEL_ORDER.indexOf(level);
    return index < 0 ? LEVEL_ORDER.length : index;
  };
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) =>
      rank(a.note.level) - rank(b.note.level) || a.index - b.index
    )
    .slice(0, MAX_CI_ANNOTATIONS)
    .map(({ note }) => annotation(note));
}
