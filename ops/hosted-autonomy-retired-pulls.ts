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
 * - Sentinel's own and open while the source issue reads OPEN again: settled
 *   `reopened`. Nothing re-admits a retired record otherwise (intake skips an
 *   existing record and the retirement is terminal for every retry rule), so
 *   the retirement blocker is lifted: the record returns to `work` with its
 *   pull request, head, counters and charges kept, an ordinary open-issue
 *   record again, and the runtime's own gates decide what follows. Only the
 *   exact retirement shape (no intent, no wait) is lifted; a later
 *   retirement of the same pull request is unsettled again.
 *
 * Each settled outcome is recorded on the record (`retiredPullClosure`) in ONE
 * expected-head repair write, so a later pass never reads, comments on or
 * closes that pull request again. An unreadable listing or issue, a refused
 * close or a missing surface or capability settles nothing: the record is
 * stamped (`pullProbe`, `hosted-autonomy-pull-probe.ts`) in the same write and
 * skipped until its backoff elapsed, and the least recently probed records
 * are read first, so an unsettleable record never starves the others. A
 * repository whose GitHub surface is unavailable (`surface_unreadable`) or
 * lacks the listing or close capability (`capability_absent`) is a pass-level
 * fact, not a record's: one action line names the repository and its records
 * are skipped with no read, no stamp and no write. A probe stamped no later than the retirement (the stale-step read of the
 * still-open pull before the issue's closure retired the record) does not
 * hold back the first read after the retirement. A
 * protected record is not read, and neither is a record the same hosted pass
 * just retired: its retirement is that cycle's one write, and the pull
 * request is settled from the next pass. The pass never throws and never fails the
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
import {
  applyPullProbes,
  pullProbedAt,
  pullProbeDue,
  type PullProbeStampV1,
} from "./hosted-autonomy-pull-probe.ts";
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
  // The surface's capabilities were checked for the whole repository; a
  // record with no source issue number is the record's own fact.
  if (issueNumber === null) {
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
  if (open === true && record.intent === null && record.wait === null) {
    return "reopened";
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

/**
 * Record the settled outcomes on their records and stamp the unsettled
 * probes (pure). A `reopened` record also leaves its retirement: back to
 * `work`, blocker cleared, everything else kept.
 */
export function applyRetiredPullClosures(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  outcomes: ReadonlyMap<string, Outcome>,
  now: number,
  probes: readonly PullProbeStampV1[] = [],
): RepairStateSnapshotV1 {
  return applyPullProbes(
    parseRepairStateSnapshotV1({
      ...snapshot,
      stateHead: head,
      sequence: snapshot.sequence + 1,
      updatedAt: now,
      work: snapshot.work.map((record) => {
        const outcome = outcomes.get(record.id);
        if (outcome === undefined) return record;
        const settled = {
          ...record,
          retiredPullClosure: { pr: record.target.pr!, outcome, at: now },
          updatedAt: now,
        };
        return outcome === "reopened"
          ? { ...settled, nextStep: "work" as const, blocker: null }
          : settled;
      }),
    }),
    probes,
    now,
  );
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
  /**
   * The start of the hosted pass this follows. A record retired at or after
   * it was retired by this same pass, in that pass's own write: it waits for
   * the next pass, so one retirement is one write and its pull request is
   * never read, settled or stamped in the cycle that retired it.
   */
  passStartedAt: number = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  // A record inside its probe backoff waits for a later pass. A probe
  // stamped no later than the retirement (the stale-step human-merge read of
  // the still-open pull, before its issue's closure retired it) was not this
  // pass's read: the first read after a retirement is always due.
  const start = deps.clock.now();
  const pending = (record: WorkRecordV1) =>
    retiredPullClosurePending(record) &&
    !(record.blocker !== null && record.blocker.since >= passStartedAt) &&
    !queueRecordProtected(record, deps.queueCustody) &&
    (pullProbeDue(record, start) ||
      (record.blocker !== null &&
        pullProbedAt(record) <= record.blocker.since));
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
    const actions: string[] = [];
    // One surface per repository. An unavailable surface or a missing
    // capability is the repository's fact: one action line, and its records
    // are not read, stamped or written.
    const surfaces = new Map<string, HostedAutonomyGitHubV1 | null>();
    const surfaceOf = (record: WorkRecordV1) => {
      const key = `${record.repository.owner}/${record.repository.name}`;
      if (surfaces.has(key)) return surfaces.get(key)!;
      let surface: HostedAutonomyGitHubV1 | null = null;
      try {
        surface = deps.githubFor(record.repository);
      } catch {
        surface = null;
      }
      if (surface === null) {
        actions.push(`retired-pull:repo=${key}:surface_unreadable`);
      } else if (
        surface.listPullsByHeadRef === undefined ||
        surface.closePull === undefined
      ) {
        actions.push(`retired-pull:repo=${key}:capability_absent`);
        surface = null;
      }
      surfaces.set(key, surface);
      return surface;
    };
    // Least recently probed first (never probed first of all, in snapshot
    // order).
    const candidates = snapshot.work
      .filter(pending)
      .filter((record) => surfaceOf(record) !== null)
      .map((record, index) => ({ record, index }))
      .sort((left, right) =>
        pullProbedAt(left.record) - pullProbedAt(right.record) ||
        left.index - right.index
      )
      .map((entry) => entry.record)
      .slice(0, RETIRED_PULLS_PER_PASS);
    if (candidates.length === 0) return actions;
    const outcomes = new Map<string, Outcome>();
    const probes: PullProbeStampV1[] = [];
    const probe = (record: WorkRecordV1) =>
      probes.push({
        id: record.id,
        repository: record.repository,
        pr: record.target.pr!,
      });
    for (const record of candidates) {
      const at = deps.clock.now();
      if (!Number.isSafeInteger(at) || at >= passDeadline) {
        actions.push("retired-pull:deadline");
        break;
      }
      const outcome = await settleRecord(surfaceOf(record)!, record, actions);
      if (outcome === null) {
        probe(record);
        continue;
      }
      outcomes.set(record.id, outcome);
      actions.push(
        `retired-pull:${record.id}:pr=${record.target.pr}:${outcome}`,
      );
    }
    if (outcomes.size === 0 && probes.length === 0) return actions;
    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return [...actions, "retired-pull:clock_invalid"];
    }
    let next: RepairStateSnapshotV1;
    try {
      next = applyRetiredPullClosures(snapshot, head, outcomes, now, probes);
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
    return [
      ...actions,
      ...(outcomes.size === 0
        ? []
        : [`retired-pull:recorded=${outcomes.size}`]),
      ...(probes.length === 0 ? [] : [`retired-pull:backoff=${probes.length}`]),
    ];
  } catch {
    return ["retired-pull:unexpected_error"];
  }
}
