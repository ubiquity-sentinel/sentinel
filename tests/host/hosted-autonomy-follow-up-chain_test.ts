/** Follow-ups follow a completed delivery pass and never a failed one. */
import assert from "node:assert/strict";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { runHostedFollowUpPass } from "../../ops/hosted-autonomy-follow-up-pass.ts";
import {
  allLiveReceipts,
  deliveryOnly,
  liveReceipts,
  liveRecord,
  liveRequest,
  liveSnapshot,
  liveSurface,
  type LiveSurfaceOptionsV1,
  liveTask,
  mergedPull,
  NOW,
  openPull,
  readSnapshot,
} from "./hosted-autonomy-spent-fixtures.ts";
import {
  CopyingRepairState,
  makeRig,
  releaseSnapshot,
} from "./hosted-autonomy-rig.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  darkQueueCoordinatorFixture,
  historicalDarkQueueFixture,
} from "./hosted-autonomy-dark-queue-fixture.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  fakeIssues,
  type FakeIssuesV1,
  FINDING_1052,
  followUps,
} from "./hosted-autonomy-follow-up-harness.ts";

Deno.test("follow-ups F9: the follow-up pass runs after a delivery and never after a failed one", async (t) => {
  // Live 618 with its latest clean review carrying one P2: the spent merge
  // at its reviewed base records the request, and the follow-up is filed
  // once that delivery pass succeeded.
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
  const rigFor = async (name: string, issues: FakeIssuesV1) => {
    const { surface } = liveSurface(options(issues));
    const { rig } = await makeRig(name, {
      repair: liveSnapshot([record], [receipt]),
      repairState: new CopyingRepairState(),
    });
    rig.githubFor = () => surface;
    // The real release transport is unrelated here; keep this fixture local.
    rig.state.readRelease = () =>
      Promise.resolve(
        portOk({
          status: "found" as const,
          head: "a".repeat(40) as GitSha,
          ref: null,
          snapshot: releaseSnapshot(),
        }),
      );
    return rig;
  };
  await t.step("completed delivery, then its follow-up", async () => {
    const issues = fakeIssues();
    const rig = await rigFor("follow-up-f9", issues);
    try {
      const delivery = await deliveryOnly(rig);
      assert.equal(delivery.result?.status, "applied");
      const [request] = (await readSnapshot(rig)).releaseRequests;
      const custody = historicalDarkQueueFixture(rig);
      const actions = await runHostedFollowUpPass({
        state: rig.state,
        githubFor: rig.githubFor,
        clock: { now: () => NOW },
        queueCustody: custody,
        queue: await darkQueueCoordinatorFixture(rig, custody),
      });
      assert.deepEqual(followUps(actions), [
        `followup:${request.id}:pr=1071:finding=${FINDING_1052}:filed=#5001`,
      ]);
      assert.ok(issues.created[0].body.includes("- Original issue: #618"));
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  });
  await t.step("a failed delivery files nothing", async () => {
    const issues = fakeIssues();
    const rig = await rigFor("follow-up-f9-failed", issues);
    rig.state.writeRepair = () => Promise.reject(new Error("unavailable"));
    try {
      const delivery = await deliveryOnly(rig);
      assert.notEqual(delivery.result?.status, "applied");
      const custody = historicalDarkQueueFixture(rig);
      const actions = await runHostedFollowUpPass({
        state: rig.state,
        githubFor: rig.githubFor,
        clock: { now: () => NOW },
        queueCustody: custody,
        queue: await darkQueueCoordinatorFixture(rig, custody),
      });
      assert.deepEqual(followUps(actions), []);
      assert.equal(issues.listings, 0);
      assert.equal(issues.created.length, 0);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  });
});
