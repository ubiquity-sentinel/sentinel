/** The real HTTP listing producer and follow-up pass must prove absence. */
import assert from "node:assert/strict";
import { createHostedFollowUpIssues } from "../../ops/hosted-autonomy-github-issues.ts";
import { createHostedAutonomyRequest } from "../../ops/hosted-autonomy-github-listing.ts";
import {
  FOLLOW_UP_LISTING_SKEW_MS,
  followUpMarker,
  planFollowUpCandidates,
} from "../../ops/hosted-autonomy-follow-ups.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { historicalDarkQueueFixture } from "./hosted-autonomy-dark-queue-fixture.ts";
import {
  allLiveReceipts,
  APP,
  liveRecord,
  liveRequest,
  liveSnapshot,
  liveSurface,
  liveTask,
  NOW,
  withHistoricalAutonomy,
} from "./hosted-autonomy-spent-fixtures.ts";

/** This suite preserves historical preactivation follow-up semantics. */
function runHistoricalFollowUps(deps: HostedAutonomyDepsV1): Promise<string[]> {
  return withHistoricalAutonomy(async (graph) => {
    const { runHostedFollowUpPass } = await graph.followUpPass();
    return await runHostedFollowUpPass(deps);
  });
}

const HORIZON = NOW - 30 * 60_000;
const REPOSITORY_URL = "https://api.github.com/repos/ubiquity/ai.ubq.fi";

for (
  const scenario of [
    {
      name: "same-second omitted marker",
      requestAt: HORIZON + 500,
      markerAt: HORIZON,
      outcome: "listing_unproven",
    },
    {
      name: "omitted marker within clock margin",
      requestAt: HORIZON + 30_000,
      markerAt: HORIZON - 30_000,
      outcome: "listing_unproven",
    },
    {
      name: "exact skew boundary remains unproven",
      requestAt: HORIZON + FOLLOW_UP_LISTING_SKEW_MS,
      markerAt: HORIZON,
      outcome: "listing_unproven",
    },
    {
      name: "older request remains unproven",
      requestAt: HORIZON - 1000,
      outcome: "listing_unproven",
    },
    {
      name: "strictly covered interval permits create",
      requestAt: HORIZON + FOLLOW_UP_LISTING_SKEW_MS + 1,
      outcome: "filed=#11000",
    },
    {
      name: "observed marker settles an otherwise unproven interval",
      requestAt: HORIZON - 1000,
      visibleMarker: true,
      outcome: "exists=#9900",
    },
  ]
) {
  Deno.test(`follow-up horizon: ${scenario.name}`, async () => {
    const request = { ...liveRequest(1052), createdAt: scenario.requestAt };
    const snapshot = liveSnapshot(
      [liveRecord(600)],
      allLiveReceipts(),
      [request],
    );
    const candidate = planFollowUpCandidates(snapshot, NOW)[0];
    assert.equal(candidate?.pullRequest, 1052);
    const marker = followUpMarker({
      owner: "ubiquity",
      name: "ai.ubq.fi",
      pullRequest: 1052,
      receiptId: candidate.receipt.id,
      depth: 1,
    })!;
    const item = (number: number, createdAt: number, body: string) => ({
      number,
      repository_url: REPOSITORY_URL,
      user: { login: APP },
      created_at: new Date(createdAt).toISOString().replace(".000Z", "Z"),
      body,
    });
    const issues = Array.from(
      { length: 500 },
      (_, index) =>
        item(
          10000 - index,
          HORIZON + (499 - index) * 1000,
          scenario.visibleMarker && index === 100 ? marker : "Unrelated issue",
        ),
    );
    if (scenario.markerAt !== undefined) {
      issues.push(item(9000, scenario.markerAt, marker));
    }
    let posts = 0;
    const pages: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      let payload: unknown;
      if ((init?.method ?? "GET") === "POST") {
        assert.equal(url.pathname, "/repos/ubiquity/ai.ubq.fi/issues");
        posts++;
        const body = JSON.parse(String(init?.body));
        payload = { ...item(11000, NOW, body.body), title: body.title };
      } else if (url.searchParams.has("page")) {
        assert.equal(url.pathname, "/repos/ubiquity/ai.ubq.fi/issues");
        const page = Number(url.searchParams.get("page"));
        pages.push(page);
        payload = issues.slice((page - 1) * 100, page * 100);
      } else {
        assert.equal(url.pathname, "/repos/ubiquity/ai.ubq.fi/issues/600");
        payload = item(600, HORIZON - 60_000, "Original ordinary issue");
      }
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    }) as typeof fetch;
    try {
      const followUpIssues = createHostedFollowUpIssues(
        createHostedAutonomyRequest("fixture-token"),
        request.target.repository,
      );
      const { surface } = liveSurface({
        tasks: { 600: liveTask(600, allLiveReceipts()) },
        extra: { followUpIssues },
        pulls: {
          1052: {
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
          },
        },
      });
      const deps = {
        state: {
          readRepair: () =>
            Promise.resolve({
              ok: true,
              value: { status: "found", head: "a".repeat(40), snapshot },
            }),
        },
        githubFor: () => surface,
        clock: { now: () => NOW },
      } as unknown as HostedAutonomyDepsV1;
      const actions = await runHistoricalFollowUps({
        ...deps,
        queueCustody: historicalDarkQueueFixture(deps),
      });
      assert.deepEqual(
        pages,
        [1, 2, 3, 4, 5],
        "the HTTP reader reaches its cap",
      );
      assert.deepEqual(actions, [
        `followup:${request.id}:pr=1052:${scenario.outcome}`,
      ]);
      assert.equal(posts, scenario.outcome.startsWith("filed=") ? 1 : 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
