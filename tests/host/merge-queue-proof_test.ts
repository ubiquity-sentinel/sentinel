import assert from "node:assert/strict";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import { baseAndHeadAreMerged } from "../../ops/hosted-autonomy-delivery.ts";
import type { HostedAutonomyPullV1 } from "../../ops/hosted-autonomy-types.ts";
import { resolveQueueAwareDelivery } from "../../ops/hosted-autonomy-queue-proof.ts";
import {
  APP,
  directProofFacts,
  POLICY,
  queueProofFacts,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  T0,
} from "./merge-queue-proof-fixtures.ts";

Deno.test("queue proof books an exact middle-of-batch patch under successful canonical group CI", async () => {
  const facts = await queueProofFacts();
  const result = await resolveQueueAwareDelivery(facts, POLICY);
  assert.equal(result.status, "verified");
  if (result.status !== "verified" || result.delivery.kind !== "queue") {
    throw new Error("expected queue proof");
  }
  assert.equal(result.delivery.firstParent, SHA3);
  assert.equal(result.delivery.head, SHA2);
  assert.equal(result.delivery.revision, SHA4);
  assert.match(result.delivery.proofDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.delivery.workflowRunId, 83);
});

Deno.test("legacy mid-batch verifier acceptance cannot bypass missing exact queue patch", async () => {
  const facts = await queueProofFacts();
  assert.equal(
    baseAndHeadAreMerged(
      {
        number: 7,
        state: "closed",
        merged: true,
        mergeCommitSha: SHA4,
        headSha: SHA2,
        baseRef: "development",
        author: APP.login,
        revisionOnBaseBranch: true,
        parents: [SHA3, SHA2],
        baseSha: SHA1,
        baseAncestorOfRevision: true,
      } satisfies HostedAutonomyPullV1,
      SHA1,
      SHA2,
    ),
    true,
  );
  if (facts.integratedPatch.status !== "complete") throw new Error("fixture");
  facts.integratedPatch.value.changes = [
    ...facts.integratedPatch.value.changes,
    {
      path: "src/unreviewed.ts",
      oldMode: null,
      oldSha: null,
      newMode: "100644",
      newSha: SHA3,
    },
  ];
  facts.directWitness = (await directProofFacts()).directWitness;
  assert.deepEqual(await resolveQueueAwareDelivery(facts, POLICY), {
    status: "rejected",
    reason: "tree_mismatch",
  });
});

Deno.test("queue proof checks ordered parents, full blob/mode identity, reachability and App provenance", async (t) => {
  const cases = [
    {
      name: "reversed parents",
      change: (f: Awaited<ReturnType<typeof queueProofFacts>>) => {
        f.commit!.parents = [SHA2, SHA3];
      },
    },
    {
      name: "wrong tree blob",
      change: (f: Awaited<ReturnType<typeof queueProofFacts>>) => {
        if (f.integratedPatch.status === "complete") {
          f.integratedPatch.value.changes = [{
            path: "src/fix.ts",
            oldMode: "100644",
            oldSha: SHA1,
            newMode: "100644",
            newSha: SHA3,
          }];
        }
      },
    },
    {
      name: "wrong tree mode",
      change: (f: Awaited<ReturnType<typeof queueProofFacts>>) => {
        if (f.integratedPatch.status === "complete") {
          f.integratedPatch.value.changes = [{
            path: "src/fix.ts",
            oldMode: "100644",
            oldSha: SHA1,
            newMode: "100755",
            newSha: SHA2,
          }];
        }
      },
    },
    {
      name: "unreachable merge",
      change: (f: Awaited<ReturnType<typeof queueProofFacts>>) => {
        f.reachable = {
          status: "complete",
          value: { revision: SHA4, branch: "development", reachable: false },
        };
      },
    },
    {
      name: "unproved ancestry",
      change: (f: Awaited<ReturnType<typeof queueProofFacts>>) => {
        f.ancestry = { status: "unavailable", reason: "not_found" };
      },
    },
    {
      name: "foreign enqueuer",
      change: (f: Awaited<ReturnType<typeof queueProofFacts>>) => {
        if (f.queue.status === "complete" && f.queue.value) {
          f.queue.value.enqueuer = {
            type: "User",
            nodeId: "U_1",
            login: "owner",
          };
        }
      },
    },
    {
      name: "wrong merged actor",
      change: (f: Awaited<ReturnType<typeof queueProofFacts>>) => {
        f.mergedBy = { ...APP, nodeId: "BOT_other" };
      },
    },
  ];
  for (const test of cases) {
    await t.step(test.name, async () => {
      const facts = await queueProofFacts();
      test.change(facts);
      assert.notEqual(
        (await resolveQueueAwareDelivery(facts, POLICY)).status,
        "verified",
      );
    });
  }
  assert.deepEqual(
    await resolveQueueAwareDelivery(await queueProofFacts(), {
      ...POLICY,
      canaryDigest: null,
    }),
    { status: "unavailable", reason: "canary_unaccepted" },
  );
});

Deno.test("queue group CI never substitutes PR CI, prior success, skipped or wrong App checks", async (t) => {
  const cases = [
    "missing",
    "wrong head",
    "skipped",
    "neutral",
    "wrong app",
    "later pending",
    "missing check",
    "wrong suite",
    "unavailable",
  ];
  for (const name of cases) {
    await t.step(name, async () => {
      const facts = await queueProofFacts();
      if (facts.groupRuns.status !== "complete") throw new Error("fixture");
      const run = facts.groupRuns.value[0];
      if (name === "missing") facts.groupRuns.value = [];
      if (name === "wrong head") run.head = SHA2;
      if (name === "skipped" || name === "neutral") {
        run.checks[0].conclusion = name;
      }
      if (name === "wrong app") run.checks[0].appId = 999;
      if (name === "wrong suite") run.checks[0].suiteId = 999;
      if (name === "missing check") run.checks = run.checks.slice(1);
      if (name === "later pending") {
        facts.groupRuns.value = [run, {
          ...run,
          id: 84,
          status: "in_progress",
          conclusion: null,
        }];
      }
      if (name === "unavailable") {
        facts.groupRuns = { status: "unavailable", reason: "not_found" };
      }
      facts.directWitness = (await directProofFacts()).directWitness;
      assert.notEqual(
        (await resolveQueueAwareDelivery(facts, POLICY)).status,
        "verified",
      );
    });
  }
});

Deno.test("latest current task review stays mandatory at third round; queue custody dominates historical direct", async () => {
  const facts = await queueProofFacts();
  assert.equal(facts.record.counters.reviewRounds, 3);
  facts.latestReceiptId = "later-blocking-receipt";
  assert.deepEqual(await resolveQueueAwareDelivery(facts, POLICY), {
    status: "rejected",
    reason: "receipt_mismatch",
  });
  const changed = await queueProofFacts();
  if (changed.task !== null && changed.task !== "unavailable") {
    changed.task.body = "Owner changed this task.";
  }
  assert.deepEqual(await resolveQueueAwareDelivery(changed, POLICY), {
    status: "rejected",
    reason: "task_mismatch",
  });
  for (const marked of [false, true]) {
    const direct = await directProofFacts();
    if (marked) {
      direct.record.intent = {
        kind: "merge",
        key: `merge-queue:v1:7:${SHA2}`,
        startedAt: T0,
        expectedHead: SHA2,
        observedBase: SHA1,
        branch: direct.pull.headRef,
        pr: 7,
        requestId: null,
        resultId: null,
      };
    } else direct.record.wait = { reason: "backoff", since: T0, until: null };
    assert.deepEqual(await resolveQueueAwareDelivery(direct, POLICY), {
      status: "rejected",
      reason: "queue_evidence_required",
    });
  }
});

Deno.test("carried review requires original and current full patches before authorizing queue delivery", async () => {
  const facts = await queueProofFacts();
  facts.receipt.pullRequest = {
    ...facts.receipt.pullRequest,
    base: SHA3,
    head: SHA4,
  };
  assert.deepEqual(await resolveQueueAwareDelivery(facts, POLICY), {
    status: "unavailable",
    reason: "tree_unavailable",
  });
  if (facts.reviewedPatch.status !== "complete") throw new Error("fixture");
  facts.originalPatch = {
    status: "complete",
    value: {
      base: SHA3,
      head: SHA4,
      mergeBase: SHA3,
      changes: facts.reviewedPatch.value.changes,
    },
  };
  assert.equal(
    (await resolveQueueAwareDelivery(facts, POLICY)).status,
    "verified",
  );
});

Deno.test("direct delivery needs authenticated exact provenance; absent group CI never proves direct", async () => {
  const facts = await directProofFacts();
  assert.equal(
    (await resolveQueueAwareDelivery(facts, { ...POLICY, canaryDigest: null }))
      .status,
    "verified",
  );
  facts.directWitness = null;
  assert.deepEqual(await resolveQueueAwareDelivery(facts, POLICY), {
    status: "rejected",
    reason: "direct_provenance_missing",
  });
  const unavailable = await directProofFacts();
  unavailable.queue = { status: "unavailable", reason: "permission" };
  assert.deepEqual(await resolveQueueAwareDelivery(unavailable, POLICY), {
    status: "unavailable",
    reason: "queue_evidence_unavailable",
  });
  const historical = await directProofFacts();
  const witnesses = [{
    binding: historical.binding,
    revision: SHA4,
    witnessDigest: "c".repeat(64),
  }];
  const manifestDigest = await canonicalStringifySha256({
    domain: "sentinel.queue-historical-direct.v1",
    witnesses,
  });
  const historicalPolicy = {
    ...POLICY,
    historicalDirectManifestDigest: manifestDigest,
    historicalDirectWitnesses: witnesses,
  };
  historical.directWitness!.provenance = {
    kind: "historical_exact",
    manifestDigest,
    witnessDigest: "c".repeat(64),
  };
  assert.equal(
    (await resolveQueueAwareDelivery(historical, historicalPolicy)).status,
    "verified",
  );
  assert.equal(
    (await resolveQueueAwareDelivery(historical, {
      ...historicalPolicy,
      historicalDirectManifestDigest: "d".repeat(64),
    })).status,
    "rejected",
  );
  assert.equal(
    (await resolveQueueAwareDelivery(historical, {
      ...historicalPolicy,
      historicalDirectWitnesses: [],
    })).status,
    "rejected",
  );
  assert.equal(
    (await resolveQueueAwareDelivery(historical, {
      ...historicalPolicy,
      historicalDirectWitnesses: [...witnesses, ...witnesses],
    })).status,
    "rejected",
  );
  historical.anyQueueEvidence = true;
  assert.deepEqual(
    await resolveQueueAwareDelivery(historical, historicalPolicy),
    {
      status: "rejected",
      reason: "queue_evidence_required",
    },
  );
});

Deno.test("a correctly hashed historical manifest still rejects duplicate or malformed grants", async () => {
  const facts = await directProofFacts();
  const grant = {
    binding: facts.binding,
    revision: SHA4,
    witnessDigest: "c".repeat(64),
  };
  for (
    const extra of [grant, {
      ...grant,
      binding: { ...grant.binding, pullRequest: 0 },
    }]
  ) {
    const witnesses = [grant, extra];
    const digest = await canonicalStringifySha256({
      domain: "sentinel.queue-historical-direct.v1",
      witnesses,
    });
    facts.directWitness!.provenance = {
      kind: "historical_exact",
      manifestDigest: digest,
      witnessDigest: grant.witnessDigest,
    };
    assert.deepEqual(
      await resolveQueueAwareDelivery(facts, {
        ...POLICY,
        historicalDirectManifestDigest: digest,
        historicalDirectWitnesses: witnesses,
      }),
      {
        status: "rejected",
        reason: "direct_provenance_mismatch",
      },
    );
  }
});

Deno.test("queue proof requires the reviewed workflow bytes at exact M", async () => {
  for (
    const variant of [
      "missing",
      "unavailable",
      "wrong_revision",
      "changed_bytes",
    ]
  ) {
    const facts = await queueProofFacts();
    if (variant === "missing") delete facts.workflow;
    else if (variant === "unavailable") {
      facts.workflow = { status: "unavailable", reason: "permission" };
    } else if (facts.workflow?.status === "complete") {
      if (variant === "wrong_revision") facts.workflow.value.revision = SHA2;
      else facts.workflow.value.sha256 = "d".repeat(64);
    }
    const result = await resolveQueueAwareDelivery(facts, POLICY);
    assert.notEqual(result.status, "verified", variant);
  }
});

Deno.test("fixture proof: active delivery consumer requires a pinned exact synthetic operation", async (t) => {
  const { darkQueueFixture } = await import(
    "./hosted-autonomy-dark-queue-fixture.ts"
  );
  const {
    liveRecord,
    liveReceipts,
    liveTask,
    liveSnapshot,
    liveSurface,
    mergedPull,
  } = await import("./hosted-autonomy-spent-fixtures.ts");
  const { MemoryState } = await import("../repair/helpers.ts");
  const { resolveHostedDelivery } = await import(
    "../../ops/hosted-autonomy-delivery-proof.ts"
  );
  for (
    const variant of [
      "exact",
      "unwitnessed",
      "wrong task",
      "wrong head",
      "wrong receipt",
      "wrong actor",
      "wrong parent",
      "held",
    ]
  ) {
    await t.step(variant, async () => {
      const record = liveRecord(618);
      const receipts = liveReceipts(record);
      const receipt = receipts[0];
      const task = liveTask(618, receipts)!;
      let pull = mergedPull(record, record.target.base!);
      if (variant === "unwitnessed") pull = structuredClone(pull);
      if (variant === "wrong task") task.body += " changed after review";
      if (variant === "wrong head") pull.headSha = SHA4;
      if (variant === "wrong actor") pull.mergedBy = "owner";
      if (variant === "wrong parent") {
        pull.parents = [SHA4, record.target.head!];
      }
      if (variant === "wrong receipt") receipt.id += "-foreign";
      if (variant === "held") {
        record.wait = { reason: "backoff", since: T0, until: null };
      }
      const snapshot = liveSnapshot([record], receipts);
      const { surface } = liveSurface({
        pulls: { [record.target.pr!]: pull },
        tasks: { 618: task },
      });
      const state = new MemoryState();
      const deps = {
        state,
        githubFor: () => surface,
        clock: { now: () => T0 },
      };
      const proof = await resolveHostedDelivery(
        {
          deps: { ...deps, queueCustody: darkQueueFixture(deps) },
          snapshot,
          observedHead: SHA1,
        },
        record,
        {
          repository: record.repository,
          key: "fixture",
          surface,
          baseBranch: "development",
        },
        pull,
        "delivery",
      );
      if (variant === "exact") {
        assert.equal(proof?.kind, "direct");
        assert.equal(proof?.head, record.target.head);
      } else assert.equal(proof, null, variant);
    });
  }
});

Deno.test("fixture proof: dormant compiled floor accepts exact legacy direct; queue custody still refuses it", async () => {
  const facts = await directProofFacts();
  const { resolveHostedDelivery } = await import(
    "../../ops/hosted-autonomy-delivery-proof.ts"
  );
  const { liveSnapshot, liveSurface } = await import(
    "./hosted-autonomy-spent-fixtures.ts"
  );
  const { MemoryState } = await import("../repair/helpers.ts");
  const pull: HostedAutonomyPullV1 = {
    number: facts.binding.pullRequest,
    state: "closed",
    merged: true,
    mergeCommitSha: facts.revision,
    headSha: facts.binding.head,
    baseRef: "development",
    baseSha: facts.binding.base,
    author: APP.login,
    mergedBy: APP.login,
    parents: [facts.binding.base, facts.binding.head],
    revisionOnBaseBranch: true,
    baseAncestorOfRevision: true,
  };
  const { surface } = liveSurface({
    pulls: { [pull.number]: pull },
    tasks: {
      [facts.record.related.issueNumber!]: facts.task === "unavailable"
        ? null
        : facts.task,
    },
  });
  const resolve = (protectedRecordIds: ReadonlySet<string>) =>
    resolveHostedDelivery(
      {
        snapshot: liveSnapshot([facts.record], [facts.receipt]),
        observedHead: SHA1,
        deps: {
          state: new MemoryState(),
          githubFor: () => surface,
          clock: { now: () => T0 },
          queueCustody: {
            ready: true,
            proofActivated: false,
            protectedRecordIds,
            resolveDelivery: () =>
              Promise.resolve({
                status: "legacy_direct",
                binding: facts.binding,
                revision: facts.revision!,
              }),
          },
        },
      },
      facts.record,
      {
        repository: facts.record.repository,
        key: "fixture",
        surface,
        baseBranch: "development",
      },
      pull,
      "delivery",
    );
  // Owner directive 2026-10-24 (#180): the shipped floor is dormant.
  const proof = await resolve(new Set());
  assert.equal(proof?.kind, "legacy");
  assert.equal(proof?.head, facts.binding.head);
  assert.equal(await resolve(new Set([facts.record.id])), null);
});
