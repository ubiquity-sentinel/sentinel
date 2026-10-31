/** Follow-up depth ceiling and opt-out labels. */
import assert from "node:assert/strict";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { runHostedFollowUpPass } from "../../ops/hosted-autonomy-follow-up-pass.ts";
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
const pull: HostedAutonomyPullV1 = {
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

function fake(origin: HostedIssueOriginV1 | null): FakeV1 {
  const state: FakeV1 = {
    created: [],
    issues: [],
    port: {
      listCreatedSince: () => Promise.resolve([...state.issues]),
      readIssueOrigin: () => Promise.resolve(origin),
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

function deps(state: FakeV1): HostedAutonomyDepsV1 {
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

Deno.test("follow-ups F7: depth 3 is filed with opt-out, deeper findings are exhausted", async (t) => {
  const marker = (depth: number) =>
    `<!-- sentinel:review-followup:v1 repo=${repository.owner}/${repository.name} pr=900 receipt=review-receipt:${
      "a".repeat(64)
    } depth=${depth} -->`;
  const cases: [string, HostedIssueOriginV1, string][] = [
    ["source is a depth-1 follow-up", {
      number: 600,
      author: APP,
      firstLine: marker(1),
    }, "depth=2 -->"],
    ["source is a depth-2 follow-up", {
      number: 600,
      author: APP,
      firstLine: marker(2),
    }, "depth=3 -->"],
    ["source is a depth-3 follow-up", {
      number: 600,
      author: APP,
      firstLine: marker(3),
    }, "depth_exhausted"],
    ["a human's forged marker", {
      number: 600,
      author: "0x4007",
      firstLine: marker(2),
    }, "depth=1 -->"],
  ];
  for (const [name, origin, expected] of cases) {
    await t.step(name, async () => {
      const state = fake(origin);
      const actions = await runHostedFollowUpPass(deps(state));
      if (expected === "depth_exhausted") {
        assert.deepEqual(actions, [
          `followup:${request.id}:pr=1052:depth_exhausted`,
        ]);
        assert.equal(state.created.length, 0);
      } else {
        assert.equal(state.created.length, 1, actions.join("\n"));
        assert.ok(
          state.created[0].body.split("\n", 1)[0].endsWith(expected),
        );
        assert.deepEqual(
          state.created[0].labels,
          expected === "depth=3 -->" ? ["sentinel:skip"] : undefined,
        );
      }
    });
  }
  await t.step("an unreadable source issue files nothing", async () => {
    const state = fake(null);
    const actions = await runHostedFollowUpPass(deps(state));
    assert.deepEqual(actions, [
      `followup:${request.id}:pr=1052:source_unreadable`,
    ]);
    assert.equal(state.created.length, 0);
  });
});
