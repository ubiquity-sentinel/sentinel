import assert from "node:assert/strict";
import { runHostedQueueCustody } from "../../ops/hosted-autonomy-queue-pass.ts";
import { queueHold } from "../../ops/hosted-autonomy-queue-writer.ts";
import { createQueueIntent } from "../../ops/hosted-autonomy-queue-intent.ts";
import { isQueueHeld } from "../../ops/hosted-autonomy-queue-policy.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { orchestrationRig } from "./merge-queue-orchestration-fixtures.ts";

async function dormantHeld() {
  const f = await orchestrationRig();
  f.queue.config.mode = "off";
  f.queue.config.proofActivated = false;
  f.state.repair!.work[0] = queueHold(f.state.repair!.work[0], f.now());
  assert.ok(isQueueHeld(f.state.repair!.work[0]));
  return f;
}

Deno.test("dormant queue proof: a bare custody hold on an unbooked gateway pull is released to a transient wait", async () => {
  const f = await dormantHeld();
  const charges = canonicalStringify(f.state.repair!.reservations);
  f.advance(1000);
  const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(result.ready, true, result.actions.join(" "));
  const record = f.state.repair!.work[0];
  assert.equal(isQueueHeld(record), false);
  assert.deepEqual(record.wait, {
    reason: "unavailable",
    since: f.now(),
    until: f.now(),
  });
  assert.ok(
    result.actions.includes(`queue:${record.id}:dormant_hold_released`),
    result.actions.join(" "),
  );
  assert.equal(canonicalStringify(f.state.repair!.reservations), charges);
  assert.equal(f.calls.includes("enqueue"), false);
  // The next pass needs no native queue read at all.
  f.calls.length = 0;
  const next = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.deepEqual(next.actions, ["queue:inactive_no_rule"]);
  assert.equal(f.calls.includes("queue"), false);
});

Deno.test("dormant queue proof: activated proof, a native entry, an unknown rule or queue intent keep the hold", async (t) => {
  for (const variant of ["activated", "entry", "rules", "intent"] as const) {
    await t.step(variant, async () => {
      const f = await dormantHeld();
      if (variant === "activated") f.queue.config.proofActivated = true;
      if (variant === "entry") f.join();
      if (variant === "rules") {
        f.rules({ status: "unavailable", reason: "http" });
      }
      if (variant === "intent") {
        const held = f.state.repair!.work[0];
        const intent = await createQueueIntent(
          { ...held, intent: null },
          f.proof.binding,
          f.now(),
        );
        f.state.repair!.work[0] = { ...held, intent };
      }
      f.advance(1000);
      const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.equal(
        isQueueHeld(f.state.repair!.work[0]),
        true,
        result.actions.join(" "),
      );
      assert.equal(
        result.actions.some((action) =>
          action.endsWith("dormant_hold_released")
        ),
        false,
      );
    });
  }
});
