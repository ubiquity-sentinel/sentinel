import { asFindingFingerprint } from "./brands.ts";
import type { FindingFingerprint, GitSha } from "./brands.ts";
import {
  parseRepositoryIdentity,
  parseSeverity,
  SEVERITIES,
} from "./shared.ts";
import type { RepositoryIdentityV1, SeverityV1 } from "./shared.ts";
import {
  expectArray,
  expectBoolean,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectExactKeysWithOptional,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectString,
  expectTimestamp,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";
import { parseReviewTaskAcceptance } from "./review-task-acceptance.ts";
import type { ReviewTaskAcceptanceV1 } from "./review-task-acceptance.ts";

/**
 * ReviewReceiptV1: strict normalized evidence of one Codex review request.
 * Completion is never inferred from silence or reactions — the receipt only
 * records a machine-verifiable completed outcome; anything else is pending or
 * unavailable. The receipt binds the exact PR head and observed base.
 */

export type ReviewStatusV1 = "completed" | "pending" | "unavailable";

/**
 * Authorizing evidence for marking a finding resolved. An agent-set
 * `resolved: true` alone never removes a P0/P1; only a trusted human dispute
 * or a changed reviewed head can do so, recorded here with the authorizing
 * identity and a machine-verifiable reference.
 */
export interface FindingResolutionEvidenceV1 {
  authorizingIdentity: string;
  reference: string;
}

export interface ReviewFindingV1 {
  id: string;
  severity: SeverityV1;
  path: string | null;
  message: string;
  /** SHA-256 over the canonical form of this finding (id/severity/path/message). */
  fingerprint: FindingFingerprint;
  resolved: boolean;
  /** Required exactly when resolved; never present on an unresolved finding. */
  resolutionEvidence: FindingResolutionEvidenceV1 | null;
}

export interface ReviewReceiptV1 {
  version: "v1";
  kind: "review_receipt";
  id: string;
  requestId: string;
  expectedReviewer: string;
  /** Reviewer identity actually observed; must match when completed. */
  observedReviewer: string | null;
  repository: RepositoryIdentityV1;
  pullRequest: { number: number; head: GitSha; base: GitSha };
  outcome: ReviewStatusV1;
  resultId: string | null;
  summary: string | null;
  /** Full original findings, never trimmed after the fact. */
  findings: ReviewFindingV1[];
  /** Findings that could not be retained (bounded cap); completeness is never claimed. */
  findingsUncounted: number;
  /** Distinct unresolved severities, derived from unresolved findings. */
  unresolvedSeverities: SeverityV1[];
  /**
   * Positive task acceptance evidence, an explicit null when the review
   * reported none, or absent entirely on a receipt written before the semantic
   * acceptance boundary existed. PRESENCE IS SEMANTIC: absence is preserved
   * through decoding and canonical serialization (it is never rewritten as an
   * explicit null), so a legacy receipt stays byte-verifiable in state. Every
   * authorization surface reads `taskAcceptance ?? null`; absence and null are
   * both "no acceptance" and can never authorize an issue-backed delivery.
   */
  taskAcceptance?: ReviewTaskAcceptanceV1 | null;
  submittedAt: number;
  completedAt: number | null;
  observedAt: number;
}

/**
 * The review severities that block an autonomous merge. Owner directive
 * 2026-10-24: branch protection rules are not a merge requirement and the only
 * internal policy is that every P0 is resolved; unresolved P1/P2/P3 findings
 * never block delivery (and so never spend a correction round).
 */
export const BLOCKING_SEVERITIES: readonly SeverityV1[] = ["P0"];

export function hasBlockingSeverity(
  severities: readonly SeverityV1[],
): boolean {
  return severities.some((severity) => BLOCKING_SEVERITIES.includes(severity));
}

const KEYS = [
  "version",
  "kind",
  "id",
  "requestId",
  "expectedReviewer",
  "observedReviewer",
  "repository",
  "pullRequest",
  "outcome",
  "resultId",
  "summary",
  "findings",
  "findingsUncounted",
  "unresolvedSeverities",
  "submittedAt",
  "completedAt",
  "observedAt",
] as const;
/**
 * Additive optional key: a receipt written before the semantic acceptance
 * boundary existed omits it entirely, and the parser preserves that absence
 * rather than injecting a default. An explicit null decodes as null and an
 * explicit acceptance decodes under the strict bounded parser; neither the
 * legacy absence nor an explicit null is ever a passing acceptance.
 */
const OPTIONAL_KEYS = ["taskAcceptance"] as const;
const PULL_REQUEST_KEYS = ["number", "head", "base"] as const;
const FINDING_KEYS = [
  "id",
  "severity",
  "path",
  "message",
  "fingerprint",
  "resolved",
  "resolutionEvidence",
] as const;
const RESOLUTION_KEYS = ["authorizingIdentity", "reference"] as const;

export function parseReviewReceiptV1(input: unknown): ReviewReceiptV1 {
  const obj = expectRecord(input, "$");
  expectExactKeysWithOptional(obj, KEYS, OPTIONAL_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["review_receipt"], "$.kind");

  const id = expectNonEmptyString(obj.id, "$.id", MaxText.recordId);
  const requestId = expectNonEmptyString(
    obj.requestId,
    "$.requestId",
    MaxText.recordId,
  );
  const expectedReviewer = expectPattern(
    obj.expectedReviewer,
    "$.expectedReviewer",
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[bot\])?$/,
    "invalid_pattern",
    "expected reviewer identity",
    MaxText.label,
  );
  const observedReviewer = expectNullable(
    obj.observedReviewer,
    "$.observedReviewer",
    (v, p) =>
      expectPattern(
        v,
        p,
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[bot\])?$/,
        "invalid_pattern",
        "expected reviewer identity",
        MaxText.label,
      ),
  );
  const repository = parseRepositoryIdentity(obj.repository, "$.repository");

  const prObj = expectRecord(obj.pullRequest, "$.pullRequest");
  expectExactKeys(prObj, PULL_REQUEST_KEYS, "$.pullRequest");
  const pullRequest = {
    number: expectPositiveInt(prObj.number, "$.pullRequest.number"),
    head: expectGitSha(prObj.head, "$.pullRequest.head"),
    base: expectGitSha(prObj.base, "$.pullRequest.base"),
  };

  const outcome = expectEnum(
    obj.outcome,
    ["completed", "pending", "unavailable"],
    "$.outcome",
  );
  const resultId = expectNullableString(
    obj.resultId,
    "$.resultId",
    MaxText.recordId,
  );
  const summary = expectNullableString(
    obj.summary,
    "$.summary",
    MaxText.summary,
  );
  const findings = expectArray(
    obj.findings,
    "$.findings",
    MaxItems.findings,
    parseFinding,
  );
  const findingsUncounted = expectCount(
    obj.findingsUncounted,
    "$.findingsUncounted",
  );

  const unresolvedSeverities = parseUnresolvedSeverities(
    obj.unresolvedSeverities,
    "$.unresolvedSeverities",
  );
  // ABSENCE IS SEMANTIC: a receipt written before the semantic acceptance
  // boundary carries no key at all, so the absent field stays absent and is
  // never defaulted to an explicit null — that default would change the
  // record's canonical bytes and reject the very blob that stored it. An
  // explicit null stays explicitly null; every other value must be the strict
  // bounded acceptance.
  const taskAcceptance = obj.taskAcceptance === undefined
    ? undefined
    : expectNullable(
      obj.taskAcceptance,
      "$.taskAcceptance",
      parseReviewTaskAcceptance,
    );

  const submittedAt = expectTimestamp(obj.submittedAt, "$.submittedAt");
  const completedAt = expectNullable(
    obj.completedAt,
    "$.completedAt",
    expectTimestamp,
  );
  const observedAt = expectTimestamp(obj.observedAt, "$.observedAt");

  // Fail-closed: completion requires machine-verifiable identity and time proof.
  if (outcome === "completed") {
    if (resultId === null) {
      fail(
        "$.resultId",
        "invalid_lifecycle",
        "completed review requires a result id",
      );
    }
    if (completedAt === null) {
      fail(
        "$.completedAt",
        "invalid_lifecycle",
        "completed review requires a completion time",
      );
    }
    if (completedAt < submittedAt) {
      fail(
        "$.completedAt",
        "invalid_lifecycle",
        "completion cannot precede submission",
      );
    }
    if (observedAt < completedAt) {
      fail(
        "$.observedAt",
        "invalid_lifecycle",
        "observation cannot precede completion",
      );
    }
    // The actual reviewer identity must bind to the expected one; a completed
    // review by another identity is a mismatch, not acceptance evidence.
    if (observedReviewer !== expectedReviewer) {
      fail(
        "$.observedReviewer",
        "invalid_lifecycle",
        "completed review requires the observed reviewer to match the expected reviewer",
      );
    }
  } else {
    if (completedAt !== null) {
      fail(
        "$.completedAt",
        "invalid_lifecycle",
        "non-completed review cannot record completion",
      );
    }
    // Only a completed review can carry a task verdict; a pending/unavailable
    // receipt claiming acceptance would be completion evidence without a
    // completed review. An absent legacy field is not a claim.
    if (taskAcceptance !== null && taskAcceptance !== undefined) {
      fail(
        "$.taskAcceptance",
        "invalid_lifecycle",
        "non-completed review cannot carry a task acceptance",
      );
    }
    if (outcome === "unavailable" && resultId !== null) {
      fail(
        "$.resultId",
        "invalid_lifecycle",
        "unavailable review has no result id",
      );
    }
    if (observedReviewer !== null) {
      fail(
        "$.observedReviewer",
        "invalid_lifecycle",
        "non-completed review has no observed reviewer",
      );
    }
  }

  const derived = deriveUnresolvedSeverities(findings);
  if (JSON.stringify(derived) !== JSON.stringify(unresolvedSeverities)) {
    fail(
      "$.unresolvedSeverities",
      "invalid_lifecycle",
      `unresolved severities must be derived from findings (expected ${
        JSON.stringify(derived)
      })`,
    );
  }
  // Truncated findings mean completeness is unknown; an empty unresolved list
  // would claim clean review evidence that was never fully observed.
  if (findingsUncounted > 0 && unresolvedSeverities.length === 0) {
    fail(
      "$.unresolvedSeverities",
      "invalid_lifecycle",
      "cannot claim no unresolved findings while findings were uncounted",
    );
  }

  const receipt = {
    version: "v1" as const,
    kind: "review_receipt" as const,
    id,
    requestId,
    expectedReviewer,
    observedReviewer,
    repository,
    pullRequest,
    outcome,
    resultId,
    summary,
    findings,
    findingsUncounted,
    unresolvedSeverities,
    submittedAt,
    completedAt,
    observedAt,
  };
  // The optional acceptance key is emitted only when the record carried it:
  // emitting an explicit null for an absent legacy field would change the
  // record's canonical bytes and reject the stored blob on read.
  return taskAcceptance === undefined
    ? receipt
    : { ...receipt, taskAcceptance };
}

function parseFinding(input: unknown, path: string): ReviewFindingV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, FINDING_KEYS, path);
  const id = expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId);
  const severity = parseSeverity(obj.severity, `${path}.severity`);
  const findingPath = expectNullableString(
    obj.path,
    `${path}.path`,
    MaxText.path,
  );
  const message = expectString(obj.message, `${path}.message`, MaxText.context);
  const fingerprint = asFindingFingerprint(
    expectSha256Hex(obj.fingerprint, `${path}.fingerprint`),
  );
  const resolved = expectBoolean(obj.resolved, `${path}.resolved`);
  const resolutionEvidence = expectNullable(
    obj.resolutionEvidence,
    `${path}.resolutionEvidence`,
    parseResolutionEvidence,
  );
  if (resolved && resolutionEvidence === null) {
    fail(
      `${path}.resolutionEvidence`,
      "invalid_lifecycle",
      "resolved finding requires authorizing resolution evidence",
    );
  }
  if (!resolved && resolutionEvidence !== null) {
    fail(
      `${path}.resolutionEvidence`,
      "invalid_lifecycle",
      "unresolved finding cannot carry resolution evidence",
    );
  }
  return {
    id,
    severity,
    path: findingPath,
    message,
    fingerprint,
    resolved,
    resolutionEvidence,
  };
}

function parseResolutionEvidence(
  input: unknown,
  path: string,
): FindingResolutionEvidenceV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RESOLUTION_KEYS, path);
  return {
    authorizingIdentity: expectPattern(
      obj.authorizingIdentity,
      `${path}.authorizingIdentity`,
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[bot\])?$/,
      "invalid_pattern",
      "expected authorizing identity",
      MaxText.label,
    ),
    reference: expectNonEmptyString(
      obj.reference,
      `${path}.reference`,
      MaxText.ref,
    ),
  };
}

/** Severity order used for the derived unresolved list. */
const SEVERITY_ORDER: Record<SeverityV1, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export function deriveUnresolvedSeverities(
  findings: ReviewFindingV1[],
): SeverityV1[] {
  const set = new Set<SeverityV1>();
  for (const finding of findings) {
    if (!finding.resolved) set.add(finding.severity);
  }
  return SEVERITIES.filter((severity) => set.has(severity));
}

function parseUnresolvedSeverities(value: unknown, path: string): SeverityV1[] {
  return expectArray(value, path, 4, (item, itemPath) => {
    const severity = parseSeverity(item, itemPath);
    return severity;
  }).sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b]);
}

export {
  checkReviewTaskStatement,
  MAX_REVIEW_TASK_BODY,
  MAX_REVIEW_TASK_TITLE,
  MAX_TASK_ACCEPTANCE_EVIDENCE,
  MAX_TASK_ACCEPTANCE_EVIDENCE_CHARS,
  parseReviewTaskAcceptance,
  REVIEW_TASK_DIGEST_DETAIL,
  REVIEW_TASK_SHAPE_DETAIL,
  reviewTaskAcceptanceRefusal,
  reviewTaskStatementDigest,
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
  TASK_ACCEPTANCE_CONTEXT_DETAIL,
  TASK_ACCEPTANCE_DIGEST_DETAIL,
  TASK_ACCEPTANCE_MISMATCH_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
  TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
  TASK_ACCEPTANCE_UNBOUND_DETAIL,
  TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
} from "./review-task-acceptance.ts";

export type {
  ReviewTaskAcceptanceV1,
  ReviewTaskStatementCheckV1,
  ReviewTaskStatementV1,
  TaskAcceptanceVerdictV1,
} from "./review-task-acceptance.ts";
