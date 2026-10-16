/**
 * Re-arm of a base refresh the runtime closed on the trusted validator's
 * deterministic refusal of its prepared merge ("base refresh failed N
 * consecutive times: invalid candidate could not be preserved").
 *
 * Up to generation 76 the publication validator bounded EVERY parent edge of
 * the refresh merge, so a base that moved by more than the changed-path bound
 * made every refresh of an intact, preserved and reviewed candidate a
 * structural refusal (ai.ubq.fi issue 649, PR 1012). The candidate itself is
 * untouched: its preserved descriptor, deterministic preservation ref, managed
 * branch and open pull request still name the exact head. markTerminalBlocked
 * only detached the pull request number, and nothing ever re-arms it.
 *
 * Only an installed runtime whose exact revision is allowlisted as carrying
 * the corrected validator qualifies (a generation number never does: a
 * rollback advances it too), and only a refusal written before that runtime
 * was activated is re-armed, so the corrected validator's own refusal stays
 * blocked. Each allowlist entry pins its own activation bound, because an
 * owner install, that runtime's bootstrap and the bootstrap's settlement all
 * happen in one workflow run after that run's maintenance: no maintenance
 * ever observes the earlier generation's settlement under the new pointer.
 * The record's exact publication is then restored from its OWN repository
 * surface — the managed branch and the preservation ref both at the exact
 * head, exactly one open pull request from that branch by a trusted author
 * against the configured base, at that head — and the record returns
 * to `delivery`, where the runtime's own refresh path observes the moved base,
 * prepares, preserves and publishes the refreshed head and requests a fresh
 * review. Nothing is charged, refunded, pushed, merged or reviewed here, and
 * one refresh refusal re-arms at most once a day (no model start is ever
 * involved).
 */
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { HOSTED_RUNTIME_ID } from "../src/contracts/hosted-supervisor.ts";
import type {
  PortResultV1,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { BASE_REFRESH_PRESERVE_DETAIL } from "../src/repair/loop-base-refresh.ts";
import {
  candidateBranch,
  candidatePreservationRef,
} from "../src/repair/keys.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  hostedIssueKey,
} from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import { failed, readRepairSafely, skipped } from "./hosted-autonomy-state.ts";
import type {
  HostedAutonomyResultV1,
  HostedRefreshRearmRuntimeV1,
} from "./hosted-autonomy-types.ts";

/**
 * Exact runtime revisions whose publication validator bounds only the base
 * edge of a refresh merge, each with an instant no later than its first
 * activation: the instant of the launcher commit that pins the entry, which
 * is written before that commit is pushed and so before its owner-install
 * rung can install the revision. A generation number never qualifies on its
 * own: a rollback advances it too (a failed 77 restores 41bb853a1 at
 * generation 78).
 */
export const HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES:
  readonly HostedRefreshRearmRuntimeV1[] = [
    // Generation 77 (the review-snapshot base-edge bound, a2a0d537e), pinned
    // by its launcher commit at 1792139532000.
    {
      revision: "ab3613e0224ff92266bed21dde6f40e6b0aab54a",
      activatedNotBefore: 1792139532000,
    },
    // Generation 78 (R78, which keeps the base-edge bound), pinned by its
    // launcher commit at 1792165758215.
    {
      revision: "474f87eb639f97cd72b9bc4b9e56101488f841aa",
      activatedNotBefore: 1792165758215,
    },
    // Generation 79 (R79, which keeps the base-edge bound), pinned by its
    // launcher commit at 1792185359753.
    {
      revision: "549c7a69186b3d2070aa4e69c92ee846d183ce8f",
      activatedNotBefore: 1792185359753,
    },
  ];

/** Every recorded execution creation of one revision in release custody. */
function executionsOf(
  release: ReleaseStateSnapshotV1,
  revision: string,
): number[] {
  const created: number[] = [];
  for (const row of release.hostedReleases) {
    for (
      const proof of [row.priorProof, row.candidateProof, row.rollbackProof]
    ) {
      if (proof?.execution.revision === revision) {
        created.push(proof.execution.createdAt);
      }
    }
  }
  for (const runtime of release.hostedRuntimes) {
    for (
      const proof of [runtime.lastHealthyProof, runtime.lastExecutionProof]
    ) {
      if (proof?.execution.revision === revision) {
        created.push(proof.execution.createdAt);
      }
    }
  }
  return created;
}

/**
 * The earliest instant a refresh refusal can be a corrected validator's own,
 * read only from the launcher's pinned activation bounds and release custody
 * that never moves forward: each allowlisted runtime's pinned bound, every
 * hosted release proof of an allowlisted runtime (immutable once written), and
 * each pointer settlement left by a generation EARLIER than the installed one
 * (written before the pointer moved). An allowlisted runtime's settlement
 * contributes its execution start, any other its observation instant. The
 * installed generation's own settlements are replaced on every run and never
 * count. A pinned bound that is not a positive safe integer, or that is later
 * than any recorded execution of its own revision, is provably not that
 * runtime's activation bound and never counts. null when the installed
 * runtime is not allowlisted or nothing qualifies, so nothing is re-armed.
 */
export function refreshFixActivation(
  release: ReleaseStateSnapshotV1,
  pinned: readonly HostedRefreshRearmRuntimeV1[] =
    HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES,
): number | null {
  const runtimes = pinned.map((row) => row.revision);
  const runtime = release.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  if (runtime === undefined || !runtimes.includes(runtime.activeRevision)) {
    return null;
  }
  const bounds: number[] = [];
  for (const row of pinned) {
    const bound = row.activatedNotBefore;
    if (
      Number.isSafeInteger(bound) && bound > 0 &&
      executionsOf(release, row.revision).every((at) => at >= bound)
    ) bounds.push(bound);
  }
  for (const row of release.hostedReleases) {
    for (
      const proof of [row.priorProof, row.candidateProof, row.rollbackProof]
    ) {
      if (proof !== null && runtimes.includes(proof.execution.revision)) {
        bounds.push(proof.execution.createdAt);
      }
    }
  }
  for (
    const proof of [runtime.lastHealthyProof, runtime.lastExecutionProof]
  ) {
    if (proof === null || proof.execution.generation >= runtime.generation) {
      continue;
    }
    bounds.push(
      runtimes.includes(proof.execution.revision)
        ? proof.execution.createdAt
        : proof.observedAt,
    );
  }
  return bounds.length === 0 ? null : Math.min(...bounds);
}

/** One refusal re-arms at most this often; refreshes never start a model. */
export const REFRESH_REARM_PACING_MS = 24 * 60 * 60 * 1000;

const REFUSED_REFRESH = new RegExp(
  `^base refresh failed [1-9][0-9]* consecutive times: invalid ${BASE_REFRESH_PRESERVE_DETAIL}$`,
);
const HEADS = "refs/heads/";

type Verdict =
  | { kind: "rearm"; pr: number }
  | { kind: "retain"; reason: string }
  | null;

interface Runtime {
  /** The installed revision is allowlisted as corrected. */
  fixed: boolean;
  /** refreshFixActivation of the installed custody. */
  activation: number | null;
}

async function judge(
  context: HostedAutonomyPassContextV1,
  record: WorkRecordV1,
  runtime: Runtime,
  now: number,
): Promise<Verdict> {
  const blocker = record.blocker;
  if (
    record.nextStep !== "blocked" || record.wait !== null ||
    record.intent !== null || blocker?.kind !== "other" ||
    !REFUSED_REFRESH.test(blocker.message)
  ) return null;
  const issue = record.related.issueNumber;
  if (
    record.source.kind !== "issue" || issue === null ||
    context.closedIssues.has(hostedIssueKey(record.repository, issue))
  ) return null;
  const head = record.target.head;
  const branch = record.target.branch;
  const state = record.target.candidateState;
  const preserved = state?.preserved ?? null;
  if (
    record.target.pr !== null || head === null ||
    branch !== candidateBranch(record.id) || preserved === null ||
    preserved.head !== head || preserved.base !== record.target.base ||
    state?.publishedHead !== head || !preserved.ref.startsWith(HEADS) ||
    preserved.ref !== await candidatePreservationRef(
        record.repository,
        record.id,
        preserved.operationKey,
      )
  ) return { kind: "retain", reason: "shape" };
  if (!runtime.fixed) return { kind: "retain", reason: "runtime" };
  // A refusal at or after the corrected runtime's activation may be its own.
  if (runtime.activation === null || blocker.since >= runtime.activation) {
    return { kind: "retain", reason: "activation" };
  }
  if (now - blocker.since < REFRESH_REARM_PACING_MS) {
    return { kind: "retain", reason: "pacing" };
  }
  const scope = await context.scopeFor(record.repository);
  const surface = scope.surface;
  const listing = surface?.mismatchDisposition;
  if (!surface || !listing || scope.baseBranch === null) {
    return { kind: "retain", reason: "surface" };
  }
  const tip = async (ref: string) => {
    try {
      return await surface.readBaseTip(ref);
    } catch {
      return null;
    }
  };
  if (await tip(branch) !== head) return { kind: "retain", reason: "branch" };
  if (await tip(preserved.ref.slice(HEADS.length)) !== head) {
    return { kind: "retain", reason: "preservation_ref" };
  }
  let pulls: Awaited<ReturnType<typeof listing.listPullsByHead>> = null;
  try {
    pulls = await listing.listPullsByHead(branch);
  } catch {
    pulls = null;
  }
  const open =
    pulls?.filter((row) => row.state === "open" && row.head === branch) ?? [];
  if (pulls === null || open.length !== 1) {
    return { kind: "retain", reason: "pull_listing" };
  }
  const pull = await context.readPull(scope, open[0]!.number);
  if (
    pull === null || pull.number !== open[0]!.number ||
    pull.state !== "open" || pull.merged !== false ||
    pull.headSha !== head || pull.baseRef !== scope.baseBranch ||
    pull.author === null ||
    !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)
  ) return { kind: "retain", reason: "pull" };
  return { kind: "rearm", pr: pull.number };
}

export async function runHostedRefreshRearmPass(
  context: HostedAutonomyPassContextV1,
): Promise<HostedAutonomyResultV1 | null> {
  const { deps, snapshot, observedHead, actions, revisions } = context;
  const now = deps.clock.now();
  const pinned = deps.refreshRearmRuntimes ??
    HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES;
  // Unparseable release custody proves no corrected runtime: nothing re-arms.
  let release: ReleaseStateSnapshotV1 | null = null;
  try {
    release = parseReleaseStateSnapshotV1(context.releaseSnapshot);
  } catch {
    release = null;
  }
  const installed = release?.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  const runtime: Runtime = {
    fixed: installed !== undefined &&
      pinned.some((row) => row.revision === installed.activeRevision),
    activation: release === null ? null : refreshFixActivation(release, pinned),
  };
  const rearmed = new Map<string, number>();
  for (const record of snapshot.work) {
    const verdict = await judge(context, record, runtime, now);
    if (verdict === null) continue;
    if (verdict.kind === "retain") {
      actions.push(`refresh:${record.id}:retained:${verdict.reason}`);
      continue;
    }
    rearmed.set(record.id, verdict.pr);
  }
  if (rearmed.size === 0) return null;
  if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
    return skipped("clock_invalid", observedHead, actions);
  }
  let next: RepairStateSnapshotV1;
  try {
    next = parseRepairStateSnapshotV1({
      ...snapshot,
      stateHead: observedHead,
      sequence: snapshot.sequence + 1,
      updatedAt: now,
      work: snapshot.work.map((record) => {
        const pr = rearmed.get(record.id);
        return pr === undefined ? record : {
          ...record,
          nextStep: "delivery",
          blocker: null,
          wait: null,
          target: { ...record.target, pr },
          updatedAt: now,
        };
      }),
    });
  } catch {
    return skipped("snapshot_invalid", observedHead, actions);
  }
  let write: PortResultV1<StateWriteResultV1> | null;
  try {
    write = await deps.state.writeRepair(next, observedHead as GitSha);
  } catch {
    return failed("write_unavailable", observedHead, actions);
  }
  if (write === null || !write.ok) {
    return failed("write_unavailable", observedHead, actions);
  }
  if (write.value.status === "conflict") {
    return skipped("write_conflict", observedHead, actions);
  }
  if (write.value.status === "ambiguous") {
    return failed("write_ambiguous", observedHead, actions);
  }
  const readback = await readRepairSafely(deps.state);
  if (
    readback === null || !readback.ok ||
    readback.value.status !== "found" ||
    readback.value.head !== write.value.head ||
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) {
    return failed("readback_unverified", observedHead, actions);
  }
  for (const [id, pr] of rearmed) actions.push(`refresh:${id}:rearmed:${pr}`);
  return {
    kind: "hosted_autonomy",
    status: "applied",
    reason: "applied",
    beforeHead: context.initialHead,
    appliedHead: write.value.head,
    actions,
    revisions,
  };
}
