/**
 * Spent-round delivery (owner decision 2026-10-16) on the live ai.ubq.fi
 * shapes of 23:21Z: a record whose review rounds are spent, whose LATEST
 * completed current-head review has no unresolved P0 and whose required CI
 * on that exact head is green merges through the trusted delivery path, also
 * on the Gateway, and is recorded exactly like an ordinary delivery (the
 * record advanced with the runtime's own `advanceToDelivery` beside one open
 * production request; no release is ever written). A red head never merges,
 * and nothing outside the closed spent shape is touched.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  parseReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import type {
  ReviewReceiptV1,
  ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import { TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL } from "../../src/repair/review-gate.ts";
import {
  authorizingReceipt,
  BASE,
  deliveryRecord,
  finding,
  HEAD,
  pullFacts,
} from "./hosted-autonomy-fixtures.ts";
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
import { spentReadWindow } from "../../ops/hosted-autonomy-spent-delivery.ts";

/** The three live records whose exact head is green after the re-runs. */
const GREEN_LIVE = [618, 698, 879] as const;

/** Surface options for one live record at the given tip. */
function optionsFor(
  record: WorkRecordV1,
  receipts: readonly ReviewReceiptV1[],
  tip: string,
  overrides: Partial<LiveSurfaceOptionsV1> = {},
): LiveSurfaceOptionsV1 {
  const pr = record.target.pr!;
  const issue = record.related.issueNumber!;
  return {
    tip,
    green: { [record.target.head!]: true, [tip]: true },
    pulls: { [pr]: openPull(record) },
    afterMerge: { [pr]: mergedPull(record, tip) },
    tasks: { [issue]: liveTask(issue, receipts) },
    ...overrides,
  };
}

/** The exact record a spent Gateway merge writes (`advanceToDelivery`). */
function advanced(record: WorkRecordV1): WorkRecordV1 {
  return {
    ...record,
    nextStep: "delivery",
    wait: null,
    blocker: null,
    updatedAt: NOW,
  };
}

async function withRig<T>(
  name: string,
  records: WorkRecordV1[],
  reviews: ReviewReceiptV1[],
  options: LiveSurfaceOptionsV1,
  body: (
    rig: Awaited<ReturnType<typeof liveRig>>,
    calls: ReturnType<typeof liveSurface>["calls"],
  ) => Promise<T>,
): Promise<T> {
  const { surface, calls } = liveSurface(options);
  const rig = await liveRig(name, liveSnapshot(records, reviews), surface);
  try {
    return await body(rig, calls);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("spent delivery S1: a green spent Gateway head at its reviewed base merges and is recorded like a delivery", async (t) => {
  for (const issue of GREEN_LIVE) {
    await t.step(`ai.ubq.fi#${issue}`, async () => {
      const record = liveRecord(issue);
      const receipts = liveReceipts(record);
      assert.equal(receipts.length, 1, "exactly one bound receipt live");
      const options = optionsFor(record, receipts, record.target.base!);
      await withRig(
        `s1-${issue}`,
        [record],
        receipts,
        options,
        async (rig, calls) => {
          const { result, actions } = await deliveryOnly(rig);
          assert.deepEqual(calls.merges, [record.target.pr], actions.join(" "));
          assert.equal(result?.status, "applied", JSON.stringify(result));
          assert.equal(rig.writes, 1);
          const after = await readSnapshot(rig);
          assert.deepEqual(after.work, [advanced(record)]);
          assert.equal(after.releaseRequests.length, 1);
          const request = after.releaseRequests[0];
          assert.equal(request.status, "open");
          assert.equal(request.revision, mergeSha(record.target.pr!));
          assert.deepEqual(request.source, {
            pullRequest: record.target.pr,
            reviewRequestId: receipts[0].requestId,
            reviewReceiptId: receipts[0].id,
            head: record.target.head,
            base: record.target.base,
          });
          assert.deepEqual(after.reviews, receipts, "receipts untouched");
        },
      );
    });
  }
});

Deno.test("spent delivery S2: once enabled, a spent Gateway head merges onto a moved base only under the full moved-base rule", async (t) => {
  // D3 ships disabled (hosted-autonomy-spent-merge-bound_test.ts); these
  // steps enable it to test its gate.
  const record = liveRecord(618);
  const receipts = liveReceipts(record);
  const base = record.target.base!;
  await t.step(
    "live shape: B is an ancestor of the green tip, mergeable",
    async () => {
      await withRig(
        "s2-merge",
        [record],
        receipts,
        optionsFor(record, receipts, TIP),
        async (rig, calls) => {
          const result = await runAt(rig, NOW, MOVED_BASE);
          assert.deepEqual(
            calls.merges,
            [1071],
            JSON.stringify(result.actions),
          );
          assert.equal(result.status, "applied");
          assert.deepEqual(calls.advancedReads, [`${base}...${TIP}`]);
          assert.ok(calls.greenReads.includes(TIP), "the tip's own CI is read");
          const after = await readSnapshot(rig);
          assert.deepEqual(after.work, [advanced(record)]);
          // The request binds the REVIEWED base B; the merge landed on T.
          assert.equal(after.releaseRequests[0].source.base, base);
          assert.equal(after.releaseRequests[0].revision, mergeSha(1071));
        },
      );
    },
  );
  const refusals: [string, Partial<LiveSurfaceOptionsV1>, string][] = [
    [
      "tip CI pending",
      { green: { [record.target.head!]: true } },
      "base_ci_pending",
    ],
    ["mergeability pending", {
      pulls: { 1071: openPull(record, { mergeable: null }) },
    }, "mergeability_pending"],
    [
      "conflicted",
      { pulls: { 1071: openPull(record, { mergeable: false }) } },
      "merge_conflicted",
    ],
    ["rewritten base", { advanced: () => false }, "base_moved"],
    ["pull base drifted", {
      pulls: { 1071: openPull(record, { baseSha: TIP }) },
    }, "base_moved"],
  ];
  for (const [name, overrides, action] of refusals) {
    await t.step(name, async () => {
      await withRig(
        `s2-${action}`,
        [record],
        receipts,
        optionsFor(record, receipts, TIP, overrides),
        async (rig, calls) => {
          const { actions } = await deliveryOnly(rig, NOW, MOVED_BASE);
          assert.ok(
            actions.includes(`delivery:${record.id}:${action}`),
            actions.join(" "),
          );
          assert.deepEqual(calls.merges, []);
          assert.equal(rig.writes, 0);
        },
      );
    });
  }
  await t.step(
    "a delivery-step spent record (live 678) merges onto the moved tip",
    async () => {
      // 678 waits `ci_pending` on its old base b89a9978 with five rounds spent;
      // the runtime would refresh it (a new head, another round) instead.
      const delivery = liveRecord(678);
      const reviews = liveReceipts(delivery);
      assert.equal(delivery.wait?.reason, "ci_pending");
      await withRig(
        "s2-678",
        [delivery],
        reviews,
        optionsFor(delivery, reviews, TIP),
        async (rig, calls) => {
          const { result, actions } = await deliveryOnly(rig, NOW, MOVED_BASE);
          assert.equal(result?.status, "applied", actions.join(" "));
          assert.deepEqual(calls.merges, [1097]);
          const after = await readSnapshot(rig);
          assert.deepEqual(after.work, [advanced(delivery)]);
          assert.equal(
            after.releaseRequests[0].source.base,
            delivery.target.base,
          );
        },
      );
    },
  );
  await t.step(
    "a review-step spent record with a review in flight is not merged",
    async () => {
      const delivery = liveRecord(678);
      const reviewing = liveRecord(678, {
        nextStep: "review",
        wait: {
          reason: "review_pending",
          since: NOW - 60_000,
          until: NOW + 60_000,
        },
      });
      const reviews = liveReceipts(delivery);
      await withRig(
        "s2-review",
        [reviewing],
        reviews,
        optionsFor(reviewing, reviews, TIP),
        async (rig, calls) => {
          const { actions } = await deliveryOnly(rig, NOW, MOVED_BASE);
          assert.ok(
            actions.includes(`delivery:${reviewing.id}:base_moved`),
            actions.join(" "),
          );
          assert.deepEqual(calls.merges, []);
          assert.equal(rig.writes, 0);
        },
      );
    },
  );
  await t.step("a self record keeps the exact-base rule", async () => {
    const self = deliveryRecord({
      nextStep: "blocked",
      blocker: {
        kind: "other",
        message: "CI checks failed: test-local(failure)",
        since: 1,
      },
      counters: { attempts: 3, retries: 0, reviewRounds: 3 },
    });
    const receipt = authorizingReceipt();
    await withRig("s2-self", [self], [receipt], {
      tip: TIP,
      green: { [HEAD]: true, [TIP]: true },
      pulls: {
        51: pullFacts({
          state: "open",
          merged: false,
          mergeCommitSha: null,
          mergeable: true,
        }),
      },
      tasks: {},
      extra: {
        readIssueTask: () =>
          Promise.resolve({
            issueNumber: 48,
            title: "t",
            body: "",
            digest: receipt.taskAcceptance!.taskDigest,
          }),
      },
    }, async (rig, calls) => {
      const { actions } = await deliveryOnly(rig, NOW, MOVED_BASE);
      assert.ok(
        actions.includes(`delivery:${self.id}:base_moved`),
        actions.join(" "),
      );
      assert.deepEqual(calls.merges, []);
      assert.equal(rig.writes, 0);
    });
  });
});

Deno.test("spent delivery S3: a spent head whose required CI is red is never merged", async (t) => {
  for (const issue of [595, 137]) {
    for (const where of ["moved", "exact"] as const) {
      await t.step(`ai.ubq.fi#${issue} ${where} base`, async () => {
        const record = liveRecord(issue);
        const receipts = liveReceipts(record);
        const tip = where === "moved" ? TIP : record.target.base!;
        const options = optionsFor(record, receipts, tip, {
          green: { [tip]: true },
        });
        await withRig(
          `s3-${issue}-${where}`,
          [record],
          receipts,
          options,
          async (rig, calls) => {
            const { actions } = await deliveryOnly(
              rig,
              NOW,
              where === "moved" ? MOVED_BASE : {},
            );
            assert.ok(
              actions.includes(`delivery:${record.id}:checks_pending`),
              actions.join(" "),
            );
            assert.deepEqual(calls.merges, []);
            assert.equal(rig.writes, 0);
          },
        );
      });
    }
  }
});

/**
 * A later completed P0 review of the same head and base (owner directive
 * 2026-10-24: only an unresolved P0 blocks a merge).
 */
function laterP0(receipt: ReviewReceiptV1): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    ...receipt,
    id: `review-receipt:${"9".repeat(64)}`,
    requestId: `${receipt.requestId}:later`,
    findings: [finding("P0")],
    unresolvedSeverities: ["P0"],
    completedAt: receipt.completedAt! + 60_000,
    observedAt: receipt.observedAt + 60_000,
  });
}

Deno.test("spent delivery S4: the LATEST completed current-head review decides", async (t) => {
  await t.step("Gateway: a later P0 after a clean review refuses", async () => {
    const record = liveRecord(618);
    const receipts = liveReceipts(record);
    const reviews = [...receipts, laterP0(receipts[0])];
    await withRig(
      "s4-gateway",
      [record],
      reviews,
      optionsFor(record, receipts, record.target.base!),
      async (rig, calls) => {
        const { actions } = await deliveryOnly(rig);
        assert.ok(
          actions.includes(`delivery:${record.id}:latest_review_blocking`),
          actions.join(" "),
        );
        assert.deepEqual(calls.merges, []);
        assert.equal(rig.writes, 0);
      },
    );
  });
  await t.step(
    "self: a delivery record whose later review has a P0 is not merged",
    async () => {
      const self = deliveryRecord();
      const receipt = authorizingReceipt();
      await withRig("s4-self", [self], [receipt, laterP0(receipt)], {
        tip: BASE,
        green: { [HEAD]: true },
        pulls: {
          51: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
        },
        afterMerge: { 51: pullFacts() },
        extra: {
          readIssueTask: () =>
            Promise.resolve({
              issueNumber: 48,
              title: "t",
              body: "",
              digest: receipt.taskAcceptance!.taskDigest,
            }),
        },
      }, async (rig, calls) => {
        const { actions } = await deliveryOnly(rig);
        assert.ok(
          actions.includes(`delivery:${self.id}:latest_review_blocking`),
          actions.join(" "),
        );
        assert.deepEqual(calls.merges, []);
        assert.equal(rig.writes, 0);
      });
    },
  );
});

Deno.test("spent delivery S5: a record outside the closed spent shape is never merged or read", async (t) => {
  const green = liveRecord(618);
  const greenReceipts = liveReceipts(green);
  const variants: [string, WorkRecordV1][] = [
    ["live 112 (task acceptance)", liveRecord(112)],
    ["live 263 (missing acceptance)", liveRecord(263)],
    ["live 421 (merged outside)", liveRecord(421)],
    ["live sentinel#79 (retired)", liveRecord(79, {}, "sentinel")],
    [
      "intent set",
      liveRecord(618, {
        intent: {
          kind: "base_refresh",
          key: `base_refresh:1071:${green.target.head}:${TIP}`,
          startedAt: NOW - 1000,
          branch: green.target.branch,
          expectedHead: green.target.head,
          observedBase: TIP,
          pr: 1071,
          requestId: null,
          resultId: null,
        },
      }),
    ],
    [
      "newer candidate",
      liveRecord(618, {
        target: {
          ...green.target,
          candidateState: {
            ...green.target.candidateState,
            publishedHead: "1".repeat(40),
          },
        },
      }),
    ],
    [
      "conflict block",
      liveRecord(618, {
        blocker: {
          kind: "other",
          message: `base refresh has conflicts at ${TIP}`,
          since: 1,
        },
      }),
    ],
    [
      "preservation unrecoverable",
      liveRecord(618, {
        blocker: {
          kind: "other",
          message: "candidate preservation unrecoverable: ref missing",
          since: 1,
        },
      }),
    ],
    [
      "release block",
      liveRecord(618, {
        blocker: {
          kind: "other",
          message: "release request failed: rejected",
          since: 1,
        },
      }),
    ],
    [
      "attempt budget",
      liveRecord(618, {
        blocker: {
          kind: "review_quota",
          message: "implementation attempt budget exhausted",
          since: 1,
        },
      }),
    ],
  ];
  for (const [name, record] of variants) {
    await t.step(name, async () => {
      const receipts = liveReceipts(record);
      const reviews = receipts.length > 0 ? receipts : greenReceipts;
      const options = optionsFor(record, reviews, record.target.base!);
      await withRig(
        `s5-${record.id.slice(-4)}`,
        [record],
        reviews,
        options,
        async (rig, calls) => {
          const { actions } = await deliveryOnly(rig);
          // JAM B6b: a spent not-fulfilled acceptance is owner gated, named
          // once in the summary instead of the per-pass refusal line.
          assert.ok(
            actions.includes(
              record.blocker?.message === TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL
                ? `owner_gate:task_acceptance_not_fulfilled:n=1:${record.id}`
                : `delivery:${record.id}:spent_not_admissible`,
            ),
            actions.join(" "),
          );
          assert.deepEqual(calls.merges, []);
          assert.deepEqual(calls.greenReads, [], "no CI read");
          assert.equal(rig.writes, 0);
        },
      );
    });
  }
});

Deno.test("spent delivery S6: the source issue and the release binding are proven before the merge", async (t) => {
  const record = liveRecord(879);
  const receipts = liveReceipts(record);
  const base = record.target.base!;
  await t.step("source issue closed", async () => {
    await withRig(
      "s6-closed",
      [record],
      receipts,
      optionsFor(record, receipts, base, { issueOpen: { 879: false } }),
      async (rig, calls) => {
        const { actions } = await deliveryOnly(rig);
        assert.ok(
          actions.includes(`delivery:${record.id}:issue_not_open`),
          actions.join(" "),
        );
        assert.deepEqual(calls.merges, []);
      },
    );
  });
  await t.step("source issue unreadable", async () => {
    await withRig(
      "s6-unreadable",
      [record],
      receipts,
      optionsFor(record, receipts, base, { issueOpen: { 879: null } }),
      async (rig, calls) => {
        const { actions } = await deliveryOnly(rig);
        assert.ok(
          actions.includes(`delivery:${record.id}:issue_not_open`),
          actions.join(" "),
        );
        assert.deepEqual(calls.merges, []);
      },
    );
  });
  await t.step("opted out", async () => {
    await withRig(
      "s6-optout",
      [record],
      receipts,
      optionsFor(record, receipts, base, {
        extra: {
          readIssueOptedOut: () => Promise.resolve(true as boolean | null),
        },
      }),
      async (rig, calls) => {
        const { actions } = await deliveryOnly(rig);
        assert.ok(
          actions.includes(`delivery:${record.id}:task_acceptance_refused`),
          actions.join(" "),
        );
        assert.deepEqual(calls.merges, []);
      },
    );
  });
  await t.step("a request that could never bind (installation 0)", async () => {
    const repository = { ...record.repository, installationId: 0 };
    const unbound = liveRecord(879, { repository });
    const reviews = receipts.map((receipt) =>
      parseReviewReceiptV1({ ...receipt, repository })
    );
    await withRig(
      "s6-unbindable",
      [unbound],
      reviews,
      optionsFor(unbound, reviews, base),
      async (rig, calls) => {
        const { actions } = await deliveryOnly(rig);
        assert.ok(
          actions.includes(`delivery:${unbound.id}:request_unbindable`),
          actions.join(" "),
        );
        assert.deepEqual(calls.merges, []);
        assert.equal(rig.writes, 0);
      },
    );
  });
  await t.step("an acceptance bound to another issue", async () => {
    const reviews = receipts.map((receipt) =>
      parseReviewReceiptV1({
        ...receipt,
        taskAcceptance: { ...receipt.taskAcceptance!, issueNumber: 880 },
      })
    );
    await withRig(
      "s6-mismatch",
      [record],
      reviews,
      optionsFor(record, receipts, base),
      async (rig, calls) => {
        const { actions } = await deliveryOnly(rig);
        assert.ok(
          actions.includes(`delivery:${record.id}:task_acceptance_refused`),
          actions.join(" "),
        );
        assert.deepEqual(calls.merges, []);
      },
    );
  });
});

Deno.test("spent delivery S7: an already-merged spent PR is adopted only from the App's own green merge", async (t) => {
  const record = liveRecord(698);
  const receipts = liveReceipts(record);
  const base = record.target.base!;
  await t.step("merged by the App (the crash window)", async () => {
    await withRig(
      "s7-app",
      [record],
      receipts,
      optionsFor(record, receipts, base, {
        pulls: { 1112: mergedPull(record, base) },
      }),
      async (rig, calls) => {
        const { result, actions } = await deliveryOnly(rig);
        assert.equal(result?.status, "applied", actions.join(" "));
        assert.deepEqual(calls.merges, [], "no merge call");
        const after = await readSnapshot(rig);
        assert.deepEqual(after.work, [advanced(record)]);
        assert.equal(after.releaseRequests[0].revision, mergeSha(1112));
      },
    );
  });
  for (
    const [name, overrides] of [
      ["merged by the owner (the PR 1088 shape)", { mergedBy: "0x4007" }],
      ["merged by the App with red CI", {}],
    ] as const
  ) {
    await t.step(name, async () => {
      const green = name.includes("red") ? {} : { [record.target.head!]: true };
      await withRig(
        `s7-${name.length}`,
        [record],
        receipts,
        optionsFor(record, receipts, base, {
          green,
          pulls: { 1112: mergedPull(record, base, overrides) },
        }),
        async (rig, calls) => {
          const { actions } = await deliveryOnly(rig);
          assert.ok(
            actions.includes(
              `delivery:${record.id}:merged_outside_trusted_path`,
            ),
            actions.join(" "),
          );
          assert.deepEqual(calls.merges, []);
          assert.equal(rig.writes, 0, "nothing is written");
        },
      );
    });
  }
});

Deno.test("spent delivery S9: an ordinary delivery record keeps today's write", async () => {
  // Live 592: a delivery-step record with a round left, here without its
  // request, merged at its exact base: only `nextStep` and `updatedAt` move.
  const record = liveRecord(592);
  const receipts = liveReceipts(record);
  await withRig(
    "s9",
    [record],
    receipts,
    optionsFor(record, receipts, record.target.base!),
    async (rig, calls) => {
      const { result, actions } = await deliveryOnly(rig);
      assert.equal(result?.status, "applied", actions.join(" "));
      assert.deepEqual(calls.merges, [1105]);
      const after = await readSnapshot(rig);
      assert.deepEqual(after.work, [{
        ...record,
        nextStep: "delivery",
        updatedAt: NOW,
      }]);
      assert.notEqual(after.work[0].wait, null, "the wait is kept");
    },
  );
});

/** Only these ten synthetic clones receive these explicit source statements. */
const CLONED_SPENT_TASKS = new Map(
  await Promise.all(
    [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009]
      .map(async (issueNumber) => {
        const text = {
          issueNumber,
          title: `Deliver synthetic spent candidate ${issueNumber}`,
          body:
            `Deliver the exact reviewed synthetic patch for issue ${issueNumber}.`,
        };
        return [issueNumber, {
          ...text,
          digest: await reviewTaskStatementDigest(text),
        }] as const;
      }),
  ),
);

/** Ten spent copies of live 618, each with its own PR, issue and receipt. */
function tenSpentRecords(): {
  records: WorkRecordV1[];
  reviews: ReviewReceiptV1[];
  tasks: Record<number, ReviewTaskStatementV1>;
} {
  const base = liveRecord(618);
  const receipt = liveReceipts(base)[0];
  const records: WorkRecordV1[] = [];
  const reviews: ReviewReceiptV1[] = [];
  for (let index = 0; index < 10; index++) {
    const pr = 2000 + index;
    const record = liveRecord(618, {
      id: `issue-ubiquity-ai.ubq.fi-${3000 + index}`,
      source: {
        kind: "issue",
        id: String(3000 + index),
        revision: base.source.revision,
      },
      related: { incidentId: null, issueNumber: 3000 + index },
      target: { ...base.target, pr },
    });
    records.push(record);
    reviews.push(parseReviewReceiptV1({
      ...receipt,
      id: `review-receipt:${index.toString(16).padStart(64, "0")}`,
      pullRequest: { ...receipt.pullRequest, number: pr },
      taskAcceptance: {
        ...receipt.taskAcceptance!,
        issueNumber: 3000 + index,
        taskDigest: CLONED_SPENT_TASKS.get(3000 + index)!.digest,
      },
    }));
  }
  return { records, reviews, tasks: Object.fromEntries(CLONED_SPENT_TASKS) };
}

Deno.test("spent delivery: every eligible spent record is read on each pass", async () => {
  const { records, reviews, tasks } = tenSpentRecords();
  const seen = new Set<string>();
  for (const now of [NOW, NOW + 300_000]) {
    await withRig(
      `cap-${now}`,
      records,
      reviews,
      { tip: TIP, green: {}, tasks },
      async (rig, calls) => {
        const { actions } = await deliveryOnly(rig, now);
        const deferred = actions.filter((action) =>
          action.endsWith(":spent_deferred")
        );
        assert.equal(deferred.length, 0, actions.join(" "));
        assert.deepEqual(calls.merges, []);
        for (const record of records) {
          if (!deferred.includes(`delivery:${record.id}:spent_deferred`)) {
            seen.add(record.id);
          }
        }
      },
    );
  }
  assert.equal(seen.size, 10, "no spent record waits for a rotating slot");
});

Deno.test("spent delivery: a record an earlier write of the pass settled takes no read slot", () => {
  // The continuation runner leaves a settled record to the next pass; the
  // delivery pass skips it, so it must not displace an unsettled record.
  const { records, reviews } = tenSpentRecords();
  const snapshot = liveSnapshot(records, reviews);
  const window = spentReadWindow(snapshot, NOW);
  assert.equal(window.size, 10);
  const settled = new Set([...window].slice(0, 2));
  const continued = spentReadWindow(snapshot, NOW, settled);
  assert.equal(continued.size, 8);
  for (const id of settled) assert.equal(continued.has(id), false, id);
  assert.deepEqual(
    [...continued].sort(),
    records.map((record) => record.id).filter((id) => !settled.has(id)).sort(),
  );
});
