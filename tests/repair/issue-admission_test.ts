/**
 * Owner directive 2026-11-17, verbatim: "i guess sentinel should only
 * automatically handle issues that are either authored by me 0x4007 or the
 * sentinel". The identity rule itself: the owner account is bound by login
 * AND numeric user id (one constant), the App by its `[bot]` login; anything
 * else, a missing id included, is not admitted. The loop's enforcement is in
 * `issue-admission-loop_test.ts`.
 */
import assert from "node:assert/strict";
import type { GitHubIssueV1 } from "../../src/contracts/ports.ts";
import {
  ADMITTED_ISSUE_OWNER,
  AUTHOR_NOT_ADMITTED_PARK,
  AUTHOR_NOT_ADMITTED_REASON,
  issueAuthorAdmitted,
  issueAuthorKind,
} from "../../src/repair/issue-admission.ts";
import { ISSUE_NOT_ADMITTED_REASONS } from "../../src/contracts/ports.ts";

const APP = "ubiquity-sentinel[bot]";

Deno.test("issue admission: only the owner's login and user id, or the App, is admitted", () => {
  assert.deepEqual(ADMITTED_ISSUE_OWNER, { login: "0x4007", id: 4975670 });
  const cases: [Partial<GitHubIssueV1>, string][] = [
    [{ author: "0x4007", authorId: 4975670 }, "owner"],
    [{ author: "0X4007", authorId: 4975670 }, "owner"],
    [{ author: APP }, "app"],
    [{ author: "0x4007", authorId: 1 }, "other"],
    [{ author: "0x4007" }, "other"],
    [{ author: "someone", authorId: 4975670 }, "other"],
    [{ author: "member", authorId: 12, authorAssociation: "MEMBER" }, "other"],
    [{ author: "collaborator", authorAssociation: "COLLABORATOR" }, "other"],
    [{ author: "OWNER", authorAssociation: "OWNER" }, "other"],
    [{ author: "ubiquity-sentinel" }, "other"],
    [{ author: null }, "other"],
  ];
  for (const [issue, kind] of cases) {
    const facts = { author: issue.author ?? null, authorId: issue.authorId };
    assert.equal(issueAuthorKind(facts), kind, JSON.stringify(issue));
    assert.equal(issueAuthorAdmitted(facts), kind !== "other");
  }
  // The loop test spells these out (it also runs against the pre-fix tree).
  assert.equal(AUTHOR_NOT_ADMITTED_REASON, "author_not_admitted");
  assert.ok(
    (ISSUE_NOT_ADMITTED_REASONS as readonly string[]).includes(
      AUTHOR_NOT_ADMITTED_REASON,
    ),
  );
  assert.equal(
    AUTHOR_NOT_ADMITTED_PARK,
    "issue author is not admitted; owner action required",
  );
});
