import assert from "node:assert/strict";
import { createHostedQueueAuthority } from "../../ops/hosted-autonomy-queue-authority.ts";
import { decideQueuePolicy } from "../../ops/hosted-autonomy-queue-policy.ts";
import { buildHostedReleaseRequest } from "../../ops/hosted-autonomy-delivery.ts";
import { queueDeliveryProvenanceRef } from "../../src/github/queue-delivery-provenance.ts";
import { closureIntentKey } from "../../src/repair/keys.ts";
import {
  QUEUE_AUTHORITY_PINS,
  QUEUE_PROOF_POLICY,
} from "../../src/github/queue-runtime-policy.ts";
import { persistVpsDelivery } from "../repair/vps-delivery-fixtures.ts";
import { authorityRig } from "./merge-queue-authority-fixtures.ts";
import { SHA1, SHA3, SHA4 } from "./merge-queue-proof-fixtures.ts";

Deno.test("queue authority remains dark with absent source pins and uses REST-only legacy proof", async () => {
  const rig = await authorityRig();
  rig.toggles.merged = true;
  rig.toggles.rule = false;
  const dark = createHostedQueueAuthority({
    ...rig.options,
    configuration: {
      mode: "off",
      proofActivated: false,
      policy: QUEUE_PROOF_POLICY,
      pins: QUEUE_AUTHORITY_PINS,
    },
  });
  assert.equal(
    (await dark.authorization.readAuthorization(rig.request())).status,
    "unavailable",
  );
  assert.equal(
    (await dark.resolveDelivery(rig.deliveryRequest())).status,
    "legacy_direct",
  );
  assert.equal(rig.nativeReads, 0);
  rig.toggles.ruleUnavailable = true;
  assert.equal(
    (await dark.resolveDelivery(rig.deliveryRequest())).status,
    "unavailable",
  );
  assert.equal(rig.nativeReads, 0);
});

Deno.test("shipped queue authority is dormant with admission off; an activated floor still refuses legacy direct", async () => {
  const rig = await authorityRig();
  rig.toggles.merged = true;
  rig.toggles.rule = false;
  // Owner directive 2026-10-24 (#180): the shipped source pins are dormant.
  const shipped = createHostedQueueAuthority(rig.options);
  assert.equal(
    (await shipped.authorization.readAuthorization(rig.request())).status,
    "unavailable",
  );
  assert.equal(
    (await shipped.resolveDelivery(rig.deliveryRequest())).status,
    "legacy_direct",
  );
  const activated = createHostedQueueAuthority({
    ...rig.options,
    configuration: {
      mode: "off",
      proofActivated: true,
      policy: QUEUE_PROOF_POLICY,
      pins: QUEUE_AUTHORITY_PINS,
    },
  });
  assert.equal(
    (await activated.authorization.readAuthorization(rig.request())).status,
    "unavailable",
  );
  assert.equal(
    (await activated.resolveDelivery(rig.deliveryRequest())).status,
    "unavailable",
  );
});

Deno.test("queue authorization derives accepted facts and holds on changed workflow, rule, paths, CI and mergeability", async (t) => {
  for (
    const key of [
      "accepted",
      "workflow",
      "rule",
      "overlap",
      "ci",
      "mergeable",
      "tipAncestry",
      "optOut",
      "stateMoved",
    ] as const
  ) {
    await t.step(key, async () => {
      const rig = await authorityRig();
      if (key === "workflow") rig.toggles.workflow = "f".repeat(64);
      else if (key !== "accepted") {
        rig.toggles[key] = ["overlap", "optOut", "stateMoved"].includes(key);
      }
      const read = await rig.authority.authorization.readAuthorization(
        rig.request(),
      );
      if (key === "stateMoved") {
        assert.notEqual(read.status, "complete");
        return;
      }
      assert.equal(read.status, "complete");
      if (read.status !== "complete") {
        return;
      }
      assert.equal(
        decideQueuePolicy(read.value.facts).action,
        key === "accepted" ? "enqueue" : "hold",
      );
    });
  }
});

Deno.test("queue authorization cannot grant from a stale state or queue snapshot", async () => {
  const rig = await authorityRig();
  const request = rig.request();
  rig.setQueue({ ...rig.queue, baseTip: SHA4 });
  assert.notEqual(
    (await rig.authority.authorization.readAuthorization(request)).status,
    "complete",
  );
  rig.setQueue(request.queue);
  assert.notEqual(
    (await rig.authority.authorization.readAuthorization({
      ...request,
      observedHead: SHA3,
    })).status,
    "complete",
  );
});

Deno.test("queue admission requires every pin and complete predecessor paths", async (t) => {
  for (
    const missing of [
      "canary",
      "workflow",
      "rules",
      "workflow_read",
      "predecessor",
      "patch_drift",
    ] as const
  ) {
    await t.step(missing, async () => {
      const rig = await authorityRig();
      if (missing === "canary") rig.policy.canaryDigest = null;
      if (missing === "workflow") rig.policy.workflowSha256 = null;
      if (missing === "rules") rig.pins.effectiveRulesSha256 = null;
      if (missing === "workflow_read") {
        rig.client.readQueueWorkflowDigest = () =>
          Promise.resolve({ status: "unavailable", reason: "transport" });
      }
      if (missing === "predecessor") {
        rig.setQueue({
          ...rig.queue,
          entries: [{
            ...rig.entry,
            id: "OTHER",
            pull: { ...rig.entry.pull, number: 8, head: SHA4 },
          }],
        });
      }
      if (missing === "patch_drift") {
        const read = rig.client.readQueuePatch.bind(rig.client);
        let calls = 0;
        rig.client.readQueuePatch = async (...args) => {
          const patch = await read(...args);
          return ++calls === 2 && patch.status === "complete"
            ? { ...patch, value: { ...patch.value, changes: [] } }
            : patch;
        };
      }
      const result = await rig.authority.authorization.readAuthorization(
        rig.request(),
      );
      if (result.status === "complete") {
        assert.equal(decideQueuePolicy(result.value.facts).action, "hold");
      } else assert.equal(result.status, "unavailable");
    });
  }
});

Deno.test("queue admission rejects predecessor workflow and action edits even when candidate paths are disjoint", async (t) => {
  for (
    const path of [
      ".github/workflows/deno-deploy.yml",
      ".github/actions/tool/action.yml",
    ]
  ) {
    await t.step(path, async () => {
      const rig = await authorityRig();
      rig.setQueue({
        ...rig.queue,
        entries: [{
          ...rig.entry,
          id: "OTHER",
          pull: { ...rig.entry.pull, number: 8, head: SHA4 },
        }],
      });
      const readPatch = rig.client.readQueuePatch.bind(rig.client);
      rig.client.readQueuePatch = async (...args) => {
        const result = await readPatch(...args);
        return args[0] === SHA3 && args[1] === SHA4 &&
            result.status === "complete"
          ? {
            ...result,
            value: {
              ...result.value,
              changes: result.value.changes.map((change) => ({
                ...change,
                path,
              })),
            },
          }
          : result;
      };
      const result = await rig.authority.authorization.readAuthorization(
        rig.request(),
      );
      assert.equal(result.status, "complete");
      if (result.status !== "complete") return;
      assert.equal(decideQueuePolicy(result.value.facts).action, "hold");
    });
  }
});

Deno.test("strict queue proof cannot become legacy direct after custody, failed CI or missing native provenance", async (t) => {
  for (
    const missing of ["events", "canary", "ci", "state", "root_only"] as const
  ) {
    await t.step(missing, async () => {
      const rig = await authorityRig(true);
      if (missing === "events") {
        rig.setEvidence({
          ...rig.evidence,
          added: [],
          removed: [],
          mergeGroupRuns: [],
        });
      }
      if (missing === "canary") rig.policy.canaryDigest = null;
      if (missing === "ci") {
        rig.setEvidence({
          ...rig.evidence,
          mergeGroupRuns: rig.evidence.mergeGroupRuns.map((run) => ({
            ...run,
            conclusion: "failure",
          })),
        });
      }
      if (missing === "state") rig.toggles.stateMoved = true;
      if (missing === "root_only") {
        rig.replace({
          ...rig.snapshot,
          work: [{
            ...rig.record,
            intent: null,
            wait: null,
            evidence: [{
              kind: "review_receipt",
              ref:
                `artifact:review-receipt/merge-queue-v1/${rig.facts.receipt.id}/${SHA3}`,
            }],
          }],
        });
      }
      rig.toggles.rule = false;
      const dark = createHostedQueueAuthority({
        ...rig.options,
        configuration: {
          ...rig.configuration,
          mode: "off",
          proofActivated: false,
        },
      });
      const result = await dark.resolveDelivery(rig.deliveryRequest());
      assert.notEqual(result.status, "verified");
      assert.notEqual(result.status, "legacy_direct");
    });
  }
});

async function booking() {
  const rig = await authorityRig(true);
  const proof = await rig.authority.resolveDelivery(rig.deliveryRequest());
  assert.equal(proof.status, "verified");
  if (proof.status !== "verified") throw new Error(JSON.stringify(proof));
  const ref = queueDeliveryProvenanceRef(proof.delivery, rig.record, rig.head);
  assert.ok(ref);
  const now = rig.clock.now();
  const request = await buildHostedReleaseRequest(
    rig.record.repository,
    SHA4,
    rig.record.target.head!,
    rig.record.target.base,
    7,
    rig.facts.receipt,
    now,
  );
  assert.ok(request);
  const next = {
    ...rig.snapshot,
    stateHead: rig.head,
    sequence: rig.snapshot.sequence + 1,
    updatedAt: now,
    work: [{
      ...rig.record,
      nextStep: "delivery" as const,
      blocker: null,
      evidence: [...rig.record.evidence, ref],
      updatedAt: now,
    }],
    releaseRequests: [request],
  };
  return { ...rig, rig, next, request, ref };
}

Deno.test("queue protected booking is exact and refuses charge, intent, hold, target and unrelated state edits", async (t) => {
  const { rig, next } = await booking();
  assert.equal(
    await rig.authority.verifyProtectedWrite(rig.snapshot, next, rig.head),
    true,
  );
  for (
    const field of [
      "counter",
      "wait",
      "intent",
      "target",
      "request",
      "root",
      "sequence",
      "reviews",
    ] as const
  ) {
    await t.step(field, async () => {
      const bad = structuredClone(next);
      if (field === "counter") bad.work[0].counters.attempts++;
      if (field === "wait") bad.work[0].wait = null;
      if (field === "intent") bad.work[0].intent = null;
      if (field === "target") bad.work[0].target.head = SHA3;
      if (field === "request") bad.releaseRequests[0].revision = SHA3;
      if (field === "root") {
        bad.work[0].evidence.at(-1)!.ref = bad.work[0].evidence.at(-1)!.ref
          .replace(SHA1, SHA3);
      }
      if (field === "sequence") bad.sequence++;
      if (field === "reviews") bad.reviews = [];
      assert.equal(
        await rig.authority.verifyProtectedWrite(rig.snapshot, bad, rig.head),
        false,
      );
    });
  }
});

Deno.test("queue custody survives booking and closes only through accepted VPS and an observed closed issue", async () => {
  const { rig, next, request } = await booking();
  rig.replace(next, SHA3);
  rig.clock.advance(1);
  const closure = {
    ...rig.snapshot,
    stateHead: rig.head,
    sequence: rig.snapshot.sequence + 1,
    updatedAt: rig.clock.now(),
    work: [{
      ...rig.record,
      updatedAt: rig.clock.now(),
      intent: {
        kind: "issue_closure" as const,
        key: closureIntentKey(1),
        startedAt: rig.clock.now(),
        branch: null,
        expectedHead: rig.record.target.head,
        observedBase: rig.record.target.base,
        pr: 7,
        requestId: request.id,
        resultId: null,
      },
    }],
  };
  assert.equal(
    await rig.authority.verifyProtectedWrite(rig.snapshot, closure, rig.head),
    false,
    "merge alone is not deployed delivery",
  );
  await persistVpsDelivery(rig.state, rig.state, rig.clock, request);
  closure.updatedAt = rig.clock.now();
  closure.work[0].updatedAt = rig.clock.now();
  closure.work[0].intent.startedAt = rig.clock.now();
  assert.equal(
    await rig.authority.verifyProtectedWrite(rig.snapshot, closure, rig.head),
    true,
  );
  assert.deepEqual(closure.work[0].wait, rig.record.wait);
  rig.replace(closure, SHA4);
  rig.clock.advance(1);
  const done = {
    ...rig.snapshot,
    stateHead: rig.head,
    sequence: rig.snapshot.sequence + 1,
    updatedAt: rig.clock.now(),
    work: [{
      ...rig.record,
      nextStep: "done" as const,
      wait: null,
      blocker: null,
      intent: null,
      updatedAt: rig.clock.now(),
    }],
  };
  assert.equal(
    await rig.authority.verifyProtectedWrite(rig.snapshot, done, rig.head),
    false,
    "unclosed issue is not done",
  );
  rig.toggles.issueOpen = false;
  assert.equal(
    await rig.authority.verifyProtectedWrite(rig.snapshot, done, rig.head),
    true,
  );
  assert.deepEqual(done.work[0].counters, rig.record.counters);
  assert.deepEqual(done.work[0].evidence, rig.record.evidence);
});
