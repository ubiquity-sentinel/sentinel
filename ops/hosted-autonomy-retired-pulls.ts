/**
 * Retired pull-request pass, run by the trusted launcher's hosted maintenance
 * pass after the ordinary phases.
 *
 * A record retired because its source issue closed (live 2026-10-27: a
 * person's pull request closed ai.ubq.fi #1325-#1327 an hour before Sentinel
 * opened #1329-#1331) can still bind Sentinel's own open pull request, which
 * then stays open, drifts into conflicts and is never merged. For every such
 * record whose pull request is not yet settled (`retiredPullClosurePending`)
 * the pass reads the pull requests on the record's own repair branch:
 *
 * - Sentinel's own (a trusted Sentinel author on exactly the record's branch),
 *   still open and unmerged, while the source issue still reads closed: the
 *   pull request is closed and one short comment names the closed issue (and
 *   the commit that closed it, when GitHub names one). The branch is kept.
 * - merged, already closed, or not Sentinel's own: nothing is written to
 *   GitHub.
 *
 * Each settled outcome is recorded on the record (`retiredPullClosure`) in ONE
 * expected-head repair write, so a later pass never reads, comments on or
 * closes that pull request again. An unreadable listing or issue, a refused
 * close, a protected record or a missing surface capability settles nothing
 * and is retried by a later pass. The pass never throws and never fails the
 * run; it only appends actions (no URL, body or credential).
 */
import type { GitSha } from "../src/contracts/brands.ts";
import type { StateReadView } from "../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type {
  RetiredPullClosureV1,
  WorkRecordV1,
} from "../src/contracts/work-record.ts";
import { retiredPullClosurePending } from "../src/contracts/work-record-retired-pull.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import { HOSTED_AUTONOMY_TRUSTED_AUTHORS } from "./hosted-autonomy-policy.ts";
import { readRepairSafely } from "./hosted-autonomy-state.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
} from "./hosted-autonomy-types.ts";

/** Retired pull requests one pass settles at most. */
export const RETIRED_PULLS_PER_PASS = 10;

/** Hidden marker of the one closing comment. */
export function retiredPullMarker(recordId: string): string {
  return `<!-- sentinel:retired-pull ${recordId} -->`;
}

/** The one short comment posted on the closed pull request. */
export function retiredPullComment(
  record: Pick<WorkRecordV1, "id" | "target">,
  issueNumber: number,
  closingCommit: string | null,
): string {
  const by = closingCommit === null
    ? ""
    : ` by commit ${closingCommit.slice(0, 10)}`;
  return [
    retiredPullMarker(record.id),
    `Sentinel is closing this pull request: its source issue #${issueNumber} was closed${by}, so this repair is no longer needed. The branch \`${record.target.branch}\` is kept.`,
  ].join("\n");
}

async function settle<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

type Outcome = RetiredPullClosureV1["outcome"];

/** Settle one record's pull request; null leaves it for a later pass. */
async function settleRecord(
  surface: HostedAutonomyGitHubV1,
  record: WorkRecordV1,
  actions: string[],
): Promise<Outcome | null> {
  const pr = record.target.pr!;
  const branch = record.target.branch!;
  const issueNumber = record.related.issueNumber;
  const tag = `retired-pull:${record.id}:pr=${pr}`;
  if (
    surface.listPullsByHeadRef === undefined ||
    surface.closePull === undefined || issueNumber === null
  ) {
    actions.push(`${tag}:capability_absent`);
    return null;
  }
  const pulls = await settle(() => surface.listPullsByHeadRef!(branch));
  if (pulls === null) {
    actions.push(`${tag}:listing_unreadable`);
    return null;
  }
  const pull = pulls.find((row) => row.number === pr);
  // A bound pull request that is not on the record's own repair branch, or
  // that Sentinel did not author, is never Sentinel's to close.
  if (
    pull === undefined || pull.headRef !== branch || pull.author === null ||
    !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)
  ) return "not_own";
  if (pull.merged) return "merged";
  if (pull.state !== "open") return "closed_elsewhere";
  // The retirement blocker says the issue closed; it must still read closed
  // now (a reopened issue keeps its pull request open).
  let open: boolean | null;
  let closingCommit: string | null = null;
  if (surface.readIssueClosingCommit !== undefined) {
    const issue = await settle(() =>
      surface.readIssueClosingCommit!(issueNumber)
    );
    open = issue?.open ?? null;
    closingCommit = issue?.closingCommit ?? null;
  } else {
    open = await settle(() => surface.readIssueOpen(issueNumber));
  }
  if (open !== false) {
    actions.push(`${tag}:${open === true ? "issue_open" : "issue_unreadable"}`);
    return null;
  }
  // Close first: a comment is posted only once the close is proven, so a
  // refused close never leaves a second comment behind on the next pass.
  const closed = await settle(() => surface.closePull!(pr));
  if (closed !== true) {
    actions.push(`${tag}:close_unproven`);
    return null;
  }
  const commented = await settle(() =>
    surface.commentIssue?.(
      pr,
      retiredPullComment(record, issueNumber, closingCommit),
    ) ?? Promise.resolve(false)
  );
  if (commented !== true) actions.push(`${tag}:comment_unproven`);
  return "closed";
}

/** Record the settled outcomes on their records (pure). */
export function applyRetiredPullClosures(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  outcomes: ReadonlyMap<string, Outcome>,
  now: number,
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) => {
      const outcome = outcomes.get(record.id);
      return outcome === undefined ? record : {
        ...record,
        retiredPullClosure: { pr: record.target.pr!, outcome, at: now },
        updatedAt: now,
      };
    }),
  });
}

/** Run the pass once over the guarded maintenance deps. */
export async function runHostedRetiredPullPass(
  deps: HostedAutonomyDepsV1,
  passDeadline: number = Number.POSITIVE_INFINITY,
  /**
   * The view candidates are discovered from: the runner passes the read the
   * state-free passes already share, so a pass with no candidate adds no
   * state read. The pass re-reads `deps.state` for its expected head.
   */
  discovery: StateReadView = deps.state,
): Promise<string[]> {
  const pending = (record: WorkRecordV1) =>
    retiredPullClosurePending(record) &&
    !queueRecordProtected(record, deps.queueCustody);
  try {
    if (discovery !== deps.state) {
      const seen = await readRepairSafely(discovery);
      if (
        seen === null || !seen.ok || seen.value.status !== "found" ||
        !seen.value.snapshot.work.some(pending)
      ) return [];
    }
    const read = await readRepairSafely(deps.state);
    if (read === null || !read.ok || read.value.status !== "found") return [];
    const { snapshot } = read.value;
    const head = read.value.head as GitSha;
    const candidates = snapshot.work.filter(pending).slice(
      0,
      RETIRED_PULLS_PER_PASS,
    );
    if (candidates.length === 0) return [];
    const actions: string[] = [];
    const outcomes = new Map<string, Outcome>();
    for (const record of candidates) {
      const at = deps.clock.now();
      if (!Number.isSafeInteger(at) || at >= passDeadline) {
        actions.push("retired-pull:deadline");
        break;
      }
      let surface: HostedAutonomyGitHubV1 | null = null;
      try {
        surface = deps.githubFor(record.repository);
      } catch {
        surface = null;
      }
      if (surface === null) {
        actions.push(`retired-pull:${record.id}:surface_unreadable`);
        continue;
      }
      const outcome = await settleRecord(surface, record, actions);
      if (outcome === null) continue;
      outcomes.set(record.id, outcome);
      actions.push(
        `retired-pull:${record.id}:pr=${record.target.pr}:${outcome}`,
      );
    }
    if (outcomes.size === 0) return actions;
    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return [...actions, "retired-pull:clock_invalid"];
    }
    let next: RepairStateSnapshotV1;
    try {
      next = applyRetiredPullClosures(snapshot, head, outcomes, now);
    } catch {
      return [...actions, "retired-pull:snapshot_invalid"];
    }
    const write = await settle(() => deps.state.writeRepair(next, head));
    if (write === null || !write.ok || write.value.status !== "applied") {
      // A pull request closed before a refused write reads closed next pass
      // and settles as `closed_elsewhere`: it is never commented on twice.
      const reason = write?.ok === true ? write.value.status : "unavailable";
      return [...actions, `retired-pull:write_${reason}`];
    }
    return [...actions, `retired-pull:recorded=${outcomes.size}`];
  } catch {
    return ["retired-pull:unexpected_error"];
  }
}
