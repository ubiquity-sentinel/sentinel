// merge helpers.

import {
  checkRunWire,
  checksPageWire,
  FakeClock,
  FakeReviewService,
  httpRespond,
  makePort,
  nonFastForwardRuleWire,
  pullRequestRuleWire,
  pullWire,
  refWire,
  REPO,
  reviewDecisionGraphqlWire,
  REVIEWER,
  rulesetWire,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  statusChecksRuleWire,
  statusesPageWire,
  structuredCompletedFixture,
  T0,
} from "./helpers.ts";
import { reviewOperationKey, reviewReceiptId } from "../../src/repair/keys.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { MergeRequestV1 } from "../../src/contracts/ports.ts";
import type { ScriptEntry } from "./helpers.ts";
import type { ScriptedHttpTransport } from "./helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";

export const CLOCK = new FakeClock(T0 + 200_000);

/** The canonical PR/head operation key the durable repair loop derives. */
export const CLEAN_OPERATION_KEY = reviewOperationKey(1, SHA1);

/** The opaque canonical loop receipt id for that exact PR/head. */
export const CLEAN_RECEIPT_ID = await reviewReceiptId(
  CLEAN_OPERATION_KEY,
  SHA1,
);

/** The canonical structured completion every positive merge fixture binds. */
export const CLEAN_COMPLETION = await structuredCompletedFixture({
  operationKey: CLEAN_OPERATION_KEY,
});

export const RULES_PATH =
  "/repos/ubiquity-sentinel/sentinel/rules/branches/development?per_page=100&page=1";

export const RULESETS_PATH =
  "/repos/ubiquity-sentinel/sentinel/rulesets?includes_parents=true&per_page=100&page=1";

export const CHECKS_PATH =
  `/repos/ubiquity-sentinel/sentinel/commits/${SHA1}/check-runs?per_page=100&page=1`;

export const STATUSES_PATH =
  `/repos/ubiquity-sentinel/sentinel/commits/${SHA1}/statuses?per_page=100&page=1`;

export function completedCleanReceipt(
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    // The canonical opaque loop receipt id for the exact PR/head operation.
    id: CLEAN_RECEIPT_ID,
    requestId: "req-1",
    expectedReviewer: REVIEWER,
    observedReviewer: REVIEWER,
    repository: REPO,
    pullRequest: { number: 1, head: SHA1, base: SHA2 },
    outcome: "completed",
    resultId: "result-9",
    summary: "no issues found",
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: T0 + 1000,
    completedAt: T0 + 120_000,
    observedAt: T0 + 130_000,
    ...overrides,
  });
}

export function mergeRequest(
  overrides: Partial<MergeRequestV1> = {},
): MergeRequestV1 {
  return {
    pullRequestNumber: 1,
    expectedHead: SHA1,
    expectedBase: SHA2,
    review: completedCleanReceipt(),
    ...overrides,
  };
}

export function pullEntry(
  overrides: Record<string, unknown> = {},
  repeat = false,
): ScriptEntry {
  return {
    ...httpRespond(
      "GET",
      "/repos/ubiquity-sentinel/sentinel/pulls/1",
      200,
      pullWire({
        number: 1,
        head: { ref: "sentinel/fix-1", sha: SHA1 },
        base: { ref: "development", sha: SHA2 },
        ...overrides,
      }),
    ),
    repeat,
  };
}

export function reviewsRead(reviews: unknown[]): ScriptEntry {
  return {
    ...httpRespond(
      "GET",
      "/repos/ubiquity-sentinel/sentinel/pulls/1/reviews?per_page=100&page=1",
      200,
      reviews,
    ),
    repeat: true,
  };
}

export function commentsRead(comments: unknown[]): ScriptEntry {
  return {
    ...httpRespond(
      "GET",
      "/repos/ubiquity-sentinel/sentinel/pulls/1/comments?per_page=100&page=1",
      200,
      comments,
    ),
    repeat: true,
  };
}

/** Default active rules: strict status checks, pull_request, non-fast-forward. */
export function defaultRules(): unknown[] {
  return [
    statusChecksRuleWire(),
    pullRequestRuleWire(),
    nonFastForwardRuleWire(),
  ];
}

export function rulesRead(
  rules: unknown[] = defaultRules(),
  rulesets: unknown[] = [rulesetWire()],
): ScriptEntry[] {
  return [
    httpRespond("GET", RULES_PATH, 200, rules),
    httpRespond("GET", RULESETS_PATH, 200, rulesets),
  ];
}

export function checksRead(
  runs: unknown[] = [checkRunWire()],
  repeat = false,
  statuses: unknown[] = [],
): ScriptEntry[] {
  return [
    {
      ...httpRespond("GET", CHECKS_PATH, 200, checksPageWire(runs)),
      repeat,
    },
    {
      ...httpRespond("GET", STATUSES_PATH, 200, statusesPageWire(statuses)),
      repeat,
    },
  ];
}

export const BASE_REF_PATH =
  "/repos/ubiquity-sentinel/sentinel/git/ref/heads/development";

export function commitPath(sha: GitSha): string {
  return `/repos/ubiquity-sentinel/sentinel/git/commits/${sha}`;
}

/** The base branch tip the port re-reads immediately before the merge call. */
export function baseTipRead(sha: GitSha = SHA2): ScriptEntry {
  return {
    ...httpRespond(
      "GET",
      BASE_REF_PATH,
      200,
      refWire(sha, "refs/heads/development"),
    ),
    repeat: true,
  };
}

/** The exact parents of one merge commit, as the port reads them. */
export function mergeParentsRead(
  mergeSha: GitSha = SHA3,
  parents: readonly GitSha[] = [SHA2, SHA1],
): ScriptEntry {
  return {
    ...httpRespond("GET", commitPath(mergeSha), 200, {
      sha: mergeSha,
      tree: { sha: SHA4 },
      parents: parents.map((sha) => ({ sha })),
    }),
    repeat: true,
  };
}

export interface HappyOptions {
  pulls?: ScriptEntry[];
  /** Base branch tip at merge time (default: the reviewed base SHA2). */
  baseTip?: ScriptEntry;
  /** Merge commit parents (default: SHA3 on exactly [SHA2, SHA1]). */
  parents?: ScriptEntry;
  rules?: unknown[];
  rulesets?: unknown[];
  checks?: unknown[];
  statuses?: unknown[];
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  extra?: ScriptEntry[];
}

export function happyScript(options: HappyOptions = {}): ScriptEntry[] {
  return [
    ...(options.pulls ?? [pullEntry(), pullEntry()]),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    ...rulesRead(
      options.rules ?? defaultRules(),
      options.rulesets ?? [rulesetWire()],
    ),
    ...checksRead(
      options.checks ?? [checkRunWire()],
      false,
      options.statuses ?? [],
    ),
    {
      ...httpRespond(
        "POST",
        "/graphql",
        200,
        reviewDecisionGraphqlWire(options.reviewDecision ?? "APPROVED"),
      ),
      repeat: true,
    },
    options.baseTip ?? baseTipRead(),
    options.parents ?? mergeParentsRead(),
    ...(options.extra ?? []),
  ];
}

export function trustedService(): FakeReviewService {
  const service = new FakeReviewService();
  service.readResult = CLEAN_COMPLETION.service;
  return service;
}

export function mergedPort(script: ScriptEntry[]) {
  const service = trustedService();
  return makePort({ clock: CLOCK, script, review: service });
}

export function blockedReason(
  result: Awaited<ReturnType<typeof mergeCall>>,
): string | null {
  if (!result.ok || result.value.outcome !== "blocked") return null;
  return result.value.reason;
}

export function mergeCall(
  port: ReturnType<typeof makePort>["port"],
  request: MergeRequestV1 = mergeRequest(),
) {
  return port.mergePullRequest(request);
}

export function putCount(transport: ScriptedHttpTransport): number {
  return transport.requests.filter((request) => request.method === "PUT")
    .length;
}

// Merge queue is never a fallback: no call can produce a queue-style outcome.
export const _sha: GitSha = SHA4;

void _sha;
