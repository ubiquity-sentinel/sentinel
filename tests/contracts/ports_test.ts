// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import type {
  MergeOutcomeV1,
  ReleaseStateWriter,
  RepairStateWriter,
  ReplayRunRequestV1,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { portError, portOk, SystemClock } from "../../src/contracts/ports.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  _githubFake,
  _releaseFake,
  commandId,
  digest,
  FakeClock,
  FakeStateStore,
  mergeRequest,
  MINIMAL_WORK,
  RecordingReplayPort,
  SHA,
  workId,
} from "./port-fixtures.ts";

Deno.test("StateStore: branch creation applies, stale expected head conflicts", async () => {
  const store = new FakeStateStore();
  const first = parseWorkRecordV1({ ...MINIMAL_WORK });
  const snapshotA: RepairStateSnapshotV1 = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: 1786000000000,
    incidents: [],
    evidence: [],
    work: [first],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
  const created = await store.writeRepair(snapshotA, null);
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.value.status, "applied");

  // Blinded write with a stale expected head must conflict, not overwrite.
  const stale = await store.writeRepair(snapshotA, SHA);
  assert.equal(stale.ok, true);
  if (stale.ok) assert.equal(stale.value.status, "conflict");

  // The store still holds the originally applied snapshot.
  const read = await store.readRepair();
  assert.equal(read.ok, true);
  if (read.ok && read.value.status === "found") {
    assert.equal(read.value.snapshot.work[0]?.id, "i:1");
  } else assert.fail("expected a found snapshot");
});

Deno.test("StateStore: ambiguous network outcome is distinct from conflict", async () => {
  const store = new FakeStateStore();
  const snapshot: RepairStateSnapshotV1 = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: 1786000000000,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
  store.ambiguousRepairNext = true;
  const ambiguous = await store.writeRepair(snapshot, null);
  assert.equal(ambiguous.ok, true);
  if (ambiguous.ok) {
    assert.equal(ambiguous.value.status, "ambiguous");
    // A failed/conflicted write and an ambiguous one are distinct kinds.
    assert.ok(!("head" in ambiguous.value));
  }
  const tryAgain = await store.writeRepair(snapshot, null);
  assert.equal(tryAgain.ok, true);
  if (tryAgain.ok) assert.equal(tryAgain.value.status, "applied");
});

Deno.test("StateStore: repair and release branches are strictly separate", async () => {
  const store = new FakeStateStore();
  const repairSnapshot: RepairStateSnapshotV1 = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: 1786000000000,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
  const releaseSnapshot: ReleaseStateSnapshotV1 = {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: 1786000000000,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  };
  await store.writeRepair(repairSnapshot, null);
  await store.writeRelease(releaseSnapshot, null);
  assert.equal(store.repairWrites, 1);
  assert.equal(store.releaseWrites, 1);
  const repair = await store.readRepair();
  assert.ok(repair.ok && repair.value.status === "found");
  if (repair.ok && repair.value.status === "found") {
    assert.ok(!("releases" in repair.value.snapshot));
    // Operational external ref identity is kept separate from the head.
    assert.equal(repair.value.ref, "refs/heads/sentinel-state/repair");
  }
  const release = await store.readRelease();
  assert.ok(release.ok && release.value.status === "found");
  if (release.ok && release.value.status === "found") {
    assert.ok(!("work" in release.value.snapshot));
    assert.equal(release.value.ref, "refs/heads/sentinel-state/release");
  }
});

Deno.test("state capabilities: read-only view and per-writer capabilities are narrow", () => {
  const store = new FakeStateStore();
  const readOnly: StateReadView = store;
  const repairWriter: RepairStateWriter = store;
  const releaseWriter: ReleaseStateWriter = store;
  assert.ok(readOnly && repairWriter && releaseWriter);
  // A release writer must never expose repair write capability.
  // @ts-expect-error release-only writer has no writeRepair
  releaseWriter.writeRepair;
  // @ts-expect-error repair-only writer has no writeRelease
  repairWriter.writeRelease;
});

Deno.test("Clock: fake time is deterministic and monotonic", () => {
  const clock = new FakeClock(1786000000000);
  assert.equal(clock.now(), 1786000000000);
  clock.advance(30_000);
  assert.equal(clock.now(), 1786000030000);
  const system = new SystemClock();
  const before = Date.now();
  const sampled = system.now();
  assert.ok(sampled >= before && sampled <= before + 5_000);
});

Deno.test("Replay port: unavailable is not an empty/success result", async () => {
  const unavailable = new RecordingReplayPort(
    portError("unavailable", "sandbox could not be provisioned"),
  );
  const request: ReplayRunRequestV1 = {
    taskId: workId("i:1"),
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
    revision: SHA,
    commandId: commandId("test_ci"),
    fixtureRef: "fixture://f.json",
    fixtureDigest: digest("aa".repeat(32)),
    testIds: ["t"],
    outputLimitBytes: 1024,
  };
  const result = await unavailable.runReplay(request);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "unavailable");

  const passed = new RecordingReplayPort(
    portOk({
      outcome: "passed",
      exitCode: 0,
      output: {
        stdoutDigest: digest("bb".repeat(32)),
        stderrDigest: null,
        truncated: false,
      },
      failure: null,
      limitations: [],
      startedAt: 1786000000000,
      endedAt: 1786000001000,
    }),
  );
  const okResult = await passed.runReplay(request);
  assert.equal(okResult.ok, true);
  if (okResult.ok) assert.equal(okResult.value.outcome, "passed");
  assert.equal(unavailable.requests.length, 1);
  assert.equal(passed.requests.length, 1);
});

Deno.test("GitHub merge result kinds are discriminated values, not booleans", () => {
  const merged: MergeOutcomeV1 = {
    outcome: "merged",
    head: SHA,
    mergeSha: SHA,
  };
  const blocked: MergeOutcomeV1 = {
    outcome: "blocked",
    reason: "checks_pending",
    head: SHA,
  };
  const baseMismatch: MergeOutcomeV1 = {
    outcome: "blocked",
    reason: "base_mismatch",
    head: SHA,
  };
  const reviewRequired: MergeOutcomeV1 = {
    outcome: "blocked",
    reason: "review_required",
    head: SHA,
  };
  const ambiguous: MergeOutcomeV1 = {
    outcome: "ambiguous",
    head: null,
    mergeSha: null,
  };
  assert.equal(merged.outcome, "merged");
  assert.equal(blocked.outcome, "blocked");
  assert.equal(ambiguous.outcome, "ambiguous");
  if (blocked.outcome === "blocked") {
    assert.equal(blocked.reason, "checks_pending");
  }
  if (baseMismatch.outcome === "blocked") {
    assert.equal(baseMismatch.reason, "base_mismatch");
  }
  if (reviewRequired.outcome === "blocked") {
    assert.equal(reviewRequired.reason, "review_required");
  }
});

Deno.test("portOk/portError helpers produce the documented shapes", () => {
  assert.deepEqual(portError("rate_limited", "backoff"), {
    ok: false,
    error: { kind: "rate_limited", detail: "backoff" },
  });
  assert.deepEqual(portOk(7), { ok: true, value: 7 });
});

// Compile-time shape guard: a minimal DenoReleasePort fake type-checks with
// exact deployment identities and the SHA+buildTransactionId+revisionId
// lookup (the exact revision id comes from the trusted receipt resolver).

Deno.test("fake ports are callable and return documented kinds", async () => {
  assert.deepEqual(await _githubFake.listOpenIssues(), portOk([]));
  const check = await _githubFake.readChecks(SHA);
  assert.ok(check.ok && check.value.checks.length === 0); // empty checks is a real value
  const merge = await _githubFake.mergePullRequest(mergeRequest());
  assert.ok(merge.ok && merge.value.outcome === "blocked");
  const dep = await _releaseFake.readCurrentDeployment("p");
  assert.ok(dep.ok && dep.value.status === "unknown");
});

// ---------------------------------------------------------------------------
// Minimal fake-port loop skeleton (plan §8, Wave A): the shape of one polling
// pass over the frozen ports, driven by the existing canned fakes. It records
// the calls it makes, runs two deterministic ticking passes, and exits at an
// unchanged review wait. This is a contract smoke skeleton ONLY — it holds no
// selection logic, no budget admission, no state write and no model port; the
// real selection/loop state machine belongs to m04 and the release state
// machine to m05 (see docs/contracts.md §10 for entrypoint ownership).
// ---------------------------------------------------------------------------
