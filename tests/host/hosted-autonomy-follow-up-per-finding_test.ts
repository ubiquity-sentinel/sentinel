/** One review follow-up issue per finding, with v1 compatibility. */
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
const second = {
  ...live.findings[0],
  id: "github-review-second-finding",
  fingerprint: "b".repeat(64),
  severity: "P3" as const,
  path: "src/other.ts",
  message: "[P3] Second finding\n\nsrc/other.ts:5",
};
const twoFindings = parseReviewReceiptV1({
  ...live,
  findings: [live.findings[0], second],
  unresolvedSeverities: ["P2", "P3"],
});
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

interface FakePortV1 {
  port: HostedFollowUpIssuesV1;
  created: { title: string; body: string }[];
  issues: HostedIssueListingItemV1[];
}

function fakePort(seed: readonly HostedIssueListingItemV1[] = []): FakePortV1 {
  const fake: FakePortV1 = {
    created: [],
    issues: [...seed],
    port: {
      listCreatedSince: () => Promise.resolve([...fake.issues]),
      readIssueOrigin: () =>
        Promise.resolve({ number: 600, author: "0x4007", firstLine: "issue" }),
      create: (input) => {
        fake.created.push(input);
        const number = 5000 + fake.created.length;
        fake.issues.push({
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
  return fake;
}

function deps(issues: FakePortV1): HostedAutonomyDepsV1 {
  const surface = {
    readDefaultBranch: () => Promise.resolve("development"),
    readPull: () => Promise.resolve(pull),
    followUpIssues: issues.port,
  } as unknown as HostedAutonomyGitHubV1;
  return {
    state: {
      readRepair: () =>
        Promise.resolve({
          ok: true,
          value: {
            status: "found",
            head: TIP,
            snapshot: liveSnapshot([liveRecord(600)], [twoFindings], [request]),
          },
        }),
    },
    githubFor: () => surface,
    clock: { now: () => NOW },
  } as unknown as HostedAutonomyDepsV1;
}

Deno.test("follow-up per finding: two findings file two v2 issues and the next run files nothing", async () => {
  const issues = fakePort();
  const first = await runHostedFollowUpPass(deps(issues));
  assert.equal(issues.created.length, 2, first.join("\n"));
  const markers = issues.created.map((issue) => issue.body.split("\n", 1)[0]);
  for (const marker of markers) {
    assert.ok(marker.startsWith("<!-- sentinel:review-followup:v2 "), marker);
    assert.ok(
      marker.includes(`receipt=${twoFindings.id} `) &&
        marker.includes(" finding="),
      marker,
    );
  }
  assert.equal(new Set(markers).size, 2, "one marker per finding");
  assert.deepEqual(issues.created.map((issue) => issue.title), [
    "[P2] Apply the empty guard only to completed Responses (src/provider/openrouter-handlers.ts:310-311)",
    "[P3] Second finding (src/other.ts:5)",
  ]);
  for (const issue of issues.created) {
    assert.ok(issue.body.includes("- Merged pull request: #1052"));
    assert.ok(issue.body.includes(`- Review receipt: \`${twoFindings.id}\``));
    assert.ok(issue.body.includes("quoted inert"));
  }
  const secondRun = await runHostedFollowUpPass(deps(issues));
  assert.ok(!secondRun.some((action) => action.includes(":filed=")));
  assert.equal(issues.created.length, 2, "the second run files nothing");
});

Deno.test("follow-up per finding: a v1 combined marker suppresses every finding", async () => {
  const v1 =
    `<!-- sentinel:review-followup:v1 repo=${repository.owner}/${repository.name} pr=1052 receipt=review-receipt:${
      "f".repeat(64)
    } depth=1 -->`;
  const issues = fakePort([{
    number: 4001,
    author: APP,
    createdAt: NOW - 60_000,
    pullRequest: false,
    firstLine: v1,
  }]);
  const actions = await runHostedFollowUpPass(deps(issues));
  assert.equal(issues.created.length, 0, actions.join("\n"));
  for (const finding of twoFindings.findings) {
    assert.ok(
      actions.includes(
        `followup:${request.id}:pr=1052:finding=${finding.fingerprint}:exists=#4001`,
      ),
      actions.join("\n"),
    );
  }
});
