/**
 * The delivery pass's merge bound and the disabled moved-base merge (review
 * of the spent-round delivery lane): the base tip and the tip's CI are read
 * once per repository per pass, so once the pass has called merge in a
 * repository, whatever it answered, no further merge is attempted in that
 * repository in that pass (another repository's: see
 * hosted-autonomy-merge-per-repository_test.ts); and the moved-base merge
 * (D3), whose merged result no CI ever tests, ships disabled.
 */
import assert from "node:assert/strict";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import { HOSTED_AUTONOMY_SPENT_MOVED_BASE_MERGE } from "../../ops/hosted-autonomy-spent-delivery.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  parseReviewReceiptV1,
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import {
  deliveryOnly,
  liveReceipts,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  type LiveSurfaceOptionsV1,
  liveTask,
  mergedPull,
  mergeSha,
  MOVED_BASE,
  NOW,
  openPull,
  readSnapshot,
  runAt,
  TIP,
} from "./hosted-autonomy-spent-fixtures.ts";

/** The live spent records whose exact head is green, and live 678. */
const LIVE_SPENT = [618, 698, 879, 678] as const;

Deno.test("spent delivery S8: one merge per pass, then the ordinary already-recorded release wait", async () => {
  // Onto moved tips, so D3 is enabled for this test.
  const first = liveRecord(618);
  const second = liveRecord(879);
  const receipts = [...liveReceipts(first), ...liveReceipts(second)];
  const options: LiveSurfaceOptionsV1 = {
    tip: TIP,
    tipFollowsMerges: true,
    green: {
      [first.target.head!]: true,
      [second.target.head!]: true,
      [TIP]: true,
    },
    pulls: { 1071: openPull(first), 1120: openPull(second) },
    afterMerge: {
      1071: mergedPull(first, TIP),
      1120: mergedPull(second, mergeSha(1071)),
    },
    tasks: { 618: liveTask(618, receipts), 879: liveTask(879, receipts) },
  };
  const { surface, calls } = liveSurface(options);
  const rig = await liveRig(
    "s8",
    liveSnapshot([first, second], receipts),
    surface,
  );
  try {
    const one = await runAt(rig, NOW, MOVED_BASE);
    assert.deepEqual(calls.merges, [1071], JSON.stringify(one.actions));
    assert.equal(rig.writes, 1);
    // The tip moved to the first merge, whose own CI has not completed: the
    // second moved-base merge waits for it.
    const two = await runAt(rig, NOW, MOVED_BASE);
    assert.deepEqual(calls.merges, [1071], JSON.stringify(two.actions));
    // Merged beside its open request while the release path is disabled:
    // counted once as a deferred release, with no gate read (JAM B12).
    assert.ok(
      two.actions.includes("release-deferred:count=1:release_path=disabled"),
      JSON.stringify(two.actions),
    );
    assert.ok(
      two.actions.includes(`delivery:${second.id}:base_ci_pending`),
      JSON.stringify(two.actions),
    );
    assert.equal(rig.writes, 1);
    options.green![mergeSha(1071)] = true;
    const three = await runAt(rig, NOW, MOVED_BASE);
    assert.deepEqual(
      calls.merges,
      [1071, 1120],
      JSON.stringify(three.actions),
    );
    assert.equal(rig.writes, 2);
    const four = await runAt(rig, NOW, MOVED_BASE);
    assert.deepEqual(calls.merges, [1071, 1120]);
    assert.equal(rig.writes, 2, "nothing more is written");
    for (const record of [first, second]) {
      assert.ok(
        four.actions.includes(`delivery:${record.id}:already_recorded`),
        JSON.stringify(four.actions),
      );
    }
    assert.ok(
      four.actions.includes("release-deferred:count=2:release_path=disabled"),
      JSON.stringify(four.actions),
    );
    const after = await readSnapshot(rig);
    assert.equal(after.releaseRequests.length, 2);
    assert.ok(after.work.every((record) => record.nextStep === "delivery"));
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("spent delivery S10: the moved-base merge (D3) ships disabled: a spent record on a moved base is never merged", async (t) => {
  // The merged result T + head is never CI-tested (the head's CI ran against
  // the old base B, the tip's CI covers T alone), so D3 waits for the owner.
  assert.equal(HOSTED_AUTONOMY_SPENT_MOVED_BASE_MERGE, false);
  for (const issue of LIVE_SPENT) {
    await t.step(`ai.ubq.fi#${issue} at the moved tip`, async () => {
      const record = liveRecord(issue);
      const receipts = liveReceipts(record);
      const pr = record.target.pr!;
      const issueNumber = record.related.issueNumber!;
      const { surface, calls } = liveSurface({
        tip: TIP,
        green: { [record.target.head!]: true, [TIP]: true },
        pulls: { [pr]: openPull(record) },
        afterMerge: { [pr]: mergedPull(record, TIP) },
        tasks: { [issueNumber]: liveTask(issueNumber, receipts) },
      });
      const rig = await liveRig(
        `s10-${issue}`,
        liveSnapshot([record], receipts),
        surface,
      );
      try {
        const result = await runAt(rig);
        assert.ok(
          result.actions.includes(`delivery:${record.id}:base_moved`),
          JSON.stringify(result.actions),
        );
        assert.deepEqual(calls.merges, []);
        assert.deepEqual(calls.advancedReads, [], "no compare read");
        assert.ok(!calls.greenReads.includes(TIP), "no tip CI read");
        assert.equal(rig.writes, 0);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

/**
 * Live 618 and a sibling (same head and base, its own issue, PR and bound
 * receipt) ordered after it, both green at their exact reviewed base.
 */
const SIBLING_TASK_TEXT = {
  issueNumber: 9000,
  title: "Deliver the exact synthetic sibling candidate",
  body: "Deliver the reviewed synthetic patch for issue 9000.",
};
const SIBLING_TASK = {
  ...SIBLING_TASK_TEXT,
  digest: await reviewTaskStatementDigest(SIBLING_TASK_TEXT),
};

function exactSiblings(): {
  first: WorkRecordV1;
  second: WorkRecordV1;
  receipts: ReviewReceiptV1[];
} {
  const first = liveRecord(618);
  const [receipt] = liveReceipts(first);
  const second = liveRecord(618, {
    id: "issue-ubiquity-ai.ubq.fi-9000",
    source: { kind: "issue", id: "9000", revision: first.source.revision },
    related: { incidentId: null, issueNumber: 9000 },
    target: { ...first.target, pr: 9100 },
  });
  const sibling = parseReviewReceiptV1({
    ...receipt,
    id: `review-receipt:${"8".repeat(64)}`,
    pullRequest: { ...receipt.pullRequest, number: 9100 },
    taskAcceptance: {
      ...receipt.taskAcceptance!,
      issueNumber: 9000,
      taskDigest: SIBLING_TASK.digest,
    },
  });
  return { first, second, receipts: [receipt, sibling] };
}

/** The two siblings' surface options at their exact base B. */
function siblingOptions(
  first: WorkRecordV1,
  second: WorkRecordV1,
  receipts: readonly ReviewReceiptV1[],
): LiveSurfaceOptionsV1 {
  const base = first.target.base!;
  return {
    tip: base,
    tipFollowsMerges: true,
    green: { [first.target.head!]: true, [base]: true },
    pulls: { 1071: openPull(first), 9100: openPull(second) },
    afterMerge: {
      1071: mergedPull(first, base),
      9100: mergedPull(second, mergeSha(1071)),
    },
    tasks: { 618: liveTask(618, receipts), 9000: { ...SIBLING_TASK } },
  };
}

/** One pass over `surface`; the merge calls it saw, the actions, the writes. */
async function onePass(
  name: string,
  records: WorkRecordV1[],
  receipts: ReviewReceiptV1[],
  surface: HostedAutonomyGitHubV1,
  extra: Parameters<typeof deliveryOnly>[2] = {},
): Promise<{ actions: string[]; writes: number; result: unknown }> {
  const rig = await liveRig(name, liveSnapshot(records, receipts), surface);
  try {
    const { result, actions } = await deliveryOnly(rig, NOW, extra);
    return { actions, writes: rig.writes, result };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("spent delivery S11: once a merge is called no further merge is attempted in the same pass", async (t) => {
  // Review probes P-A and P-A2: the base tip and the tip's CI are read once
  // per pass, so a second merge after anything going wrong past the first
  // merge call would land on the first merge's never-checked commit.
  const assertOneMerge = (
    merges: number[],
    actions: string[],
    deferred: WorkRecordV1,
  ) => {
    assert.equal(merges.length, 1, `merges=${merges} ${actions.join(" ")}`);
    assert.ok(
      actions.includes(`delivery:${deferred.id}:merge_deferred`),
      actions.join(" "),
    );
  };
  await t.step(
    "moved base, the post-merge read still shows the PR open (P-A)",
    async () => {
      const first = liveRecord(618);
      const second = liveRecord(879);
      const receipts = [...liveReceipts(first), ...liveReceipts(second)];
      const { surface, calls } = liveSurface({
        tip: TIP,
        tipFollowsMerges: true,
        green: {
          [first.target.head!]: true,
          [second.target.head!]: true,
          [TIP]: true,
        },
        pulls: { 1071: openPull(first), 1120: openPull(second) },
        // 1071's post-merge read is stale: the PR still reads open.
        afterMerge: { 1120: mergedPull(second, TIP) },
        tasks: { 618: liveTask(618, receipts), 879: liveTask(879, receipts) },
      });
      const out = await onePass(
        "s11-pa",
        [first, second],
        receipts,
        surface,
        MOVED_BASE,
      );
      assertOneMerge(calls.merges, out.actions, second);
      assert.deepEqual(calls.merges, [1071]);
      assert.ok(
        !calls.greenReads.includes(second.target.head!),
        "the deferred record reads no gate",
      );
      assert.equal(out.result, null);
      assert.equal(out.writes, 0);
    },
  );
  await t.step(
    "moved base, the post-merge read is unavailable (P-A2)",
    async () => {
      const first = liveRecord(618);
      const second = liveRecord(698);
      const receipts = [...liveReceipts(first), ...liveReceipts(second)];
      const base = liveSurface({
        tip: TIP,
        tipFollowsMerges: true,
        green: {
          [first.target.head!]: true,
          [second.target.head!]: true,
          [TIP]: true,
        },
        pulls: { 1071: openPull(first), 1112: openPull(second) },
        afterMerge: { 1112: mergedPull(second, TIP) },
        tasks: { 618: liveTask(618, receipts), 698: liveTask(698, receipts) },
      });
      const surface: HostedAutonomyGitHubV1 = {
        ...base.surface,
        readPull: (number, branch) =>
          number === 1071 && base.calls.merges.includes(1071)
            ? Promise.resolve(null)
            : base.surface.readPull(number, branch),
      };
      const out = await onePass(
        "s11-pa2",
        [first, second],
        receipts,
        surface,
        MOVED_BASE,
      );
      assertOneMerge(base.calls.merges, out.actions, second);
      assert.equal(
        base.calls.greenReads.filter((sha) => sha === TIP).length,
        1,
        "the tip's CI is read once, for the one merge",
      );
      assert.equal(out.writes, 0);
    },
  );
  await t.step(
    "exact base, the post-merge read still shows the PR open",
    async () => {
      const { first, second, receipts } = exactSiblings();
      const options = siblingOptions(first, second, receipts);
      delete options.afterMerge![1071];
      const { surface, calls } = liveSurface(options);
      const out = await onePass(
        "s11-exact",
        [first, second],
        receipts,
        surface,
      );
      assertOneMerge(calls.merges, out.actions, second);
      assert.deepEqual(calls.merges, [1071]);
      assert.equal(out.writes, 0);
    },
  );
  for (
    const [name, answer] of [
      ["the merge call throws", "throw"],
      ["the merge answer is lost", null],
      ["the merge is not observed", { merged: false, sha: null }],
    ] as const
  ) {
    await t.step(`exact base, ${name}`, async () => {
      const { first, second, receipts } = exactSiblings();
      const { surface } = liveSurface(siblingOptions(first, second, receipts));
      const attempted: number[] = [];
      const merging: HostedAutonomyGitHubV1 = {
        ...surface,
        merge: (number, head) => {
          attempted.push(number);
          if (attempted.length > 1) return surface.merge(number, head);
          return answer === "throw"
            ? Promise.reject(new Error("socket hang up"))
            : Promise.resolve(answer);
        },
      };
      const out = await onePass(
        `s11-merge-${name.length}`,
        [first, second],
        receipts,
        merging,
      );
      assertOneMerge(attempted, out.actions, second);
      assert.deepEqual(attempted, [1071]);
      assert.equal(out.writes, 0);
    });
  }
  await t.step(
    "exact base, the post-merge opt-out read is unavailable",
    async () => {
      const { first, second, receipts } = exactSiblings();
      const { surface, calls } = liveSurface(
        siblingOptions(first, second, receipts),
      );
      const optOutReads = new Map<number, number>();
      const reading: HostedAutonomyGitHubV1 = {
        ...surface,
        readIssueOptedOut: (number) => {
          const seen = (optOutReads.get(number) ?? 0) + 1;
          optOutReads.set(number, seen);
          // The pre-merge read answers; the post-merge read does not.
          return Promise.resolve(seen === 1 ? false : null);
        },
      };
      const out = await onePass(
        "s11-optout",
        [first, second],
        receipts,
        reading,
      );
      assert.ok(
        out.actions.includes(`delivery:${first.id}:task_acceptance_refused`),
        out.actions.join(" "),
      );
      assertOneMerge(calls.merges, out.actions, second);
      assert.equal(out.writes, 0);
    },
  );
  await t.step(
    "an already-merged record is still recorded after a merge call",
    async () => {
      // The bound is on merge CALLS: adopting a PR the App already merged is
      // read-only and still settles in the same pass.
      const { first, second, receipts } = exactSiblings();
      const options = siblingOptions(first, second, receipts);
      delete options.afterMerge![1071];
      options.pulls![9100] = mergedPull(second, first.target.base!);
      options.green![second.target.head!] = true;
      const { surface, calls } = liveSurface(options);
      const out = await onePass(
        "s11-adopt",
        [first, second],
        receipts,
        surface,
      );
      assert.deepEqual(calls.merges, [1071], out.actions.join(" "));
      assert.ok(
        out.actions.some((a) => a.startsWith(`request:${second.id}:`)),
        out.actions.join(" "),
      );
      assert.equal(out.writes, 1);
    },
  );
});
