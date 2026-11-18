/**
 * The one safeguard kept under the owner's 2026-11-17 "full access"
 * directive: a candidate that changes a CI-executable path is pushed only on
 * a trusted source's authority. Sentinel pushes its candidate branch into
 * the target repository itself, so a changed workflow or action runs on
 * `push` and `pull_request` with that repository's Actions secrets before
 * any review, and the implementer prompt carries the source's text. A
 * leaked secret is not undone by a revert, so this gate stays when every
 * other protected path publishes.
 *
 * Trust follows where the text came from (owner directive 2026-11-17: only
 * the owner's and the App's issues are worked at all, `issue-admission.ts`):
 * - an issue by the owner account (login and user id): trusted;
 * - the App's structured kinds, whose text Sentinel writes from its own
 *   facts: a base-repair issue (`isBaseRepairBody`) and a target capability
 *   notice (`SENTINEL_SKIP_MARKER` then `TARGET_CAPABILITY_ISSUE_MARKER`):
 *   trusted;
 * - an App review follow-up (the follow-up marker for this repository on its
 *   first line): the trust of the original issue its header names
 *   (`- Original issue: #N`), walked a bounded number of times; no such
 *   line, a self-reference or an origin that does not exist is untrusted;
 * - every other App kind (a CI outage notice, a throughput watchdog issue,
 *   anything else), any other author, and a record with no issue (an
 *   incident, from production text): untrusted, and so is a number that
 *   no longer names an issue here (deleted, or transferred: GitHub answers
 *   with the moved issue's own number).
 * A failed read is `unavailable`: the caller defers and never pushes, and a
 * transient failure parks nothing.
 * Issue comments never reach the prompt (`observeIssueForModel` passes only
 * the title and body). A candidate that changes no CI-executable path costs
 * no read.
 */
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { isBaseRepairBody } from "./base-repair.ts";
import {
  SENTINEL_SKIP_MARKER,
  TARGET_CAPABILITY_ISSUE_MARKER,
} from "./target-capability.ts";
import { issueAuthorKind } from "./issue-admission.ts";
import { normalizePathPrefix } from "./loop-records.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";

/** The runtime's exact protected-path park (`loop-implementation-result.ts`). */
export const PROTECTED_PATH_PARK = "candidate touches a protected path";

/**
 * The park of a CI-executable change on an untrusted source's authority. It
 * keeps the protected park's prefix, which summaries read, but not its exact
 * text: the owner's `sentinel:retry` exit would only re-run the same task.
 */
export const UNTRUSTED_WORKFLOW_PARK = `${PROTECTED_PATH_PARK}: workflow ` +
  "change from an untrusted issue author; owner action required";

/**
 * A changed path that is not a plain, normalised, repository-relative path:
 * empty, absolute, quoted or escaped as `git` prints a path without `-z`
 * (a quote or backslash), carrying a control character, or with an empty,
 * `.` or `..` segment beyond a leading `./`. No predicate can classify it,
 * so every predicate fails closed on it.
 */
export function unsafeChangedPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return true;
  if (path.startsWith("/") || /["\\]/.test(path)) return true;
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return true;
  const relative = path.startsWith("./") ? path.slice(2) : path;
  const trimmed = relative.endsWith("/") ? relative.slice(0, -1) : relative;
  return trimmed.length === 0 ||
    trimmed.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    );
}

/**
 * A path CI executes or that configures how it runs: anything under
 * `.github/` in any letter case (workflows, composite actions, repository
 * automation; a case variant is CI-executable on a case-insensitive
 * checkout), and any path no predicate can classify (`unsafeChangedPath`).
 */
export function ciExecutablePath(path: string): boolean {
  if (unsafeChangedPath(path)) return true;
  return normalizePathPrefix(path).split("/")[0].toLowerCase() === ".github";
}

/** How far one candidate's CI-executable change may be pushed. */
export type WorkflowTrustV1 = "trusted" | "untrusted" | "unavailable";

/** At most this many follow-up issues are walked back to their origin. */
const MAX_PROVENANCE_HOPS = 4;

/** The App's review follow-up marker (`hosted-autonomy-follow-up-render.ts`). */
const FOLLOW_UP_MARKER =
  /^<!-- sentinel:review-followup:v[12] repo=([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}) pr=[1-9][0-9]{0,9} receipt=[A-Za-z0-9:_.-]{1,200}(?: finding=[A-Za-z0-9_.-]{1,128})? depth=[1-9][0-9]? -->$/;
/** The App-written header line naming a follow-up's original issue. */
const ORIGINAL_ISSUE_LINE = /^- Original issue: #([1-9][0-9]{0,9})$/;

/**
 * The original issue an App-authored review follow-up names in its own
 * header (before the quoted reviewer text, which starts at the first `###`
 * heading), when its marker names this repository; null otherwise.
 */
export function followUpOriginIssue(
  body: string,
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
): number | null {
  const lines = body.split(/\r?\n/);
  const marker = FOLLOW_UP_MARKER.exec(lines[0] ?? "");
  if (
    marker === null ||
    marker[1].toLowerCase() !== repository.owner.toLowerCase() ||
    marker[2].toLowerCase() !== repository.name.toLowerCase()
  ) return null;
  for (const line of lines.slice(1)) {
    if (line.startsWith("###")) break;
    const origin = ORIGINAL_ISSUE_LINE.exec(line);
    if (origin !== null) return Number(origin[1]);
  }
  return null;
}

/**
 * Whether the text behind `record` may steer a CI-executable change,
 * independent of any path: the source issue's (or its origin's) author.
 */
export async function recordCiTrust(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: Pick<WorkRecordV1, "related" | "repository">,
): Promise<WorkflowTrustV1> {
  const number = record.related.issueNumber;
  if (number === null) return "untrusted";
  const seen = new Set<number>();
  let current = number;
  for (let hop = 0; hop <= MAX_PROVENANCE_HOPS; hop++) {
    if (seen.has(current)) return "untrusted";
    seen.add(current);
    let issue;
    try {
      const read = await deps.github.readIssue(current);
      if (!read.ok) return "unavailable";
      // An issue that does not exist can never vouch for anything, and
      // neither can a number GitHub answers with another issue (a transfer
      // or a move: definitive, so it parks instead of deferring for ever).
      if (read.value === null) return "untrusted";
      if (read.value.number !== current) return "untrusted";
      issue = read.value;
    } catch {
      return "unavailable";
    }
    const kind = issueAuthorKind(issue);
    if (kind === "owner") return "trusted";
    if (kind === "other") return "untrusted";
    if (isBaseRepairBody(issue.body) || capabilityNotice(issue.body)) {
      return "trusted";
    }
    const origin = followUpOriginIssue(issue.body, record.repository);
    if (origin === null) return "untrusted";
    current = origin;
  }
  return "untrusted";
}

/** The App's target capability notice: its two marker lines, in order. */
function capabilityNotice(body: string): boolean {
  const [first, second] = body.split(/\r?\n/, 2);
  return first === SENTINEL_SKIP_MARKER &&
    second === TARGET_CAPABILITY_ISSUE_MARKER;
}

/**
 * `trusted` without a read when no changed path is CI-executable; otherwise
 * the record's source decides (`recordCiTrust`).
 */
export async function workflowChangeTrust(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: Pick<WorkRecordV1, "related" | "repository">,
  changedPaths: readonly string[],
): Promise<WorkflowTrustV1> {
  if (!changedPaths.some(ciExecutablePath)) return "trusted";
  return await recordCiTrust(deps, record);
}
