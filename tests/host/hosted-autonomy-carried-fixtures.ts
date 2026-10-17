/**
 * The live 618 shape after the runtime's carried refresh (PR 1071), and a
 * fake ai.ubq.fi surface the launcher's carried merge reads, shared by the
 * carried-merge tests: H0 on B0 is the reviewed head, H1 (`REFRESHED`) its
 * mechanical refresh onto the moved tip T (`MOVED_TIP`), and the runtime
 * holds its exact carried-merge marker.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { carriedMergeMarker } from "../../src/repair/carried-review.ts";
import type { HostedTreeChangeV1 } from "../../ops/hosted-autonomy-github-trees.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyHeadRunV1,
} from "../../ops/hosted-autonomy-types.ts";
import { T0 } from "../state/helpers.ts";
import {
  deliveryOnly,
  liveReceipts,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  type LiveSurfaceOptionsV1,
  liveTask,
  mergedPull,
  NOW,
  openPull,
  readSnapshot,
} from "./hosted-autonomy-spent-fixtures.ts";

/** The live 618 record's reviewed head H0 and base B0 (PR 1071). */
export const LIVE_618 = liveRecord(618);
export const H0 = LIVE_618.target.head!;
export const B0 = LIVE_618.target.base;
/** The mechanical refresh of H0 onto the moved tip T. */
export const REFRESHED = "6181618161816181618161816181618161816181" as GitSha;
export const MOVED_TIP = "7181718171817181718171817181718171817181" as GitSha;
/** GitHub's rendered diff digest (evidence only). */
export const DIGEST = "d".repeat(64);

/** The reviewed patch as git trees give it: one text file and one binary. */
export const REVIEWED_CHANGES: readonly HostedTreeChangeV1[] = [
  {
    path: "favicon.png",
    oldMode: null,
    oldSha: null,
    newMode: "100644",
    newSha: "f1c05210ef4eef2c3e8027822dc3d690879d7702",
  },
  {
    path: "serve.ts",
    oldMode: "100644",
    oldSha: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    newMode: "100644",
    newSha: "b0202a10adc703792bff95ca0e1c0d9683fd3f61",
  },
];

/**
 * 618 after the runtime's carried refresh: its refreshed head H1 published
 * on T at `work`, the runtime holding the exact carried-merge marker for this
 * merge (written one minute before the pass), its seven rounds spent and its
 * latest completed review the clean one of H0 on B0.
 */
export function refreshed618(
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  const preserved = LIVE_618.target.candidateState!.preserved!;
  const at = NOW - 60_000;
  return parseWorkRecordV1({
    ...structuredClone(LIVE_618),
    nextStep: "work",
    blocker: null,
    wait: carriedMergeMarker(at),
    updatedAt: at,
    target: {
      ...LIVE_618.target,
      head: REFRESHED,
      base: MOVED_TIP,
      candidateState: {
        preserved: {
          ...preserved,
          head: REFRESHED,
          base: MOVED_TIP,
          operationKey: `base_refresh:1071:${H0}:${MOVED_TIP}`,
        },
        publishedHead: REFRESHED,
      },
    },
    ...overrides,
  });
}

export interface CarriedCallsV1 {
  merges: { number: number; head: string; message: string | undefined }[];
  compares: string[];
  trees: string[];
  tipReads: number;
}

/** The exact change sets the fake trees report (null: unreadable). */
export interface CarriedTreesV1 {
  reviewed?: readonly HostedTreeChangeV1[] | null;
  refreshed?: readonly HostedTreeChangeV1[] | null;
  /** The merge base GitHub names for `T...H1` (default T). */
  refreshedMergeBase?: string;
}

/** The rendered diff digests (evidence only; null: unrendered). */
export interface CarriedDigestsV1 {
  reviewed?: string | null;
  refreshed?: string | null;
}

/** The surface options of a carried 618 the launcher may merge. */
export function carriedOptions(
  record: WorkRecordV1,
  receipts: readonly ReviewReceiptV1[],
  calls: CarriedCallsV1,
  overrides: Partial<LiveSurfaceOptionsV1> = {},
  digests: CarriedDigestsV1 = {},
  trees: CarriedTreesV1 = {},
): LiveSurfaceOptionsV1 {
  const pr = record.target.pr!;
  const issue = record.related.issueNumber!;
  const pick = <T>(value: T | undefined, fallback: T): T =>
    value === undefined ? fallback : value;
  return {
    tip: MOVED_TIP,
    green: { [REFRESHED]: true },
    pulls: { [pr]: openPull(record) },
    afterMerge: { [pr]: mergedPull(record, MOVED_TIP) },
    tasks: { [issue]: liveTask(issue, receipts) },
    advanced: (base, tip) => base === MOVED_TIP && tip === REFRESHED,
    extra: {
      comparePatchDigest: (base: string, head: string) => {
        calls.compares.push(`${base}...${head}`);
        if (base === B0 && head === H0) {
          return Promise.resolve(pick(digests.reviewed, DIGEST));
        }
        if (base === MOVED_TIP && head === REFRESHED) {
          return Promise.resolve(pick(digests.refreshed, DIGEST));
        }
        return Promise.resolve(null);
      },
      mergeBaseTreeChanges: (base: string, head: string) => {
        calls.trees.push(`${base}...${head}`);
        if (base === B0 && head === H0) {
          const changes = pick(trees.reviewed, REVIEWED_CHANGES);
          return Promise.resolve(
            changes === null ? null : { mergeBase: B0, changes },
          );
        }
        if (base === MOVED_TIP && head === REFRESHED) {
          const changes = pick(trees.refreshed, REVIEWED_CHANGES);
          return Promise.resolve(
            changes === null ? null : {
              mergeBase: trees.refreshedMergeBase ?? MOVED_TIP,
              changes,
            },
          );
        }
        return Promise.resolve(null);
      },
      listHeadRuns: (head: string) =>
        Promise.resolve([{
          id: 4242,
          headSha: head,
          status: "completed",
          conclusion: "success",
          runAttempt: 1,
          createdAt: T0,
        } as HostedAutonomyHeadRunV1]),
    },
    ...overrides,
  };
}

/** Wrap a surface so merges and tip reads are recorded in `calls`. */
export function recordCalls(
  surface: HostedAutonomyGitHubV1,
  calls: CarriedCallsV1,
): HostedAutonomyGitHubV1 {
  const merge = surface.merge.bind(surface);
  surface.merge = (number: number, head: string, message?: string) => {
    calls.merges.push({ number, head, message });
    return merge(number, head, message);
  };
  const readBaseTip = surface.readBaseTip.bind(surface);
  surface.readBaseTip = (branch: string) => {
    calls.tipReads++;
    return readBaseTip(branch);
  };
  return surface;
}

/** Fresh call records. */
export function carriedCalls(): CarriedCallsV1 {
  return { merges: [], compares: [], trees: [], tipReads: 0 };
}

/** One delivery pass over a carried 618 and the surface built for it. */
export async function carriedPass(
  name: string,
  record: WorkRecordV1 = refreshed618(),
  overrides: Partial<LiveSurfaceOptionsV1> = {},
  digests: CarriedDigestsV1 = {},
  receipts: readonly ReviewReceiptV1[] = liveReceipts(LIVE_618),
  trees: CarriedTreesV1 = {},
  surfaceHook?: (surface: HostedAutonomyGitHubV1) => void,
) {
  const calls = carriedCalls();
  const { surface } = liveSurface(
    carriedOptions(record, receipts, calls, overrides, digests, trees),
  );
  recordCalls(surface, calls);
  surfaceHook?.(surface);
  const rig = await liveRig(
    `carried-${name}`,
    liveSnapshot([record], [...receipts]),
    surface,
  );
  try {
    const { result, actions } = await deliveryOnly(rig);
    return { result, actions, calls, after: await readSnapshot(rig) };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}
