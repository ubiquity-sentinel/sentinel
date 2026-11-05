import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { DeliveryCheckV1 } from "../../src/contracts/delivery-checks.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  deliveryCheckTransition,
  DEPLOYMENT_WAIT_MS,
  requiredDeliveryChecks,
} from "../../src/repair/delivery-checks.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { gateRequiredDeliveryChecks } from "../../src/repair/loop-delivery-checks.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import { FakeGithub, FakeIncidents, FakeReplay } from "./helpers.ts";
import { makeMemoryRig, seededSnapshot } from "./loop-rig.ts";

const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 1,
};
const record = () =>
  workRecord("required-delivery", {
    repository: PASSPORT,
    nextStep: "delivery",
    target: { ...workRecord("required-delivery").target, head: SHA2, pr: 7 },
  });
const check = (overrides: Partial<DeliveryCheckV1> = {}): DeliveryCheckV1 => ({
  name: "deploy-standby",
  runId: 337,
  head: SHA2,
  status: "completed",
  conclusion: "success",
  ...overrides,
});

Deno.test("delivery policy: named per target and absent for other targets", () => {
  assert.deepEqual(requiredDeliveryChecks(PASSPORT), ["deploy-standby"]);
  assert.deepEqual(
    requiredDeliveryChecks({ owner: "ubiquity", name: "ubq.fi-router" }),
    ["deploy"],
  );
  const untouched = workRecord("unaffected");
  assert.strictEqual(
    deliveryCheckTransition(untouched, [], T0).record,
    untouched,
  );
});

Deno.test("delivery checks: latest native run wins; skipped/neutral are not delivery", () => {
  for (
    const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "skipped",
      "neutral",
    ]
  ) {
    const result = deliveryCheckTransition(
      record(),
      [check({ conclusion })],
      T0,
    );
    assert.equal(result.outcome, "failed");
    assert.match(
      result.record.blocker!.message,
      new RegExp(`deploy-standby run 337: ${conclusion}`),
    );
  }
  const pending = check({ runId: 338, status: "queued", conclusion: null });
  assert.equal(
    deliveryCheckTransition(record(), [check(), pending], T0).outcome,
    "wait",
  );
  assert.equal(
    deliveryCheckTransition(record(), [
      check({ conclusion: "failure" }),
      check({ runId: 338 }),
    ], T0).outcome,
    "passed",
  );
});

Deno.test("delivery checks: missing, unreadable and wrong-head evidence time out without resetting since", () => {
  for (const checks of [null, [], [check({ head: SHA3 })]]) {
    const first = deliveryCheckTransition(record(), checks, T0).record;
    assert.equal(first.wait?.reason, "deployment");
    const again = deliveryCheckTransition(first, checks, T0 + 60_000).record;
    assert.equal(again.wait?.since, T0);
    const expired = deliveryCheckTransition(
      again,
      checks,
      T0 + DEPLOYMENT_WAIT_MS,
    );
    assert.equal(expired.outcome, "failed");
    assert.match(expired.record.blocker!.message, /deploy-standby \(missing\)/);
  }
});

Deno.test("delivery receipt: strict parsing preserves legacy shape and native identity", () => {
  assert.ok(!Object.hasOwn(parseWorkRecordV1(record()), "deliveryReceipt"));
  const passed = deliveryCheckTransition(record(), [check()], T0).record;
  assert.deepEqual(parseWorkRecordV1(passed), passed);
  assert.throws(() =>
    parseWorkRecordV1({
      ...passed,
      deliveryReceipt: { ...passed.deliveryReceipt, checks: [] },
    })
  );
  assert.throws(() =>
    parseWorkRecordV1({
      ...passed,
      deliveryReceipt: {
        ...passed.deliveryReceipt,
        checks: [{ name: "deploy-standby", runId: 337, conclusion: "failure" }],
      },
    })
  );
});

for (const conclusion of ["success", "failure"] as const) {
  Deno.test(`repair closure delivery gate: ${conclusion} uses the real state consumer`, async () => {
    const github = new FakeGithub({
      checks: [{
        ...check(),
        status: "completed",
        conclusion,
        startedAt: T0,
        completedAt: T0,
      }],
    });
    const rig = makeMemoryRig(github);
    rig.state.repair = seededSnapshot([record()]);
    rig.state.repairHead = SHA1;
    const context: LoopContextV1 = {
      snapshot: rig.state.repair,
      head: SHA1,
      executionBaseline: null,
      bounds: { runDeadline: T0 + 60_000, modelCutoff: T0 + 30_000 },
    };
    const deps: RepairCycleDepsV1 = {
      ...rig,
      controllerSha: SHA1,
      githubCooldown: new DurableGitHubCooldownGate({
        state: rig.state,
        clock: rig.clock,
      }),
      incidents: new FakeIncidents({ summaries: [], evidence: null }),
      replay: new FakeReplay(),
      budget: new RollingStartBudget(rig),
    };
    assert.equal(
      (await gateRequiredDeliveryChecks(deps, context, record()))?.kind,
      "progress",
    );
    const saved = (await rig.snapshot()).work[0];
    if (conclusion === "success") {
      assert.equal(saved.deliveryReceipt?.checks[0].runId, 337);
      assert.equal(
        await gateRequiredDeliveryChecks(deps, context, saved),
        null,
      );
    } else {
      assert.equal(saved.nextStep, "blocked");
      assert.match(saved.blocker!.message, /deploy-standby run 337: failure/);
    }
  });
}
