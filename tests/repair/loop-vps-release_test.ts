import assert from "node:assert/strict";
import { closureIntentKey } from "../../src/repair/keys.ts";
import { makeRig, seededSnapshot } from "./loop-rig.ts";
import {
  gatewayLoopDelivery,
  persistVpsDelivery,
} from "./vps-delivery-fixtures.ts";
import { reservation, T0 } from "../state/helpers.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";

Deno.test("gateway VPS loop: saved closure intent requires accepted receipt", async () => {
  const rig = await makeRig("vps-closure-intent", { summaries: false });
  try {
    const { record, request, review } = await gatewayLoopDelivery();
    const original = {
      ...record,
      intent: {
        kind: "issue_closure" as const,
        key: closureIntentKey(record.related.issueNumber!),
        startedAt: T0,
        branch: null,
        expectedHead: record.target.head,
        observedBase: record.target.base,
        pr: record.target.pr,
        requestId: request.id,
        resultId: null,
      },
    };
    const write = await rig.store.writeRepair(
      seededSnapshot([original], {
        releaseRequests: [request],
        reviews: [review],
      }),
      null,
    );
    assert.ok(write.ok && write.value.status === "applied");
    await rig.entry();
    assert.deepEqual(
      rig.github.calls.filter((call) => call.startsWith("closeIssue")),
      [],
    );
    const after = (await rig.snapshot()).work[0];
    assert.equal(after.nextStep, "delivery");
    assert.deepEqual(
      after.intent,
      original.intent,
      "absence preserves the original closure intent",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("gateway VPS loop: Deno acceptance cannot authorize gateway delivery", async () => {
  const rig = await makeRig("vps-deno-refusal", { summaries: false });
  try {
    const { record, request, review } = await gatewayLoopDelivery();
    const seed = await rig.store.writeRepair(
      seededSnapshot([record], {
        releaseRequests: [request],
        reviews: [review],
      }),
      null,
    );
    assert.ok(seed.ok && seed.value.status === "applied");
    await rig.acceptRelease(request.id);
    await rig.entry();
    assert.equal((await rig.snapshot()).work[0].nextStep, "delivery");
    assert.equal(
      rig.github.calls.some((call) => call.startsWith("closeIssue")),
      false,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("gateway VPS loop: real Git accepted tuple, tamper refusal, stale readback and closure-only retry", async () => {
  const rig = await makeRig("vps-accepted-loop", {
    summaries: false,
    github: { closeFailNext: true },
  });
  try {
    const { record, request, review } = await gatewayLoopDelivery();
    const charge = reservation("vps-original-charge", {
      repository: record.repository,
      taskId: record.id,
      head: record.target.head!,
      outcome: "submitted",
      settledAt: T0 + 1000,
    });
    const original = seededSnapshot([record], {
      releaseRequests: [request],
      reviews: [review],
      reservations: [charge],
    });
    const seed = await rig.store.writeRepair(original, null);
    assert.ok(seed.ok && seed.value.status === "applied");
    const accepted = await persistVpsDelivery(
      rig.store,
      rig.releaseStore,
      rig.clock,
      request,
    );
    assert.equal(accepted.driver.activations, 1);
    const readRelease = rig.store.readRelease.bind(rig.store);
    const bad = structuredClone(accepted.release.snapshot);
    const valid = bad.vpsReleases![0];
    const variants: ReleaseStateSnapshotV1[] = [
      { ...bad, vpsReleases: [] },
      {
        ...bad,
        vpsReleases: [{
          ...valid,
          request: { ...valid.request, id: "foreign-request" },
        }],
      },
      {
        ...bad,
        vpsReleases: [{
          ...valid,
          request: {
            ...valid.request,
            source: {
              ...valid.request.source,
              reviewRequestId: "foreign-review",
            },
          },
        }],
      },
      {
        ...bad,
        vpsReleases: [{
          ...valid,
          driver: {
            ...valid.driver,
            candidate: {
              ...valid.driver.candidate,
              immutableTreeSha256: "1".repeat(64),
            },
          },
        }],
      },
      {
        ...bad,
        vpsReleases: [{
          ...valid,
          driver: {
            ...valid.driver,
            prior: { ...valid.driver.prior, target: "releases/foreign" },
          },
        }],
      },
      {
        ...bad,
        vpsReleases: [{
          ...valid,
          driver: { ...valid.driver, abi: "untrusted-driver" as never },
        }],
      },
      { ...bad, vpsReleases: [{ ...valid, phase: "monitoring" }] },
    ];
    for (const variant of variants) {
      rig.store.readRelease = () =>
        Promise.resolve(portOk({ ...accepted.release, snapshot: variant }));
      rig.clock.advance(300_001);
      await rig.entry();
      const after = await rig.snapshot();
      assert.equal(after.work[0].nextStep, "delivery");
      assert.equal(after.work[0].intent, null);
      assert.deepEqual(after.reservations, [charge]);
      assert.deepEqual(after.releaseRequests, [request]);
      assert.equal(
        rig.github.calls.some((call) => call.startsWith("closeIssue")),
        false,
      );
    }
    let reads = 0;
    rig.store.readRelease = async () => {
      const value = await readRelease();
      // Cooldown/entrypoint reads precede the receipt gate. Every second matching
      // receipt read reports another head: no unverified terminal readback passes.
      if (value.ok && value.value.status === "found" && ++reads % 2 === 0) {
        return portOk({ ...value.value, head: "f".repeat(40) as GitSha });
      }
      return value;
    };
    rig.clock.advance(300_001);
    await rig.entry();
    assert.equal((await rig.snapshot()).work[0].nextStep, "delivery");
    assert.equal(
      rig.github.calls.some((call) => call.startsWith("closeIssue")),
      false,
    );
    rig.store.readRelease = () =>
      Promise.resolve(portError("unavailable", "offline read"));
    rig.clock.advance(300_001);
    await rig.entry();
    assert.equal(
      rig.github.calls.some((call) => call.startsWith("closeIssue")),
      false,
    );
    rig.store.readRelease = readRelease;
    rig.clock.advance(300_001);
    await rig.entry();
    const pending = await rig.snapshot();
    assert.equal(pending.work[0].nextStep, "delivery");
    assert.equal(pending.work[0].intent?.kind, "issue_closure");
    assert.equal(pending.work[0].intent?.requestId, request.id);
    const requestsBefore = pending.releaseRequests;
    const closesBefore = rig.github.calls.filter((call) =>
      call.startsWith("closeIssue")
    ).length;
    rig.clock.advance(300_001);
    await rig.entry();
    const done = await rig.snapshot();
    assert.equal(done.work[0].nextStep, "done");
    assert.deepEqual(done.releaseRequests, requestsBefore);
    assert.deepEqual(done.reservations, [charge]);
    assert.equal(
      rig.github.calls.filter((call) => call.startsWith("closeIssue")).length,
      closesBefore + 1,
    );
    assert.equal(
      rig.github.calls.some((call) => call.startsWith("merge")),
      false,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
