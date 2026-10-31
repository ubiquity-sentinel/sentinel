/** Only the App's own verified merge of the exact head gets a follow-up. */
import assert from "node:assert/strict";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { runHostedFollowUpPass } from "../../ops/hosted-autonomy-follow-up-pass.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedFollowUpIssuesV1,
  HostedIssueListingItemV1,
} from "../../ops/hosted-autonomy-types.ts";
import {
  allLiveReceipts,
  APP,
  liveRecord,
  liveRequest,
  liveSnapshot,
  NOW,
  TIP,
} from "./hosted-autonomy-spent-fixtures.ts";

const repository = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 155687488,
};
const base = liveRequest(1052);
const request = {
  ...base,
  target: { ...base.target, repository },
} as typeof base;
const live = {
  ...allLiveReceipts().find((row) =>
    row.id === request.source.reviewReceiptId
  )!,
  repository,
};
const receipt = parseReviewReceiptV1(live);
const merged: HostedAutonomyPullV1 = {
  number: 1052,
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
};

interface FakeV1 {
  port: HostedFollowUpIssuesV1;
  created: { title: string; body: string; labels?: readonly string[] }[];
  issues: HostedIssueListingItemV1[];
}

function fake(): FakeV1 {
  const state: FakeV1 = {
    created: [],
    issues: [],
    port: {
      listCreatedSince: () => Promise.resolve([...state.issues]),
      readIssueOrigin: () =>
        Promise.resolve({ number: 600, author: "0x4007", firstLine: "issue" }),
      create: (input) => {
        state.created.push(input);
        const number = 5000 + state.created.length;
        state.issues.push({
          number,
          author: APP,
          createdAt: NOW,
          pullRequest: false,
          firstLine: input.body.split("\n", 1)[0],
        });
        return Promise.resolve(number);
      },
    },
  };
  return state;
}

function deps(
  state: FakeV1,
  pull: HostedAutonomyPullV1,
): HostedAutonomyDepsV1 {
  const surface = {
    readDefaultBranch: () => Promise.resolve("development"),
    readPull: () => Promise.resolve(pull),
    followUpIssues: state.port,
  } as unknown as HostedAutonomyGitHubV1;
  return {
    state: {
      readRepair: () =>
        Promise.resolve({
          ok: true,
          value: {
            status: "found",
            head: TIP,
            snapshot: liveSnapshot([liveRecord(600)], [receipt], [request]),
          },
        }),
    },
    githubFor: () => surface,
    clock: { now: () => NOW },
  } as unknown as HostedAutonomyDepsV1;
}

Deno.test("follow-ups F5: only the App's own verified merge of the exact head gets a follow-up", async (t) => {
  const cases: [string, Partial<HostedAutonomyPullV1>][] = [
    ["merged by the owner", { mergedBy: "0x4007" }],
    ["another merge commit", { mergeCommitSha: "2".repeat(40) }],
    ["another head", { headSha: "3".repeat(40) }],
    ["not merged", { merged: false, state: "open", mergeCommitSha: null }],
    ["untrusted author", { author: "someone" }],
    ["not on the base branch", { revisionOnBaseBranch: false }],
    ["another base branch", { baseRef: "main" }],
  ];
  for (const [name, overrides] of cases) {
    await t.step(name, async () => {
      const state = fake();
      const actions = await runHostedFollowUpPass(
        deps(state, { ...merged, ...overrides }),
      );
      assert.deepEqual(actions, [
        `followup:${request.id}:pr=1052:merge_unverified`,
      ]);
      assert.equal(state.created.length, 0);
    });
  }
});
