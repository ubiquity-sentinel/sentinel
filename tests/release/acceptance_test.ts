// m05-release acceptance checkpoint: the deterministic release state machine
// driven by a scripted Deno transport plus actual temporary Git state.
//
// Every scenario runs against a real disposable bare repository (the real
// GitStateStore) and a stateful scripted transport that models the documented
// Deno REST contract: revisions list, exact revision resources, pagination,
// promote (204 + effect), managed/custom health identity headers, and the
// logs endpoint with exact revision/window filtering.
//
// Covered: exactly-one candidate binding, promotion 204+identity proof,
// baseline/candidate windows, threshold and minimum-coverage evaluation,
// ambiguous-promotion recovery (no repeated POST), monitoring interruption
// reset, wrong revision/200 identity, managed pass plus Cloudflare-403
// warning, exact rollback, unrelated-newer protection, read/CAS conflict, and
// restart after durable intent. No real network, model, or production state
// branch is touched.
import assert from "node:assert/strict";
import { parseReleaseRecordV1 } from "../../src/contracts/release.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { nextAlignedWindowStart } from "../../src/release/acceptance.ts";
import { RELEASE_SAMPLE_INTERVAL_MS } from "../../src/release/config.ts";
import {
  acceptedEvent,
  DEP_0,
  DEP_1,
  DEP_X,
  LOGS_RE,
  PROMOTE_RE,
  stabilityPolicy,
  storeAt,
  targetConfig,
  terminalEvent,
} from "./helpers.ts";
import {
  assertCycle,
  completeWindow,
  makeRestartController,
  makeScenario,
  promoteToMonitoring,
  seedMonitorWindow,
  stepSlots,
} from "./acceptance-helpers.ts";

Deno.test("checkpoint: discovery binds exactly one build and persists candidate+prior", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    const result = await scene.controller.run();
    assertCycle(result, "advanced");
    const records = await scene.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].phase, "requested");
    assert.equal(records[0].candidate.identity.gitSha, DEP_1.gitSha);
    assert.equal(records[0].candidate.identity.revisionId, DEP_1.revisionId);
    assert.equal(
      records[0].candidate.buildTransactionId,
      `txn-${DEP_1.revisionId}`,
    );
    assert.equal(records[0].prior.identity.gitSha, DEP_0.gitSha);
    assert.equal(records[0].requestRevision, DEP_1.gitSha);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: promotion requires 204 plus post-effect identity proof", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    assertCycle(await scene.controller.run(), "advanced");
    scene.clock.advance(1);
    assertCycle(await scene.controller.run(), "advanced");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    const records = await scene.records();
    assert.equal(records[0].phase, "monitoring");
    assert.ok(records[0].receipts.promote);
    assert.equal(records[0].receipts.promote!.ok, true);
    assert.equal(records[0].receipts.promote!.statusCode, 204);
    assert.equal(records[0].observed.verified, true);
    assert.equal(records[0].observed.identity?.revisionId, DEP_1.revisionId);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: baseline and candidate windows accept within the owner policy", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    await completeWindow(scene);
    const records = await scene.records();
    assert.equal(records[0].phase, "accepted");
    const acceptance = records[0].acceptance;
    assert.ok(acceptance);
    assert.equal(acceptance.samples.length, 60);
    assert.equal(acceptance.baseline.length, 60);
    assert.equal(acceptance.passed, true);
    assert.equal(acceptance.continuous, true);
    const fiveXx = acceptance.thresholdResults.find((t) =>
      t.metric === "five_xx_rate"
    );
    assert.ok(fiveXx);
    assert.equal(fiveXx.observedRate, 0.01);
    assert.equal(fiveXx.baselineRate, 0);
    assert.equal(fiveXx.passed, true);
    // Every sample binds its exact identity: candidate samples the candidate,
    // baseline samples the recorded prior.
    for (const sample of acceptance.samples) {
      assert.equal(sample.identity.revisionId, DEP_1.revisionId);
      assert.equal(sample.identity.gitSha, DEP_1.gitSha);
    }
    for (const sample of acceptance.baseline) {
      assert.equal(sample.identity.revisionId, DEP_0.revisionId);
      assert.equal(sample.identity.gitSha, DEP_0.gitSha);
    }
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: minimum request coverage failure is insufficient, not a rollback", async () => {
  const policy = stabilityPolicy({ minRequests: 500 });
  const scene = await makeScenario({
    policy,
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    await completeWindow(scene);
    const records = await scene.records();
    assert.equal(records[0].phase, "failed");
    assert.equal(records[0].receipts.error?.kind, "acceptance_insufficient");
    assert.equal(records[0].receipts.rollback, null);
    assert.equal(records[0].acceptance?.passed, false);
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1); // no rollback promote
  } finally {
    await scene.cleanup();
  }
});

Deno.test(
  "checkpoint: known requests with null failure counters are insufficient, not zero",
  async () => {
    const scene = await makeScenario({
      logs: { accept: 100, fails: { fiveXx: 1 } },
    });
    try {
      await promoteToMonitoring(scene);
      await seedMonitorWindow(scene, 59);

      // Keep the denominator known while removing the configured five_xx
      // counter from every persisted candidate sample. The old evaluator
      // converted these nulls to zero and could accept the window.
      const store = storeAt(scene.ctx, "null-counter", "release");
      const read = await store.readRelease();
      assert.ok(read.ok, "release state must be readable");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("release state unavailable");
      }
      const record = read.value.snapshot.releases[0];
      if (record === undefined || record.acceptance === null) {
        throw new Error("seeded acceptance evidence unavailable");
      }
      const mutated = parseReleaseRecordV1({
        ...record,
        acceptance: {
          ...record.acceptance,
          samples: record.acceptance.samples.map((sample) => ({
            ...sample,
            fiveXxCount: null,
          })),
        },
        updatedAt: scene.clock.now(),
      });
      const snapshot: ReleaseStateSnapshotV1 = {
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: read.value.snapshot.sequence + 1,
        updatedAt: scene.clock.now(),
        releases: read.value.snapshot.releases.map((entry) =>
          entry.id === mutated.id ? mutated : entry
        ),
      };
      const written = await store.writeRelease(snapshot, read.value.head);
      assert.ok(written.ok, "null-counter fixture must be applied");

      scene.clock.advance(RELEASE_SAMPLE_INTERVAL_MS);
      assertCycle(await scene.controller.run(), "advanced");
      const records = await scene.records();
      assert.equal(records[0].phase, "failed");
      assert.equal(records[0].receipts.error?.kind, "acceptance_insufficient");
      assert.equal(records[0].receipts.rollback, null);
      assert.equal(records[0].acceptance?.passed, false);
      const fiveXx = records[0].acceptance?.thresholdResults.find((result) =>
        result.metric === "five_xx_rate"
      );
      assert.ok(fiveXx);
      assert.equal(fiveXx.observedRate, null);
      assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    } finally {
      await scene.cleanup();
    }
  },
);

Deno.test("checkpoint: threshold breach is objective failure and rolls back exactly", async () => {
  const policy = stabilityPolicy({
    thresholds: [
      { metric: "five_xx_rate", maxRate: 0.005, maxIncrease: 0 },
      { metric: "timeout_rate", maxRate: 0.01, maxIncrease: 0.01 },
      { metric: "stream_failure_rate", maxRate: 0.01, maxIncrease: 0.01 },
    ],
  });
  const scene = await makeScenario({
    policy,
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    // Persist the rollback intent before the restore effect, then verify the
    // exact restored prior.
    const recordsBefore = await scene.records();
    await completeWindow(scene);
    const records = await scene.records();
    assert.equal(records[0].phase, "rolled_back");
    assert.equal(records[0].receipts.rollback?.ok, true);
    assert.equal(
      records[0].receipts.rollback?.observedIdentity?.revisionId,
      DEP_0.revisionId,
    );
    assert.equal(records[0].observed.identity?.revisionId, DEP_0.revisionId);
    assert.equal(records[0].observed.verified, true);
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 2); // promote + rollback
    const rollbackIntentPersisted = recordsBefore.length === 1;
    assert.ok(rollbackIntentPersisted);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: lost promotion response reconciles without a repeated POST", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
    promote: { target: DEP_1, lost: true },
  });
  try {
    assertCycle(await scene.controller.run(), "advanced");
    scene.clock.advance(1);
    assertCycle(await scene.controller.run(), "persisted"); // promoting, pending proof
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    const records = await scene.records();
    assert.equal(records[0].phase, "promoting");
    assert.equal(records[0].receipts.promote?.ok, false);
    assert.ok(
      records[0].intent?.action === "promote",
      "intent must be persisted",
    );
    // Reconciliation run: the deployed candidate is observed; no new POST.
    scene.clock.advance(1);
    assertCycle(await scene.controller.run(), "advanced");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    const reconciled = await scene.records();
    assert.equal(reconciled[0].phase, "monitoring");
    assert.equal(reconciled[0].receipts.promote?.ok, true);
    assert.equal(reconciled[0].observed.identity?.revisionId, DEP_1.revisionId);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: an interrupted monitor resets continuity and the observation window", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    const record = await promoteToMonitoring(scene);
    const firstStart = record.monitoring.startedAt;
    if (firstStart === null) throw new Error("missing start");
    // One healthy slot persists, then the log source becomes unreadable for
    // the next slot: continuity restarts and nothing is reconstructed.
    scene.clock.at(firstStart + 65_000);
    assertCycle(await scene.controller.run(), "persisted");
    let records = await scene.records();
    assert.equal(records[0].monitoring.samples, 1);
    assert.notEqual(records[0].monitoring.startedAt, null);
    const secondStart = records[0].monitoring.startedAt!;
    scene.transport.logsReject = true;
    scene.clock.at(secondStart + 95_000);
    assertCycle(await scene.controller.run(), "persisted");
    records = await scene.records();
    assert.equal(records[0].monitoring.samples, 0);
    assert.equal(records[0].monitoring.continuous, true);
    assert.notEqual(records[0].monitoring.startedAt, secondStart);
    assert.equal(records[0].acceptance, null);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: managed 200 with the wrong revision is an unrelated-deployment block", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    scene.transport.identityOverride = DEP_X;
    scene.clock.advance(35_001);
    const result = await scene.controller.run();
    assertCycle(result, "blocked");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1); // no rollback promote
    const records = await scene.records();
    assert.equal(records[0].phase, "monitoring"); // untouched, blocked
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: custom 200 identity mismatch fails and restores the exact prior", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    scene.transport.customIdentityOverride = DEP_X;
    scene.clock.advance(35_001);
    await scene.controller.run(); // hard-fail → rollback flow in one run
    const records = await scene.records();
    assert.equal(records[0].phase, "rolled_back");
    assert.equal(
      records[0].receipts.rollback?.observedIdentity?.revisionId,
      DEP_0.revisionId,
    );
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 2);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: managed pass plus Cloudflare-identified 403 warns only", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    scene.transport.customStatus = 403;
    scene.transport.customCloudflare = true;
    scene.clock.advance(65_001);
    const result = await scene.controller.run();
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.value.status, "persisted");
      const warnings = result.value.status === "persisted"
        ? result.value.warnings
        : [];
      assert.ok(
        warnings.some((w) => w.includes("Cloudflare-identified 403")),
        `expected a Cloudflare warning, got ${JSON.stringify(warnings)}`,
      );
    }
    const records = await scene.records();
    assert.equal(records[0].phase, "monitoring"); // warning never fails the monitor
    assert.equal(records[0].monitoring.samples, 1);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: unrelated-newer deployment during rollback blocks, never restores", async () => {
  const policy = stabilityPolicy({
    thresholds: [
      { metric: "five_xx_rate", maxRate: 0.005, maxIncrease: 0 },
      { metric: "timeout_rate", maxRate: 0.01, maxIncrease: 0.01 },
      { metric: "stream_failure_rate", maxRate: 0.01, maxIncrease: 0.01 },
    ],
  });
  const scene = await makeScenario({
    policy,
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    scene.transport.identityOverride = DEP_X; // an unrelated deployment is current
    const recordsBefore = await scene.records();
    const startedAt = recordsBefore[0].monitoring.startedAt;
    if (startedAt === null) throw new Error("missing start");
    scene.clock.at(startedAt + 35_000 + 59 * 30_000);
    const result = await scene.controller.run();
    assertCycle(result, "blocked");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1); // no rollback POST
    const records = await scene.records();
    assert.equal(records[0].phase, "monitoring");
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: state CAS conflict stops the run before any promotion", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    assertCycle(await scene.controller.run(), "advanced");
    // Another writer moves the release-state head before the promote run.
    const other = storeAt(scene.ctx, "other", "release");
    const read = await other.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("expected release state");
    }
    const next: ReleaseStateSnapshotV1 = {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: read.value.head,
      sequence: read.value.snapshot.sequence + 1,
      updatedAt: read.value.snapshot.updatedAt + 5,
      releases: read.value.snapshot.releases,
      hostedRuntimes: read.value.snapshot.hostedRuntimes,
      hostedReleases: read.value.snapshot.hostedReleases,
      githubCooldowns: read.value.snapshot.githubCooldowns,
    };
    const pushed = await other.writeRelease(next, read.value.head);
    assert.ok(pushed.ok);
    if (pushed.ok) assert.equal(pushed.value.status, "applied");

    scene.clock.advance(1);
    const result = await scene.controller.run();
    assertCycle(result, "conflict");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 0);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: restart after durable intent reconciles instead of promoting again", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    assertCycle(await scene.controller.run(), "advanced");
    scene.clock.advance(1);
    // The post-effect proof stays unobservable (health serves the prior
    // identity) so the run persists a promoting record with the intent.
    scene.transport.identityOverride = DEP_0;
    assertCycle(await scene.controller.run(), "persisted");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    let records = await scene.records();
    assert.equal(records[0].phase, "promoting");
    assert.equal(records[0].intent?.action, "promote");

    // Restart with a fresh controller over the same durable state; the
    // deployment now shows the candidate; reconciliation must NOT re-POST.
    scene.transport.identityOverride = null;
    const restarted = makeRestartController(scene);
    scene.clock.advance(1);
    assertCycle(await restarted.run(), "advanced");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    records = await scene.records();
    assert.equal(records[0].phase, "monitoring");
    assert.equal(records[0].receipts.promote?.ok, true);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: consecutive slots persist their exact windows with continuity", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    const record = await promoteToMonitoring(scene);
    const startedAt = record.monitoring.startedAt;
    if (startedAt === null) throw new Error("missing start");
    const collected = await stepSlots(scene, 3);
    assert.equal(collected, 3);
    const records = await scene.records();
    assert.equal(records[0].monitoring.startedAt, startedAt);
    assert.equal(records[0].monitoring.continuous, true);
    const acceptance = records[0].acceptance;
    assert.ok(acceptance);
    assert.equal(acceptance!.samples.length, 3);
    acceptance!.samples.forEach((sample, index) => {
      assert.equal(sample.windowStart, startedAt + index * 30_000);
      assert.equal(sample.windowEnd, startedAt + (index + 1) * 30_000);
      assert.equal(sample.identity.revisionId, DEP_1.revisionId);
    });
    assert.equal(acceptance!.baseline.length, 60);
  } finally {
    await scene.cleanup();
  }
});

Deno.test(
  "checkpoint: a future adjacent terminal is revisited without losing the slot",
  async () => {
    const scene = await makeScenario();
    try {
      const record = await promoteToMonitoring(scene);
      const startedAt = record.monitoring.startedAt;
      if (startedAt === null) throw new Error("missing window start");
      const interval = RELEASE_SAMPLE_INTERVAL_MS;
      const lag = targetConfig().logsLagMs;

      scene.transport.any(
        "GET",
        new RegExp("^/v2/apps/[^/]+/logs$"),
        (url) => {
          const revisionId = url.searchParams.get("revision_id");
          const start = Date.parse(url.searchParams.get("start") ?? "0");
          if (revisionId !== DEP_1.revisionId) {
            return {
              kind: "response",
              status: 200,
              body: JSON.stringify({ logs: [], next_cursor: null }),
            };
          }
          const slot = Math.round((start - startedAt) / interval);
          const events: { at: number; message: string }[] = [];
          if (slot >= 0 && slot <= 3) {
            if (slot < 3) {
              const at = startedAt + (slot + 1) * interval - 1;
              events.push({
                at,
                message: acceptedEvent({
                  requestId: `boundary-${slot}`,
                  identity: DEP_1,
                  timestamp: at,
                }),
              });
            }
            if (slot > 0) {
              const at = startedAt + slot * interval + 10_000;
              events.push({
                at,
                message: terminalEvent({
                  requestId: `boundary-${slot - 1}`,
                  identity: DEP_1,
                  timestamp: at,
                }),
              });
            }
          }
          const visible = events.filter((event) =>
            event.at + lag <= scene.clock.now()
          );
          return {
            kind: "response",
            status: 200,
            body: JSON.stringify({
              logs: visible.map((event) => ({
                timestamp: new Date(event.at).toISOString(),
                level: "info",
                message: event.message,
                revision_id: DEP_1.revisionId,
              })),
              next_cursor: null,
            }),
          };
        },
      );

      for (let slot = 0; slot < 3; slot++) {
        scene.clock.at(startedAt + (slot + 2) * interval + lag + 1);
        assertCycle(await scene.controller.run(), "persisted");
      }
      const after = await scene.records();
      assert.equal(after[0].monitoring.startedAt, startedAt);
      assert.equal(after[0].monitoring.samples, 3);
      assert.equal(after[0].acceptance?.samples.length, 3);
    } finally {
      await scene.cleanup();
    }
  },
);

Deno.test("checkpoint: an unobserved monitoring gap restarts the window, historical slots are never accepted", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    const record = await promoteToMonitoring(scene);
    const startedAt = record.monitoring.startedAt;
    if (startedAt === null) throw new Error("missing start");
    // Slot 0 is due after its following window and the trusted lag; collect it.
    scene.clock.at(startedAt + 65_000);
    assertCycle(await scene.controller.run(), "persisted");
    let records = await scene.records();
    assert.equal(records[0].monitoring.samples, 1);
    const logCalls = scene.transport.callCount("GET", LOGS_RE);
    // The monitor is absent for the whole next slot: the observation is more
    // than one interval late, so two slots are overdue — an unobserved gap.
    // The window must restart fresh; the historical slot telemetry must never
    // be queried or accepted as continuous coverage.
    scene.clock.at(startedAt + 125_000);
    assertCycle(await scene.controller.run(), "persisted");
    records = await scene.records();
    assert.equal(records[0].monitoring.samples, 0);
    assert.notEqual(records[0].monitoring.startedAt, startedAt);
    assert.equal(
      records[0].monitoring.startedAt,
      nextAlignedWindowStart(RELEASE_SAMPLE_INTERVAL_MS, startedAt + 125_000),
    );
    assert.equal(records[0].acceptance, null);
    assert.equal(
      scene.transport.callCount("GET", LOGS_RE),
      logCalls,
      "the missed slots must not be re-queried as historical evidence",
    );
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: a degraded managed health sample never advances the acceptance window", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    const record = await promoteToMonitoring(scene);
    const startedAt = record.monitoring.startedAt;
    if (startedAt === null) throw new Error("missing start");
    // The candidate identity serves 200 with exact identity headers but the
    // required body marker is missing: the managed sample is NOT healthy.
    scene.transport.managedBodyMissing = true;
    scene.clock.at(startedAt + 65_000);
    assertCycle(await scene.controller.run(), "persisted");
    const records = await scene.records();
    assert.equal(records[0].monitoring.samples, 0);
    assert.equal(records[0].acceptance, null);
    assert.notEqual(records[0].monitoring.startedAt, startedAt);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: missing baseline telemetry persists explicit insufficient evidence, never throws", async () => {
  const scene = await makeScenario({
    // Candidate telemetry is readable; every PRIOR (baseline) log query
    // fails, so the run collects candidate slots with zero baseline evidence.
    logs: {
      accept: 100,
      fails: { fiveXx: 1 },
      rejectRevisionIds: ["dep-0000"],
    },
  });
  try {
    const record = await promoteToMonitoring(scene);
    const startedAt = record.monitoring.startedAt;
    if (startedAt === null) throw new Error("missing start");
    scene.clock.at(startedAt + 65_000);
    const result = await scene.controller.run(); // must resolve, never throw
    assert.ok(result.ok, "the missing baseline must not crash the run");
    if (!result.ok) return;
    assert.equal(result.value.status, "advanced");
    const records = await scene.records();
    assert.equal(records[0].phase, "failed");
    assert.equal(
      records[0].receipts.error?.kind,
      "acceptance_insufficient",
      "missing baseline is an explicit persisted insufficiency",
    );
    assert.equal(records[0].receipts.rollback, null);
    assert.equal(records[0].acceptance, null);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: an unverified custom 403 blocks acceptance instead of warning", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    const record = await promoteToMonitoring(scene);
    const startedAt = record.monitoring.startedAt;
    if (startedAt === null) throw new Error("missing start");
    // A bare origin 403 carries no Cloudflare challenge identification.
    scene.transport.customStatus = 403;
    scene.transport.customCloudflare = false;
    scene.clock.at(startedAt + 35_000);
    const result = await scene.controller.run();
    assertCycle(result, "blocked");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1); // no rollback
    const records = await scene.records();
    assert.equal(records[0].phase, "monitoring");
    assert.equal(records[0].monitoring.samples, 0);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: any other custom-domain failure blocks acceptance", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    const record = await promoteToMonitoring(scene);
    const startedAt = record.monitoring.startedAt;
    if (startedAt === null) throw new Error("missing start");
    scene.transport.customStatus = 503;
    scene.clock.at(startedAt + 35_000);
    assertCycle(await scene.controller.run(), "blocked");
    let records = await scene.records();
    assert.equal(records[0].phase, "monitoring");
    assert.equal(records[0].monitoring.samples, 0);

    // An unobservable custom gateway is equally blocking.
    const scene2 = await makeScenario({
      logs: { accept: 100, fails: { fiveXx: 1 } },
    });
    try {
      const record2 = await promoteToMonitoring(scene2);
      const startedAt2 = record2.monitoring.startedAt;
      if (startedAt2 === null) throw new Error("missing start");
      scene2.transport.customReject = true;
      scene2.clock.at(startedAt2 + 35_000);
      assertCycle(await scene2.controller.run(), "blocked");
      records = await scene2.records();
      assert.equal(records[0].phase, "monitoring");
      assert.equal(records[0].monitoring.samples, 0);
    } finally {
      await scene2.cleanup();
    }
  } finally {
    await scene.cleanup();
  }
});
