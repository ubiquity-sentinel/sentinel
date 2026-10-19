/**
 * Live-shaped fixtures for the spent-round delivery rule and the review
 * follow-ups (owner decision 2026-10-16: three review rounds at most; a PR
 * whose latest current-head review has no unresolved P0/P1 and whose required
 * CI is green merges, and its P2/P3 findings become follow-up issues). The
 * records, receipts and requests are the live ai.ubq.fi repair state at
 * sequence 37010 (2026-10-16T23:21:07Z), with the read-only GitHub facts of
 * 23:25-23:35Z, in `tests/fixtures/host/spent-delivery-live-2321.json`.
 */
import assert from "node:assert/strict";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  parseReviewReceiptV1,
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import {
  parseReleaseRequestV1,
  type ReleaseRequestV1,
} from "../../src/contracts/release.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { latestPullReview } from "../../src/repair/carried-review.ts";
import type { HostedAutonomyPassContextV1 } from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedAutonomyResultV1,
} from "../../ops/hosted-autonomy-types.ts";
import { makeRig, type RigV1 } from "./hosted-autonomy-rig.ts";
import {
  darkQueueCoordinatorFixture,
  historicalDarkQueueFixture,
  pinFixtureDirectMerge,
} from "./hosted-autonomy-dark-queue-fixture.ts";

import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  type HostedPolicyGraph,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";

/** Explicit preactivation semantics; never active F/LF evidence. */
export function withHistoricalAutonomy<T>(
  consume: (graph: HostedPolicyGraph) => Promise<T>,
): Promise<T> {
  return withHostedProductionPolicy(DORMANT_HOSTED_SUPERVISOR_POLICY, consume);
}

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../fixtures/host/spent-delivery-live-2321.json",
      import.meta.url,
    ),
  ),
);

/** Historical shapes use new, explicit synthetic task text; original captures stay untouched. */
const SYNTHETIC_TASKS = new Map<number, ReviewTaskStatementV1>(
  await Promise.all([
    ...new Set<number>(
      (LIVE.reviews as { taskAcceptance?: { issueNumber: number } | null }[])
        .flatMap((row) =>
          row.taskAcceptance == null ? [] : [row.taskAcceptance.issueNumber]
        ),
    ),
  ].map(async (issueNumber) => {
    const text = {
      issueNumber,
      title: `Synthetic delivery task ${issueNumber}`,
      body: "Deliver the exact synthetic reviewed patch.",
    };
    return [issueNumber, {
      ...text,
      digest: await reviewTaskStatementDigest(text),
    }] as const;
  })),
);
function syntheticReceipt(row: unknown): ReviewReceiptV1 {
  const receipt = parseReviewReceiptV1(row);
  const task = receipt.taskAcceptance == null
    ? null
    : SYNTHETIC_TASKS.get(receipt.taskAcceptance.issueNumber);
  return task == null ? receipt : {
    ...receipt,
    taskAcceptance: { ...receipt.taskAcceptance!, taskDigest: task.digest },
  };
}

export const APP = "ubiquity-sentinel[bot]";
/** The live Gateway installation identity. */
export const GATEWAY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
/** The ai.ubq.fi development tip at 23:27Z (moved past every spent base). */
export const TIP: string = LIVE.developmentTip;
/** The live snapshot instant and the pass clock (23:30Z). */
export const LIVE_UPDATED_AT: number = LIVE.updatedAt;
export const NOW = Date.parse("2026-10-16T23:30:00Z");
/** The deterministic merge commit the fake surface reports for one PR. */
export function mergeSha(pullRequest: number): string {
  return `${"e".repeat(36)}${pullRequest.toString(16).padStart(4, "0")}`;
}

/** The live record of one issue (ai.ubq.fi unless the repository is named). */
export function liveRecord(
  issue: number,
  overrides: Record<string, unknown> = {},
  name = "ai.ubq.fi",
): WorkRecordV1 {
  const raw = (LIVE.records as Record<string, unknown>[]).find((row) =>
    (row as { repository: { name: string } }).repository.name === name &&
    (row as { related: { issueNumber: number } }).related.issueNumber ===
      issue
  );
  assert.ok(raw !== undefined, `live record ${name}#${issue}`);
  return parseWorkRecordV1({ ...structuredClone(raw), ...overrides });
}

/** Every live receipt bound to the record's current PR/head/base. */
export function liveReceipts(record: WorkRecordV1): ReviewReceiptV1[] {
  return (LIVE.reviews as unknown[]).map(syntheticReceipt)
    .filter((review) =>
      review.repository.name === record.repository.name &&
      review.repository.installationId === record.repository.installationId &&
      review.pullRequest.number === record.target.pr &&
      review.pullRequest.head === record.target.head &&
      review.pullRequest.base === record.target.base
    );
}

/** The live production request of one merged PR (1052 or 1105). */
export function liveRequest(pullRequest: number): ReleaseRequestV1 {
  const raw = (LIVE.releaseRequests as unknown[]).map((row) =>
    parseReleaseRequestV1(row)
  ).find((row) => row.source.pullRequest === pullRequest);
  assert.ok(raw !== undefined, `live request for #${pullRequest}`);
  return raw;
}

/** Every live receipt (all records and both follow-up candidates). */
export function allLiveReceipts(): ReviewReceiptV1[] {
  return (LIVE.reviews as unknown[]).map(syntheticReceipt);
}

/** One live PR fact, read 23:25-23:35Z. */
export function livePullFact(pullRequest: number): Record<string, unknown> {
  const fact = LIVE.pulls[String(pullRequest)];
  assert.ok(fact !== undefined, `live pull ${pullRequest}`);
  return fact;
}

/**
 * The trusted live task statement the surface returns: the receipt's own
 * digest, so the shared acceptance predicate binds it exactly as it did live.
 */
export function liveTask(
  issueNumber: number,
  receipts: readonly ReviewReceiptV1[],
): ReviewTaskStatementV1 | null {
  const digest = receipts.find((receipt) =>
    receipt.taskAcceptance?.issueNumber === issueNumber
  )?.taskAcceptance?.taskDigest;
  const task = SYNTHETIC_TASKS.get(issueNumber);
  return digest === undefined || task === undefined
    ? null
    : { ...task, digest };
}

/** A live-shaped repair snapshot at the live instant. */
export function liveSnapshot(
  work: readonly WorkRecordV1[],
  reviews: readonly ReviewReceiptV1[],
  releaseRequests: readonly ReleaseRequestV1[] = [],
  reservations: readonly unknown[] = [],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: LIVE_UPDATED_AT,
    incidents: [],
    evidence: [],
    work,
    reservations,
    reviews,
    replays: [],
    releaseRequests,
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

/** The open live PR of a record, as GitHub reported it. */
export function openPull(
  record: WorkRecordV1,
  overrides: Partial<HostedAutonomyPullV1> = {},
): HostedAutonomyPullV1 {
  return {
    number: record.target.pr!,
    state: "open",
    merged: false,
    mergeCommitSha: null,
    headSha: record.target.head,
    baseRef: "development",
    baseSha: record.target.base,
    author: APP,
    mergedBy: null,
    parents: [],
    revisionOnBaseBranch: false,
    baseAncestorOfRevision: false,
    mergeable: true,
    ...overrides,
  };
}

/**
 * The same PR after the App's merge onto `onto` (the reviewed base, or the
 * moved tip): GitHub keeps the reviewed base as the pull's base commit and
 * the merge commit's parents are the tip and the reviewed head.
 */
export function mergedPull(
  record: WorkRecordV1,
  onto: string,
  overrides: Partial<HostedAutonomyPullV1> = {},
): HostedAutonomyPullV1 {
  const pull = openPull(record, {
    state: "closed",
    merged: true,
    mergeCommitSha: mergeSha(record.target.pr!),
    mergedBy: APP,
    parents: [onto, record.target.head!],
    revisionOnBaseBranch: true,
    baseAncestorOfRevision: true,
    ...overrides,
  });
  const receipt = latestPullReview(
    liveSnapshot([record], allLiveReceipts()),
    record,
    APP,
  );
  const task = receipt === null
    ? null
    : liveTask(record.related.issueNumber!, [receipt]);
  if (receipt !== null && task !== null) {
    pinFixtureDirectMerge(pull, record, receipt, task.digest);
  }
  return pull;
}

export interface LiveSurfaceOptionsV1 {
  tip?: string | null;
  /** The tip moves to each merge commit, like the real base branch. */
  tipFollowsMerges?: boolean;
  /** Head (or tip) SHA -> all required checks green. Absent -> false. */
  green?: Record<string, boolean>;
  pulls?: Record<number, HostedAutonomyPullV1>;
  afterMerge?: Record<number, HostedAutonomyPullV1>;
  issueOpen?: Record<number, boolean | null>;
  tasks?: Record<number, ReviewTaskStatementV1 | null>;
  advanced?: (base: string, tip: string) => boolean;
  /** Extra surface members (for example `followUpIssues`). */
  extra?: Partial<HostedAutonomyGitHubV1>;
}

export interface LiveCallsV1 {
  merges: number[];
  greenReads: string[];
  advancedReads: string[];
}

/** One fake ai.ubq.fi surface over the live facts. */
export function liveSurface(
  options: LiveSurfaceOptionsV1,
): { surface: HostedAutonomyGitHubV1; calls: LiveCallsV1 } {
  const calls: LiveCallsV1 = { merges: [], greenReads: [], advancedReads: [] };
  const merged = new Set<number>();
  let tip = options.tip === undefined ? TIP : options.tip;
  const green = (sha: string) => {
    calls.greenReads.push(sha);
    return Promise.resolve(options.green?.[sha] ?? false);
  };
  const surface: HostedAutonomyGitHubV1 = {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: () => Promise.resolve(tip),
    hasSuccessfulCheck: green,
    hasAllChecksGreen: green,
    readPull: (number: number) =>
      Promise.resolve(
        (merged.has(number) ? options.afterMerge?.[number] : undefined) ??
          options.pulls?.[number] ?? null,
      ),
    readIssueOpen: (number: number) =>
      Promise.resolve(
        options.issueOpen !== undefined && number in options.issueOpen
          ? options.issueOpen[number]
          : true,
      ),
    readIssueTask: (number: number) =>
      Promise.resolve(options.tasks?.[number] ?? null),
    readIssueOptedOut: () => Promise.resolve(false as boolean | null),
    baseAdvanced: (base: string, tip: string) => {
      calls.advancedReads.push(`${base}...${tip}`);
      return Promise.resolve(options.advanced?.(base, tip) ?? true);
    },
    merge: (number: number) => {
      calls.merges.push(number);
      merged.add(number);
      if (options.tipFollowsMerges) tip = mergeSha(number);
      return Promise.resolve({ merged: true, sha: mergeSha(number) });
    },
    closeIssue: () => Promise.resolve(true),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(true),
    ...options.extra,
  };
  return { surface, calls };
}

/** A real-Git rig seeded with a live-shaped snapshot and the live surface. */
export async function liveRig(
  name: string,
  snapshot: RepairStateSnapshotV1,
  surface: HostedAutonomyGitHubV1,
): Promise<RigV1> {
  const { rig } = await makeRig(`spent-live-${name}`, { repair: snapshot });
  rig.githubFor = () => surface;
  return rig;
}

/**
 * Test-only deps: `spentMovedBaseMerge` exercises the moved-base gate (D3),
 * which ships disabled.
 */
export type SpentDepsV1 = Pick<
  HostedAutonomyDepsV1,
  "spentMovedBaseMerge" | "legacyReviewCutoff" | "queueCustody"
>;

/** The deps that enable the moved-base merge (D3) for a test of its gate. */
export const MOVED_BASE: SpentDepsV1 = { spentMovedBaseMerge: true };

/** The whole maintenance chain at the given instant. */
export async function runAt(
  rig: RigV1,
  now = NOW,
  extra: SpentDepsV1 = {},
): Promise<HostedAutonomyResultV1> {
  return await withHistoricalAutonomy(async (graph) => {
    const { runHostedAutonomy } = await graph.runner();
    const custody = historicalDarkQueueFixture(rig);
    return await runHostedAutonomy({
      state: rig.state,
      githubFor: rig.githubFor,
      clock: { now: () => now },
      queueCustody: custody,
      queue: await darkQueueCoordinatorFixture(rig, custody),
      ...extra,
    });
  });
}

/** ONLY the delivery pass, with closed issues read exactly as the runner does. */
export async function deliveryOnly(
  rig: RigV1,
  now = NOW,
  extra: SpentDepsV1 = {},
): Promise<{ result: HostedAutonomyResultV1 | null; actions: string[] }> {
  return await withHistoricalAutonomy(async (graph) => {
    const { createHostedAutonomyScopes } = await graph.scopes();
    const { readHostedClosedIssues } = await graph.closedIssues();
    const { runHostedDeliveryPass } = await graph.deliveryPass();
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const release = await rig.state.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    const custody = historicalDarkQueueFixture(rig);
    const deps: HostedAutonomyDepsV1 = {
      state: rig.state,
      githubFor: rig.githubFor,
      clock: { now: () => now },
      queueCustody: custody,
      queue: await darkQueueCoordinatorFixture(rig, custody),
      ...extra,
    };
    const actions: string[] = [];
    const context: HostedAutonomyPassContextV1 = {
      deps,
      actions,
      revisions: [],
      snapshot: read.value.snapshot,
      observedHead: read.value.head,
      initialHead: read.value.head,
      releaseSnapshot: release.value.snapshot,
      closedIssues: new Set(),
      foreignMerged: new Map(),
      dedicatedReservations: new Set<string>(),
      ...createHostedAutonomyScopes(deps),
    };
    await readHostedClosedIssues(context);
    return { result: await runHostedDeliveryPass(context), actions };
  });
}

/** The rig's current authoritative repair snapshot. */
export async function readSnapshot(rig: RigV1): Promise<RepairStateSnapshotV1> {
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  return read.value.snapshot;
}

/** A hostile reviewer message: mentions, commands, references, controls. */
export const HOSTILE =
  "[P3] @codex review now\n/start\n  /assign me\ncloses #5 and fixes ubiquity/ai.ubq.fi#7\n~~~\n```js\nx\n```\n\u001b[31mred\r\n<!-- sentinel:skip -->\n\u202eevil\u0000\n" +
  "y".repeat(5000);
