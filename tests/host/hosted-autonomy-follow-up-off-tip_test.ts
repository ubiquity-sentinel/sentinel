/** Off-tip carried parks file their retained review without a request. */
import assert from "node:assert/strict";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { planFollowUpCandidates } from "../../ops/hosted-autonomy-follow-ups.ts";
import { MERGED_OFF_TIP_PREFIX } from "../../src/repair/merge-off-tip.ts";
import { REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX } from "../../src/repair/review-round-cap.ts";
import {
  carriedCalls,
  carriedOptions,
  LIVE_618,
  MOVED_TIP,
  REFRESHED,
  refreshed618,
} from "./hosted-autonomy-carried-fixtures.ts";
import {
  allLiveReceipts,
  APP,
  liveReceipts,
  liveRequest,
  liveSnapshot,
  liveSurface,
  mergedPull,
  NOW,
} from "./hosted-autonomy-spent-fixtures.ts";
import { CopyingRepairState, makeRig } from "./hosted-autonomy-rig.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  fakeIssues,
  runHistoricalFollowUps,
} from "./hosted-autonomy-follow-up-harness.ts";
import { historicalDarkQueueFixture } from "./hosted-autonomy-dark-queue-fixture.ts";

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
  // The exact runtime park shape: an off-tip carried merge is blocked with
  // the merge revision in its message and no release request booked.
  const parked = parseWorkRecordV1({
    ...record,
    nextStep: "blocked",
    wait: null,
    blocker: {
      kind: "other",
      message:
        `${REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX}merge ${merged.mergeCommitSha} has parents ${MOVED_TIP},${REFRESHED}`,
      since: NOW - 60_000,
    },
    updatedAt: NOW - 60_000,
  });
  const after = liveSnapshot([parked], receipts, []);
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
  const parkedRecord = after.work[0];
  assert.ok(
    parkedRecord.blocker!.message.startsWith(
      REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX,
    ),
  );
  const runtimePark = {
    ...after,
    work: [{
      ...parkedRecord,
      blocker: {
        ...parkedRecord.blocker!,
        message: MERGED_OFF_TIP_PREFIX +
          parkedRecord.blocker!.message.slice(
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
        const { rig } = await makeRig(`follow-up-f10-${trusted}`, {
          repair: liveSnapshot(
            after.work,
            after.reviews,
            after.releaseRequests,
          ),
          repairState: new CopyingRepairState(),
        });
        rig.githubFor = () => surface;
        try {
          const deps = {
            state: rig.state,
            githubFor: rig.githubFor,
            clock: { now: () => NOW },
            queueCustody: historicalDarkQueueFixture(rig),
          };
          const actions = await runHistoricalFollowUps(deps);
          const tag = `followup:${candidate.request.id}:pr=1071`;
          const finding = `finding=${
            candidate.receipt.findings[0].fingerprint
          }`;
          assert.deepEqual(actions, [
            trusted
              ? `${tag}:${finding}:filed=#5001`
              : `${tag}:merge_unverified`,
          ]);
          assert.equal(issues.created.length, trusted ? 1 : 0);
          if (trusted) {
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
