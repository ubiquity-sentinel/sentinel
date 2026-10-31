/**
 * Shared harness for the review follow-up suites: the live delivered records,
 * an App-bound follow-up issue port and one full maintenance run.
 */
import {
  darkQueueCoordinatorFixture,
  historicalDarkQueueFixture,
} from "./hosted-autonomy-dark-queue-fixture.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  parseReviewReceiptV1,
  type ReviewReceiptV1,
} from "../../src/contracts/review-receipt.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedFollowUpIssuesV1,
  HostedIssueListingItemV1,
  HostedIssueOriginV1,
} from "../../ops/hosted-autonomy-types.ts";
import {
  allLiveReceipts,
  APP,
  liveRecord,
  liveRequest,
  liveRig,
  liveSnapshot,
  liveSurface,
  liveTask,
  NOW,
  runAt,
  TIP,
  withHistoricalAutonomy,
} from "./hosted-autonomy-spent-fixtures.ts";

/** This suite preserves historical preactivation follow-up semantics. */
export function runHistoricalFollowUps(
  deps: HostedAutonomyDepsV1,
): Promise<string[]> {
  return withHistoricalAutonomy(async (graph) => {
    const { runHostedFollowUpPass } = await graph.followUpPass();
    return await runHostedFollowUpPass(deps);
  });
}

/** A direct, runner-free follow-up pass over fake GitHub facts. */
export interface DirectFollowUpV1 {
  requests: readonly ReleaseRequestV1[];
  reviews: readonly ReviewReceiptV1[];
  records?: readonly WorkRecordV1[];
  pulls: Record<number, HostedAutonomyPullV1>;
  issues: FakeIssuesV1;
  now?: () => number;
}

/** Deps for `runHostedFollowUpPass` without the maintenance runner. */
export function directFollowUpDeps(
  input: DirectFollowUpV1,
): HostedAutonomyDepsV1 {
  const surface = {
    readDefaultBranch: () => Promise.resolve("development"),
    readPull: (number: number) => Promise.resolve(input.pulls[number] ?? null),
    followUpIssues: input.issues.port,
  } as unknown as HostedAutonomyGitHubV1;
  return {
    state: {
      readRepair: () =>
        Promise.resolve({
          ok: true,
          value: {
            status: "found",
            head: TIP,
            snapshot: liveSnapshot(
              input.records ?? [],
              input.reviews,
              input.requests,
            ),
          },
        }),
    },
    githubFor: () => surface,
    clock: { now: input.now ?? (() => NOW) },
  } as unknown as HostedAutonomyDepsV1;
}

/** Clone the two live requests and their receipts onto one ordinary repo. */
export function cloneLiveFollowUps(): {
  repository: { owner: string; name: string; installationId: number };
  requests: ReleaseRequestV1[];
  reviews: ReviewReceiptV1[];
} {
  const repository = {
    owner: "ubiquity",
    name: "passport.ubq.fi",
    installationId: 155687488,
  };
  return {
    repository,
    requests: [liveRequest(1052), liveRequest(1105)].map((request) => ({
      ...request,
      target: { ...request.target, repository },
    })),
    reviews: allLiveReceipts().map((receipt) =>
      parseReviewReceiptV1({ ...receipt, repository })
    ),
  };
}

export const FINDING_1052 =
  "dffaff566223605af1f23144f775164c6c11312e82778382d3f56d3655c9ccb1";
export const FINDING_1105 =
  "eb92d0d973fdbaadaa9966b2dfeb36a8861d25ab4d1b38733b5d277262485d54";
export const FIRST_LINE_1052 =
  "<!-- sentinel:review-followup:v1 repo=ubiquity/passport.ubq.fi pr=1052 receipt=review-receipt:171aed7474c3730b3b721967dcbe14d7623da6f67e5e70e6a48e0967ba602eb7 depth=1 -->";
export const FIRST_LINE_1052_V2 =
  `<!-- sentinel:review-followup:v2 repo=ubiquity/passport.ubq.fi pr=1052 receipt=review-receipt:171aed7474c3730b3b721967dcbe14d7623da6f67e5e70e6a48e0967ba602eb7 finding=${FINDING_1052} depth=1 -->`;
export const FIRST_LINE_1105 =
  "<!-- sentinel:review-followup:v1 repo=ubiquity/passport.ubq.fi pr=1105 receipt=review-receipt:44fd1a26189b99c0d752b4b157d445c431e96f7e0761dd3cbdaaaba5eed581a4 depth=1 -->";
export const FIRST_LINE_1105_V2 =
  `<!-- sentinel:review-followup:v2 repo=ubiquity/passport.ubq.fi pr=1105 receipt=review-receipt:44fd1a26189b99c0d752b4b157d445c431e96f7e0761dd3cbdaaaba5eed581a4 finding=${FINDING_1105} depth=1 -->`;

/** The App's own verified merge of one request's exact head. */
export function requestPull(
  request: ReleaseRequestV1,
  overrides: Partial<HostedAutonomyPullV1> = {},
): HostedAutonomyPullV1 {
  return {
    number: request.source.pullRequest,
    state: "closed",
    merged: true,
    mergeCommitSha: request.revision,
    headSha: request.source.head,
    baseRef: "development",
    baseSha: request.source.base,
    author: APP,
    mergedBy: APP,
    parents: ["1".repeat(40), request.source.head],
    revisionOnBaseBranch: true,
    baseAncestorOfRevision: true,
    mergeable: null,
    ...overrides,
  };
}

export interface FakeIssuesV1 {
  port: HostedFollowUpIssuesV1;
  created: { title: string; body: string; labels?: readonly string[] }[];
  issues: HostedIssueListingItemV1[];
  listings: number;
}

/** An in-memory target tracker; a create appears in the next listing. */
export function fakeIssues(
  options: {
    issues?: HostedIssueListingItemV1[];
    listing?: "null" | "throw";
    createUnproven?: boolean;
    origins?: Record<number, HostedIssueOriginV1 | null>;
  } = {},
): FakeIssuesV1 {
  const fake: FakeIssuesV1 = {
    created: [],
    issues: [...(options.issues ?? [])],
    listings: 0,
    port: {
      listCreatedSince: () => {
        fake.listings++;
        if (options.listing === "throw") throw new Error("listing");
        if (options.listing === "null") return Promise.resolve(null);
        return Promise.resolve(
          [...fake.issues].sort((a, b) => b.createdAt - a.createdAt),
        );
      },
      readIssueOrigin: (number: number) =>
        Promise.resolve(
          options.origins !== undefined && number in options.origins
            ? options.origins[number]
            : { number, author: "0x4007", firstLine: "An ordinary issue" },
        ),
      create: (
        input: { title: string; body: string; labels?: readonly string[] },
      ) => {
        fake.created.push(input);
        const number = 5000 + fake.created.length;
        fake.issues.push({
          number,
          author: APP,
          createdAt: NOW,
          pullRequest: false,
          firstLine: input.body.split("\n", 1)[0],
        });
        return Promise.resolve(options.createUnproven ? null : number);
      },
    },
  };
  return fake;
}

/** The two live delivered records with their requests and receipts. */
export function liveDelivered(): {
  records: WorkRecordV1[];
  reviews: ReviewReceiptV1[];
  requests: ReleaseRequestV1[];
} {
  return {
    records: [liveRecord(592), liveRecord(600)],
    reviews: allLiveReceipts(),
    requests: [liveRequest(1052), liveRequest(1105)],
  };
}

export async function followUpRun(
  name: string,
  issues: FakeIssuesV1,
  options: {
    requests?: ReleaseRequestV1[];
    records?: WorkRecordV1[];
    reviews?: ReviewReceiptV1[];
    pulls?: Record<number, HostedAutonomyPullV1>;
    passes?: number;
    now?: () => number;
  } = {},
) {
  const live = liveDelivered();
  const requests = options.requests ?? live.requests;
  const pulls: Record<number, HostedAutonomyPullV1> = {};
  for (const request of requests) {
    pulls[request.source.pullRequest] = requestPull(request);
  }
  const { surface } = liveSurface({
    tip: TIP,
    pulls: { ...pulls, ...options.pulls },
    tasks: Object.fromEntries(
      live.records.map((
        row,
      ) => [
        row.related.issueNumber!,
        liveTask(row.related.issueNumber!, options.reviews ?? live.reviews),
      ]),
    ),
    extra: { followUpIssues: issues.port },
  });
  const rig = await liveRig(
    name,
    liveSnapshot(
      options.records ?? live.records,
      options.reviews ?? live.reviews,
      requests,
    ),
    surface,
  );
  try {
    const results = [];
    for (let pass = 0; pass < (options.passes ?? 1); pass++) {
      results.push(
        options.now === undefined
          ? await runAt(rig)
          : await withHistoricalAutonomy(async (graph) => {
            const { runHostedAutonomy } = await graph.runner();
            const custody = historicalDarkQueueFixture(rig);
            return await runHostedAutonomy({
              state: rig.state,
              githubFor: rig.githubFor,
              clock: { now: options.now! },
              queueCustody: custody,
              queue: await darkQueueCoordinatorFixture(rig, custody),
            });
          }),
      );
    }
    return { results, writes: rig.writes };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

export const followUps = (actions: readonly string[]) =>
  actions.filter((action) => action.startsWith("followup:"));

/** One listed issue or pull request of the fake created-since listing. */
export function listed(
  number: number,
  author: string,
  firstLine: string,
  pullRequest = false,
): HostedIssueListingItemV1 {
  return { number, author, createdAt: NOW - 60_000, pullRequest, firstLine };
}
