/**
 * Which issues Sentinel works at all (owner directive 2026-11-17, verbatim:
 * "i guess sentinel should only automatically handle issues that are either
 * authored by me 0x4007 or the sentinel"). On every target an issue is
 * admitted, and an existing record's issue keeps being worked, only when its
 * author is the owner account (bound by login AND numeric user id, so a
 * renamed or recycled login never matches) or the Sentinel App itself (the
 * identity `isBaseRepairIssue` checks; GitHub reserves the `[bot]` suffix
 * for Apps). A missing or mismatched author identity is not admitted.
 *
 * The same identities decide whether a candidate may change a CI-executable
 * path (`workflow-trust.ts`), with the provenance rules kept there.
 */
import { BASE_REPAIR_AUTHOR } from "./base-repair.ts";

/** The owner account whose issues Sentinel works: login and user id. */
export const ADMITTED_ISSUE_OWNER: Readonly<{ login: string; id: number }> =
  Object.freeze({ login: "0x4007", id: 4975670 });

/** The Sentinel App's own issue author login. */
export const SENTINEL_APP_ISSUE_AUTHOR = BASE_REPAIR_AUTHOR;

/** Intake's closed reason for an open issue it leaves for its author. */
export const AUTHOR_NOT_ADMITTED_REASON = "author_not_admitted";

/** The uncharged park of an existing record whose issue is not admitted. */
export const AUTHOR_NOT_ADMITTED_PARK =
  "issue author is not admitted; owner action required";

/** Who wrote one issue, as far as admission is concerned. */
export type IssueAuthorKindV1 = "owner" | "app" | "other";

/** The author fields one issue read carries. */
export interface IssueAuthorFactsV1 {
  readonly author: string | null;
  readonly authorId?: number;
}

/** `owner` only for the exact login and user id; `app` for the App. */
export function issueAuthorKind(issue: IssueAuthorFactsV1): IssueAuthorKindV1 {
  if (issue.author === SENTINEL_APP_ISSUE_AUTHOR) return "app";
  if (
    issue.author !== null &&
    issue.author.toLowerCase() === ADMITTED_ISSUE_OWNER.login.toLowerCase() &&
    issue.authorId === ADMITTED_ISSUE_OWNER.id
  ) return "owner";
  return "other";
}

/** Whether Sentinel works this issue at all. */
export function issueAuthorAdmitted(issue: IssueAuthorFactsV1): boolean {
  return issueAuthorKind(issue) !== "other";
}
