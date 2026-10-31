/**
 * #169: a definitely-unsent admission refused by a later preflight is
 * reconciled only when every native read of the pass shows the pull absent.
 * Fake queue/authorization ports and an injected clock; no network or model.
 */
import assert from "node:assert/strict";
import { runHostedQueueCustody } from "../../ops/hosted-autonomy-queue-pass.ts";
import { parseQueueIntent } from "../../ops/hosted-autonomy-queue-intent.ts";
import { isQueueHeld } from "../../ops/hosted-autonomy-queue-policy.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { QueueEntry } from "../../src/github/merge-queue-types.ts";
import {
  nativeEntry,
  orchestrationRig,
  PULL,
  QUEUE_REPO,
  SHA1,
} from "./merge-queue-orchestration-fixtures.ts";

type Rig = Awaited<ReturnType<typeof orchestrationRig>>;

function foreignEntry(): QueueEntry {
  return {
    ...nativeEntry(),
    enqueuer: { type: "User", nodeId: "U_owner", login: "owner" },
  };
}
async function activeRig(): Promise<Rig> {
  const f = await orchestrationRig();
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  return f;
}
const pass = (f: Rig) => runHostedQueueCustody(f.deps, f.now() + 60000);
const enqueues = (f: Rig) => f.calls.filter((call) => call === "enqueue");
const has = (actions: readonly string[], suffix: string) =>
  actions.some((action) => action.endsWith(suffix));

/** The native client proves the first admission was never sent. */
async function definitelyUnsent(): Promise<Rig> {
  const f = await activeRig();
  f.admission({ status: "not_submitted", reason: "permission" });
  const first = await pass(f);
  assert.equal(first.ready, true, first.actions.join(" "));
  assert.equal(
    parseQueueIntent(f.state.repair!.work[0])?.stage,
    "not_submitted",
  );
  return f;
}
/** The n-th authorization read of the next pass refuses (red head CI). */
function refuseOnAuthorization(f: Rig, call: number): void {
  const read = f.queue.authorization.readAuthorization;
  let calls = 0;
  f.queue.authorization.readAuthorization = (request) => {
    if (++calls === call) f.auth.headCiGreen = false;
    return read(request);
  };
}
/** Exactly one read of the next pass observes the pull. */
function observeOnce(
  f: Rig,
  where: "scan" | "authorization",
  call: number,
): void {
  if (where === "scan") {
    const read = f.queue.surface.readQueue;
    let calls = 0;
    f.queue.surface.readQueue = async (base) => {
      const observed = await read(base);
      if (++calls !== call) return observed;
      return {
        status: "complete",
        value: {
          repository: QUEUE_REPO,
          baseRef: "development",
          baseTip: SHA1,
          queueId: "MQ_1",
          entries: [foreignEntry()],
          observedAt: f.now(),
        },
      };
    };
    return;
  }
  const read = f.queue.authorization.readAuthorization;
  let calls = 0;
  f.queue.authorization.readAuthorization = async (request) => {
    const observed = await read(request);
    if (++calls !== call || observed.status !== "complete") return observed;
    return {
      status: "complete",
      value: {
        ...observed.value,
        facts: {
          ...observed.value.facts,
          membership: {
            status: "complete",
            value: { pull: PULL, entry: foreignEntry(), mergedRevision: null },
          },
        },
      },
    };
  };
}

Deno.test("queue not-submitted: a definite preflight refusal keeps custody under an active rule and is reconciled under a negative one", async (t) => {
  for (const history of ["first admission", "unsent retry"] as const) {
    await t.step(history, async () => {
      const f = history === "first admission"
        ? await activeRig()
        : await definitelyUnsent();
      const unsent = f.state.repair!.work[0].intent;
      const charges = canonicalStringify(f.state.repair!.reservations);
      const counters = canonicalStringify(f.state.repair!.work[0].counters);
      const sent = enqueues(f).length;
      // The reconcile read admits; the submission's own fresh read refuses.
      refuseOnAuthorization(f, 2);
      const refused = await pass(f);
      assert.equal(refused.ready, true, refused.actions.join(" "));
      assert.ok(
        has(refused.actions, "pre_effect_not_submitted:authorization_refused"),
        refused.actions.join(" "),
      );
      const restored = parseQueueIntent(f.state.repair!.work[0])!;
      assert.equal(restored.stage, "not_submitted");
      if (unsent !== null) {
        // A retry restores its earlier durable result, not an ambiguous mark.
        assert.deepEqual(f.state.repair!.work[0].intent, unsent);
      }
      assert.ok(isQueueHeld(f.state.repair!.work[0]));
      assert.equal(enqueues(f).length, sent);
      f.advance(1000);
      // Under the still-active rule a transient refusal keeps the retryable
      // unsent custody: a released record would meet the runtime's
      // `queue_required` guard and stay held with no intent for good.
      const kept = await pass(f);
      assert.equal(kept.ready, true, kept.actions.join(" "));
      assert.ok(!has(kept.actions, "not_submitted_reconciled"));
      assert.equal(
        parseQueueIntent(f.state.repair!.work[0])?.stage,
        "not_submitted",
      );
      assert.ok(isQueueHeld(f.state.repair!.work[0]));
      assert.ok(kept.protectedRecordIds.has(f.state.repair!.work[0].id));
      assert.equal(enqueues(f).length, sent);
      // Only an authenticated negative rule lets the runtime's direct path take it.
      f.rules({ status: "complete", value: false });
      f.advance(1000);
      f.calls.length = 0;
      const reconciled = await pass(f);
      assert.equal(reconciled.ready, true, reconciled.actions.join(" "));
      assert.ok(
        has(reconciled.actions, "not_submitted_reconciled"),
        reconciled.actions.join(" "),
      );
      // A fresh scan is read in addition to the pass's initial snapshot.
      assert.deepEqual(f.calls, [
        "rules",
        "queue",
        "authorization",
        "membership",
        "rules",
        "queue",
      ]);
      const row = f.state.repair!.work[0];
      assert.equal(row.intent, null);
      assert.equal(isQueueHeld(row), false);
      assert.deepEqual(row.wait, {
        reason: "unavailable",
        since: f.now(),
        until: f.now(),
      });
      assert.equal(canonicalStringify(f.state.repair!.reservations), charges);
      assert.equal(canonicalStringify(row.counters), counters);
      assert.equal(enqueues(f).length, 0);
      assert.equal(sent, history === "first admission" ? 0 : 1);
      // A later native entry is still taken into custody.
      f.join(foreignEntry());
      const later = await pass(f);
      assert.equal(later.ready, true, later.actions.join(" "));
      assert.ok(later.protectedRecordIds.has(row.id));
      assert.ok(isQueueHeld(f.state.repair!.work[0]));
      assert.equal(enqueues(f).length, 0);
    });
  }
});

Deno.test("queue not-submitted: an entry in any one read, incomplete facts or provenance keeps strict custody", async (t) => {
  const variants = {
    // An initially listed or provenance-bearing pull without an intent is a
    // foreign hold, and a membership entry fails the submission preflight.
    "first submission": [
      "fresh scan",
      "authorization membership",
      "incomplete authorization",
    ],
    "unsent retry submission": [
      "initial snapshot",
      "fresh scan",
      "authorization membership",
      "incomplete authorization",
      "queue provenance",
    ],
    "reconciliation": [
      "initial snapshot",
      "fresh scan",
      "membership read",
      "authorization membership",
      "incomplete authorization",
      "queue provenance",
    ],
  } as const;
  for (const [side, list] of Object.entries(variants)) {
    for (const variant of list) {
      await t.step(`${side}: ${variant}`, async () => {
        const f = side === "first submission"
          ? await activeRig()
          : await definitelyUnsent();
        if (variant === "queue provenance") {
          f.state.repair!.work[0] = {
            ...f.state.repair!.work[0],
            evidence: [{
              kind: "review_receipt",
              ref: "artifact:review-receipt/merge-queue-v1/prior",
            }],
          };
        }
        // Submission: the second authorization read refuses. Reconciliation:
        // the pass's only authorization read refuses.
        const submission = side !== "reconciliation";
        const refusal = submission ? 2 : 1;
        if (variant === "incomplete authorization") {
          const read = f.queue.authorization.readAuthorization;
          let calls = 0;
          f.queue.authorization.readAuthorization = (request) => {
            if (++calls === refusal) f.auth.pathsDisjoint = null;
            return read(request);
          };
        } else refuseOnAuthorization(f, refusal);
        if (variant === "initial snapshot") observeOnce(f, "scan", 1);
        if (variant === "fresh scan") observeOnce(f, "scan", 2);
        if (variant === "authorization membership") {
          observeOnce(f, "authorization", refusal);
        }
        if (variant === "membership read") {
          const entry = foreignEntry();
          f.member({
            status: "complete",
            value: { pull: PULL, entry, mergedRevision: null },
          });
        }
        const before = f.state.repair!.work[0].intent;
        const charges = canonicalStringify(f.state.repair!.reservations);
        const sent = enqueues(f).length;
        const observed = await pass(f);
        assert.equal(
          has(
            observed.actions,
            "pre_effect_not_submitted:authorization_refused",
          ),
          false,
          observed.actions.join(" "),
        );
        assert.equal(has(observed.actions, "not_submitted_reconciled"), false);
        const state = parseQueueIntent(f.state.repair!.work[0]);
        if (submission) {
          // The pre-effect mark stays uncertain, never "unsent".
          assert.equal(
            state?.stage,
            side === "first submission" ? "unresolved" : "ambiguous",
            observed.actions.join(" "),
          );
        } else {
          assert.deepEqual(f.state.repair!.work[0].intent, before);
        }
        assert.ok(isQueueHeld(f.state.repair!.work[0]));
        if (submission) {
          // A later pass with every read clean cannot release an unresolved intent.
          f.leave();
          f.advance(1000);
          const next = await pass(f);
          assert.equal(has(next.actions, "not_submitted_reconciled"), false);
          assert.ok(
            has(next.actions, "hold:ambiguous_admission"),
            next.actions.join(" "),
          );
          assert.ok(f.state.repair!.work[0].intent !== null);
          assert.ok(isQueueHeld(f.state.repair!.work[0]));
        }
        assert.equal(canonicalStringify(f.state.repair!.reservations), charges);
        assert.equal(enqueues(f).length, sent);
      });
    }
  }
});

Deno.test("queue not-submitted: a moved state head before the recording write keeps the uncertain mark", async () => {
  const f = await activeRig();
  const read = f.queue.authorization.readAuthorization;
  let calls = 0;
  f.queue.authorization.readAuthorization = (request) => {
    if (++calls === 2) {
      f.auth.headCiGreen = false;
      // A competing writer wins between the intent readback and the record.
      f.state.conflictRepairNext = true;
    }
    return read(request);
  };
  const charges = canonicalStringify(f.state.repair!.reservations);
  const moved = await pass(f);
  assert.equal(moved.ready, false, moved.actions.join(" "));
  assert.equal(
    has(moved.actions, "pre_effect_not_submitted:authorization_refused"),
    false,
  );
  assert.equal(parseQueueIntent(f.state.repair!.work[0])?.stage, "unresolved");
  for (const advance of [1000, 7 * 60 * 60 * 1000]) {
    f.advance(advance);
    const restarted = await pass(f);
    assert.equal(has(restarted.actions, "not_submitted_reconciled"), false);
    assert.ok(f.state.repair!.work[0].intent !== null);
    assert.ok(isQueueHeld(f.state.repair!.work[0]));
  }
  assert.equal(enqueues(f).length, 0);
  assert.equal(canonicalStringify(f.state.repair!.reservations), charges);
});

Deno.test("queue not-submitted: only an authenticated negative rule during submission is a definite refusal", async (t) => {
  for (const rule of ["negative", "unknown"] as const) {
    await t.step(rule, async () => {
      const f = await activeRig();
      const read = f.queue.readEffectiveQueueRule;
      let reads = 0;
      // The pass reads an active rule; the submission's fresh read differs.
      f.queue.readEffectiveQueueRule = async () => {
        const observed = await read();
        if (++reads !== 2) return observed;
        return rule === "negative"
          ? { status: "complete", value: false }
          : { status: "unavailable", reason: "http" };
      };
      const changed = await pass(f);
      assert.equal(changed.ready, false, changed.actions.join(" "));
      assert.ok(has(changed.actions, "pre_effect_observation_changed"));
      assert.equal(
        has(changed.actions, "pre_effect_not_submitted:queue_disabled"),
        rule === "negative",
        changed.actions.join(" "),
      );
      assert.equal(
        parseQueueIntent(f.state.repair!.work[0])?.stage,
        rule === "negative" ? "not_submitted" : "unresolved",
      );
      // The authority then refuses the removed rule on the next pass.
      f.rules({ status: "complete", value: false });
      f.auth.rulesAccepted = false;
      f.advance(1000);
      const next = await pass(f);
      assert.equal(
        has(next.actions, "not_submitted_reconciled"),
        rule === "negative",
        next.actions.join(" "),
      );
      assert.equal(isQueueHeld(f.state.repair!.work[0]), rule === "unknown");
      assert.equal(enqueues(f).length, 0);
    });
  }
});

Deno.test("queue not-submitted: an authorized unsent admission keeps its bounded retry and is never cleared by age", async () => {
  const f = await definitelyUnsent();
  const startedAt = f.state.repair!.work[0].intent!.startedAt;
  const charges = canonicalStringify(f.state.repair!.reservations);
  f.advance(1000);
  const retried = await pass(f);
  assert.equal(has(retried.actions, "not_submitted_reconciled"), false);
  assert.equal(enqueues(f).length, 2);
  assert.equal(
    parseQueueIntent(f.state.repair!.work[0])?.stage,
    "not_submitted",
  );
  f.advance(6 * 60 * 60 * 1000);
  const parked = await pass(f);
  assert.ok(
    has(parked.actions, "owner_park:admission_unresolved"),
    parked.actions.join(" "),
  );
  assert.equal(f.state.repair!.work[0].intent?.startedAt, startedAt);
  assert.ok(isQueueHeld(f.state.repair!.work[0]));
  assert.equal(enqueues(f).length, 2);
  assert.equal(canonicalStringify(f.state.repair!.reservations), charges);
});

Deno.test("queue not-submitted: an earlier definitive refusal is durable history and keeps custody", async () => {
  const f = await activeRig();
  f.admission({ status: "refused", reason: "not_mergeable" });
  await pass(f);
  assert.equal(parseQueueIntent(f.state.repair!.work[0])?.refusals, 1);
  refuseOnAuthorization(f, 2);
  f.advance(1000);
  const refused = await pass(f);
  assert.equal(
    has(refused.actions, "pre_effect_not_submitted:authorization_refused"),
    false,
  );
  assert.equal(parseQueueIntent(f.state.repair!.work[0])?.stage, "ambiguous");
  f.advance(1000);
  const next = await pass(f);
  assert.equal(has(next.actions, "not_submitted_reconciled"), false);
  assert.ok(isQueueHeld(f.state.repair!.work[0]));
  assert.equal(enqueues(f).length, 1);
});
