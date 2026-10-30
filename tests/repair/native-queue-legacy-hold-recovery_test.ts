/** A pre-m25 permanent queue hold is inspected before its scheduling wait changes. */
import assert from "node:assert/strict";
import type {
  NativeQueueGuardV1,
  QueueGuardDecision,
} from "../../src/github/native-queue-guard.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import { createNativeQueueGuard } from "../../src/github/native-queue-guard.ts";
import { createQueueDeliveryReader } from "../../src/github/queue-delivery-reader.ts";
import { QUEUE_PROOF_POLICY } from "../../src/github/queue-runtime-policy.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { FakeGithub } from "./helpers.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { preservedIssueWork } from "./loop-candidate-fixtures.ts";
import {
  localScopeConfig,
  makeMemoryRig,
  makeRig,
  seededSnapshot,
} from "./loop-rig.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";

function legacyHeldRecord(
  intent: WorkRecordV1["intent"] = null,
): WorkRecordV1 {
  const base = preservedIssueWork("issue-1", SHA2);
  return {
    ...base,
    nextStep: "work",
    wait: { reason: "backoff", since: T0, until: null },
    updatedAt: T0,
    intent,
    target: {
      ...base.target,
      candidateState: { preserved: null, publishedHead: null },
    },
  };
}

function decisionGuard(decision: QueueGuardDecision) {
  const calls = { inspect: 0, effect: 0, delivery: 0 };
  const guard: NativeQueueGuardV1 = {
    inspect: () => {
      calls.inspect++;
      return Promise.resolve(decision);
    },
    inspectEffect: () => {
      calls.effect++;
      return Promise.resolve(decision);
    },
    proveDelivery: () => {
      calls.delivery++;
      return Promise.resolve({
        status: "unavailable",
        reason: "queue_evidence_unavailable",
      });
    },
  };
  return { guard, calls };
}

async function rig(decision: QueueGuardDecision, record = legacyHeldRecord()) {
  const r = await makeRig("m25b-legacy-queue-hold", { summaries: false });
  const written = await r.store.writeRepair(seededSnapshot([record]), null);
  assert.ok(written.ok && written.value.status === "applied");
  const read = await r.store.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const before = read.value.snapshot;
  const fixed = decisionGuard(decision);
  r.github.nativeQueue = fixed.guard;
  return { r, before, calls: fixed.calls };
}

Deno.test("a legacy permanent queue hold is re-inspected and allow clears it", async () => {
  const f = await rig({ status: "allow", basis: "inactive_no_rule" });
  try {
    const outcome = await f.r.run();
    assert.equal(f.calls.inspect, 1, JSON.stringify(outcome));
    const after = await f.r.snapshot();
    assert.equal(after.work[0].wait, null);
    assert.deepEqual(after.work[0].intent, f.before.work[0].intent);
    assert.deepEqual(after.work[0].target, f.before.work[0].target);
    assert.deepEqual(after.work[0].counters, f.before.work[0].counters);
    assert.deepEqual(after.reservations, f.before.reservations);
    assert.deepEqual(after.reviews, f.before.reviews);
    assert.deepEqual(after.releaseRequests, f.before.releaseRequests);
  } finally {
    await f.r.ctx.cleanup();
  }
});

Deno.test("a legacy permanent queue hold converts to the bounded transient wait", async () => {
  const f = await rig({
    status: "hold",
    reason: "rule_unavailable",
    pull: null,
  });
  try {
    const outcome = await f.r.run();
    assert.equal(f.calls.effect, 1, JSON.stringify(outcome));
    let after = await f.r.snapshot();
    assert.deepEqual(after.work[0].wait, {
      reason: "unavailable",
      since: T0,
      until: T0 + CHECK_POLL_MS,
    });
    assert.deepEqual(after.reservations, f.before.reservations);
    assert.deepEqual(after.work[0].intent, f.before.work[0].intent);

    f.r.clock.advance(CHECK_POLL_MS + 1);
    const second = await f.r.run();
    assert.equal(f.calls.inspect, 1, JSON.stringify(second));
    after = await f.r.snapshot();
    assert.deepEqual(after.work[0].wait, {
      reason: "unavailable",
      since: T0,
      until: f.r.clock.now() + CHECK_POLL_MS,
    });
  } finally {
    await f.r.ctx.cleanup();
  }
});

Deno.test("a legacy permanent queue hold stays held after a positive denial", async () => {
  const f = await rig({ status: "hold", reason: "custody", pull: null });
  try {
    const outcome = await f.r.run();
    assert.equal(f.calls.effect, 1, JSON.stringify(outcome));
    const first = await f.r.snapshot();
    assert.deepEqual(first.work[0].wait, f.before.work[0].wait);
    assert.deepEqual(first.work[0].counters, f.before.work[0].counters);
    assert.deepEqual(first.reservations, f.before.reservations);

    const second = await f.r.run();
    assert.equal(f.calls.effect, 2, JSON.stringify(second));
    const after = await f.r.snapshot();
    assert.deepEqual(after.work[0].wait, {
      reason: "backoff",
      since: T0,
      until: null,
    });
  } finally {
    await f.r.ctx.cleanup();
  }
});

Deno.test("queue intent namespace remains strict during legacy hold recovery", async () => {
  const held = legacyHeldRecord({
    kind: "merge",
    key: "merge-queue:v1:damaged",
    branch: legacyHeldRecord().target.branch,
    expectedHead: SHA2,
    observedBase: SHA1,
    pr: 7,
    startedAt: T0,
    requestId: null,
    resultId: null,
  });
  const f = await rig({ status: "allow", basis: "inactive_no_rule" }, held);
  try {
    const outcome = await f.r.run();
    assert.equal(f.calls.inspect, 0, JSON.stringify(outcome));
    const after = await f.r.snapshot();
    assert.deepEqual(after.work[0].wait, f.before.work[0].wait);
    assert.deepEqual(after.work[0].intent, f.before.work[0].intent);
  } finally {
    await f.r.ctx.cleanup();
  }
});

Deno.test("the actual native guard observes the released legacy hold afresh", async () => {
  const record = legacyHeldRecord();
  const r = await makeRig("m25b-native-legacy-queue-hold", {
    summaries: false,
  });
  try {
    const written = await r.store.writeRepair(seededSnapshot([record]), null);
    assert.ok(written.ok && written.value.status === "applied");
    const client = new GitHubQueueDeliveryClient({
      repository: record.repository,
      clock: r.clock,
      apiBaseUrl: "https://api.github.com",
      auth: new FakeAuthProvider(),
      cooldownGate: new FakeCooldownGate(),
      http: () => Promise.reject(new Error("no HTTP is authorized")),
    }, null);
    client.readBranchRules = () => Promise.resolve(portOk([]));
    const actual = createNativeQueueGuard({
      repository: record.repository,
      state: r.store,
      clock: r.clock,
      client,
      reader: createQueueDeliveryReader({
        repository: record.repository,
        clock: r.clock,
        client,
        policy: QUEUE_PROOF_POLICY,
      }),
      policy: QUEUE_PROOF_POLICY,
      mode: "off",
      proofActivated: false,
    });
    let inspections = 0;
    r.github.nativeQueue = {
      ...actual,
      inspect: (input) => {
        inspections++;
        return actual.inspect(input);
      },
    };
    const outcome = await r.run();
    assert.equal(inspections, 1, JSON.stringify(outcome));
    const after = await r.snapshot();
    assert.equal(after.work[0].wait, null);
  } finally {
    await r.ctx.cleanup();
  }
});

Deno.test("a review-phase legacy hold is inspected before a one-step run can clear it", async () => {
  const r = makeMemoryRig(new FakeGithub());
  const held = { ...legacyHeldRecord(), nextStep: "review" as const };
  r.state.repair = seededSnapshot([held]);
  r.state.repairHead = SHA1;
  const fixed = decisionGuard({ status: "allow", basis: "inactive_no_rule" });
  let observedWait: WorkRecordV1["wait"] | undefined;
  r.github.nativeQueue = {
    ...fixed.guard,
    inspectEffect: (input) => {
      observedWait = r.state.repair?.work[0].wait;
      return fixed.guard.inspectEffect(input);
    },
  };

  const outcome = await r.run(1);
  assert.equal(
    fixed.calls.inspect + fixed.calls.effect,
    1,
    JSON.stringify(outcome),
  );
  assert.deepEqual(observedWait, held.wait);
  const after = await r.snapshot();
  assert.equal(after.work[0].wait, null);
});

Deno.test("a Sentinel-only cycle leaves a Gateway legacy hold byte-identical", async () => {
  const r = makeMemoryRig(new FakeGithub());
  r.configs.splice(0, r.configs.length, localScopeConfig(r.configs[0]));
  const held = legacyHeldRecord();
  r.state.repair = seededSnapshot([held]);
  r.state.repairHead = SHA1;
  const fixed = decisionGuard({ status: "allow", basis: "inactive_no_rule" });
  r.github.nativeQueue = fixed.guard;
  const before = canonicalStringify(r.state.repair.work[0]);

  const outcome = await r.run(1);
  const after = await r.snapshot();
  assert.equal(
    canonicalStringify(after.work[0]),
    before,
    JSON.stringify(outcome),
  );
  assert.equal(fixed.calls.inspect + fixed.calls.effect, 0);
  assert.equal(r.state.repairWrites, 0);
});

Deno.test("a positive denial leaves the permanent hold without a write", async () => {
  const r = makeMemoryRig(new FakeGithub());
  const held = legacyHeldRecord();
  r.state.repair = seededSnapshot([held]);
  r.state.repairHead = SHA1;
  const fixed = decisionGuard({
    status: "hold",
    reason: "custody",
    pull: null,
  });
  r.github.nativeQueue = fixed.guard;
  const before = canonicalStringify(r.state.repair.work[0]);

  const outcome = await r.run(1);
  const after = await r.snapshot();
  assert.equal(
    canonicalStringify(after.work[0]),
    before,
    JSON.stringify(outcome),
  );
  assert.equal(fixed.calls.effect, 1);
  assert.equal(r.state.repairWrites, 0);
});

Deno.test("a failed legacy queue inspection leaves the hold untouched", async () => {
  const r = makeMemoryRig(new FakeGithub());
  const held = legacyHeldRecord();
  r.state.repair = seededSnapshot([held]);
  r.state.repairHead = SHA1;
  const fixed = decisionGuard({ status: "allow", basis: "inactive_no_rule" });
  r.github.nativeQueue = {
    ...fixed.guard,
    inspectEffect: () =>
      Promise.reject(new Error("synthetic inspection fault")),
  };
  const before = canonicalStringify(r.state.repair.work[0]);

  const outcome = await r.run(1);
  const after = await r.snapshot();
  assert.equal(
    canonicalStringify(after.work[0]),
    before,
    JSON.stringify(outcome),
  );
  assert.equal(r.state.repairWrites, 0);
});

Deno.test("delivery provenance keeps a legacy queue hold strict", async () => {
  const r = makeMemoryRig(new FakeGithub());
  const held = {
    ...legacyHeldRecord(),
    evidence: [{
      kind: "review_receipt" as const,
      ref: "artifact:review-receipt/merge-queue-v1/prior",
    }],
  };
  r.state.repair = seededSnapshot([held]);
  r.state.repairHead = SHA1;
  const fixed = decisionGuard({ status: "allow", basis: "inactive_no_rule" });
  r.github.nativeQueue = fixed.guard;
  const before = canonicalStringify(r.state.repair.work[0]);

  const outcome = await r.run(1);
  const after = await r.snapshot();
  assert.equal(
    canonicalStringify(after.work[0]),
    before,
    JSON.stringify(outcome),
  );
  assert.equal(fixed.calls.inspect + fixed.calls.effect, 0);
  assert.equal(r.state.repairWrites, 0);
});

Deno.test("another installation scope cannot release a legacy queue hold", async () => {
  const r = makeMemoryRig(new FakeGithub());
  const config = r.configs[0];
  r.configs.splice(0, 1, {
    ...config,
    repository: { ...config.repository, installationId: 99 },
  });
  const held = legacyHeldRecord();
  r.state.repair = seededSnapshot([held]);
  r.state.repairHead = SHA1;
  const fixed = decisionGuard({ status: "allow", basis: "inactive_no_rule" });
  r.github.nativeQueue = fixed.guard;
  const before = canonicalStringify(r.state.repair.work[0]);

  const outcome = await r.run(1);
  const after = await r.snapshot();
  assert.equal(
    canonicalStringify(after.work[0]),
    before,
    JSON.stringify(outcome),
  );
  assert.equal(fixed.calls.inspect + fixed.calls.effect, 0);
  assert.equal(r.state.repairWrites, 0);
});
