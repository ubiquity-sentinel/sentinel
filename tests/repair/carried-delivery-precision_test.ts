/**
 * Carried delivery precision (sentinel issue #156), driven through the REAL
 * repair loop and the REAL launcher delivery pass (`delivery-queue-rig.ts`):
 *
 * - (2) a carried merge that landed off its tip (the tip moved between the
 *   launcher's uncached re-read and its merge call) can never be booked: the
 *   runtime reads the merge commit's parents itself and parks the self
 *   record at once with the launcher's own off-tip blocker, instead of
 *   holding the delivery line for 6 hours and parking it as a generic stall;
 * - (5) the refreshed head H1's own CI is read before the tip: a red H1 the
 *   candidate caused parks even when the base moved meanwhile, and is never
 *   refreshed onto the new tip (one more CI run per refresh, up to the
 *   refresh limit, while it held the delivery line).
 *
 * Every snapshot either writes parses under the generation-80 rollback
 * runtime.
 */
import assert from "node:assert/strict";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import {
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { isCarriedMergeMarker } from "../../src/repair/carried-review.ts";
import {
  MAX_REVIEW_ROUNDS,
  REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX,
} from "../../src/repair/review-round-cap.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { assertGen80Parses, gen80Available } from "../state/gen77-contracts.ts";
import {
  APP,
  historicalDeliveryScenario,
  queueRig,
} from "./delivery-queue-rig.ts";
import type { HostedPolicyGraph } from "../host/hosted-supervisor-policy-fixture.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { sha } from "./review-round-cap-rig.ts";

const GEN80 = await gen80Available();

/** The first prepared refresh of the rig (`QueueGithub.prepareBaseRefresh`). */
const H1 = sha(0x5001);

/** The sentinel self scope (the no-App owner identity). */
const SELF: RepositoryIdentityV1 = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

function spentCharges(record: WorkRecordV1): BudgetReservationV1[] {
  return Array.from(
    { length: MAX_REVIEW_ROUNDS },
    (_, index) =>
      reservation(`${record.id}-review-${index + 1}`, {
        repository: record.repository,
        taskId: record.id,
        attempt: index + 1,
        head: record.target.head,
        purpose: "review_request",
        outcome: "submitted",
        createdAt: T0 - 30 * 60_000 + index,
        settledAt: T0 - 30 * 60_000 + index + 1,
      }),
  );
}

async function cleanReview(record: WorkRecordV1): Promise<ReviewReceiptV1> {
  const issueNumber = record.related.issueNumber!;
  return completedReceipt(record.target.pr!, record.target.head!, SHA1, {
    id: `review-receipt:${record.id}:latest`,
    repository: record.repository,
    resultId: `result-${record.id}`,
    expectedReviewer: APP,
    observedReviewer: APP,
    taskAcceptance: {
      issueNumber,
      taskDigest: await reviewTaskStatementDigest({
        issueNumber,
        title: `issue ${issueNumber}`,
        body: "",
      }),
      verdict: "fulfilled",
      evidence: ["the exact reviewed change implements the source issue"],
    },
  });
}

/** One spent, cleanly reviewed record on B0 = SHA1 with the tip at T = SHA2. */
async function spentRig(
  repository: RepositoryIdentityV1 = REPO,
  historicalLauncher?: HostedPolicyGraph,
) {
  const base = await queueRig(1, { repository });
  const spent = base.records.map((record) =>
    workRecord(record.id, {
      ...record,
      nextStep: "delivery",
      counters: { attempts: 1, retries: 0, reviewRounds: MAX_REVIEW_ROUNDS },
    })
  );
  const reviews = await Promise.all(spent.map(cleanReview));
  return queueRig(1, {
    historicalLauncher,
    tip: SHA2,
    shape: () => spent,
    reservations: spent.flatMap(spentCharges),
    reviews,
    reviewer: APP,
    livePolicy: true,
    repository,
  });
}

type Rig = Awaited<ReturnType<typeof spentRig>>;

async function runOnce(rig: Rig) {
  await runRepairCycle(rig.deps, {
    deadline: rig.clock.now() + 60 * 60_000,
    stepLimit: 16,
  });
}

async function assertRollbackParses(rig: Rig) {
  if (!GEN80) return;
  assert.ok(rig.writes.length > 0);
  for (const written of rig.writes) await assertGen80Parses(written);
}

function failing(head: GitSha): GitHubCheckV1[] {
  return [{
    name: "validate",
    status: "completed",
    conclusion: "failure",
    head,
    startedAt: T0,
    completedAt: T0 + 1000,
  }];
}

Deno.test(
  "carried precision (#156): a self carried merge that landed off its tip parks at once with the off-tip blocker, not a 6-hour stall",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(SELF, graph);
    await runOnce(rig);
    await runOnce(rig);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.target.head, H1);
    assert.equal(record.target.base, SHA2);
    assert.ok(isCarriedMergeMarker(record.wait), JSON.stringify(record.wait));
    // GitHub has no compare-and-swap on the base: an owner merge lands
    // between the launcher's uncached tip re-read and its merge call, so the
    // carried merge lands on that commit instead of T.
    const owner = sha(0x7777);
    const surface = rig.github.launcherSurface.bind(rig.github);
    rig.github.launcherSurface = () => {
      const real = surface();
      return {
        ...real,
        merge: (number: number, head: string, message?: string) => {
          rig.github.remoteBase = owner;
          return real.merge(number, head, message);
        },
      };
    };
    const actions = await rig.launcher();
    assert.equal(rig.github.launcherMerges.length, 1, JSON.stringify(actions));
    const revision = rig.github.pulls.get(101)!.mergeSha!;
    assert.ok(
      actions.includes(
        `delivery:${record.id}:carried_merged_off_tip:sha=${revision}`,
      ),
      JSON.stringify(actions),
    );
    // The launcher never rewrites a self record and books nothing.
    [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "work");
    assert.deepEqual((await rig.snapshot()).releaseRequests, []);
    // The runtime's next step reads the merge commit's parents and parks.
    rig.clock.advance(5 * 60_000);
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "blocked");
    assert.equal(
      record.blocker!.message,
      `${REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX}merge ${revision} has parents ${owner},${H1}, not ${SHA2},${H1}`,
    );
    assert.equal(record.wait, null);
    assert.equal(record.counters.reviewRounds, MAX_REVIEW_ROUNDS);
    assert.deepEqual((await rig.snapshot()).releaseRequests, []);
    await assertRollbackParses(rig);
  }),
);

Deno.test(
  "carried precision (#156): a self carried merge at exactly its tip whose state write was lost still waits for the launcher's adoption",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(SELF, graph);
    await runOnce(rig);
    await runOnce(rig);
    rig.state.conflictRepairNext = true;
    await rig.launcher();
    assert.equal(rig.github.launcherMerges.length, 1);
    rig.clock.advance(5 * 60_000);
    await runOnce(rig);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "work");
    assert.equal(record.wait?.reason, "unavailable");
    rig.clock.advance(5 * 60_000);
    await rig.launcher();
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "delivery");
    assert.equal((await rig.snapshot()).releaseRequests.length, 1);
    await assertRollbackParses(rig);
  }),
);

Deno.test("carried precision (#156): a red refreshed head is parked before a base move can refresh it again", async () => {
  const rig = await spentRig();
  const charges = (await rig.snapshot()).reservations.length;
  rig.github.checksByHead.set(H1, failing(H1));
  // The base moves again right after H1 is pushed, before the runtime reads
  // H1's red CI.
  const push = rig.github.pushHead.bind(rig.github);
  rig.github.pushHead = async (ref, next, expected) => {
    const result = await push(ref, next, expected);
    if (next === H1) rig.github.remoteBase = sha(0x7001);
    return result;
  };
  await runOnce(rig);
  rig.clock.advance(5 * 60_000);
  await runOnce(rig);
  const [record] = (await rig.snapshot()).work;
  assert.equal(record.nextStep, "blocked");
  assert.equal(
    record.blocker!.message,
    `${REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX}validate(failure)`,
  );
  assert.equal(record.target.head, H1);
  assert.equal(rig.github.refreshes, 1, "never refreshed onto the new tip");
  assert.equal((await rig.snapshot()).reservations.length, charges);
  assert.deepEqual(rig.github.merged, []);
  await assertRollbackParses(rig);
});

Deno.test("carried precision (#156): a base-caused red refreshed head is still refreshed onto a moved tip", async () => {
  // Review finding (upheld 3 of 3): only a red the head's own change caused
  // parks before the refresh; a red the base caused may be cured by one.
  const rig = await spentRig();
  rig.github.checksByHead.set(H1, failing(H1));
  // T (SHA2) is red on the same check: H1's red is the base's.
  rig.github.checksByHead.set(SHA2, failing(SHA2));
  await runOnce(rig);
  rig.clock.advance(5 * 60_000);
  await runOnce(rig);
  // The owner fixes the base: the tip moves on.
  rig.github.remoteBase = sha(0x7001);
  rig.clock.advance(31 * 60_000);
  await runOnce(rig);
  const [record] = (await rig.snapshot()).work;
  assert.notEqual(record.nextStep, "blocked", record.blocker?.message);
  assert.equal(rig.github.refreshes, 2, "refreshed onto the fixed tip");
  assert.deepEqual(rig.github.merged, []);
  await assertRollbackParses(rig);
});
