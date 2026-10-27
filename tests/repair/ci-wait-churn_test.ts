import assert from "node:assert/strict";
import { SHA3, T0 } from "../state/helpers.ts";
import {
  check,
  ciFirstRig,
  HOUR,
  reviewCharges,
  taskRecord,
} from "./ci-first-rig.ts";
import { CHECK_POLL_MS } from "./loop-candidate-fixtures.ts";

Deno.test("CI wait: an unchanged pending head writes nothing and resumes on the next invocation", async () => {
  const { rig, charges, writes, checkReads, setChecks } = await ciFirstRig(
    "ci-wait-unchanged",
    {
      checks: { [SHA3]: [check("ci", SHA3, null, "in_progress")] },
      wait: { reason: "ci_pending", since: T0, until: T0 + CHECK_POLL_MS },
    },
  );
  try {
    const before = await rig.snapshot();
    await rig.entry();
    const pending = await rig.snapshot();
    assert.equal(writes.length, 0, "unchanged CI does not commit another wait");
    assert.deepEqual(
      pending,
      before,
      "timestamps and stalled counters stay intact",
    );
    assert.deepEqual(
      checkReads,
      [SHA3],
      "read this pending head once per invocation",
    );
    assert.deepEqual(
      pending.reservations,
      charges,
      "pending CI reserves nothing",
    );

    setChecks(SHA3, [check("ci", SHA3, "success")]);
    await rig.entry();
    const resumed = await rig.snapshot();
    assert.equal(taskRecord(resumed).nextStep, "review");
    assert.equal(reviewCharges(resumed).length, 1);
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
    await rig.entry();
    assert.equal(
      reviewCharges(await rig.snapshot()).length,
      1,
      "a repeated invocation does not duplicate the start",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI wait: a first durable wait yields even when its commit crosses the poll interval", async () => {
  const { rig, charges, writes, checkReads } = await ciFirstRig(
    "ci-wait-applied-yield",
    { checks: { [SHA3]: [check("ci", SHA3, null, "in_progress")] } },
  );
  try {
    const write = rig.store.writeRepair.bind(rig.store);
    let delayed = false;
    rig.store.writeRepair = async (snapshot, expectedHead) => {
      const result = await write(snapshot, expectedHead);
      if (!delayed && taskRecord(snapshot).wait?.reason === "ci_pending") {
        delayed = true;
        rig.clock.advance(CHECK_POLL_MS + 1);
      }
      return result;
    };
    const outcome = await rig.entry();
    assert.notEqual(
      outcome.status,
      "source_error",
      "the durable write remains progress",
    );
    assert.equal(
      writes.length,
      1,
      "a slow wait commit cannot re-enter the same pending head",
    );
    assert.deepEqual(checkReads, [SHA3]);
    assert.deepEqual((await rig.snapshot()).reservations, charges);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI wait: unchanged observations retain the original six-hour deadline", async () => {
  const { rig, writes, charges } = await ciFirstRig("ci-wait-deadline", {
    checks: { [SHA3]: [check("ci", SHA3, null, "in_progress")] },
    wait: { reason: "ci_pending", since: T0, until: T0 + CHECK_POLL_MS },
  });
  try {
    await rig.entry();
    assert.equal(writes.length, 0);
    assert.equal(taskRecord(await rig.snapshot()).wait?.since, T0);
    rig.clock.advance(6 * HOUR);
    await rig.entry();
    const expired = await rig.snapshot();
    assert.equal(
      writes.length,
      1,
      "deadline expiry still records the existing park",
    );
    assert.equal(taskRecord(expired).nextStep, "blocked");
    assert.match(
      taskRecord(expired).blocker!.message,
      /CI did not finish before review within 6 hours/,
    );
    assert.deepEqual(expired.reservations, charges);
  } finally {
    await rig.ctx.cleanup();
  }
});
