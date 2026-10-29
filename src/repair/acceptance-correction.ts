/**
 * Repair loop internals: a task acceptance the reviewer found NOT fulfilled
 * (JAM B6). Positive task acceptance is an independent merge gate; P0 alone
 * blocks by severity. A `not_fulfilled` acceptance bound to the record's own
 * source issue and trusted live text retains its synthetic P1 marker for the
 * existing acceptance-correction and historical rollback contracts. While a
 * review round is left the existing acceptance path corrects it (B6a); with
 * none left the record parks once with
 * `TASK_ACCEPTANCE_OWNER_GATE_DETAIL`, which no runtime path and no launcher
 * rule ever re-admits and which the launcher names in its run summary (B6b).
 *
 * The receipt is the runtime's normalized evidence of that review: every
 * reviewer finding stays verbatim and in order, the reviewer's acceptance
 * verdict and evidence stay verbatim in `taskAcceptance`, and the verdict is
 * normalized into ONE added unresolved P1 finding with a fixed id that no
 * reviewer finding can carry (reviewer ids are `github-review-<n>-finding-<m>`),
 * whose message quotes the reviewer's acceptance evidence, bounded. The
 * GitHub review journal itself is never touched.
 *
 * Rollback contract (generation 81 -> R80 e48e7e110): the receipt is a strict
 * `ReviewReceiptV1` under R80's parser (no new key, a valid fingerprint, the
 * unresolved severities derived from the findings), and R80's own predicates
 * read it as the P1 it is: `rejectedReceipt` and `correctionFindings` start the
 * same correction with the same first finding, the matrix consumer accepts its
 * cell (a completed review with unresolved findings binds the checked-out
 * head), the ceiling parks it as rejected and every merge gate refuses it. A
 * clean-findings receipt at `work` would instead read as a reviewed head
 * awaiting a CI correction under R80, whose green exit delivers it to a merge
 * gate that refuses the acceptance with a state error on every run.
 */
import { asFindingFingerprint } from "../contracts/brands.ts";
import { canonicalStringifySha256 } from "../contracts/canonical.ts";
import {
  deriveUnresolvedSeverities,
  parseReviewReceiptV1,
  type ReviewFindingV1,
  type ReviewReceiptV1,
  type ReviewTaskAcceptanceV1,
} from "../contracts/review-receipt.ts";
import { MaxItems } from "../contracts/validation.ts";

/** Fixed id of the normalized acceptance finding (never a reviewer id). */
export const TASK_ACCEPTANCE_FINDING_ID = "task-acceptance-not-fulfilled";

/** Fixed opening of the normalized acceptance finding's message. */
export const TASK_ACCEPTANCE_FINDING_PREFIX = "Task acceptance not fulfilled: ";

/**
 * Bound of the finding's message: the correction finding bound
 * (`MAX_CORRECTION_FINDING_CHARS`), so the receipt finding and the finding a
 * correction session receives are the same bytes.
 */
export const TASK_ACCEPTANCE_FINDING_MAX_CHARS = 2_000;

/**
 * The one owner-gated terminal park of a not-fulfilled acceptance that no
 * correction can follow: every review round is spent (B6b), or the receipt
 * cannot carry the acceptance finding (it already holds the most findings a
 * receipt may). Distinct from the R80-written refusal
 * (`TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL`), which the launcher re-admits while
 * a round is left, so this park can never be re-admitted into a loop.
 */
export const TASK_ACCEPTANCE_OWNER_GATE_DETAIL =
  "task acceptance not fulfilled and no correction can follow: owner decision required";

const TRUNCATED = " [statement truncated]";

/**
 * The bounded finding text: what the issue requires that the candidate lacks,
 * in the reviewer's own acceptance evidence, at most
 * `TASK_ACCEPTANCE_FINDING_MAX_CHARS`.
 */
export function acceptanceFindingMessage(
  acceptance: ReviewTaskAcceptanceV1,
): string {
  const text = `${TASK_ACCEPTANCE_FINDING_PREFIX}the review found that the ` +
    `candidate does not satisfy source issue #${acceptance.issueNumber}. ` +
    "Change the candidate so it satisfies everything the issue requires; " +
    "the reviewer's acceptance evidence:" +
    acceptance.evidence.map((item) => `\n- ${item}`).join("");
  return text.length <= TASK_ACCEPTANCE_FINDING_MAX_CHARS
    ? text
    : `${
      text.slice(0, TASK_ACCEPTANCE_FINDING_MAX_CHARS - TRUNCATED.length)
    }${TRUNCATED}`;
}

/** True for the normalized, still unresolved acceptance finding. */
export function isAcceptanceFinding(
  finding: Pick<ReviewFindingV1, "id" | "severity" | "path" | "resolved">,
): boolean {
  return finding.id === TASK_ACCEPTANCE_FINDING_ID &&
    finding.severity === "P1" && finding.path === null && !finding.resolved;
}

/** The normalized unresolved P1 finding of a not-fulfilled acceptance. */
export async function acceptanceFinding(
  acceptance: ReviewTaskAcceptanceV1,
): Promise<ReviewFindingV1> {
  const id = TASK_ACCEPTANCE_FINDING_ID;
  const severity = "P1" as const;
  const message = acceptanceFindingMessage(acceptance);
  return {
    id,
    severity,
    path: null,
    message,
    fingerprint: asFindingFingerprint(
      await canonicalStringifySha256({ id, severity, path: null, message }),
    ),
    resolved: false,
    resolutionEvidence: null,
  };
}

/**
 * `receipt` with its not-fulfilled acceptance normalized into the leading
 * unresolved P1 finding, strictly re-parsed; null when the receipt carries no
 * not-fulfilled acceptance, already holds a finding with the fixed id, or
 * cannot hold one more finding.
 */
export async function withAcceptanceFinding(
  receipt: ReviewReceiptV1,
): Promise<ReviewReceiptV1 | null> {
  const acceptance = receipt.taskAcceptance ?? null;
  if (
    acceptance === null || acceptance.verdict !== "not_fulfilled" ||
    receipt.findings.length >= MaxItems.findings ||
    receipt.findings.some((finding) =>
      finding.id === TASK_ACCEPTANCE_FINDING_ID
    )
  ) return null;
  const findings = [await acceptanceFinding(acceptance), ...receipt.findings];
  try {
    return parseReviewReceiptV1({
      ...receipt,
      findings,
      unresolvedSeverities: deriveUnresolvedSeverities(findings),
    });
  } catch {
    return null;
  }
}
