/** Shared correction prompt bounds for independently reviewed candidates. */
export const MAX_CORRECTION_FINDINGS = 8;
export const MAX_CORRECTION_FINDING_CHARS = 2_000;
export const MAX_CORRECTION_HISTORY_RECEIPTS = 3;

export interface CorrectionFindingV1 {
  severity: string;
  path: string | null;
  message: string;
}

type ReviewFeedbackFinding = CorrectionFindingV1 & { resolved: boolean };

/** Latest review first, followed by earlier rejecting reviews. */
export function boundedCorrectionFindings(
  reviews: readonly (readonly ReviewFeedbackFinding[])[],
  ciFinding: CorrectionFindingV1 | null = null,
): CorrectionFindingV1[] {
  const seen = new Set<string>();
  const findings = ciFinding === null ? [] : [ciFinding];
  for (const review of reviews.slice(0, 1 + MAX_CORRECTION_HISTORY_RECEIPTS)) {
    for (const finding of review) {
      if (finding.resolved) continue;
      const message = finding.message.slice(0, MAX_CORRECTION_FINDING_CHARS);
      const key = `${finding.severity}\u0000${
        finding.path ?? ""
      }\u0000${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        severity: finding.severity,
        path: finding.path,
        message,
      });
      if (findings.length >= MAX_CORRECTION_FINDINGS) return findings;
    }
  }
  return findings;
}

export function renderCorrectionFeedback(
  findings: readonly CorrectionFindingV1[],
): string {
  return "Unresolved findings of the review that rejected this candidate " +
    "(fix these in the current checkout):\n" +
    findings.map((finding) =>
      `- [${finding.severity}] ${
        finding.path ?? "(no file)"
      }: ${finding.message}`
    ).join("\n");
}
