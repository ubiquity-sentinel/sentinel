import assert from "node:assert/strict";
import {
  decideQueuePolicy,
  effectiveQueueMode,
  hasQueueIntentNamespace,
  isQueueHeld,
  isQueueMarked,
  QUEUE_ADMISSION_MAX_AGE_MS,
  queueCustodyRequired,
  requiresStrictQueueProof,
} from "../../ops/hosted-autonomy-queue-policy.ts";
import { parseQueueEntry } from "../../src/github/merge-queue-wire.ts";
import { entryWire, QUEUE_REPO } from "../github/merge-queue-fixtures.ts";
import {
  queueAuthorizationFacts,
  queueProofFacts,
  SHA2,
  SHA3,
  T0,
} from "./merge-queue-proof-fixtures.ts";

Deno.test("dark mode cannot be raised by a variable and no-rule fast path excludes every custody marker", async () => {
  assert.equal(effectiveQueueMode("off", "on"), "off");
  assert.equal(effectiveQueueMode("on", "observe"), "observe");
  assert.equal(effectiveQueueMode("on", "invalid"), "off");
  const { record } = await queueProofFacts();
  assert.equal(
    requiresStrictQueueProof({
      proofActivated: false,
      record,
      anyQueueEvidence: false,
    }),
    false,
  );
  assert.equal(
    requiresStrictQueueProof({
      proofActivated: true,
      record,
      anyQueueEvidence: false,
    }),
    true,
  );
  assert.equal(
    requiresStrictQueueProof({
      proofActivated: false,
      record,
      anyQueueEvidence: true,
    }),
    true,
  );
  assert.equal(
    queueCustodyRequired({
      mode: "off",
      effectiveQueueRule: false,
      records: [record],
    }),
    false,
  );
  for (const rule of [true, null]) {
    assert.equal(
      queueCustodyRequired({
        mode: "off",
        effectiveQueueRule: rule,
        records: [],
      }),
      true,
    );
  }
  record.wait = { reason: "backoff", since: T0, until: null };
  assert.equal(isQueueHeld(record), true);
  assert.equal(
    queueCustodyRequired({
      mode: "off",
      effectiveQueueRule: false,
      records: [record],
    }),
    true,
  );
  const prless = { ...record, target: { ...record.target, pr: null } };
  assert.equal(isQueueHeld(prless), false);
  assert.equal(
    queueCustodyRequired({
      mode: "off",
      effectiveQueueRule: false,
      records: [prless],
    }),
    false,
  );
  record.wait = null;
  record.intent = {
    kind: "merge",
    key: `merge-queue:v1:7:${SHA2}`,
    startedAt: T0,
    branch: record.target.branch,
    expectedHead: SHA2,
    observedBase: record.target.base,
    pr: 7,
    requestId: null,
    resultId: null,
  };
  assert.equal(isQueueMarked(record), true);
  record.target.head = SHA3;
  assert.equal(isQueueMarked(record), false);
  assert.equal(hasQueueIntentNamespace(record), true);
  assert.equal(
    queueCustodyRequired({
      mode: "off",
      effectiveQueueRule: false,
      records: [record],
    }),
    true,
  );
});

Deno.test("queue policy enqueues only complete pre-enqueue authorization and green head CI", async () => {
  const positive = await queueAuthorizationFacts();
  assert.equal(decideQueuePolicy(positive).action, "enqueue");
  for (
    const key of [
      "reviewAuthorized",
      "headCiGreen",
      "workflowAccepted",
      "rulesAccepted",
      "exactPatch",
      "pathsDisjoint",
      "tipEligible",
    ] as const
  ) {
    for (const value of [false, null]) {
      const facts = await queueAuthorizationFacts();
      facts[key] = value;
      assert.notEqual(
        decideQueuePolicy(facts).action,
        "enqueue",
        `${key}=${value}`,
      );
    }
  }
  positive.membership = { status: "unavailable", reason: "permission" };
  assert.deepEqual(decideQueuePolicy(positive), {
    action: "hold",
    reason: "queue_unavailable",
  });
});

Deno.test("every-pass drift dequeues only own entries; foreign entries remain protected", async () => {
  for (const ownsEntry of [true, false]) {
    const facts = await queueAuthorizationFacts();
    if (facts.membership.status !== "complete") throw new Error("fixture");
    facts.membership.value.entry = parseQueueEntry(entryWire(), QUEUE_REPO);
    facts.ownsEntry = ownsEntry;
    assert.equal(decideQueuePolicy(facts).action, "hold");
    facts.pathsDisjoint = false;
    assert.deepEqual(
      decideQueuePolicy(facts),
      ownsEntry
        ? { action: "dequeue_owned", entryId: "MQE_7", reason: "path_overlap" }
        : { action: "owner_park", reason: "foreign_entry_drift" },
    );
  }
});

Deno.test("three refusals and unresolved age park visibly; long native queue residence never expires hold", async () => {
  const facts = await queueAuthorizationFacts();
  facts.definitiveRefusals = 2;
  assert.equal(decideQueuePolicy(facts).action, "enqueue");
  facts.definitiveRefusals = 3;
  assert.deepEqual(decideQueuePolicy(facts), {
    action: "owner_park",
    reason: "refusals_exhausted",
  });
  facts.definitiveRefusals = 0;
  facts.admissionStartedAt = T0;
  facts.now = T0 + QUEUE_ADMISSION_MAX_AGE_MS;
  assert.deepEqual(decideQueuePolicy(facts), {
    action: "owner_park",
    reason: "admission_unresolved",
  });
  if (facts.membership.status !== "complete") throw new Error("fixture");
  facts.membership.value.entry = parseQueueEntry(entryWire(), QUEUE_REPO);
  facts.ownsEntry = true;
  facts.now += 30 * 24 * 60 * 60 * 1000;
  assert.deepEqual(decideQueuePolicy(facts), {
    action: "hold",
    reason: "queued",
  });
});

Deno.test("ambiguous admission never resubmits and distinct CI ejections get at most one reentry", async () => {
  const facts = await queueAuthorizationFacts();
  facts.admissionAmbiguous = true;
  assert.deepEqual(decideQueuePolicy(facts), {
    action: "hold",
    reason: "ambiguous_admission",
  });
  facts.admissionAmbiguous = false;
  facts.reentry = true;
  facts.failedQueueAdmissions = 1;
  assert.equal(decideQueuePolicy(facts).action, "reenter");
  facts.failedQueueAdmissions = 2;
  assert.deepEqual(decideQueuePolicy(facts), {
    action: "owner_park",
    reason: "repeated_queue_failure",
  });
});
