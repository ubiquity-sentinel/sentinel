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
 * involved). A record with no review round left is never re-armed: the
 * refreshed head could not be reviewed under the hard review-round ceiling.
 *
 * A refusal at or after that activation (or with no provable activation) is
 * the corrected validator's own verdict on immutable content, which no re-arm
 * can change (sentinel issue 157: a candidate R79 produced edits paths R80
 * protects). It is parked ONCE as the runtime's explicit owner-gated block
 * (`BASE_REFRESH_REFUSED_PREFIX`, the original message kept after it), in the
 * same CAS write that restores the pull-request binding the terminal block
 * detached, when the same native publication facts verify it; an unverified
 * publication is parked without a binding and bound by one later write once
 * it verifies, never fabricated. Every owner-gated park (launcher- or
 * runtime-written) is then named on every pass
 * (`refresh:<id>:owner_required:pr=<n|unverified>`) and never rewritten. No
 * pull request is closed, no branch deleted, nothing pushed or charged.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import { HOSTED_RUNTIME_ROLLOUT } from "../src/host/hosted-runtime-rollout.ts";
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
import {
  BASE_REFRESH_PRESERVE_DETAIL,
  baseRefreshRefusedMessage,
  isBaseRefreshRefusedPark,
} from "../src/repair/loop-base-refresh.ts";
import { reviewRoundsLeft } from "../src/repair/review-round-cap.ts";
import {
  candidateBranch,
  candidatePreservationRef,
} from "../src/repair/keys.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  hostedIssueKey,
} from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import {
  ciFirstRuntimeProven,
  ciFirstSelfInstalledRuntimeProven,
  launcherLegacyCutoff,
  LEGACY_ROUND_REQUIRES_CI_FIRST,
  legacyFinalRoundAdmissible,
} from "./hosted-autonomy-ci-first.ts";
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
    ...HOSTED_RUNTIME_ROLLOUT.refreshRearm,
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
    // Generation 80 (R80, which keeps the base-edge bound), pinned by its
    // launcher commit at 1792256700000.
    {
      revision: "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481",
      activatedNotBefore: 1792256700000,
    },
    // Generation 81 (R81), bound before publication and first activation.
    {
      revision: "da98f5f49c45b57cfa97a45fe647c36b1021f302",
      activatedNotBefore: 1792299493000,
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
  | { kind: "park"; pr: number | null }
  | { kind: "bind"; pr: number }
  | { kind: "owner"; pr: number | null }
  | { kind: "retain"; reason: string }
  | null;

interface Runtime {
  /** The installed revision is allowlisted as corrected. */
  fixed: boolean;
  /** refreshFixActivation of the installed custody. */
  activation: number | null;
  /** The installed runtime is a proven CI-first runtime. */
  ciFirst: boolean;
  /** The launcher's legacy review cutoff (`launcherLegacyCutoff`). */
  legacyCutoff: number | null;
}

/** The exact preserved, published candidate shape a re-arm or binding needs. */
async function publishedShape(record: WorkRecordV1): Promise<boolean> {
  const head = record.target.head;
  const state = record.target.candidateState;
  const preserved = state?.preserved ?? null;
  return head !== null && record.target.branch === candidateBranch(record.id) &&
    preserved !== null && preserved.head === head &&
    preserved.base === record.target.base && state?.publishedHead === head &&
    preserved.ref.startsWith(HEADS) &&
    preserved.ref === await candidatePreservationRef(
        record.repository,
        record.id,
        preserved.operationKey,
      );
}

/**
 * The record's exact open publication, verified from its OWN repository
 * surface: the managed branch and the preservation ref both at the exact
 * head, exactly one open pull request from that branch by a trusted author
 * against the configured base, at that head. The pull-request number, or the
 * closed reason it does not verify (never a guessed number).
 */
async function verifiedPull(
  context: HostedAutonomyPassContextV1,
  record: WorkRecordV1,
): Promise<number | string> {
  if (!await publishedShape(record)) return "shape";
  const head = record.target.head!;
  const branch = record.target.branch!;
  const preserved = record.target.candidateState!.preserved!;
  const scope = await context.scopeFor(record.repository);
  const surface = scope.surface;
  const listing = surface?.mismatchDisposition;
  if (!surface || !listing || scope.baseBranch === null) return "surface";
  const tip = async (ref: string) => {
    try {
      return await surface.readBaseTip(ref);
    } catch {
      return null;
    }
  };
  if (await tip(branch) !== head) return "branch";
  if (await tip(preserved.ref.slice(HEADS.length)) !== head) {
    return "preservation_ref";
  }
  let pulls: Awaited<ReturnType<typeof listing.listPullsByHead>> = null;
  try {
    pulls = await listing.listPullsByHead(branch);
  } catch {
    pulls = null;
  }
  const open =
    pulls?.filter((row) => row.state === "open" && row.head === branch) ?? [];
  if (pulls === null || open.length !== 1) return "pull_listing";
  const pull = await context.readPull(scope, open[0]!.number);
  if (
    pull === null || pull.number !== open[0]!.number ||
    pull.state !== "open" || pull.merged !== false ||
    pull.headSha !== head || pull.baseRef !== scope.baseBranch ||
    pull.author === null ||
    !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)
  ) return "pull";
  return pull.number;
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
    record.intent !== null || blocker?.kind !== "other"
  ) return null;
  const parked = isBaseRefreshRefusedPark(blocker.message);
  if (!parked && !REFUSED_REFRESH.test(blocker.message)) return null;
  const issue = record.related.issueNumber;
  if (
    record.source.kind !== "issue" || issue === null ||
    context.closedIssues.has(hostedIssueKey(record.repository, issue))
  ) return null;
  // An owner-gated park is named on every pass. Its binding is restored by
  // one write once the publication verifies, and is never re-read after.
  if (parked) {
    if (record.target.pr !== null) {
      return { kind: "owner", pr: record.target.pr };
    }
    const pr = await verifiedPull(context, record);
    return typeof pr === "number"
      ? { kind: "bind", pr }
      : { kind: "owner", pr: null };
  }
  // The corrected validator's own refusal (at or after its activation, or
  // with no provable activation) is a verdict no re-arm can change: it is
  // parked for the owner, whatever its review rounds, with the binding the
  // terminal block detached restored when it verifies.
  if (
    runtime.fixed &&
    (runtime.activation === null || blocker.since >= runtime.activation)
  ) {
    if (record.target.pr !== null) {
      return { kind: "park", pr: record.target.pr };
    }
    const pr = await verifiedPull(context, record);
    return { kind: "park", pr: typeof pr === "number" ? pr : null };
  }
  // The re-armed delivery refreshes onto the moved base, and the refreshed
  // head needs a review round of its own: with none left (the hard ceiling,
  // owner decision 2026-10-16) the record stays blocked, before any read.
  if (
    reviewRoundsLeft(context.snapshot, record, runtime.legacyCutoff) === 0
  ) {
    return { kind: "retain", reason: "review_rounds_spent" };
  }
  // A legacy record's one final round is spent only on a green head,
  // which only a proven CI-first runtime guarantees.
  if (!legacyFinalRoundAdmissible(context.snapshot, record, runtime.ciFirst)) {
    return { kind: "retain", reason: LEGACY_ROUND_REQUIRES_CI_FIRST };
  }
  if (record.target.pr !== null || !await publishedShape(record)) {
    return { kind: "retain", reason: "shape" };
  }
  if (!runtime.fixed) return { kind: "retain", reason: "runtime" };
  if (now - blocker.since < REFRESH_REARM_PACING_MS) {
    return { kind: "retain", reason: "pacing" };
  }
  const pr = await verifiedPull(context, record);
  return typeof pr === "number"
    ? { kind: "rearm", pr }
    : { kind: "retain", reason: pr };
}

/**
 * The one owner-gated write of a record. A park keeps the record blocked with
 * no intent or wait, replaces only the blocker (the runtime's owner-gated
 * prefix, the original message after it) and restores a verified binding; a
 * binding sets only the verified `target.pr` of an existing park. Candidate,
 * counters, evidence and every charge are untouched.
 */
function ownerWrite(
  record: WorkRecordV1,
  own: { kind: "park" | "bind"; pr: number | null },
  now: number,
): WorkRecordV1 {
  const pr = own.pr ?? record.target.pr;
  return {
    ...record,
    ...(own.kind === "park"
      ? {
        blocker: {
          kind: "other" as const,
          message: baseRefreshRefusedMessage(record.blocker!.message),
          since: now,
        },
      }
      : {}),
    target: { ...record.target, pr },
    updatedAt: now,
  };
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
    ciFirst: ciFirstRuntimeProven(installed) ||
      ciFirstSelfInstalledRuntimeProven(installed),
    legacyCutoff: context.deps.legacyReviewCutoff !== undefined
      ? context.deps.legacyReviewCutoff
      : launcherLegacyCutoff(
        installed,
        ciFirstRuntimeProven(installed) ||
          ciFirstSelfInstalledRuntimeProven(installed),
        release,
      ),
  };
  const rearmed = new Map<string, number>();
  /** Owner-gated parks and late bindings this pass writes, by record id. */
  const owned = new Map<
    string,
    Exclude<Verdict, null> & { kind: "park" | "bind" }
  >();
  for (const record of snapshot.work) {
    // A record an earlier write of this pass touched waits for the next pass.
    if (context.settled?.has(record.id)) continue;
    const verdict = await judge(context, record, runtime, now);
    if (verdict === null) continue;
    if (verdict.kind === "retain") {
      actions.push(`refresh:${record.id}:retained:${verdict.reason}`);
      continue;
    }
    if (verdict.kind === "owner") {
      actions.push(
        `refresh:${record.id}:owner_required:pr=${verdict.pr ?? "unverified"}`,
      );
      continue;
    }
    if (verdict.kind === "park" || verdict.kind === "bind") {
      owned.set(record.id, verdict);
      continue;
    }
    rearmed.set(record.id, verdict.pr);
  }
  if (rearmed.size === 0 && owned.size === 0) return null;
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
        const own = owned.get(record.id);
        if (own !== undefined) return ownerWrite(record, own, now);
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
  for (const [id, own] of owned) {
    actions.push(
      own.kind === "park"
        ? `refresh:${id}:owner_parked:pr=${own.pr ?? "unverified"}`
        : `refresh:${id}:owner_bound:pr=${own.pr}`,
    );
  }
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
