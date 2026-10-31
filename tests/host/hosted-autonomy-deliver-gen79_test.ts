/**
 * Rollback proof for the spent-round delivery and the review follow-ups.
 * Generation 80 has the generation-79 runtime R79 549c7a691 as its rollback
 * target and the live launcher L79 7e38d16a4 as the launcher's, so their OWN
 * code (extracted read-only from the pinned commits) must accept every state
 * shape this launcher writes and every issue it files:
 *
 * - R79's parsers accept every written snapshot (exact base, moved base and
 *   the adopted crash window);
 * - R79's own Gateway binding binds the recorded request to the advanced
 *   record (and refuses the blocked shape it replaces), and its VPS delivery
 *   observation waits: no release is fabricated;
 * - R79's repair entrypoint over the written state waits on the request:
 *   no merge, no refresh intent, the request unchanged;
 * - L79's maintenance chain over it reports `already_recorded` and
 *   `release_unavailable` and writes nothing;
 * - R79's task-statement check and intake opt-out reader admit the rendered
 *   follow-up issues as ordinary issues.
 *
 * Every case is ignored in a checkout without the pinned commits.
 */
import assert from "node:assert/strict";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { StateReadView } from "../../src/contracts/ports.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { assertGen79Parses } from "../state/gen77-contracts.ts";
import {
  gen79Available,
  l79Available,
  loadGen79Modules,
  loadL79Modules,
} from "./gen77-runtime-source.ts";
import {
  BASE,
  FOREIGN_TASK,
  foreignReceipt,
  foreignRecord,
  HEAD,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";
import {
  allLiveReceipts,
  deliveryOnly,
  HOSTILE,
  liveReceipts,
  liveRecord,
  liveRequest,
  liveRig,
  liveSnapshot,
  liveSurface,
  type LiveSurfaceOptionsV1,
  liveTask,
  mergedPull,
  MOVED_BASE,
  NOW,
  openPull,
  readSnapshot,
  TIP,
} from "./hosted-autonomy-spent-fixtures.ts";
import {
  planFollowUpCandidates,
  renderFollowUpIssue,
} from "../../ops/hosted-autonomy-follow-ups.ts";
import { T0 } from "../state/helpers.ts";

const r79 = await gen79Available();
const l79 = await l79Available();

interface R79DeliveryV1 {
  gatewayRequestBindsDelivery(
    request: ReleaseRequestV1,
    record: WorkRecordV1,
    review: ReviewReceiptV1 | null,
    revision?: string,
  ): Promise<boolean>;
  observeGatewayVpsDelivery(
    state: Pick<StateReadView, "readRelease">,
    record: WorkRecordV1,
    request: ReleaseRequestV1,
    review: ReviewReceiptV1 | null,
  ): Promise<{ kind: string }>;
}
interface R79RecordsV1 {
  releaseRequestMatchesDelivery(
    request: ReleaseRequestV1,
    record: WorkRecordV1,
  ): boolean;
}

/** One spent live record merged by this launcher; the written snapshot. */
async function writtenBy(
  name: string,
  issue: number,
  shape: "exact" | "moved" | "adopted",
): Promise<{
  before: WorkRecordV1;
  after: RepairStateSnapshotV1;
  receipt: ReviewReceiptV1;
}> {
  const record = liveRecord(issue);
  const receipts = liveReceipts(record);
  const base = record.target.base!;
  const tip = shape === "moved" ? TIP : base;
  const pr = record.target.pr!;
  const options: LiveSurfaceOptionsV1 = {
    tip,
    green: { [record.target.head!]: true, [tip]: true },
    pulls: {
      [pr]: shape === "adopted" ? mergedPull(record, base) : openPull(record),
    },
    afterMerge: { [pr]: mergedPull(record, tip) },
    tasks: { [issue]: liveTask(issue, receipts) },
  };
  const { surface } = liveSurface(options);
  const rig = await liveRig(name, liveSnapshot([record], receipts), surface);
  try {
    // The moved shape is written only once D3 is enabled (it ships disabled).
    const { result } = await deliveryOnly(
      rig,
      NOW,
      shape === "moved" ? MOVED_BASE : {},
    );
    assert.equal(result?.status, "applied", JSON.stringify(result));
    return {
      before: record,
      after: await readSnapshot(rig),
      receipt: receipts[0],
    };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test({
  name:
    "R79 rollback: every spent-delivery snapshot parses, binds and waits under R79's own code",
  ignore: !r79,
  async fn() {
    const loaded = await loadGen79Modules([
      "src/repair/vps-delivery.ts",
      "src/repair/loop-records.ts",
    ]);
    try {
      const [vps, records] = loaded.modules as unknown as [
        R79DeliveryV1,
        R79RecordsV1,
      ];
      for (
        const [issue, shape] of [
          [618, "exact"],
          [879, "moved"],
          [698, "adopted"],
        ] as const
      ) {
        const { before, after, receipt } = await writtenBy(
          `r79-${issue}`,
          issue,
          shape,
        );
        await assertGen79Parses(after);
        const [written] = after.work;
        const [request] = after.releaseRequests;
        assert.equal(written.nextStep, "delivery");
        assert.equal(
          await vps.gatewayRequestBindsDelivery(request, written, receipt),
          true,
          `${issue} binds under R79`,
        );
        assert.equal(
          await vps.gatewayRequestBindsDelivery(request, before, receipt),
          false,
          "the blocked shape it replaces never binds",
        );
        assert.equal(
          records.releaseRequestMatchesDelivery(request, written),
          true,
        );
        assert.deepEqual(
          await vps.observeGatewayVpsDelivery(
            {
              readRelease: () =>
                Promise.resolve({
                  ok: true,
                  value: { status: "absent" },
                } as never),
            },
            written,
            request,
            receipt,
          ),
          { kind: "wait" },
          "no release exists, so R79 waits",
        );
      }
    } finally {
      await loaded.dispose();
    }
  },
});

/** The Gateway identity R79's own loop rig configures (installation 7). */
const RIG_GATEWAY = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 };

/** A spent, CI-blocked Gateway record in R79's rig identity, merged here. */
async function rigShapeWritten(): Promise<RepairStateSnapshotV1> {
  const base = foreignRecord();
  const record = parseWorkRecordV1({
    ...base,
    repository: RIG_GATEWAY,
    target: {
      ...base.target,
      candidateState: {
        preserved: {
          operationKey: `impl:${"d".repeat(64)}`,
          base: BASE,
          head: HEAD,
          ref: `refs/heads/sentinel-candidates/${"c".repeat(64)}`,
        },
        publishedHead: HEAD,
      },
    },
    counters: { attempts: 3, retries: 0, reviewRounds: 4 },
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "CI checks failed: verify-artifact(skipped), validate(failure)",
      since: T0 + 3000,
    },
  });
  const receipt = parseReviewReceiptV1({
    ...foreignReceipt(),
    repository: RIG_GATEWAY,
  });
  const { surface } = liveSurface({
    tip: BASE,
    green: { [HEAD]: true },
    pulls: { [record.target.pr!]: openPull(record) },
    afterMerge: { [record.target.pr!]: mergedPull(record, BASE) },
    tasks: { [FOREIGN_TASK.issueNumber]: FOREIGN_TASK },
  });
  const { rig } = await makeRig("r79-loop-seed", {
    repair: repairSnapshot([record], [receipt]),
  });
  rig.githubFor = () => surface;
  try {
    const { result } = await deliveryOnly(rig, T0 + 5_000_000);
    assert.equal(result?.status, "applied", JSON.stringify(result));
    return await readSnapshot(rig);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test({
  name:
    "R79 rollback: R79's repair entrypoint waits on the recorded request without a merge or refresh",
  ignore: !r79,
  async fn() {
    const written = await rigShapeWritten();
    await assertGen79Parses(written);
    const loaded = await loadGen79Modules([
      "tests/repair/loop-rig.ts",
      "src/contracts/ports.ts",
    ]);
    // deno-lint-ignore no-explicit-any
    const [loopRig, ports] = loaded.modules as any[];
    const rig = await loopRig.makeRig("gen80-spent-r79", {
      summaries: false,
      localScope: true,
    });
    try {
      rig.clock.advance(written.updatedAt - rig.clock.now() + 60_000);
      const seeded = await rig.store.writeRepair(
        loopRig.seededSnapshot(written.work, {
          reviews: written.reviews,
          releaseRequests: written.releaseRequests,
          updatedAt: written.updatedAt,
        }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      Object.assign(rig.store, {
        readHostedRelease: () => Promise.resolve(ports.portOk(null)),
      });
      const run = await rig.entry();
      assert.notEqual(run.status, "state_error", JSON.stringify(run));
      const after = await rig.snapshot();
      const [record] = after.work;
      assert.equal(record.nextStep, "delivery", JSON.stringify(record));
      assert.equal(
        record.wait?.reason,
        "unavailable",
        "R79 waits on the recorded request exactly like a live delivered record",
      );
      assert.equal(record.blocker, null);
      assert.equal(record.intent, null, "no refresh or merge intent");
      // R79 only counts the unchanged wait (`stalled`, as on the live
      // delivered records); no attempt, retry or review round is charged.
      const { attempts, retries, reviewRounds } = written.work[0].counters;
      assert.deepEqual(
        {
          attempts: record.counters.attempts,
          retries: record.counters.retries,
          reviewRounds: record.counters.reviewRounds,
        },
        { attempts, retries, reviewRounds },
      );
      assert.deepEqual(after.releaseRequests, written.releaseRequests);
      const effects = (rig.github.calls as string[]).filter((call) =>
        /^(merge|closeIssue|push|createPr|requestReview|assignIssue)/
          .test(call)
      );
      assert.deepEqual(effects, [], JSON.stringify(rig.github.calls));
    } finally {
      await rig.ctx.cleanup();
      await loaded.dispose();
    }
  },
});

Deno.test({
  name:
    "L79 rollback: the live launcher reports already_recorded and release_unavailable and writes nothing",
  ignore: !l79,
  async fn() {
    const loaded = await loadL79Modules(["ops/hosted-autonomy-runner.ts"]);
    // deno-lint-ignore no-explicit-any
    const [runner] = loaded.modules as any[];
    const record = liveRecord(879);
    const receipts = liveReceipts(record);
    const base = record.target.base!;
    const { surface } = liveSurface({
      tip: base,
      green: { [record.target.head!]: true, [base]: true },
      pulls: { 1120: openPull(record) },
      afterMerge: { 1120: mergedPull(record, base) },
      tasks: { 879: liveTask(879, receipts) },
    });
    const rig = await liveRig("l79", liveSnapshot([record], receipts), surface);
    try {
      // This launcher merges and records it at its reviewed base...
      const { result } = await deliveryOnly(rig);
      assert.equal(result?.status, "applied");
      const writes = rig.writes;
      // ...then the launcher is rolled back to L79.
      for (const pass of [1, 2]) {
        const rolled = await runner.runHostedAutonomy({
          state: rig.state,
          githubFor: rig.githubFor,
          clock: { now: () => NOW + pass * 300_000 },
        });
        assert.ok(
          rolled.actions.includes(`delivery:${record.id}:already_recorded`),
          JSON.stringify(rolled.actions),
        );
        assert.ok(
          rolled.actions.includes(`delivery:${record.id}:release_unavailable`),
          JSON.stringify(rolled.actions),
        );
      }
      assert.equal(rig.writes, writes, "L79 writes nothing");
      const after = await readSnapshot(rig);
      assert.equal(after.work[0].nextStep, "delivery");
      assert.equal(after.releaseRequests[0].source.base, base);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
      await loaded.dispose();
    }
  },
});

interface R79TaskV1 {
  checkReviewTaskStatement(input: unknown): Promise<{ ok: boolean }>;
  reviewTaskStatementDigest(input: unknown): Promise<string>;
}
interface R79WireV1 {
  parseIssueWire(
    input: unknown,
    path: string,
  ): { kind: string; issue?: { body: string; title: string } };
}
interface R79LocalV1 {
  scopeLocalRepairIssues(port: unknown): {
    listOpenIssues(): Promise<{ ok: boolean; value: unknown[] }>;
  };
}

Deno.test({
  name:
    "R79 rollback: live and hostile follow-up issues are ordinary admissible issues for R79",
  ignore: !r79,
  async fn() {
    const loaded = await loadGen79Modules([
      "src/contracts/review-receipt.ts",
      "src/github/wire.ts",
      "src/host/local-github.ts",
    ]);
    try {
      const [task, wire, local] = loaded.modules as unknown as [
        R79TaskV1,
        R79WireV1,
        R79LocalV1,
      ];
      const request = liveRequest(1052);
      const reviews = allLiveReceipts();
      const live = planFollowUpCandidates(
        liveSnapshot([liveRecord(600)], reviews, [request]),
        NOW,
      )[0];
      const hostile = {
        ...live,
        findings: [{
          ...live.findings[0],
          message: HOSTILE,
          path: "src/a b.ts",
        }],
      };
      for (const [index, candidate] of [live, hostile].entries()) {
        const issue = renderFollowUpIssue({
          candidate,
          finding: candidate.findings[0],
          mergeRevision: request.revision,
          depth: index + 1,
        })!;
        const statement = {
          issueNumber: 6000 + index,
          title: issue.title,
          body: issue.body,
        };
        const checked = await task.checkReviewTaskStatement({
          ...statement,
          digest: await task.reviewTaskStatementDigest(statement),
        });
        assert.equal(checked.ok, true, "R79 accepts the task statement");
        const parsed = wire.parseIssueWire({
          number: 6000 + index,
          title: issue.title,
          body: issue.body,
          state: "open",
          user: { login: "ubiquity-sentinel[bot]" },
          labels: [],
          created_at: "2026-10-16T23:31:00Z",
          updated_at: "2026-10-16T23:31:00Z",
          closed_at: null,
        }, "$");
        assert.equal(parsed.kind, "issue");
        assert.equal(parsed.issue?.body, issue.body);
        const port = local.scopeLocalRepairIssues({
          listOpenIssues: () =>
            Promise.resolve({ ok: true, value: [parsed.issue] }),
          readIssue: () => Promise.resolve({ ok: true, value: parsed.issue }),
        });
        const listed = await port.listOpenIssues();
        assert.ok(listed.ok);
        assert.equal(listed.value.length, 1, "R79's opt-out reader admits it");
      }
    } finally {
      await loaded.dispose();
    }
  },
});
