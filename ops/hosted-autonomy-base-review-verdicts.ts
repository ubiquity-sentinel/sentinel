/**
 * Recovery of a historical base review's verdict for the one-time
 * `base_review_work_needed` re-arm (`hosted-autonomy-historical-rearms.ts`).
 *
 * The state keeps no verdict for these parks: the runtime's evidence ref
 * (`artifact:base-review/...`) names the issue comment that holds the native
 * review result and the SHA-256 of that result's canonical JSON, and the
 * parked intent repeats that digest as its `resultId`. The verdict is
 * recovered only from that exact comment: read over the record's OWN
 * repository surface, authored by the sentinel App (the runtime's base-review
 * publisher), parsed with the runtime's own result parser, and hashing to the
 * stored digest. Anything unreadable, foreign or mismatched recovers nothing,
 * so the park stays as it is.
 */
import { canonicalStringifySha256 } from "../src/contracts/canonical.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  baseReviewCommentPayload,
  type BaseReviewCommentV1,
  parseBaseReviewComment,
} from "../src/github/base-review-comments.ts";
import {
  baseResultSatisfied,
  baseResultWorkNeeded,
} from "../src/github/base-review-evidence.ts";
import { parseReviewResultV1 } from "../src/github/review-result-parser.ts";
import { API_BASE } from "./hosted-autonomy-github-listing.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  hostedIssueKey,
} from "./hosted-autonomy-policy.ts";
import {
  baseReviewRearmCandidate,
  baseReviewVerdictKey,
} from "./hosted-autonomy-historical-rearms.ts";

/** The bounded JSON reader of one repository (`createHostedAutonomyRequest`). */
type Request = (method: string, path: string) => Promise<unknown | null>;

/**
 * The surface member `readIssueComment` for one repository (`owner/name`):
 * the exact comment of that issue, or null for anything unreadable, foreign
 * to the issue or malformed.
 */
export function createReadIssueComment(request: Request, scope: string) {
  return async function readIssueComment(
    issue: number,
    id: number,
  ): Promise<BaseReviewCommentV1 | null> {
    if (
      !Number.isSafeInteger(issue) || issue <= 0 ||
      !Number.isSafeInteger(id) || id <= 0
    ) return null;
    const body = await request("GET", `/repos/${scope}/issues/comments/${id}`);
    if (body === null) return null;
    try {
      return parseBaseReviewComment(
        body,
        `${API_BASE}/repos/${scope}/issues/${issue}`,
      );
    } catch {
      return null;
    }
  };
}

type ReadIssueComment = (
  issue: number,
  id: number,
) => Promise<BaseReviewCommentV1 | null>;

/**
 * `baseReviewVerdictKey` values of the historical base-review parks whose
 * result comment proves a work-needed verdict. Only candidates of the exact
 * shape below the no-change bound are read (one comment each), and never a
 * record whose issue is closed.
 */
export async function readBaseReviewWorkNeeded(
  snapshot: RepairStateSnapshotV1,
  closedIssues: ReadonlySet<string>,
  scopeFor: (
    repository: RepositoryIdentityV1,
  ) => Promise<
    { readonly surface: { readIssueComment?: ReadIssueComment } | null }
  >,
): Promise<Set<string>> {
  const verified = new Set<string>();
  for (const record of snapshot.work) {
    const binding = baseReviewRearmCandidate(snapshot, record);
    if (
      binding === null ||
      closedIssues.has(hostedIssueKey(record.repository, binding.issueNumber))
    ) continue;
    try {
      const read = (await scopeFor(record.repository)).surface
        ?.readIssueComment;
      if (read === undefined) continue;
      const comment = await read(binding.issueNumber, binding.resultComment);
      if (
        comment === null || comment.id !== binding.resultComment ||
        comment.author !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR
      ) continue;
      const result = parseReviewResultV1(
        baseReviewCommentPayload(comment.body),
      );
      if (
        await canonicalStringifySha256(result) !== binding.resultDigest ||
        baseResultSatisfied(result, binding) ||
        !baseResultWorkNeeded(result, binding)
      ) continue;
      verified.add(baseReviewVerdictKey(record, binding));
    } catch {
      // An unreadable or malformed comment recovers nothing.
    }
  }
  return verified;
}
