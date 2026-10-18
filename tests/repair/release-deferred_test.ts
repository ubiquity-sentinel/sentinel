/**
 * JAM B12 (non-progress cycle): a merged ai.ubq.fi delivery whose production
 * release request is open while the release path is disabled. R80 re-armed a
 * five-minute `unavailable` release wait on every cycle (live 670 rewrote it
 * 138 times; 348 of 632 state commits in 3.8 hours were these re-arms). The
 * record now waits in one stable shape (an open-ended `unavailable` wait at
 * `delivery`, written once) until the release ref records its request, and
 * resumes by itself from there; it is never marked done, so the release
 * outcome is still consumed.
 */
import assert from "node:assert/strict";
import { makeRig, seededSnapshot } from "./loop-rig.ts";
import {
  gatewayLoopDelivery,
  persistVpsDelivery,
} from "./vps-delivery-fixtures.ts";
import {
  LIVE_RECORDS,
  LIVE_REPO,
  LIVE_REQUESTS,
  LIVE_REVIEWS,
  LIVE_UPDATED_AT,
  loadRevisionModules,
  R80,
  releaseWithoutVps,
  revisionAvailable,
} from "./release-deferred-fixtures.ts";
import { reservation, T0 } from "../state/helpers.ts";
import { closureIntentKey } from "../../src/repair/keys.ts";
import { portError } from "../../src/contracts/ports.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";

const POLL = 300_001;

/** The state store orders every collection by id. */
function byId<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The one stable deferred shape; everything else of the record is kept. */
function assertDeferred(
  after: WorkRecordV1,
  before: WorkRecordV1,
  at: number,
): void {
  assert.equal(after.nextStep, "delivery", after.id);
  assert.equal(after.intent, null, after.id);
  assert.equal(after.blocker, null, after.id);
  assert.deepEqual(
    after.wait,
    { reason: "unavailable", since: at, until: null },
    after.id,
  );
  assert.deepEqual(after.target, before.target, after.id);
  assert.deepEqual(after.related, before.related, after.id);
  assert.deepEqual(after.evidence, before.evidence, after.id);
  assert.equal(after.counters.attempts, before.counters.attempts, after.id);
  assert.equal(after.counters.retries, before.counters.retries, after.id);
  assert.equal(
    after.counters.reviewRounds,
    before.counters.reviewRounds,
    after.id,
  );
}

async function liveRig(prefix: string) {
  const rig = await makeRig(prefix, {
    summaries: false,
    configOverrides: { repository: LIVE_REPO },
  });
  // Past every live five-minute wait, as the next runtime cycle sees them.
  rig.clock.advance(LIVE_UPDATED_AT + 600_000 - T0);
  const release = await rig.releaseStore.writeRelease(
    releaseWithoutVps(LIVE_UPDATED_AT),
    null,
  );
  assert.ok(release.ok && release.value.status === "applied");
  const seed = await rig.store.writeRepair(
    seededSnapshot([...LIVE_RECORDS], {
      updatedAt: LIVE_UPDATED_AT,
      releaseRequests: [...LIVE_REQUESTS],
      reviews: [...LIVE_REVIEWS],
    }),
    null,
  );
  assert.ok(seed.ok && seed.value.status === "applied");
  return rig;
}

Deno.test("B12 live shapes: a merged Gateway delivery without a release record is deferred once and never rewritten", async () => {
  const rig = await liveRig("b12-live-deferred");
  try {
    const at = rig.clock.now();
    await rig.entry();
    const deferred = await rig.snapshot();
    for (const before of LIVE_RECORDS) {
      const after = deferred.work.find((record) => record.id === before.id)!;
      assertDeferred(after, before, at);
    }
    assert.deepEqual(byId(deferred.releaseRequests), byId(LIVE_REQUESTS));
    assert.deepEqual(byId(deferred.reviews), byId(LIVE_REVIEWS));
    // One hour of five-minute cycles: no state write, no re-armed wait.
    for (let cycle = 0; cycle < 12; cycle++) {
      rig.clock.advance(POLL);
      await rig.entry();
    }
    const later = await rig.snapshot();
    assert.equal(later.sequence, deferred.sequence);
    assert.equal(canonicalStringify(later), canonicalStringify(deferred));
    assert.equal(
      rig.github.calls.some((call) =>
        call.startsWith("closeIssue") || call.startsWith("merge")
      ),
      false,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("B12: a deferred release resumes by itself once the release ref records its request, and its outcome is consumed", async () => {
  for (const phase of ["accepted", "rolled_back"] as const) {
    const rig = await makeRig(`b12-resume-${phase}`, { summaries: false });
    try {
      const { record, request, review } = await gatewayLoopDelivery();
      const charge = reservation(`b12-charge-${phase}`, {
        repository: record.repository,
        taskId: record.id,
        head: record.target.head!,
        outcome: "submitted",
        settledAt: T0 + 1000,
      });
      const release = await rig.releaseStore.writeRelease(
        releaseWithoutVps(T0),
        null,
      );
      assert.ok(release.ok && release.value.status === "applied");
      const seed = await rig.store.writeRepair(
        seededSnapshot([record], {
          releaseRequests: [request],
          reviews: [review],
          reservations: [charge],
        }),
        null,
      );
      assert.ok(seed.ok && seed.value.status === "applied");
      const at = rig.clock.now();
      await rig.entry();
      const deferred = await rig.snapshot();
      assertDeferred(deferred.work[0], record, at);
      for (let cycle = 0; cycle < 3; cycle++) {
        rig.clock.advance(POLL);
        await rig.entry();
      }
      assert.equal((await rig.snapshot()).sequence, deferred.sequence);
      // The release path is enabled: the real VPS controller records and
      // settles the exact open request on the release ref.
      await persistVpsDelivery(
        rig.store,
        rig.releaseStore,
        rig.clock,
        request,
        phase,
      );
      let after: RepairStateSnapshotV1 = deferred;
      for (let cycle = 0; cycle < 3; cycle++) {
        rig.clock.advance(POLL);
        await rig.entry();
        after = await rig.snapshot();
        if (after.work[0].nextStep !== "delivery") break;
      }
      if (phase === "accepted") {
        assert.equal(after.work[0].nextStep, "done");
        assert.equal(
          rig.github.calls.filter((call) => call.startsWith("closeIssue"))
            .length,
          1,
        );
      } else {
        assert.equal(after.work[0].nextStep, "blocked");
        assert.equal(after.work[0].blocker?.message, "release rolled_back");
        assert.equal(
          rig.github.calls.some((call) => call.startsWith("closeIssue")),
          false,
        );
      }
      assert.deepEqual(after.releaseRequests, [request]);
      assert.deepEqual(after.reservations, [charge]);
      assert.equal(
        rig.github.calls.some((call) => call.startsWith("merge")),
        false,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  }
});

Deno.test("B12: a cancelled request is never deferred; it still parks with its recorded reason", async () => {
  const rig = await makeRig("b12-cancelled", { summaries: false });
  try {
    const { record, request, review } = await gatewayLoopDelivery();
    const cancelled = {
      ...request,
      status: "cancelled" as const,
      failureReason: "trusted cancellation",
    };
    const release = await rig.releaseStore.writeRelease(
      releaseWithoutVps(T0),
      null,
    );
    assert.ok(release.ok && release.value.status === "applied");
    const seed = await rig.store.writeRepair(
      seededSnapshot([record], {
        releaseRequests: [cancelled],
        reviews: [review],
      }),
      null,
    );
    assert.ok(seed.ok && seed.value.status === "applied");
    await rig.entry();
    const after = (await rig.snapshot()).work[0];
    assert.equal(after.nextStep, "blocked");
    assert.equal(after.blocker?.message, "trusted cancellation");
    assert.equal(after.wait, null);
  } finally {
    await rig.ctx.cleanup();
  }
});

/** A rig seeded with the synthetic Gateway delivery `shape` returns. */
async function deferredRig(
  prefix: string,
  shape: (record: WorkRecordV1, requestId: string) => WorkRecordV1,
) {
  const rig = await makeRig(prefix, { summaries: false });
  const { record, request, review } = await gatewayLoopDelivery();
  const release = await rig.releaseStore.writeRelease(
    releaseWithoutVps(T0),
    null,
  );
  assert.ok(release.ok && release.value.status === "applied");
  const seed = await rig.store.writeRepair(
    seededSnapshot([shape(record, request.id)], {
      releaseRequests: [request],
      reviews: [review],
    }),
    null,
  );
  assert.ok(seed.ok && seed.value.status === "applied");
  return rig;
}

const DEFERRED = { reason: "unavailable" as const, since: T0, until: null };

Deno.test("B12: an unreadable release ref resumes nothing and writes nothing", async () => {
  const rig = await deferredRig("b12-unreadable", (record) => ({
    ...record,
    wait: DEFERRED,
  }));
  try {
    const readRelease = rig.store.readRelease.bind(rig.store);
    const before = await rig.snapshot();
    for (const offline of [true, false]) {
      rig.store.readRelease = offline
        ? () => Promise.resolve(portError("unavailable", "offline read"))
        : readRelease;
      rig.clock.advance(POLL);
      await rig.entry();
      assert.equal(
        canonicalStringify(await rig.snapshot()),
        canonicalStringify(before),
        offline ? "unreadable" : "still no release record",
      );
    }
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("B12: a deferred record that holds an intent is handed back to its own step", async () => {
  const rig = await deferredRig("b12-intent", (record, requestId) => ({
    ...record,
    wait: DEFERRED,
    intent: {
      kind: "issue_closure",
      key: closureIntentKey(record.related.issueNumber!),
      startedAt: T0,
      branch: null,
      expectedHead: record.target.head,
      observedBase: record.target.base,
      pr: record.target.pr,
      requestId,
      resultId: null,
    },
  }));
  try {
    const before = (await rig.snapshot()).work[0];
    rig.clock.advance(POLL);
    await rig.entry();
    const after = (await rig.snapshot()).work[0];
    // No longer open-ended: the closure step re-armed its own bounded wait,
    // and with no accepted release it closes nothing.
    assert.equal(after.nextStep, "delivery");
    assert.notEqual(after.wait?.until ?? null, null);
    assert.deepEqual(after.intent, before.intent);
    assert.equal(
      rig.github.calls.some((call) => call.startsWith("closeIssue")),
      false,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test({
  name:
    "B12 rollback: R80 parses the deferred shape, never selects it and writes nothing over it",
  ignore: !await revisionAvailable(R80),
  fn: async () => {
    const rig = await liveRig("b12-r80-source");
    const r80 = await loadRevisionModules(R80, [
      "tests/repair/loop-rig.ts",
      "src/repair/selection.ts",
      "src/contracts/state-snapshots.ts",
    ]);
    try {
      await rig.entry();
      const written = await rig.snapshot();
      const [rigModule, selection, snapshots] = r80.modules as [
        typeof import("./loop-rig.ts"),
        typeof import("../../src/repair/selection.ts"),
        typeof import("../../src/contracts/state-snapshots.ts"),
      ];
      const parsed = snapshots.parseRepairStateSnapshotV1(
        structuredClone(written),
      );
      const ranked = selection.rankEligibleWork(
        parsed,
        [],
        rig.clock.now() + 24 * 60 * 60_000,
      );
      for (const record of LIVE_RECORDS) {
        assert.equal(ranked.skipped[record.id], "waiting", record.id);
      }
      const old = await rigModule.makeRig("b12-r80-rollback", {
        summaries: false,
        configOverrides: { repository: LIVE_REPO },
      });
      try {
        old.clock.advance(rig.clock.now() - T0);
        const release = await old.releaseStore.writeRelease(
          releaseWithoutVps(LIVE_UPDATED_AT),
          null,
        );
        assert.ok(release.ok && release.value.status === "applied");
        const seed = await old.store.writeRepair(
          { ...structuredClone(written), stateHead: null, sequence: 1 },
          null,
        );
        assert.ok(seed.ok && seed.value.status === "applied");
        const seeded = await old.snapshot();
        for (let cycle = 0; cycle < 6; cycle++) {
          old.clock.advance(POLL);
          await old.entry();
        }
        const after = await old.snapshot();
        assert.equal(after.sequence, seeded.sequence);
        assert.equal(
          canonicalStringify(after.work),
          canonicalStringify(written.work),
        );
      } finally {
        await old.ctx.cleanup();
      }
    } finally {
      await r80.dispose();
      await rig.ctx.cleanup();
    }
  },
});
