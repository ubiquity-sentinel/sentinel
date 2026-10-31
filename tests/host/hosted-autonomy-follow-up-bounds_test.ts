/** Follow-up rate and wall-clock bounds. */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  parseReviewReceiptV1,
  type ReviewReceiptV1,
} from "../../src/contracts/review-receipt.ts";
import {
  parseReleaseRequestV1,
  type ReleaseRequestV1,
} from "../../src/contracts/release.ts";
import { runHostedFollowUpPass } from "../../ops/hosted-autonomy-follow-up-pass.ts";
import { FOLLOW_UP_PASS_BUDGET_MS } from "../../ops/hosted-autonomy-follow-ups.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { historicalDarkQueueFixture } from "./hosted-autonomy-dark-queue-fixture.ts";
import {
  allLiveReceipts,
  liveRecord,
  liveRequest,
  liveSnapshot,
  liveSurface,
  liveTask,
  NOW,
} from "./hosted-autonomy-spent-fixtures.ts";
import {
  cloneLiveFollowUps,
  directFollowUpDeps,
  fakeIssues,
  followUps,
  liveDelivered,
  requestPull,
  runHistoricalFollowUps,
} from "./hosted-autonomy-follow-up-harness.ts";

const live = cloneLiveFollowUps();

/** A third merged request with its own P2 (cloned from PR 1052's shape). */
function thirdCandidate(): {
  request: ReleaseRequestV1;
  receipt: ReviewReceiptV1;
} {
  const base = live.requests[0];
  const receipt = live.reviews.find((row) =>
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

const third = thirdCandidate();
const requests = [...live.requests, third.request];
const reviews = [...live.reviews, third.receipt];
const records: WorkRecordV1[] = liveDelivered()
  .records.map((record) => ({
    ...record,
    id: `${record.id}-third` as WorkRecordV1["id"],
    target: { ...record.target, pr: 1130 },
  }));
const pulls = Object.fromEntries(
  requests.map((request) => [
    request.source.pullRequest,
    requestPull(request),
  ]),
);

Deno.test("follow-ups F6: creates, deadlines and body bounds stay bounded", async (t) => {
  await t.step("every pending finding files while in budget", async () => {
    const issues = fakeIssues();
    const first = await runHostedFollowUpPass(directFollowUpDeps({
      requests,
      reviews,
      records,
      pulls,
      issues,
    }));
    assert.equal(issues.created.length, 3, first.join("\n"));
    assert.deepEqual(
      followUps(first).map((action) => action.split(":").at(-1)),
      ["filed=#5001", "filed=#5002", "filed=#5003"],
    );
    const second = await runHostedFollowUpPass(directFollowUpDeps({
      requests,
      reviews,
      records,
      pulls,
      issues,
    }));
    assert.equal(issues.created.length, 3, "the next pass files nothing new");
    assert.ok(
      !followUps(second).some((action) => action.endsWith(":filed=#5004")),
      second.join("\n"),
    );
  });
  await t.step(
    "the 60-second budget stops before the next GitHub call",
    async () => {
      const issues = fakeIssues();
      let now = NOW;
      const actions = await runHostedFollowUpPass(directFollowUpDeps({
        requests: live.requests,
        reviews: live.reviews,
        records: liveDelivered().records,
        pulls,
        issues,
        now: () => (now += 31_000),
      }));
      assert.equal(issues.created.length, 0, actions.join("\n"));
      assert.ok(followUps(actions).at(-1)!.endsWith(":deadline"));
    },
  );
  await t.step(
    "a pass already at its own deadline leaves the follow-ups to the next pass",
    async () => {
      const issues = fakeIssues();
      const actions = await runHostedFollowUpPass(
        directFollowUpDeps({
          requests: live.requests,
          reviews: live.reviews,
          records: liveDelivered().records,
          pulls,
          issues,
        }),
        NOW,
      );
      assert.deepEqual(followUps(actions), ["followup:deadline"]);
      assert.equal(issues.listings, 0);
      assert.equal(issues.created.length, 0);
    },
  );
});

Deno.test("follow-up deadline: a source read at the deadline starts no further GitHub read", async () => {
  const request = liveRequest(1052);
  const receipts = allLiveReceipts();
  const snapshot = liveSnapshot([liveRecord(600)], receipts, [request]);
  const pull = requestPull(request);
  let now = NOW;
  let originRead = false;
  let readsAfterOrigin = 0;
  const { surface } = liveSurface({
    tasks: { 600: liveTask(600, receipts) },
    pulls: { 1052: pull },
    extra: {
      readPull: (number: number) => {
        if (originRead) readsAfterOrigin++;
        return Promise.resolve(number === 1052 ? pull : null);
      },
      followUpIssues: {
        listCreatedSince: () => Promise.resolve([]),
        readIssueOrigin: () => {
          originRead = true;
          now = NOW + FOLLOW_UP_PASS_BUDGET_MS;
          return Promise.resolve({
            number: 600,
            author: "0x4007",
            firstLine: "An ordinary issue",
          });
        },
        create: () => Promise.reject(new Error("create after deadline")),
      },
    },
  });
  const base = {
    state: {
      readRepair: () =>
        Promise.resolve({
          ok: true as const,
          value: { status: "found" as const, head: "a".repeat(40), snapshot },
        }),
    },
    githubFor: () => surface,
    clock: { now: () => now },
  };
  const rig = base as unknown as Parameters<
    typeof historicalDarkQueueFixture
  >[0];
  const deps = {
    ...base,
    queueCustody: historicalDarkQueueFixture(rig),
  } as unknown as HostedAutonomyDepsV1;
  const actions = await runHistoricalFollowUps(deps);
  assert.equal(readsAfterOrigin, 0, actions.join("\n"));
  assert.ok(actions.at(-1)!.endsWith(":deadline"), actions.join("\n"));
});
