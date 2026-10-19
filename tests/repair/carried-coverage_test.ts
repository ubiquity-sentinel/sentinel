/**
 * Carried delivery requires every expected check (sentinel issue #154), over
 * the live verify-artifact gap shape (ai.ubq.fi PR 1064: H1 f0008beb62, a
 * refresh onto T 9cdc76dc, read green with `verify-artifact` not created yet).
 *
 * - The runtime's carried step holds no carried-merge marker for a refreshed
 *   head H1 that lacks a check name of T's suites: it waits (`ci_pending`,
 *   bounded, uncharged) and writes the marker once GitHub created the job.
 * - The launcher's carried merge passes T to its green read, so a marker
 *   written in the gap (R80 reads no base) merges nothing (`checks_pending`).
 * - The ceiling's moved-base read refreshes a spent reviewed head H0 only once
 *   it reports every check name of its reviewed base B0's suites.
 * - A base whose runs cannot be read is awaited the same way and parks after
 *   the bound naming it, never a silent deferral; bases are read leniently
 *   (live sentinel `development` carries 78-character `matrix_cell` runs) and
 *   the sentinel self scope reads none, like the launcher.
 *
 * Driven through the REAL repair loop and the REAL launcher delivery pass
 * (`delivery-queue-rig.ts`); every write parses under the rollback target R80
 * (skipped in a checkout without it).
 */
import assert from "node:assert/strict";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { CARRIED_WAIT_BOUND_MS } from "../../src/repair/loop-carried-delivery.ts";
import { isCarriedMergeMarker } from "../../src/repair/carried-review.ts";
import {
  MAX_REVIEW_ROUNDS,
  REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX,
  REVIEW_ROUND_CEILING_PREFIX,
  REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX,
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
import {
  LIVE_L80,
  LIVE_TIP,
  liveGapChecks,
  routeLiveDevelopment,
  suiteCheck,
} from "./ci-coverage-fixtures.ts";

const HOUR = 60 * 60_000;
const GEN80 = await gen80Available();

/** The first prepared refresh of the rig (`QueueGithub.prepareBaseRefresh`). */
const H1 = sha(0x5001);

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

async function assertNothingSpent(rig: Rig, before: number) {
  const snapshot = await rig.snapshot();
  assert.equal(snapshot.reservations.length, before, "nothing charged");
  for (const record of snapshot.work) {
    assert.equal(record.counters.reviewRounds, MAX_REVIEW_ROUNDS);
    assert.equal(record.counters.retries, 0);
  }
  assert.deepEqual(rig.github.reviewed, [], "no review requested");
}

async function assertRollbackParses(rig: Rig) {
  if (!GEN80) return;
  assert.ok(rig.writes.length > 0);
  for (const written of rig.writes) await assertGen80Parses(written);
}

Deno.test(
  "carried coverage: a refreshed head in the live verify-artifact gap holds no merge marker; it merges once GitHub creates verify-artifact",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(undefined, graph);
    const charges = (await rig.snapshot()).reservations.length;
    rig.github.checksByHead.set(SHA2, liveGapChecks("tip", SHA2, T0));
    rig.github.checksByHead.set(H1, liveGapChecks("gap", H1, T0));
    await runOnce(rig);
    await runOnce(rig);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.target.head, H1, "refreshed once onto T");
    assert.equal(record.target.base, SHA2);
    assert.equal(record.nextStep, "work");
    assert.equal(record.wait?.reason, "ci_pending");
    assert.equal(isCarriedMergeMarker(record.wait), false, "no merge marker");
    const since = record.wait!.since;
    await rig.launcher();
    assert.equal(rig.github.launcherMerges.length, 0, "nothing merged in gap");
    // GitHub creates verify-artifact: the marker, then the launcher's merge.
    rig.github.checksByHead.set(H1, liveGapChecks("complete", H1, T0));
    rig.clock.advance(5 * 60_000);
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
    assert.ok(isCarriedMergeMarker(record.wait), JSON.stringify(record.wait));
    assert.ok(record.wait!.since > since);
    await rig.launcher();
    assert.equal(rig.github.launcherMerges.length, 1);
    assert.equal(rig.github.launcherMerges[0].head, H1);
    assert.equal(rig.github.launcherMerges[0].onto, SHA2);
    assert.equal(rig.github.refreshes, 1);
    await assertNothingSpent(rig, charges);
    await assertRollbackParses(rig);
  }),
);

Deno.test(
  "carried coverage: a refreshed head that never gets its expected check parks after the bound, naming it",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(undefined, graph);
    const charges = (await rig.snapshot()).reservations.length;
    rig.github.checksByHead.set(SHA2, liveGapChecks("tip", SHA2, T0));
    rig.github.checksByHead.set(H1, liveGapChecks("gap", H1, T0));
    await runOnce(rig);
    await runOnce(rig);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.wait?.reason, "ci_pending");
    for (let elapsed = 0; elapsed <= CARRIED_WAIT_BOUND_MS; elapsed += HOUR) {
      rig.clock.advance(HOUR);
      await rig.launcher();
      await runOnce(rig);
      [record] = (await rig.snapshot()).work;
      if (record.nextStep === "blocked") break;
    }
    assert.equal(record.nextStep, "blocked");
    assert.equal(
      record.blocker!.message,
      `${REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX}verify-artifact(absent)`,
    );
    assert.ok(record.blocker!.message.startsWith(REVIEW_ROUND_CEILING_PREFIX));
    assert.equal(rig.github.launcherMerges.length, 0);
    await assertNothingSpent(rig, charges);
    await assertRollbackParses(rig);
  }),
);

Deno.test(
  "carried coverage: the launcher refuses a carried-merge marker written in the gap (R80 reads no base)",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(undefined, graph);
    // R80's carried step judges H1's existing runs alone, so in the gap it
    // holds the marker; an empty listing for T gives this runtime the same
    // view (no suite to require a name from).
    rig.github.checksByHead.set(SHA2, []);
    rig.github.checksByHead.set(H1, liveGapChecks("gap", H1, T0));
    await runOnce(rig);
    await runOnce(rig);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.target.head, H1);
    assert.ok(isCarriedMergeMarker(record.wait), JSON.stringify(record.wait));
    // GitHub reports T's own four runs, as it did throughout.
    rig.github.checksByHead.set(SHA2, liveGapChecks("tip", SHA2, T0));
    const actions = await rig.launcher();
    assert.equal(
      rig.github.launcherMerges.length,
      0,
      JSON.stringify(actions),
    );
    assert.ok(
      actions.includes(`delivery:${record.id}:checks_pending`),
      JSON.stringify(actions),
    );
    // Once verify-artifact exists the same marker merges H1 at exactly T.
    rig.github.checksByHead.set(H1, liveGapChecks("complete", H1, T0));
    rig.clock.advance(60_000);
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
    assert.ok(isCarriedMergeMarker(record.wait));
    await rig.launcher();
    assert.equal(rig.github.launcherMerges.length, 1);
    assert.equal(rig.github.launcherMerges[0].head, H1);
    assert.equal(rig.github.launcherMerges[0].onto, SHA2);
    await assertRollbackParses(rig);
  }),
);

Deno.test("carried coverage: a spent reviewed head on a moved base is refreshed only once it reports every check of its reviewed base", async () => {
  const rig = await spentRig();
  const charges = (await rig.snapshot()).reservations.length;
  const h0 = rig.records[0].target.head!;
  rig.github.checksByHead.set(SHA1, liveGapChecks("tip", SHA1, T0));
  rig.github.checksByHead.set(h0, liveGapChecks("gap", h0, T0));
  await runOnce(rig);
  let [record] = (await rig.snapshot()).work;
  assert.equal(rig.github.refreshes, 0, "never refreshed in the gap");
  assert.equal(record.target.head, h0);
  assert.equal(record.nextStep, "delivery");
  assert.equal(record.wait?.reason, "ci_pending");
  rig.github.checksByHead.set(h0, liveGapChecks("complete", h0, T0));
  rig.clock.advance(5 * 60_000);
  await runOnce(rig);
  [record] = (await rig.snapshot()).work;
  assert.equal(rig.github.refreshes, 1, "refreshed once complete");
  assert.equal(record.target.head, H1);
  await assertNothingSpent(rig, charges);
  await assertRollbackParses(rig);
});

Deno.test("carried coverage: a spent reviewed head whose expected check never appears parks under the ceiling after the bound", async () => {
  const rig = await spentRig();
  const h0 = rig.records[0].target.head!;
  rig.github.checksByHead.set(SHA1, liveGapChecks("tip", SHA1, T0));
  rig.github.checksByHead.set(h0, liveGapChecks("gap", h0, T0));
  let [record] = (await rig.snapshot()).work;
  for (let run = 0; run <= 7 && record.nextStep !== "blocked"; run++) {
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
    rig.clock.advance(HOUR);
  }
  assert.equal(record.nextStep, "blocked");
  assert.equal(
    record.blocker!.message,
    `${REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX}verify-artifact(absent)`,
  );
  assert.equal(rig.github.refreshes, 0);
  await assertRollbackParses(rig);
});

/** The sentinel self scope (the no-App owner identity). */
const SELF: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
};

/**
 * One spent, cleanly reviewed `test-local` head H0 on B0 = SHA1 with the tip
 * at T = SHA2, both bases read through the REAL port over the live sentinel
 * `development` listings (B0 L80 9a1b1d924, T the tip 3f041b46d), which the
 * strict check read refuses (78-character `matrix_cell` runs). Before this
 * fix the coverage read made of them deferred H0 forever, with no write: no
 * refresh, no wait, no park. Returns each base's reads made by the runtime.
 */
async function liveBasesCase(repository: RepositoryIdentityV1) {
  const rig = await spentRig(repository);
  const charges = (await rig.snapshot()).reservations.length;
  const h0 = rig.records[0].target.head!;
  const transports = routeLiveDevelopment(rig.github, repository, {
    [SHA1]: LIVE_L80,
    [SHA2]: LIVE_TIP,
  });
  rig.github.checksByHead.set(h0, [suiteCheck("test-local", h0, 9001, T0)]);
  rig.github.checksByHead.set(H1, [suiteCheck("test-local", H1, 9002, T0)]);
  for (const base of [SHA1, SHA2]) {
    const strict = await rig.github.readChecks(base);
    assert.equal(strict.ok, false, "the strict read refuses the listing");
  }
  const probed = new Map(
    [...transports].map(([base, transport]) => [
      base,
      transport.requests.length,
    ]),
  );
  await runOnce(rig);
  let [record] = (await rig.snapshot()).work;
  assert.equal(record.repository.name, repository.name);
  assert.equal(rig.github.refreshes, 1, "the spent head is refreshed onto T");
  assert.equal(record.target.head, H1);
  assert.equal(record.target.base, SHA2);
  await runOnce(rig);
  [record] = (await rig.snapshot()).work;
  assert.equal(record.blocker, null, JSON.stringify(record.blocker));
  assert.ok(isCarriedMergeMarker(record.wait), JSON.stringify(record.wait));
  await assertNothingSpent(rig, charges);
  await assertRollbackParses(rig);
  return new Map(
    [...transports].map(([base, transport]) => [
      base,
      transport.requests.slice(probed.get(base)!),
    ]),
  );
}

Deno.test("carried coverage: a green self head on the live sentinel development tips (78-character matrix_cell runs) is refreshed and carried; the self scope reads no base", async () => {
  const reads = await liveBasesCase(SELF);
  assert.deepEqual(reads.get(SHA1), [], "B0 is never read");
  assert.deepEqual(reads.get(SHA2), [], "T is never read");
});

Deno.test("carried coverage: a green foreign head on bases carrying the live sentinel listings is refreshed and carried through the real port's coverage read", async () => {
  const reads = await liveBasesCase(REPO);
  for (const base of [SHA1, SHA2]) {
    assert.ok(reads.get(base)!.length > 0, `${base} read through the port`);
    for (const request of reads.get(base)!) {
      assert.match(request.url, /\/check-runs\?/, "no commit-status read");
    }
  }
});

/** Every check read of `base` fails, as a rate-limited listing does. */
function unreadableBase(rig: Rig, base: GitSha) {
  const refused = () =>
    Promise.resolve(portError("unavailable", "check runs unavailable"));
  const readChecks = rig.github.readChecks.bind(rig.github);
  const readCheckSuites = rig.github.readCheckSuites.bind(rig.github);
  rig.github.readChecks = (sha: GitSha) =>
    sha === base ? refused() : readChecks(sha);
  rig.github.readCheckSuites = (sha: GitSha) =>
    sha === base ? refused() : readCheckSuites(sha);
}

/** Poll hourly (launcher pass, then runtime cycle) until parked or bounded. */
async function pollUntilParked(rig: Rig, launcher: boolean) {
  let [record] = (await rig.snapshot()).work;
  for (
    let elapsed = 0;
    elapsed <= CARRIED_WAIT_BOUND_MS && record.nextStep !== "blocked";
    elapsed += HOUR
  ) {
    rig.clock.advance(HOUR);
    if (launcher) await rig.launcher();
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
  }
  return record;
}

Deno.test("carried coverage: a spent reviewed head whose reviewed base cannot be read waits at delivery and parks after the bound naming it", async () => {
  const rig = await spentRig();
  const charges = (await rig.snapshot()).reservations.length;
  const h0 = rig.records[0].target.head!;
  rig.github.checksByHead.set(SHA1, liveGapChecks("tip", SHA1, T0));
  rig.github.checksByHead.set(h0, liveGapChecks("complete", h0, T0));
  unreadableBase(rig, SHA1);
  await runOnce(rig);
  let [record] = (await rig.snapshot()).work;
  assert.equal(rig.github.refreshes, 0);
  assert.equal(record.nextStep, "delivery");
  assert.equal(
    record.wait?.reason,
    "ci_pending",
    "a bounded wait, not silence",
  );
  record = await pollUntilParked(rig, false);
  assert.equal(record.nextStep, "blocked");
  assert.equal(
    record.blocker!.message,
    `${REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX}base checks unreadable`,
  );
  assert.equal(rig.github.refreshes, 0);
  await assertNothingSpent(rig, charges);
  await assertRollbackParses(rig);
});

Deno.test(
  "carried coverage: a refreshed head whose T cannot be read holds no merge marker and parks after the bound naming it",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(undefined, graph);
    const charges = (await rig.snapshot()).reservations.length;
    rig.github.checksByHead.set(SHA2, liveGapChecks("tip", SHA2, T0));
    rig.github.checksByHead.set(H1, liveGapChecks("complete", H1, T0));
    unreadableBase(rig, SHA2);
    await runOnce(rig);
    await runOnce(rig);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.target.head, H1, "refreshed once onto T");
    assert.equal(
      record.wait?.reason,
      "ci_pending",
      "a bounded wait, not silence",
    );
    assert.equal(isCarriedMergeMarker(record.wait), false, "no merge marker");
    record = await pollUntilParked(rig, true);
    assert.equal(record.nextStep, "blocked");
    assert.equal(
      record.blocker!.message,
      `${REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX}base checks unreadable`,
    );
    assert.equal(rig.github.launcherMerges.length, 0);
    await assertNothingSpent(rig, charges);
    await assertRollbackParses(rig);
  }),
);
