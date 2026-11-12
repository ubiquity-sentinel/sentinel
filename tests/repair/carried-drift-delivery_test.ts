/**
 * Carried delivery across base drift (sentinel PRs 304 and 307), driven
 * through the REAL repair loop and the REAL launcher delivery pass
 * (`delivery-queue-rig.ts`). A spent self record whose refreshed head carries
 * the reviewed hunk verbatim while the base edited a context line beside it
 * is no longer parked "the refreshed head does not carry the reviewed patch":
 * the runtime's git proof (`driftCarried`) and the launcher's tree proof over
 * the exact blobs both carry it, and the launcher merges it under the carried
 * review, charging nothing. The same added line elsewhere in the file still
 * parks, and a native queue target keeps the exact identity.
 *
 * The fakes answer what git and GitHub derive for real fixture blobs: the
 * runtime's proof marks drift by the shared rule (`carriedAcrossDrift`), the
 * launcher's trees name the blobs by their real ids and serve their bytes.
 */
import assert from "node:assert/strict";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  carriedAcrossDrift,
  type CarriedPathChangeV1,
  gitBlobId,
} from "../../src/github/carried-drift.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { isCarriedMergeMarker } from "../../src/repair/carried-review.ts";
import {
  MAX_REVIEW_ROUNDS,
  REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
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

/** The sentinel self scope. */
const SELF: RepositoryIdentityV1 = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

const encoder = new TextEncoder();
const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`);
/** The base edits line 4: inside the reviewed hunk's three context lines. */
const TIP_LINES = LINES.map((line, i) => i === 3 ? "line four (base)\n" : line);
const guarded = (lines: string[], at: number) =>
  encoder.encode(
    [...lines.slice(0, at), "guard();\n", ...lines.slice(at)].join(""),
  );
const FILES = {
  base: encoder.encode(LINES.join("")),
  reviewed: guarded(LINES, 6),
  tip: encoder.encode(TIP_LINES.join("")),
  carried: guarded(TIP_LINES, 6),
  moved: guarded(TIP_LINES, 9),
};
type FileName = keyof typeof FILES;
const IDS = {} as Record<FileName, string>;
for (const name of Object.keys(FILES) as FileName[]) {
  IDS[name] = await gitBlobId(FILES[name]);
}
const BLOBS = new Map(
  (Object.keys(FILES) as FileName[]).map((name) => [IDS[name], FILES[name]]),
);
const readBlob = (sha: string) => Promise.resolve(BLOBS.get(sha) ?? null);

function appChange(oldSha: string, newSha: string): CarriedPathChangeV1 {
  return {
    path: "src/app.ts",
    oldMode: "100644",
    oldSha,
    newMode: "100644",
    newSha,
  };
}

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
  repository: RepositoryIdentityV1,
  historicalLauncher: HostedPolicyGraph,
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

/**
 * Script the refreshed head H1 as `refreshed` over the fixture blobs: the
 * reviewed side is base -> reviewed, the refreshed side tip -> refreshed.
 */
async function driftedRefresh(rig: Rig, refreshed: "carried" | "moved") {
  const reviewedChanges = [appChange(IDS.base, IDS.reviewed)];
  const refreshedChanges = [appChange(IDS.tip, IDS[refreshed])];
  // The runtime's git proof: unequal exact digests, drift by the shared rule.
  const verdict = await carriedAcrossDrift(
    reviewedChanges,
    refreshedChanges,
    readBlob,
  );
  const prove = rig.github.proveCarriedPatch!.bind(rig.github);
  rig.github.proveCarriedPatch = async (request) => {
    const proof = await prove(request);
    if (!proof.ok || request.head !== H1) return proof;
    return portOk({
      ...proof.value,
      refreshedPatch: "c".repeat(64),
      ...(verdict.kind === "carried" ? { driftCarried: true } : {}),
    });
  };
  // The launcher's proof: GitHub's trees of the same identities and blobs.
  const surface = rig.github.launcherSurface.bind(rig.github);
  rig.github.launcherSurface = () => {
    const real = surface();
    return {
      ...real,
      mergeBaseTreeChanges: async (base: string, head: string) => {
        const tree = await real.mergeBaseTreeChanges!(base, head);
        return tree === null ? null : {
          ...tree,
          changes: head === H1 ? refreshedChanges : reviewedChanges,
        };
      },
      readBlob,
    };
  };
  return verdict.kind;
}

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

Deno.test(
  "carried drift (#304/#307): a reviewed hunk carried across context-only base drift merges under its carried review and spends nothing",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(SELF, graph);
    const charges = (await rig.snapshot()).reservations.length;
    assert.equal(await driftedRefresh(rig, "carried"), "carried");
    await runOnce(rig);
    await runOnce(rig);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "work", record.blocker?.message);
    assert.equal(record.target.head, H1);
    assert.equal(record.target.base, SHA2);
    assert.ok(isCarriedMergeMarker(record.wait), JSON.stringify(record.wait));
    const actions = await rig.launcher();
    assert.equal(rig.github.launcherMerges.length, 1, JSON.stringify(actions));
    const [merge] = rig.github.launcherMerges;
    assert.equal(merge.head, H1);
    assert.equal(merge.onto, SHA2);
    assert.match(
      merge.message ?? "",
      /\(1 paths by path and mode; 1 text paths carried hunk for hunk across base drift, the rest by full blob id\)/,
    );
    assert.ok(
      actions.some((action) =>
        action.startsWith(`delivery:${record.id}:carried_merge:`) &&
        action.includes("/1:drift=1:patch=")
      ),
      JSON.stringify(actions),
    );
    rig.clock.advance(5 * 60_000);
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
    assert.notEqual(record.nextStep, "blocked", record.blocker?.message);
    assert.equal((await rig.snapshot()).releaseRequests.length, 1);
    assert.equal(record.counters.reviewRounds, MAX_REVIEW_ROUNDS);
    assert.equal((await rig.snapshot()).reservations.length, charges);
    assert.equal(rig.github.launcherMerges.length, 1, "merged once");
    await assertRollbackParses(rig);
  }),
);

Deno.test(
  "carried drift (#304/#307): the reviewed line moved elsewhere in the drifted file still parks precisely and merges nothing",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(SELF, graph);
    const charges = (await rig.snapshot()).reservations.length;
    assert.equal(await driftedRefresh(rig, "moved"), "changed");
    await runOnce(rig);
    await runOnce(rig);
    await rig.launcher();
    const [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "blocked");
    assert.ok(
      record.blocker!.message.startsWith(
        REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
      ),
      record.blocker!.message,
    );
    assert.deepEqual(rig.github.launcherMerges, []);
    assert.equal((await rig.snapshot()).reservations.length, charges);
    await assertRollbackParses(rig);
  }),
);

Deno.test(
  "carried drift (#304/#307): a native queue target keeps the exact identity and parks as before",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(REPO, graph);
    assert.equal(await driftedRefresh(rig, "carried"), "carried");
    await runOnce(rig);
    await runOnce(rig);
    await rig.launcher();
    const [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "blocked");
    assert.ok(
      record.blocker!.message.startsWith(
        REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
      ),
      record.blocker!.message,
    );
    assert.deepEqual(rig.github.launcherMerges, []);
    await assertRollbackParses(rig);
  }),
);
