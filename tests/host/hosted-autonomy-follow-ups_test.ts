import {
  darkQueueCoordinatorFixture,
  historicalDarkQueueFixture,
} from "./hosted-autonomy-dark-queue-fixture.ts";
/**
 * Review follow-up issues (owner decision 2026-10-16: merge with the
 * remaining P1/P2/P3 findings filed as new issues). After the maintenance chain
 * the trusted launcher files ONE issue per merged PR in the target
 * repository, listing every unresolved P1/P2/P3 finding of the latest
 * current-head review with its file:line. It is idempotent without state (a
 * deterministic first-line marker, a complete listing before any create),
 * bounded per pass, never filed twice, and only for the App's own verified
 * merges. Live shapes: PR 1052 (#600) and PR 1105 (#592) at 23:21Z.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  checkReviewTaskStatement,
  parseReviewReceiptV1,
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import {
  parseReleaseRequestV1,
  type ReleaseRequestV1,
} from "../../src/contracts/release.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyPullV1,
  HostedFollowUpIssuesV1,
  HostedIssueListingItemV1,
  HostedIssueOriginV1,
} from "../../ops/hosted-autonomy-types.ts";
import { HOSTED_AUTONOMY_PASS_DEADLINE_MS } from "../../ops/hosted-autonomy-continuation.ts";
import { planFollowUpCandidates } from "../../ops/hosted-autonomy-follow-ups.ts";
import { MERGED_OFF_TIP_PREFIX } from "../../src/repair/merge-off-tip.ts";
import { REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX } from "../../src/repair/review-round-cap.ts";
import {
  carriedCalls,
  carriedOptions,
  carriedPass,
  LIVE_618,
  MOVED_TIP,
  REFRESHED,
  refreshed618,
} from "./hosted-autonomy-carried-fixtures.ts";
import {
  allLiveReceipts,
  APP,
  liveReceipts,
  liveRecord,
  liveRequest,
  liveRig,
  liveSnapshot,
  liveSurface,
  type LiveSurfaceOptionsV1,
  liveTask,
  mergedPull,
  NOW,
  openPull,
  readSnapshot,
  runAt,
  TIP,
  withHistoricalAutonomy,
} from "./hosted-autonomy-spent-fixtures.ts";

/** This suite preserves historical preactivation follow-up semantics. */
function runHistoricalFollowUps(deps: HostedAutonomyDepsV1): Promise<string[]> {
  return withHistoricalAutonomy(async (graph) => {
    const { runHostedFollowUpPass } = await graph.followUpPass();
    return await runHostedFollowUpPass(deps);
  });
}

const FIRST_LINE_1052 =
  "<!-- sentinel:review-followup:v1 repo=ubiquity/ai.ubq.fi pr=1052 receipt=review-receipt:171aed7474c3730b3b721967dcbe14d7623da6f67e5e70e6a48e0967ba602eb7 depth=1 -->";
const FIRST_LINE_1105 =
  "<!-- sentinel:review-followup:v1 repo=ubiquity/ai.ubq.fi pr=1105 receipt=review-receipt:44fd1a26189b99c0d752b4b157d445c431e96f7e0761dd3cbdaaaba5eed581a4 depth=1 -->";
const BODY_1052 = [
  FIRST_LINE_1052,
  "",
  "Pull request #1052 was merged by Sentinel as `8a99ecbeaf8fd5f845fd6be034e284dd370f332c`. Its latest current-head review had no unresolved P0 finding, so it merged; the review left the P1/P2/P3 finding below unresolved. Only P0 findings block a merge (owner directive 2026-10-24), so the rest are filed here as follow-up work.",
  "",
  "- Merged pull request: #1052",
  "- Original issue: #600",
  "- Reviewed head: `825c7008a357213e901d6fb87df70d83f8969801`",
  "- Review receipt: `review-receipt:171aed7474c3730b3b721967dcbe14d7623da6f67e5e70e6a48e0967ba602eb7`",
  "",
  "### 1. P2 at [`src/provider/openrouter-handlers.ts:310-311`](https://github.com/ubiquity/ai.ubq.fi/blob/825c7008a357213e901d6fb87df70d83f8969801/src/provider/openrouter-handlers.ts#L310-L311)",
  "",
  "~~~text",
  "[P2] Apply the empty guard only to completed Responses",
  "",
  'When OpenRouter returns a valid HTTP 200 Responses payload with `status: "failed"` and no answer-bearing output, this condition routes it through the generic 502 `empty_upstream_completion` response, discarding the provider\'s `response.failed` terminal and error payload. Apply the empty-completion guard only to a would-be `completed` response, as the streamed Responses path does.',
  "~~~",
  "",
  "Filed by the Sentinel launcher from the stored review receipt. The reviewer's text is quoted inert. Fix each finding with a regression test where practical.",
].join("\n");

/** The App's own verified merge of one request's exact head. */
function requestPull(
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

interface FakeIssuesV1 {
  port: HostedFollowUpIssuesV1;
  created: { title: string; body: string; labels?: readonly string[] }[];
  issues: HostedIssueListingItemV1[];
  listings: number;
}

/** An in-memory target tracker; a create appears in the next listing. */
function fakeIssues(
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
function liveDelivered(): {
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

async function followUpRun(
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

const followUps = (actions: readonly string[]) =>
  actions.filter((action) => action.startsWith("followup:"));

Deno.test("follow-ups F1: each live merged PR with an open P2 gets exactly one aggregated issue", async () => {
  const issues = fakeIssues();
  const { results, writes } = await followUpRun("f1", issues, { passes: 2 });
  assert.equal(issues.created.length, 2, JSON.stringify(results[0].actions));
  // Newest request first: PR 1052 (12:40Z) before PR 1105 (11:50Z).
  assert.equal(issues.created[1].body.split("\n", 1)[0], FIRST_LINE_1105);
  assert.equal(
    issues.created[1].title,
    "Review follow-ups from #1105: 1 P1/P2/P3 finding",
  );
  assert.ok(
    issues.created[1].body.includes(
      "[`src/live/upstream.ts:165-168`](https://github.com/ubiquity/ai.ubq.fi/blob/c1fbeaffe5b4cc0550dcd45d9979f5b71760bd78/src/live/upstream.ts#L165-L168)",
    ),
  );
  assert.equal(
    issues.created[0].title,
    "Review follow-ups from #1052: 1 P1/P2/P3 finding",
  );
  assert.equal(issues.created[0].body, BODY_1052);
  const [request1052, request1105] = [liveRequest(1052), liveRequest(1105)];
  assert.deepEqual(followUps(results[0].actions), [
    `followup:${request1052.id}:pr=1052:filed=#5001`,
    `followup:${request1105.id}:pr=1105:filed=#5002`,
  ]);
  // The next pass finds both and files nothing; no state is ever written.
  assert.deepEqual(followUps(results[1].actions), [
    `followup:${request1052.id}:pr=1052:exists=#5001`,
    `followup:${request1105.id}:pr=1105:exists=#5002`,
  ]);
  assert.equal(writes, 0);
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

function listed(
  number: number,
  author: string,
  firstLine: string,
  pullRequest = false,
): HostedIssueListingItemV1 {
  return { number, author, createdAt: NOW - 60_000, pullRequest, firstLine };
}

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
  const { results } = await followUpRun("f2", issues);
  assert.deepEqual(followUps(results[0].actions), [
    `followup:${liveRequest(1052).id}:pr=1052:exists=#4001`,
    `followup:${liveRequest(1105).id}:pr=1105:filed=#5001`,
  ]);
  assert.equal(issues.created.length, 1);
});

Deno.test("follow-ups F3: an unproven listing creates nothing", async (t) => {
  for (const listing of ["null", "throw"] as const) {
    await t.step(listing, async () => {
      const issues = fakeIssues({ listing });
      const { results } = await followUpRun(`f3-${listing}`, issues);
      assert.equal(issues.created.length, 0);
      assert.equal(issues.listings, 1, "one listing per repository and pass");
      assert.deepEqual(followUps(results[0].actions), [
        `followup:${liveRequest(1052).id}:pr=1052:listing_unproven`,
        `followup:${liveRequest(1105).id}:pr=1105:listing_unproven`,
      ]);
    });
  }
});

Deno.test("follow-ups F4: an unproven create is settled by the next listing, never created twice", async () => {
  const issues = fakeIssues({ createUnproven: true });
  const { results } = await followUpRun("f4", issues, { passes: 2 });
  assert.deepEqual(followUps(results[0].actions), [
    `followup:${liveRequest(1052).id}:pr=1052:create_unproven`,
    `followup:${liveRequest(1105).id}:pr=1105:create_unproven`,
  ]);
  assert.deepEqual(followUps(results[1].actions), [
    `followup:${liveRequest(1052).id}:pr=1052:exists=#5001`,
    `followup:${liveRequest(1105).id}:pr=1105:exists=#5002`,
  ]);
  assert.equal(issues.created.length, 2);
});

Deno.test("follow-ups F5: only the App's own verified merge of the exact head gets a follow-up", async (t) => {
  const request = liveRequest(1052);
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
      const issues = fakeIssues();
      const { results } = await followUpRun(`f5-${name.length}`, issues, {
        requests: [request],
        pulls: { 1052: requestPull(request, overrides) },
      });
      assert.deepEqual(followUps(results[0].actions), [
        `followup:${request.id}:pr=1052:merge_unverified`,
      ]);
      assert.equal(issues.created.length, 0);
    });
  }
});

/** A third merged request with its own P2 (cloned from PR 1052's shape). */
function thirdCandidate(): {
  request: ReleaseRequestV1;
  receipt: ReviewReceiptV1;
} {
  const base = liveRequest(1052);
  const receipt = allLiveReceipts().find((row) =>
    row.id === base.source.reviewReceiptId
  )!;
  const id = `review-receipt:${"7".repeat(64)}`;
  return {
    receipt: parseReviewReceiptV1({
      ...receipt,
      id,
      pullRequest: { ...receipt.pullRequest, number: 1130 },
    }),
    request: parseReleaseRequestV1({
      ...base,
      id: `release:${"8".repeat(64)}`,
      revision: "6".repeat(40),
      source: { ...base.source, pullRequest: 1130, reviewReceiptId: id },
      createdAt: base.createdAt + 1000,
    }),
  };
}

Deno.test("follow-ups F6: creates, deadlines and body bounds stay bounded", async (t) => {
  await t.step("at most two creates per pass", async () => {
    const third = thirdCandidate();
    const live = liveDelivered();
    const issues = fakeIssues();
    const { results } = await followUpRun("f6-creates", issues, {
      requests: [...live.requests, third.request],
      reviews: [...live.reviews, third.receipt],
      records: [...live.records, {
        ...live.records[1],
        id: `${live.records[1].id}-third` as WorkRecordV1["id"],
        target: { ...live.records[1].target, pr: 1130 },
      }],
      passes: 2,
    });
    assert.equal(issues.created.length, 3);
    assert.deepEqual(
      followUps(results[0].actions).map((a) => a.split(":").at(-1)),
      [
        "filed=#5001",
        "filed=#5002",
        "deferred",
      ],
    );
    assert.ok(followUps(results[1].actions).at(-1)!.endsWith(":filed=#5003"));
  });
  await t.step(
    "the 60-second budget stops before the next GitHub call",
    async () => {
      const issues = fakeIssues();
      let now = NOW;
      const { results } = await followUpRun("f6-deadline", issues, {
        now: () => (now += 31_000),
      });
      assert.equal(
        issues.created.length,
        0,
        JSON.stringify(results[0].actions),
      );
      assert.ok(followUps(results[0].actions).at(-1)!.endsWith(":deadline"));
    },
  );
  await t.step(
    "a pass already at its own deadline leaves the follow-ups to the next pass",
    async () => {
      // The follow-ups run after every continued phase of the pass, so they
      // share its deadline: none starts a read past it.
      const issues = fakeIssues();
      let calls = 0;
      const { results } = await followUpRun("f6-pass-deadline", issues, {
        now: () => calls++ === 0 ? NOW : NOW + HOSTED_AUTONOMY_PASS_DEADLINE_MS,
      });
      assert.deepEqual(followUps(results[0].actions), ["followup:deadline"]);
      assert.equal(issues.listings, 0);
      assert.equal(issues.created.length, 0);
    },
  );
});

Deno.test("follow-ups F7: depth 3 is filed with opt-out, deeper findings are exhausted", async (t) => {
  const request = liveRequest(1052);
  const marker = (depth: number) =>
    `<!-- sentinel:review-followup:v1 repo=ubiquity/ai.ubq.fi pr=900 receipt=review-receipt:${
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
      const issues = fakeIssues({ origins: { 600: origin } });
      const { results } = await followUpRun(`f7-${name.length}`, issues, {
        requests: [request],
      });
      if (expected === "depth_exhausted") {
        assert.deepEqual(followUps(results[0].actions), [
          `followup:${request.id}:pr=1052:depth_exhausted`,
        ]);
        assert.equal(issues.created.length, 0);
      } else {
        assert.ok(issues.created[0].body.split("\n", 1)[0].endsWith(expected));
        assert.deepEqual(
          issues.created[0].labels,
          expected === "depth=3 -->" ? ["sentinel:skip"] : undefined,
        );
      }
    });
  }
  await t.step("an unreadable source issue files nothing", async () => {
    const issues = fakeIssues({ origins: { 600: null } });
    const { results } = await followUpRun("f7-unreadable", issues, {
      requests: [request],
    });
    assert.deepEqual(followUps(results[0].actions), [
      `followup:${request.id}:pr=1052:source_unreadable`,
    ]);
  });
});

Deno.test("follow-ups F8: production requests since the fixed epoch remain eligible beyond 72 hours", async (t) => {
  const base = liveRequest(1052);
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
      target: { ...base.target, environment: "isolated" },
    }],
  ];
  for (const [name, overrides] of cases) {
    await t.step(name, async () => {
      const issues = fakeIssues();
      const request = parseReleaseRequestV1({ ...base, ...overrides });
      const { results } = await followUpRun(`f8-${name.length}`, issues, {
        requests: [request],
        now: () => Math.max(NOW, request.createdAt + 1),
      });
      assert.deepEqual(followUps(results[0].actions), []);
      assert.equal(issues.listings, 0, "nothing is even listed");
    });
  }
  await t.step("a post-epoch request still files after 72 hours", async () => {
    const issues = fakeIssues();
    const { results } = await followUpRun("f8-old-eligible", issues, {
      requests: [base],
      now: () => NOW + 73 * 3_600_000,
    });
    assert.deepEqual(followUps(results[0].actions), [
      `followup:${base.id}:pr=1052:filed=#5001`,
    ]);
    assert.equal(issues.created.length, 1);
  });
  await t.step(
    "a review with an unresolved P1 files it as a follow-up (only P0 blocks)",
    async () => {
      const issues = fakeIssues();
      const live = liveDelivered();
      const reviews = live.reviews.map((review) =>
        review.id === base.source.reviewReceiptId
          ? parseReviewReceiptV1({
            ...review,
            findings: review.findings.map((f) => ({ ...f, severity: "P1" })),
            unresolvedSeverities: ["P1"],
          })
          : review
      );
      const { results } = await followUpRun("f8-p1", issues, {
        requests: [base],
        reviews,
      });
      assert.deepEqual(followUps(results[0].actions), [
        `followup:${base.id}:pr=1052:filed=#5001`,
      ]);
      assert.equal(issues.created.length, 1);
    },
  );
});

Deno.test("follow-ups F9: the runner files in the same run as a merge and never after a failed chain", async (t) => {
  // Live 618 with its latest clean review carrying one P2: the spent merge
  // at its reviewed base records the request, and the follow-up is filed in
  // the same run without changing the chain's status or reason.
  const record = liveRecord(618);
  const reviewedBase = record.target.base!;
  const [clean] = liveReceipts(record);
  const p2 = liveRequest(1052);
  const p2Finding =
    allLiveReceipts().find((r) => r.id === p2.source.reviewReceiptId)!
      .findings[0];
  const receipt = parseReviewReceiptV1({
    ...clean,
    findings: [p2Finding],
    unresolvedSeverities: ["P2"],
  });
  const options = (issues: FakeIssuesV1): LiveSurfaceOptionsV1 => ({
    tip: reviewedBase,
    green: { [record.target.head!]: true, [reviewedBase]: true },
    pulls: { 1071: openPull(record) },
    afterMerge: { 1071: mergedPull(record, reviewedBase) },
    tasks: { 618: liveTask(618, [receipt]) },
    extra: { followUpIssues: issues.port },
  });
  await t.step("applied merge, then its follow-up", async () => {
    const issues = fakeIssues();
    const { surface } = liveSurface(options(issues));
    const rig = await liveRig("f9", liveSnapshot([record], [receipt]), surface);
    try {
      // At its reviewed base the green CI-parked spent head merges in the
      // first run (the retry pass leaves it to the spent-round rule).
      const result = await runAt(rig);
      assert.ok(
        !result.actions.some((a) => a.startsWith(`retry:${record.id}:`)),
        JSON.stringify(result.actions),
      );
      assert.equal(result.status, "applied", JSON.stringify(result.actions));
      assert.equal(result.reason, "applied");
      const [request] = (await readSnapshot(rig)).releaseRequests;
      assert.deepEqual(followUps(result.actions), [
        `followup:${request.id}:pr=1071:filed=#5001`,
      ]);
      assert.ok(issues.created[0].body.includes("- Original issue: #618"));
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  });
  await t.step("a failed chain files nothing", async () => {
    const issues = fakeIssues();
    const { surface } = liveSurface(options(issues));
    const rig = await liveRig(
      "f9-failed",
      liveSnapshot([record], [receipt], [liveRequest(1052)]),
      surface,
    );
    rig.state.writeRepair = () => Promise.reject(new Error("unavailable"));
    try {
      const result = await runAt(rig);
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.deepEqual(followUps(result.actions), []);
      assert.equal(issues.listings, 0);
      assert.equal(issues.created.length, 0);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  });
});

Deno.test("follow-ups F10: a real off-tip carried park files its retained review without a release request", async (t) => {
  const record = refreshed618();
  const finding =
    allLiveReceipts().find((row) =>
      row.id === liveRequest(1052).source.reviewReceiptId
    )!.findings[0];
  const receipts = liveReceipts(LIVE_618).map((receipt) =>
    parseReviewReceiptV1({
      ...receipt,
      findings: [finding],
      unresolvedSeverities: ["P2"],
    })
  );
  const merged = mergedPull(record, "9e".repeat(20));
  const { after } = await carriedPass(
    "follow-up-off-tip",
    record,
    { afterMerge: { 1071: merged } },
    {},
    receipts,
  );
  assert.equal(after.work[0].nextStep, "blocked");
  assert.deepEqual(
    after.releaseRequests,
    [],
    "off-tip delivery did not book a request",
  );
  const [candidate] = planFollowUpCandidates(after, NOW);
  assert.equal(candidate.pullRequest, 1071);
  assert.equal(candidate.request.source.head, REFRESHED);
  assert.equal(candidate.request.source.base, MOVED_TIP);
  assert.equal(candidate.receipt.pullRequest.head, LIVE_618.target.head);
  assert.equal(candidate.request.source.reviewReceiptId, candidate.receipt.id);
  // The runtime's merge CAS park records the same merge with its own prefix
  // and files the same follow-up (stage-1 review, 2026-10-25).
  const parked = after.work[0];
  assert.ok(
    parked.blocker!.message.startsWith(
      REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX,
    ),
  );
  const runtimePark = {
    ...after,
    work: [{
      ...parked,
      blocker: {
        ...parked.blocker!,
        message: MERGED_OFF_TIP_PREFIX +
          parked.blocker!.message.slice(
            REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX.length,
          ),
      },
    }],
  };
  assert.deepEqual(
    planFollowUpCandidates(runtimePark, NOW).map((c) => c.request.id),
    [candidate.request.id],
  );

  for (const trusted of [true, false]) {
    await t.step(
      trusted ? "App merge files once" : "owner merge refuses",
      async () => {
        const issues = fakeIssues();
        const { surface } = liveSurface(carriedOptions(
          after.work[0],
          receipts,
          carriedCalls(),
          {
            pulls: { 1071: { ...merged, mergedBy: trusted ? APP : "0x4007" } },
          },
        ));
        surface.followUpIssues = issues.port;
        const rig = await liveRig(
          `f10-${trusted}`,
          liveSnapshot(after.work, after.reviews, after.releaseRequests),
          surface,
        );
        try {
          const deps = {
            state: rig.state,
            githubFor: rig.githubFor,
            clock: { now: () => NOW },
            queueCustody: historicalDarkQueueFixture(rig),
          };
          const actions = await runHistoricalFollowUps(deps);
          const tag = `followup:${candidate.request.id}:pr=1071`;
          assert.deepEqual(actions, [
            `${tag}:${trusted ? "filed=#5001" : "merge_unverified"}`,
          ]);
          assert.equal(issues.created.length, trusted ? 1 : 0);
          if (trusted) {
            assert.deepEqual(await runHistoricalFollowUps(deps), [
              `${tag}:exists=#5001`,
            ]);
            assert.ok(issues.created[0].body.includes(candidate.receipt.id));
          }
          assert.equal(
            rig.writes,
            0,
            "follow-ups preserve the parked record and charges",
          );
        } finally {
          await Deno.remove(rig.tmp, { recursive: true });
        }
      },
    );
  }
});
