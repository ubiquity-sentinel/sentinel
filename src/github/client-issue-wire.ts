// client issue wire.

import type { GitHubIssueRelationsV1 } from "../contracts/ports.ts";
import {
  expectArray,
  expectCount,
  expectEnum,
  expectNonEmptyString,
  expectPositiveInt,
  expectRecord,
  fail,
  MaxText,
} from "../contracts/validation.ts";

export const REVIEW_DECISION_QUERY = `
  query SentinelPullReviewDecision($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewDecision
      }
    }
  }
`;

/**
 * Native issue dependency read (blockedBy + sub-issue total). The blockedBy
 * connection is read one page of `first: 100`; `hasNextPage` is a hard
 * truncation signal, never a silently ignored continuation.
 */
export const ISSUE_RELATIONS_QUERY = `
  query SentinelIssueRelations($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        blockedBy(first: 100) {
          nodes {
            number
            state
            repository {
              nameWithOwner
            }
          }
          pageInfo {
            hasNextPage
          }
        }
        subIssues(first: 1) {
          totalCount
        }
      }
    }
  }
`;

/** Maximum native blockedBy nodes accepted from one relations read. */
export const MAX_BLOCKED_BY_NODES = 100;

/**
 * Strict parser for the native issue-relations GraphQL response. Fails
 * closed on a non-empty `errors` array, a missing/mismatched issue identity,
 * a truncated blockedBy page, an invalid blocker repository identity, state
 * or number, or an invalid sub-issue count. Closed native blockers are
 * dropped (closed state is authoritative for the dependency); open blockers
 * are retained regardless of repository, so a cross-repository blocker still
 * gates. An empty result is only ever returned after all of those checks
 * passed on a complete, untruncated page.
 */
export function parseIssueRelations(
  input: unknown,
  issueNumber: number,
): GitHubIssueRelationsV1 {
  const obj = expectRecord(input, "$");
  const errors = obj.errors;
  if (errors !== undefined && errors !== null) {
    const list = expectArray(errors, "$.errors", 100, (value) => value);
    if (list.length > 0) {
      fail("$.errors", "invalid_value", "GraphQL response contains errors");
    }
  }
  const data = expectRecord(obj.data, "$.data");
  const repository = expectRecord(data.repository, "$.data.repository");
  const rawIssue = repository.issue;
  if (rawIssue === null || rawIssue === undefined) {
    fail(
      "$.data.repository.issue",
      "invalid_value",
      "GraphQL response has no issue",
    );
  }
  const issuePath = "$.data.repository.issue";
  const issue = expectRecord(rawIssue, issuePath);
  const number = expectPositiveInt(issue.number, `${issuePath}.number`);
  if (number !== issueNumber) {
    fail(
      `${issuePath}.number`,
      "invalid_value",
      "GraphQL issue identity does not match the requested number",
    );
  }
  const blockedBy = expectRecord(issue.blockedBy, `${issuePath}.blockedBy`);
  const nodes = expectArray(
    blockedBy.nodes,
    `${issuePath}.blockedBy.nodes`,
    MAX_BLOCKED_BY_NODES,
    (value) => value,
  );
  const pageInfo = expectRecord(
    blockedBy.pageInfo,
    `${issuePath}.blockedBy.pageInfo`,
  );
  const hasNextPage = pageInfo.hasNextPage;
  if (hasNextPage !== false) {
    if (hasNextPage === true) {
      fail(
        `${issuePath}.blockedBy.pageInfo.hasNextPage`,
        "bound_exceeded",
        "blockedBy page exceeded the read bound",
      );
    }
    fail(
      `${issuePath}.blockedBy.pageInfo.hasNextPage`,
      "invalid_boolean",
      "expected boolean",
    );
  }
  const subIssues = expectRecord(issue.subIssues, `${issuePath}.subIssues`);
  const subIssueCount = expectCount(
    subIssues.totalCount,
    `${issuePath}.subIssues.totalCount`,
  );

  const openBlockers: GitHubIssueRelationsV1["openBlockers"] = [];
  const seenBlockers = new Set<string>();
  for (let index = 0; index < nodes.length; index++) {
    const nodePath = `${issuePath}.blockedBy.nodes[${index}]`;
    const node = expectRecord(nodes[index], nodePath);
    const blockerNumber = expectPositiveInt(node.number, `${nodePath}.number`);
    const state = expectEnum(
      node.state,
      ["OPEN", "CLOSED"] as const,
      `${nodePath}.state`,
    );
    const blockerRepository = expectRecord(
      node.repository,
      `${nodePath}.repository`,
    );
    const nameWithOwner = expectNonEmptyString(
      blockerRepository.nameWithOwner,
      `${nodePath}.repository.nameWithOwner`,
      MaxText.owner + 1 + MaxText.name,
    );
    const separator = nameWithOwner.indexOf("/");
    const owner = separator === -1 ? "" : nameWithOwner.slice(0, separator);
    const name = separator === -1 ? "" : nameWithOwner.slice(separator + 1);
    if (
      owner.length === 0 || name.length === 0 || name.includes("/") ||
      owner.length > MaxText.owner || name.length > MaxText.name
    ) {
      fail(
        `${nodePath}.repository.nameWithOwner`,
        "invalid_pattern",
        "expected owner/name repository identity",
      );
    }
    // Closed native blockers are authoritative as satisfied and excluded;
    // open blockers are retained even when they live in another repository.
    if (state === "CLOSED") continue;
    const blockerKey = `${owner}\u0000${name}\u0000${blockerNumber}`;
    if (seenBlockers.has(blockerKey)) continue;
    seenBlockers.add(blockerKey);
    openBlockers.push({ owner, name, number: blockerNumber });
  }
  return { openBlockers, subIssueCount };
}
