/** Follow-up eligibility since the fixed epoch. */
import assert from "node:assert/strict";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
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
const baseRequest = {
  ...base,
  target: { ...base.target, repository },
} as typeof base;
const live = {
  ...allLiveReceipts().find((row) =>
    row.id === baseRequest.source.reviewReceiptId
  )!,
  repository,
};
const receipt = parseReviewReceiptV1(live);
const pull: HostedAutonomyPullV1 = {
  number: 1052,
  state: "closed",
  merged: true,
  mergeCommitSha: baseRequest.revision,
  headSha: baseRequest.source.head,
  baseRef: "development",
  baseSha: baseRequest.source.base,
  author: APP,
  mergedBy: APP,
  parents: ["1".repeat(40), baseRequest.source.head],
  revisionOnBaseBranch: true,
  baseAncestorOfRevision: true,
  mergeable: null,
};

interface FakeV1 {
  port: HostedFollowUpIssuesV1;
  created: { title: string; body: string; labels?: readonly string[] }[];
  issues: HostedIssueListingItemV1[];
  listings: number;
}

function fake(): FakeV1 {
  const state: FakeV1 = {
    created: [],
    issues: [],
    listings: 0,
    port: {
      listCreatedSince: () => {
        state.listings++;
        return Promise.resolve([...state.issues]);
      },
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
  request: typeof baseRequest,
  reviews: readonly typeof receipt[],
  now: () => number = () => NOW,
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
            snapshot: liveSnapshot([liveRecord(600)], reviews, [request]),
          },
        }),
    },
    githubFor: () => surface,
    clock: { now },
  } as unknown as HostedAutonomyDepsV1;
}

Deno.test("follow-ups F8: production requests since the fixed epoch remain eligible beyond 72 hours", async (t) => {
  const cases: [string, Record<string, unknown>][] = [
    ["before 2026-10-16T00:00Z", {
      createdAt: Date.parse("2026-10-15T23:59:59Z"),
    }],
    ["a failed request", { status: "failed", failureReason: "rejected" }],
    ["a cancelled request", {
      status: "cancelled",
      failureReason: "superseded",
    }],
    ["an isolated request", {
      target: { ...baseRequest.target, environment: "isolated" },
    }],
  ];
  for (const [name, overrides] of cases) {
    await t.step(name, async () => {
      const state = fake();
      const request = parseReleaseRequestV1({
        ...baseRequest,
        ...overrides,
      }) as typeof baseRequest;
      const actions = await runHostedFollowUpPass(
        deps(state, request, [receipt]),
      );
      assert.deepEqual(actions, []);
      assert.equal(state.listings, 0, "nothing is even listed");
      assert.equal(state.created.length, 0);
    });
  }
  await t.step("a post-epoch request still files after 72 hours", async () => {
    const state = fake();
    const actions = await runHostedFollowUpPass(
      deps(state, baseRequest, [receipt], () => NOW + 73 * 3_600_000),
    );
    assert.deepEqual(actions, [
      `followup:${baseRequest.id}:pr=1052:finding=${
        live.findings[0].fingerprint
      }:filed=#5001`,
    ]);
    assert.equal(state.created.length, 1);
  });
  await t.step(
    "a review with an unresolved P1 files it as a follow-up (only P0 blocks)",
    async () => {
      const state = fake();
      const p1 = parseReviewReceiptV1({
        ...receipt,
        findings: receipt.findings.map((finding) => ({
          ...finding,
          severity: "P1",
        })),
        unresolvedSeverities: ["P1"],
      });
      const actions = await runHostedFollowUpPass(
        deps(state, baseRequest, [p1]),
      );
      assert.deepEqual(actions, [
        `followup:${baseRequest.id}:pr=1052:finding=${
          live.findings[0].fingerprint
        }:filed=#5001`,
      ]);
      assert.equal(state.created.length, 1);
    },
  );
});
