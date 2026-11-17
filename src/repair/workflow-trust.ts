/**
 * The one safeguard kept under the owner's 2026-11-17 "full access"
 * directive: a candidate that changes a CI-executable path is pushed only on
 * a trusted issue's authority. Sentinel pushes its candidate branch into the
 * target repository itself, so a changed workflow or action runs on `push`
 * and `pull_request` with that repository's Actions secrets before any
 * review, and the implementer prompt carries the issue title and body, which
 * anyone can write on a public repository. A leaked secret is not undone by
 * a revert, so this gate stays when every other protected path publishes.
 *
 * Trusted: an issue the Sentinel App opened (its own capability notices and
 * base-repair issues) or one whose author GitHub reports as `OWNER`,
 * `MEMBER` or `COLLABORATOR` at read time. Issue comments never reach the
 * prompt (`observeIssueForModel` passes only the title and body), and only
 * the author or a collaborator can edit the body. A candidate that changes
 * no CI-executable path costs no read.
 */
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { BASE_REPAIR_AUTHOR } from "./base-repair.ts";
import { normalizePathPrefix } from "./loop-records.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";

/** The runtime's exact protected-path park (`loop-implementation-result.ts`). */
export const PROTECTED_PATH_PARK = "candidate touches a protected path";

/**
 * The park of a CI-executable change on an untrusted issue's authority. It
 * keeps the protected park's prefix, which the owner comment and summaries
 * read, but not its exact text: the owner's `sentinel:retry` exit would only
 * re-run the same untrusted task.
 */
export const UNTRUSTED_WORKFLOW_PARK = `${PROTECTED_PATH_PARK}: workflow ` +
  "change from an untrusted issue author; owner action required";

/** GitHub `author_association` values whose issue may steer CI changes. */
export const TRUSTED_ISSUE_ASSOCIATIONS: readonly string[] = Object.freeze([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/**
 * A path CI executes or that configures how it runs: anything under
 * `.github/` (workflows, composite actions, repository automation).
 */
export function ciExecutablePath(path: string): boolean {
  return normalizePathPrefix(path).split("/")[0] === ".github";
}

/** How far one candidate's CI-executable change may be pushed. */
export type WorkflowTrustV1 = "trusted" | "untrusted" | "unavailable";

/**
 * `trusted` without a read when no changed path is CI-executable, or when the
 * record has no issue at all (an incident or backlog task Sentinel wrote);
 * otherwise the issue's author decides. An unreadable issue, a mismatched
 * read or an author without a known association is `unavailable`.
 */
export async function workflowChangeTrust(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: Pick<WorkRecordV1, "related" | "source">,
  changedPaths: readonly string[],
): Promise<WorkflowTrustV1> {
  if (!changedPaths.some(ciExecutablePath)) return "trusted";
  const number = record.related.issueNumber;
  if (number === null) {
    return record.source.kind === "issue" ? "unavailable" : "trusted";
  }
  try {
    const read = await deps.github.readIssue(number);
    if (!read.ok || read.value === null || read.value.number !== number) {
      return "unavailable";
    }
    if (read.value.author === BASE_REPAIR_AUTHOR) return "trusted";
    const association = read.value.authorAssociation;
    if (association === undefined) return "unavailable";
    return TRUSTED_ISSUE_ASSOCIATIONS.includes(association)
      ? "trusted"
      : "untrusted";
  } catch {
    return "unavailable";
  }
}
