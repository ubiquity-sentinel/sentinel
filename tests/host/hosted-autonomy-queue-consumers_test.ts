import assert from "node:assert/strict";
import { withHistoricalAutonomy } from "./hosted-autonomy-spent-fixtures.ts";
import { runHostedDeliveryPass } from "../../ops/hosted-autonomy-delivery-pass.ts";
import { verifiedMergedDelivery } from "../../ops/hosted-autonomy-delivery.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import type { HostedQueueCustodyContext } from "../../ops/hosted-autonomy-queue-context.ts";
import { resolveQueueAwareDelivery } from "../../ops/hosted-autonomy-queue-proof.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";
import {
  directProofFacts,
  POLICY,
  queueProofFacts,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  T0,
} from "./merge-queue-proof-fixtures.ts";
import {
  hostedDeliveryProofMatches,
  resolveHostedDelivery,
} from "../../ops/hosted-autonomy-delivery-proof.ts";
import {
  planHostedClosures,
  planHostedRetirements,
} from "../../ops/hosted-autonomy-closures.ts";
import {
  hostedDeliveryKey,
  hostedIssueKey,
} from "../../ops/hosted-autonomy-policy.ts";
import { reservation } from "../state/helpers.ts";
import type { QueueDeliveryFacts } from "../../ops/hosted-autonomy-queue-proof.ts";
import { runHostedFollowUpPass } from "../../ops/hosted-autonomy-follow-up-pass.ts";
import { runHostedClosurePass } from "../../ops/hosted-autonomy-closure-pass.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { persistVpsDelivery } from "../repair/vps-delivery-fixtures.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { r80Available, withR80Parsers } from "./r80-contracts.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  BASE as OTHER_BASE,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  repositoryTask,
} from "./hosted-autonomy-fixtures.ts";

async function fixture(
  accepted: boolean,
  customize?: (facts: QueueDeliveryFacts) => void,
) {
  const facts = await queueProofFacts();
  customize?.(facts);
  if (!accepted) facts.groupRuns = { status: "complete", value: [] };
  const pull: HostedAutonomyPullV1 = {
    number: 7,
    state: "closed",
    merged: true,
    headSha: SHA2,
    baseSha: SHA1,
    baseRef: "development",
    author: "ubiquity-sentinel[bot]",
    mergedBy: "github-merge-queue[bot]",
    mergeCommitSha: SHA4,
    parents: [SHA3, SHA2],
    revisionOnBaseBranch: true,
    baseAncestorOfRevision: true,
    mergeable: true,
  };
  const { rig, github } = await makeRig("queue-proof-consumer", {
    repair: repairSnapshot([facts.record], [facts.receipt], [], [
      reservation("charged", {
        repository: facts.record.repository,
        taskId: facts.record.id,
        head: SHA2,
        outcome: "ambiguous",
        settledAt: T0 + 1000,
      }),
    ]),
  });
  rig.githubFor = () => ({
    ...github,
    readDefaultBranch: () => Promise.resolve("development"),
    readIssueTask: () =>
      Promise.resolve(facts.task === "unavailable" ? null : facts.task),
    readIssueOptedOut: () => Promise.resolve(false),
    readPull: () => Promise.resolve(pull),
  });
  let resolutions = 0;
  const custody: HostedQueueCustodyContext = {
    ready: true,
    proofActivated: true,
    protectedRecordIds: new Set([facts.record.id]),
    resolveDelivery: async () => {
      resolutions++;
      return await resolveQueueAwareDelivery(facts, POLICY);
    },
  };
  const deps: HostedAutonomyDepsV1 = {
    state: rig.state,
    githubFor: rig.githubFor,
    clock: { now: () => T0 + 2000 },
    queueCustody: custody,
  };
  const read = await rig.state.readRepair();
  const release = await rig.state.readRelease();
  assert.ok(read.ok && read.value.status === "found");
  assert.ok(release.ok && release.value.status === "found");
  const context: HostedAutonomyPassContextV1 = {
    deps,
    snapshot: read.value.snapshot,
    observedHead: read.value.head,
    initialHead: read.value.head,
    releaseSnapshot: release.value.snapshot,
    actions: [],
    revisions: [],
    closedIssues: new Set(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set(),
    ...createHostedAutonomyScopes(deps),
  };
  return { rig, facts, pull, context, resolutions: () => resolutions };
}

Deno.test("queue delivery: weak legacy parents cannot book a merge without group CI", async () => {
  const f = await fixture(false);
  try {
    // This accepted ancestor-shaped merge was the legacy booking bypass.
    await withHistoricalAutonomy(async (graph) => {
      const { verifiedMergedDelivery } = await graph.deliveryFacts();
      assert.ok(
        verifiedMergedDelivery(f.facts.record, f.pull, "development") !== null,
      );
    });
    await runHostedDeliveryPass(f.context);
    const read = await f.rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(read.value.snapshot.releaseRequests.length, 0);
    assert.ok(
      f.resolutions() > 0,
      "the production consumer must consult queue proof",
    );
    assert.equal(f.rig.merges, 0);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("queue delivery: verified group merge books under indefinite custody without a direct merge", async () => {
  const f = await fixture(true, (facts) => {
    facts.record = {
      ...facts.record,
      wait: { reason: "backoff", until: null, since: T0 },
      intent: {
        kind: "merge",
        key: `merge-queue:v1:7:${SHA2}`,
        startedAt: T0,
        branch: facts.record.target.branch,
        expectedHead: SHA2,
        observedBase: SHA1,
        pr: 7,
        requestId: "queue-admission",
        resultId: null,
      },
    };
  });
  try {
    assert.equal(
      verifiedMergedDelivery(f.facts.record, f.pull, "development"),
      null,
    );
    const result = await runHostedDeliveryPass(f.context);
    assert.equal(result?.status, "applied", f.context.actions.join(" "));
    const read = await f.rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(read.value.snapshot.releaseRequests[0]?.revision, SHA4);
    assert.equal(
      read.value.snapshot.releaseRequests[0]?.source.reviewReceiptId,
      f.facts.receipt.id,
    );
    assert.deepEqual(
      read.value.snapshot.reservations,
      f.context.snapshot.reservations,
    );
    assert.deepEqual(read.value.snapshot.work[0].intent, f.facts.record.intent);
    assert.deepEqual(read.value.snapshot.work[0].wait, {
      reason: "backoff",
      until: null,
      since: T0,
    });
    assert.equal(f.rig.merges, 0);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("queue delivery: missing, unavailable and mismatched resolver grants never fall back", async (t) => {
  for (
    const scenario of [
      "missing_context",
      "missing_resolver",
      "unready",
      "throws",
      "unavailable",
      "wrong_revision",
      "wrong_task",
      "wrong_receipt",
      "forged_legacy",
    ] as const
  ) {
    await t.step(scenario, async () => {
      const f = await fixture(true);
      try {
        const original = f.context.deps.queueCustody!;
        if (scenario === "missing_context") {
          f.context.deps.queueCustody = undefined;
        } else if (scenario === "missing_resolver") {
          f.context.deps.queueCustody = {
            ...original,
            resolveDelivery: undefined,
          };
        } else if (scenario === "unready") {
          f.context.deps.queueCustody = { ...original, ready: false };
        } else {f.context.deps.queueCustody = {
            ...original,
            resolveDelivery: async () => {
              if (scenario === "throws") throw new Error("unreadable");
              if (scenario === "unavailable") {
                return {
                  status: "unavailable",
                  reason: "queue_evidence_unavailable",
                };
              }
              if (scenario === "forged_legacy") {
                return {
                  status: "legacy_direct",
                  binding: f.facts.binding,
                  revision: SHA4,
                };
              }
              const result = await resolveQueueAwareDelivery(f.facts, POLICY);
              assert.equal(result.status, "verified");
              if (result.status !== "verified") {
                throw new Error("fixture");
              }
              return {
                status: "verified",
                delivery: {
                  ...result.delivery,
                  ...(scenario === "wrong_revision"
                    ? { revision: SHA3 }
                    : scenario === "wrong_task"
                    ? { taskDigest: "f".repeat(64) }
                    : { reviewReceiptId: "another-review" }),
                },
              };
            },
          };}
        await runHostedDeliveryPass(f.context);
        const read = await f.rig.state.readRepair();
        assert.ok(read.ok && read.value.status === "found");
        assert.deepEqual(read.value.snapshot, f.context.snapshot);
        assert.equal(f.rig.merges, 0);
      } finally {
        await Deno.remove(f.rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("queue closure authority: a map key or copied proof cannot authorize any issue", async () => {
  const f = await fixture(true);
  try {
    const { record, task } = f.facts;
    const scope = await f.context.scopeFor(record.repository);
    const proof = await resolveHostedDelivery(
      f.context,
      record,
      scope,
      f.pull,
      "closure",
    );
    assert.ok(proof !== null);
    const key = hostedDeliveryKey(record.repository, 7, SHA2, SHA1);
    const tasks = new Map([[record.id, task]]);
    for (const fake of [true, { revision: SHA4 }, { ...proof }]) {
      assert.deepEqual(
        planHostedClosures(
          f.context.snapshot,
          new Map(),
          new Map([[key, fake]]),
          tasks,
        ),
        [],
      );
    }
    assert.ok(
      hostedDeliveryProofMatches(proof, f.context.snapshot, record, task, SHA4),
    );
    assert.ok(
      !hostedDeliveryProofMatches(
        proof,
        f.context.snapshot,
        record,
        task,
        SHA3,
      ),
    );
    assert.ok(
      !hostedDeliveryProofMatches(proof, f.context.snapshot, {
        ...record,
        target: { ...record.target, head: SHA3 },
      }, task),
    );
    assert.ok(
      !hostedDeliveryProofMatches(
        proof,
        f.context.snapshot,
        record,
        task === null || task === "unavailable"
          ? null
          : { ...task, title: "changed" },
      ),
    );
    assert.ok(
      !hostedDeliveryProofMatches(
        proof,
        { ...f.context.snapshot, reviews: [] },
        record,
        task,
      ),
    );
    assert.equal(
      planHostedClosures(
        f.context.snapshot,
        new Map(),
        new Map([[key, proof]]),
        tasks,
      ).length,
      1,
    );
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("queue custody: ordinary retirement cannot erase a held or indexed publication", async () => {
  const f = await fixture(true);
  try {
    const { record } = f.facts;
    const closed = new Set([
      hostedIssueKey(record.repository, record.related.issueNumber!),
    ]);
    assert.deepEqual(
      planHostedRetirements(
        f.context.snapshot,
        closed,
        new Set([record.id]),
        f.context.deps.queueCustody,
      ),
      [],
    );
    const held = {
      ...record,
      wait: { reason: "backoff" as const, until: null, since: T0 },
    };
    assert.deepEqual(
      planHostedRetirements(
        { ...f.context.snapshot, work: [held] },
        closed,
        new Set([record.id]),
      ),
      [],
    );
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("queue follow-ups: exact group proof permits P2 filing and is re-read after source inspection", async (t) => {
  for (const drift of [false, true]) {
    await t.step(
      drift ? "task changes before create" : "accepted group merge",
      async () => {
        const f = await fixture(true, (facts) => {
          facts.receipt = parseReviewReceiptV1({
            ...facts.receipt,
            unresolvedSeverities: ["P2"],
            findings: [{
              id: "finding-1",
              severity: "P2",
              path: "src/fix.ts",
              message: "Add a useful edge case.",
              fingerprint: "a".repeat(64),
              resolved: false,
              resolutionEvidence: null,
            }],
          });
        });
        try {
          f.context.deps.clock = { now: () => 1792200000000 };
          assert.equal(
            (await runHostedDeliveryPass(f.context))?.status,
            "applied",
          );
          let creates = 0;
          const surface = f.context.deps.githubFor(f.facts.record.repository)!;
          f.context.deps.githubFor = () => ({
            ...surface,
            followUpIssues: {
              listCreatedSince: () => Promise.resolve([]),
              readIssueOrigin: () => {
                if (
                  drift && f.facts.task !== null &&
                  f.facts.task !== "unavailable"
                ) f.facts.task = { ...f.facts.task, title: "Changed source" };
                return Promise.resolve({
                  number: 1,
                  author: "owner",
                  firstLine: "ordinary source",
                });
              },
              create: () => {
                creates++;
                return Promise.resolve(50);
              },
            },
          });
          const actions = await runHostedFollowUpPass(f.context.deps);
          assert.equal(creates, drift ? 0 : 1, actions.join(" "));
          assert.ok(
            f.resolutions() >= 3,
            "booking and both follow-up proof reads must use the resolver",
          );
        } finally {
          await Deno.remove(f.rig.tmp, { recursive: true });
        }
      },
    );
  }
});

Deno.test("queue closure: an exact booked request alone never implies accepted VPS release", async () => {
  const f = await fixture(true);
  try {
    assert.equal((await runHostedDeliveryPass(f.context))?.status, "applied");
    const read = await f.rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    f.context.snapshot = read.value.snapshot;
    f.context.observedHead = read.value.head;
    await runHostedClosurePass(f.context);
    assert.deepEqual(f.rig.closed, []);
    const after = await f.rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.deepEqual(after.value.snapshot, read.value.snapshot);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("queue closure: accepted VPS lifecycle still needs fresh queue proof, and every written shape parses under R80", async (t) => {
  const f = await fixture(true, (facts) => {
    facts.record = {
      ...facts.record,
      wait: { reason: "backoff", until: null, since: T0 },
      intent: {
        kind: "merge",
        key: `merge-queue:v1:7:${SHA2}`,
        startedAt: T0,
        branch: facts.record.target.branch,
        expectedHead: SHA2,
        observedBase: SHA1,
        pr: 7,
        requestId: "queue-admission",
        resultId: null,
      },
    };
  });
  try {
    assert.equal((await runHostedDeliveryPass(f.context))?.status, "applied");
    const refresh = async () => {
      const read = await f.rig.state.readRepair();
      const release = await f.rig.state.readRelease();
      assert.ok(read.ok && read.value.status === "found");
      assert.ok(release.ok && release.value.status === "found");
      f.context.snapshot = read.value.snapshot;
      f.context.observedHead = read.value.head;
      f.context.releaseSnapshot = release.value.snapshot;
      f.context.actions = [];
      f.context.foreignMerged.clear();
      return read.value.snapshot;
    };
    const booked = await refresh();
    let now = T0 + 5000;
    f.context.deps.clock = { now: () => now };
    await persistVpsDelivery(
      f.rig.state,
      createReleaseStateStore({
        remoteUrl: `${f.rig.tmp}/remote.git`,
        scratchDir: `${f.rig.tmp}/vps-release`,
      }),
      {
        now: () => now,
        advance: (ms) => {
          now += ms;
        },
      },
      booked.releaseRequests[0],
    );
    await refresh();
    assert.equal((await runHostedClosurePass(f.context))?.status, "applied");
    const intended = await refresh();
    assert.equal(intended.work[0].intent?.kind, "issue_closure");
    assert.deepEqual(f.rig.closed, []);
    const original = f.facts.groupRuns;
    f.facts.groupRuns = { status: "complete", value: [] };
    await runHostedClosurePass(f.context);
    assert.deepEqual(
      f.rig.closed,
      [],
      "accepted release alone cannot bypass lost group proof",
    );
    assert.deepEqual(await refresh(), intended);
    f.facts.groupRuns = original;
    assert.equal(
      (await runHostedClosurePass(f.context))?.reason,
      "closed_issues",
    );
    const done = await refresh();
    assert.equal(done.work[0].nextStep, "done");
    assert.deepEqual(f.rig.closed, [1]);
    assert.deepEqual(done.reservations, booked.reservations);
    assert.equal(
      booked.work[0].evidence.filter((item) =>
        item.ref.startsWith("artifact:review-receipt/merge-queue-v1/")
      ).length,
      1,
    );
    assert.deepEqual(intended.work[0].evidence, booked.work[0].evidence);
    assert.deepEqual(done.work[0].evidence, booked.work[0].evidence);
    assert.equal(
      verifiedMergedDelivery(done.work[0], f.pull, "development"),
      null,
      "durable provenance still blocks legacy booking after intent clears",
    );
    await t.step({
      name: "actual R80 parsers accept booking, closure intent and done",
      ignore: !await r80Available(),
      fn: async () => {
        await withR80Parsers((parsers) => {
          for (const snapshot of [booked, intended, done]) {
            assert.deepEqual(
              parsers.parseRepairStateSnapshotV1(
                JSON.parse(JSON.stringify(snapshot)),
              ),
              snapshot,
            );
          }
        });
      },
    });
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("queue carried delivery: original receipt is booked but cannot claim VPS acceptance or closure", async () => {
  const f = await fixture(true, (facts) => {
    const oldBase = "5".repeat(40) as GitSha,
      oldHead = "6".repeat(40) as GitSha;
    facts.receipt = parseReviewReceiptV1({
      ...facts.receipt,
      pullRequest: {
        ...facts.receipt.pullRequest,
        base: oldBase,
        head: oldHead,
      },
    });
    assert.equal(facts.reviewedPatch.status, "complete");
    if (facts.reviewedPatch.status !== "complete") throw new Error("fixture");
    facts.originalPatch = {
      status: "complete",
      value: {
        ...facts.reviewedPatch.value,
        base: oldBase,
        head: oldHead,
        mergeBase: oldBase,
      },
    };
  });
  try {
    assert.equal((await runHostedDeliveryPass(f.context))?.status, "applied");
    const read = await f.rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(
      read.value.snapshot.releaseRequests[0].source.reviewReceiptId,
      f.facts.receipt.id,
    );
    assert.deepEqual(read.value.snapshot.reviews, [f.facts.receipt]);
    f.context.snapshot = read.value.snapshot;
    f.context.observedHead = read.value.head;
    await runHostedClosurePass(f.context);
    await runHostedDeliveryPass(f.context);
    assert.deepEqual(f.rig.closed, []);
    assert.ok(
      f.context.actions.includes(
        `delivery:${f.facts.record.id}:carried_release_pending`,
      ),
    );
    const after = await f.rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.deepEqual(after.value.snapshot, read.value.snapshot);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("queue bookkeeping remains eligible after the pass spends its one direct merge", async () => {
  const f = await fixture(true, (facts) => {
    facts.record = { ...facts.record, id: "z-queue" as typeof facts.record.id };
  });
  const other = foreignRecord();
  const { rig, github } = await makeRig("queue-after-direct-effect", {
    repair: repairSnapshot([other, f.facts.record], [
      foreignReceipt(),
      f.facts.receipt,
    ]),
  });
  try {
    let directMerged = false;
    let merges = 0;
    const queueSurface = f.context.deps.githubFor(f.facts.record.repository)!;
    rig.githubFor = (repository) =>
      repository.name === "ai.ubq.fi" ? queueSurface : {
        ...github,
        readDefaultBranch: () => Promise.resolve("main"),
        readBaseTip: () => Promise.resolve(OTHER_BASE),
        readIssueTask: (issue) =>
          Promise.resolve(repositoryTask(repository, issue)),
        readPull: () =>
          Promise.resolve(
            directMerged ? foreignPullFacts() : foreignPullFacts({
              state: "open",
              merged: false,
              mergeCommitSha: null,
            }),
          ),
        merge: () => {
          merges++;
          directMerged = true;
          return Promise.resolve({
            merged: true,
            sha: foreignPullFacts().mergeCommitSha,
          });
        },
      };
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const deps = {
      ...f.context.deps,
      state: rig.state,
      githubFor: rig.githubFor,
    };
    const context = {
      ...f.context,
      deps,
      snapshot: read.value.snapshot,
      observedHead: read.value.head,
      initialHead: read.value.head,
      ...createHostedAutonomyScopes(deps),
    };
    const result = await runHostedDeliveryPass(context);
    assert.equal(merges, 1, context.actions.join(" "));
    assert.equal(result?.status, "applied", context.actions.join(" "));
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(after.value.snapshot.releaseRequests.length, 1);
    assert.equal(after.value.snapshot.releaseRequests[0].source.pullRequest, 7);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("activated direct proof: only the resolver's live capability can book", async (t) => {
  for (const forged of [false, true]) {
    await t.step(
      forged ? "copied object refused" : "native proof accepted",
      async () => {
        const f = await fixture(true);
        try {
          const facts = await directProofFacts();
          f.pull.parents = [SHA1, SHA2];
          f.pull.mergedBy = "ubiquity-sentinel[bot]";
          f.context.deps.queueCustody = {
            ready: true,
            proofActivated: true,
            protectedRecordIds: new Set(),
            resolveDelivery: async () => {
              const result = await resolveQueueAwareDelivery(facts, POLICY);
              assert.equal(result.status, "verified");
              if (result.status !== "verified") throw new Error("fixture");
              return forged
                ? { ...result, delivery: { ...result.delivery } }
                : result;
            },
          };
          await runHostedDeliveryPass(f.context);
          const read = await f.rig.state.readRepair();
          assert.ok(read.ok && read.value.status === "found");
          assert.equal(
            read.value.snapshot.releaseRequests.length,
            forged ? 0 : 1,
          );
        } finally {
          await Deno.remove(f.rig.tmp, { recursive: true });
        }
      },
    );
  }
});

Deno.test("dormant queue floor: open green spent head merges directly once; verified direct booking preserves charges once", async () => {
  const f = await fixture(true);
  try {
    const facts = await directProofFacts();
    const githubFor = f.context.deps.githubFor;
    f.context.deps.githubFor = (repository) => {
      const surface = githubFor(repository);
      return surface === null ? null : {
        ...surface,
        readBaseTip: () => Promise.resolve(facts.binding.base),
        hasSuccessfulCheck: () => Promise.resolve(true),
        hasAllChecksGreen: () => Promise.resolve(true),
        readIssueOpen: () => Promise.resolve(true),
      };
    };
    const scope = await f.context.scopeFor(f.facts.record.repository);
    assert.ok(scope.surface);
    assert.equal(
      await scope.surface.readBaseTip("development"),
      f.facts.record.target.base,
    );
    assert.equal(await scope.surface.hasAllChecksGreen?.(SHA2), true);

    f.pull.state = "open";
    f.pull.merged = false;
    f.pull.mergeCommitSha = null;
    f.pull.parents = [];
    f.context.deps.queueCustody = {
      ready: true,
      proofActivated: false,
      protectedRecordIds: new Set(),
      resolveDelivery: () => resolveQueueAwareDelivery(facts, POLICY),
    };
    assert.equal(f.facts.record.counters.reviewRounds, 3);
    // Owner directive 2026-10-24 (#180): with queue proof dormant an
    // unprotected gateway record takes the direct launcher delivery.
    await runHostedDeliveryPass(f.context);
    assert.equal(
      f.rig.merges,
      1,
      "dormant floor merges the exact green head once",
    );
    assert.equal(f.rig.writes, 0, "an unobserved merge books nothing");
    const open = await f.rig.state.readRepair();
    assert.ok(open.ok && open.value.status === "found");
    assert.deepEqual(
      open.value.snapshot.reservations,
      f.context.snapshot.reservations,
    );
    f.pull.state = "closed";
    f.pull.merged = true;
    f.pull.mergeCommitSha = SHA4;
    f.pull.parents = [SHA1, SHA2];
    f.pull.mergedBy = "ubiquity-sentinel[bot]";
    const result = await runHostedDeliveryPass(f.context);
    assert.equal(result?.status, "applied", f.context.actions.join(" "));
    const booked = await f.rig.state.readRepair();
    assert.ok(booked.ok && booked.value.status === "found");
    assert.equal(booked.value.snapshot.releaseRequests.length, 1);
    assert.deepEqual(
      booked.value.snapshot.reservations,
      f.context.snapshot.reservations,
    );
    assert.equal(f.rig.merges, 1);
    assert.equal(f.rig.writes, 1);
    await runHostedDeliveryPass({
      ...f.context,
      snapshot: booked.value.snapshot,
      observedHead: booked.value.head,
      initialHead: booked.value.head,
      actions: [],
      revisions: [],
      ...createHostedAutonomyScopes(f.context.deps),
    });
    assert.equal(f.rig.merges, 1);
    assert.equal(f.rig.writes, 1, "exact replay is read-only");
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});
