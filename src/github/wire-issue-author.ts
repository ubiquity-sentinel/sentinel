/**
 * The optional author facts of one issue wire (`parseIssueWire`): GitHub's
 * closed `author_association` (any other value is dropped), and the author's
 * numeric user id (`user.id`), which binds the owner's issue admission to the
 * account rather than to a login that can be renamed or recycled (owner
 * directive 2026-11-17, `src/repair/issue-admission.ts`). Each is absent
 * unless the response carries a known value: a positive safe integer id.
 */
import type { GitHubIssueV1 } from "../contracts/ports.ts";

/** GitHub's closed `author_association` values; any other is dropped. */
const AUTHOR_ASSOCIATIONS: readonly string[] = Object.freeze([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
]);

/** The known author id and association of one issue wire object. */
export function issueAuthorFacts(
  obj: Record<string, unknown>,
): Pick<GitHubIssueV1, "authorId" | "authorAssociation"> {
  const user = obj.user;
  const id = user !== null && typeof user === "object" && !Array.isArray(user)
    ? (user as Record<string, unknown>).id
    : undefined;
  const association = obj.author_association;
  return {
    ...(typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? { authorId: id }
      : {}),
    ...(typeof association === "string" &&
        AUTHOR_ASSOCIATIONS.includes(association)
      ? { authorAssociation: association }
      : {}),
  };
}
