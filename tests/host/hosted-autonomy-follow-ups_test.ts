/** Review follow-up planning: bounded candidates and one issue per finding. */
import assert from "node:assert/strict";
import {
  checkReviewTaskStatement,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import { runHostedFollowUpPass } from "../../ops/hosted-autonomy-follow-up-pass.ts";
import { APP } from "./hosted-autonomy-spent-fixtures.ts";
import {
  cloneLiveFollowUps,
  directFollowUpDeps,
  fakeIssues,
  FINDING_1052,
  FINDING_1105,
  FIRST_LINE_1052,
  FIRST_LINE_1052_V2,
  FIRST_LINE_1105,
  FIRST_LINE_1105_V2,
  followUps,
  listed,
  liveDelivered,
  requestPull,
} from "./hosted-autonomy-follow-up-harness.ts";

const live = cloneLiveFollowUps();
const pulls = Object.fromEntries(
  live.requests.map((request) => [
    request.source.pullRequest,
    requestPull(request),
  ]),
);
const run = (issues: ReturnType<typeof fakeIssues>) =>
  runHostedFollowUpPass(directFollowUpDeps({
    requests: live.requests,
    reviews: live.reviews,
    records: liveDelivered().records,
    pulls,
    issues,
  }));

Deno.test("follow-ups F1: each live merged PR with an open P2 gets exactly one issue per finding", async () => {
  const issues = fakeIssues();
  const first = await run(issues);
  assert.equal(issues.created.length, 2, first.join("\n"));
  // Newest request first: PR 1052 (12:40Z) before PR 1105 (11:50Z).
  assert.equal(issues.created[1].body.split("\n", 1)[0], FIRST_LINE_1105_V2);
  assert.equal(
    issues.created[1].title,
    "[P2] Make terminal mapping retirement durable (src/live/upstream.ts:165-168)",
  );
  assert.ok(
    issues.created[1].body.includes(
      "[`src/live/upstream.ts:165-168`](https://github.com/ubiquity/passport.ubq.fi/blob/c1fbeaffe5b4cc0550dcd45d9979f5b71760bd78/src/live/upstream.ts#L165-L168)",
    ),
  );
  assert.equal(
    issues.created[0].title,
    "[P2] Apply the empty guard only to completed Responses (src/provider/openrouter-handlers.ts:310-311)",
  );
  assert.equal(issues.created[0].body.split("\n", 1)[0], FIRST_LINE_1052_V2);
  for (
    const [body, expected] of [
      [issues.created[0].body, [
        "- Original issue: #600",
        "- Reviewed head: `825c7008a357213e901d6fb87df70d83f8969801`",
      ]],
      [issues.created[1].body, ["- Original issue: #592"]],
    ] as const
  ) {
    for (const line of expected) assert.ok(body.includes(line), line);
    assert.ok(body.includes("quoted inert"));
    assert.ok(body.includes("### P2 at [`"));
  }
  const [request1052, request1105] = live.requests;
  assert.deepEqual(followUps(first), [
    `followup:${request1052.id}:pr=1052:finding=${FINDING_1052}:filed=#5001`,
    `followup:${request1105.id}:pr=1105:finding=${FINDING_1105}:filed=#5002`,
  ]);
  // The next pass finds both and files nothing.
  assert.deepEqual(followUps(await run(issues)), [
    `followup:${request1052.id}:pr=1052:finding=${FINDING_1052}:exists=#5001`,
    `followup:${request1105.id}:pr=1105:finding=${FINDING_1105}:exists=#5002`,
  ]);
  for (const issue of issues.created) {
    assert.ok(issue.body.length <= 12_000 && issue.title.length <= 120);
    const checked = await checkReviewTaskStatement({
      issueNumber: 5001,
      title: issue.title,
      body: issue.body,
      digest: await reviewTaskStatementDigest({
        issueNumber: 5001,
        title: issue.title,
        body: issue.body,
      }),
    });
    assert.ok(checked.ok, "an ordinary admissible task statement");
  }
});

Deno.test("follow-ups F2: an App-authored marker of any receipt or depth dedupes; another login's or a PR's never does", async () => {
  const depth2 = FIRST_LINE_1052.replace("depth=1", "depth=2")
    .replace(/receipt=\S+/, `receipt=review-receipt:${"f".repeat(64)}`);
  const issues = fakeIssues({
    issues: [
      listed(4001, APP, depth2),
      listed(4002, "0x4007", FIRST_LINE_1105),
      listed(4003, APP, FIRST_LINE_1105, true),
    ],
  });
  assert.deepEqual(followUps(await run(issues)), [
    `followup:${
      live.requests[0].id
    }:pr=1052:finding=${FINDING_1052}:exists=#4001`,
    `followup:${
      live.requests[1].id
    }:pr=1105:finding=${FINDING_1105}:filed=#5001`,
  ]);
  assert.equal(issues.created.length, 1);
});

Deno.test("follow-ups F3: an unproven listing creates nothing", async (t) => {
  for (const listing of ["null", "throw"] as const) {
    await t.step(listing, async () => {
      const issues = fakeIssues({ listing });
      const actions = await run(issues);
      assert.equal(issues.created.length, 0);
      assert.equal(issues.listings, 1, actions.join(" "));
      assert.deepEqual(followUps(actions), [
        `followup:${live.requests[0].id}:pr=1052:listing_unproven`,
        `followup:${live.requests[1].id}:pr=1105:listing_unproven`,
      ]);
    });
  }
});

Deno.test("follow-ups F4: an unproven create is settled by the next listing, never created twice", async () => {
  const issues = fakeIssues({ createUnproven: true });
  assert.deepEqual(followUps(await run(issues)), [
    `followup:${
      live.requests[0].id
    }:pr=1052:finding=${FINDING_1052}:create_unproven`,
    `followup:${
      live.requests[1].id
    }:pr=1105:finding=${FINDING_1105}:create_unproven`,
  ]);
  assert.deepEqual(followUps(await run(issues)), [
    `followup:${
      live.requests[0].id
    }:pr=1052:finding=${FINDING_1052}:exists=#5001`,
    `followup:${
      live.requests[1].id
    }:pr=1105:finding=${FINDING_1105}:exists=#5002`,
  ]);
  assert.equal(issues.created.length, 2);
});
