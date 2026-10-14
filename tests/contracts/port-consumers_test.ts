// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import type {
  GitHubPort,
  ReplayPort,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  _githubFake,
  commandId,
  digest,
  FakeClock,
  FakeStateStore,
  MINIMAL_WORK,
  RecordingReplayPort,
  SHA,
  workId,
} from "./port-fixtures.ts";

interface SmokeLoopDepsV1 {
  /** Read-only repair snapshot access; a writer is never handed to the loop. */
  repair: Pick<StateReadView, "readRepair">;
  /** Canned authoritative source read + review observation (m01 fake). */
  github: Pick<GitHubPort, "readIssue" | "observeReview">;
  replay: ReplayPort;
  clock: Clock;
}

interface SmokePollV1 {
  /** Ordered record of every port call made during this pass. */
  trace: string[];
  /** True when the observed review is still pending: the wait stays unchanged. */
  waitUnchanged: boolean;
}

/** One scripted poll: repair read, source read, replay, review observation. */
async function smokePoll(
  deps: SmokeLoopDepsV1,
  tick: number,
  waiting: WorkRecordV1,
): Promise<SmokePollV1> {
  const trace: string[] = [];
  const at = deps.clock.now();
  const read = await deps.repair.readRepair();
  trace.push(
    `tick:${tick}@${at}:repair-read:${read.ok ? "found" : "unavailable"}`,
  );
  const source = await deps.github.readIssue(waiting.related.issueNumber ?? 1);
  trace.push(`tick:${tick}@${at}:source-read:${source.ok ? "ok" : "error"}`);
  const replayResult = await deps.replay.runReplay({
    taskId: waiting.id,
    repository: waiting.repository,
    revision: waiting.failingRevision ?? waiting.target.base,
    commandId: commandId("test_ci"),
    fixtureRef: "fixture://sentinel/synth-0001.json",
    fixtureDigest: digest("cc".repeat(32)),
    testIds: ["test_ci"],
    outputLimitBytes: 4096,
  });
  trace.push(
    `tick:${tick}@${at}:replay:${
      replayResult.ok ? replayResult.value.outcome : "error"
    }`,
  );
  const observed = await deps.github.observeReview({
    operationKey: `review:${waiting.id}`,
    prNumber: waiting.target.pr ?? 1,
    head: waiting.target.head ?? waiting.failingRevision ?? SHA,
  });
  trace.push(
    `tick:${tick}@${at}:review-observe:${
      observed.ok ? observed.value.status : "unavailable"
    }`,
  );
  return {
    trace,
    waitUnchanged: observed.ok && observed.value.status === "pending",
  };
}

const T0 = 1786000000000;

Deno.test(
  "fake-port loop skeleton: two ticks exit at an unchanged review wait, no model or sleep",
  async () => {
    const clock = new FakeClock(T0);
    const store = new FakeStateStore();
    const replay = new RecordingReplayPort(
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
        startedAt: T0,
        endedAt: T0 + 1000,
      }),
    );

    // One work item sitting in the review wait: the source/replay evidence is
    // done; the wait reason is review_pending until T0 + 1h.
    const waiting: WorkRecordV1 = {
      ...MINIMAL_WORK,
      id: workId("i:2"),
      nextStep: "review",
      wait: { reason: "review_pending", since: T0, until: T0 + 3_600_000 },
    };
    const repairSnapshot: RepairStateSnapshotV1 = {
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [],
      evidence: [],
      work: [waiting],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    };
    await store.writeRepair(repairSnapshot, null);
    const releaseSnapshot: ReleaseStateSnapshotV1 = {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      releases: [],
      hostedRuntimes: [],
      hostedReleases: [],
      githubCooldowns: [],
    };
    await store.writeRelease(releaseSnapshot, null);
    assert.equal(store.repairWrites, 1);
    assert.equal(store.releaseWrites, 1);

    // Capability separation at the smoke boundary: the loop reads the repair
    // snapshot only, and the release read stays an independent capability.
    const repairRead: Pick<StateReadView, "readRepair"> = store;
    const releaseRead: Pick<StateReadView, "readRelease"> = store;
    // @ts-expect-error a repair read capability never carries release reads
    repairRead.readRelease;
    // @ts-expect-error a release read capability never carries repair reads
    releaseRead.readRepair;
    const deps: SmokeLoopDepsV1 = {
      repair: repairRead,
      github: _githubFake,
      replay,
      clock,
    };
    // @ts-expect-error the smoke loop has no model port (admission is never in scope here)
    deps.runModel;
    // @ts-expect-error the smoke loop has no state write capability
    deps.repair.writeRepair;

    // Two deterministic polling ticks; the canned review stays pending, so
    // both pass ends at the same wait and the loop advances nothing.
    const trace: string[] = [];
    const exits: string[] = [];
    for (let tick = 1; tick <= 2; tick++) {
      const poll = await smokePoll(deps, tick, waiting);
      trace.push(...poll.trace);
      exits.push(
        `tick:${tick}:${poll.waitUnchanged ? "unchanged" : "changed"}`,
      );
      // Independent release read: its own branch, never repair records.
      const release = await releaseRead.readRelease();
      assert.ok(release.ok && release.value.status === "found");
      if (release.ok && release.value.status === "found") {
        assert.deepEqual(release.value.snapshot.releases, []);
        assert.ok(!("work" in release.value.snapshot));
      }
      clock.advance(60_000);
    }

    assert.deepEqual(exits, ["tick:1:unchanged", "tick:2:unchanged"]);
    assert.deepEqual(trace, [
      `tick:1@${T0}:repair-read:found`,
      `tick:1@${T0}:source-read:ok`,
      `tick:1@${T0}:replay:passed`,
      `tick:1@${T0}:review-observe:pending`,
      `tick:2@${T0 + 60_000}:repair-read:found`,
      `tick:2@${T0 + 60_000}:source-read:ok`,
      `tick:2@${T0 + 60_000}:replay:passed`,
      `tick:2@${T0 + 60_000}:review-observe:pending`,
    ]);
    // Both ticks issued one deterministic replay for the same identity.
    assert.equal(replay.requests.length, 2);
    assert.deepEqual(replay.requests[1], replay.requests[0]);
    // The loop wrote nothing: only the two seed writes happened.
    assert.equal(store.repairWrites, 1);
    assert.equal(store.releaseWrites, 1);
    // The wait and lifecycle are byte-identical after the loop; the clock moved
    // only by explicit ticks (no real sleeping, no model call).
    const finalRead = await store.readRepair();
    assert.ok(finalRead.ok && finalRead.value.status === "found");
    if (finalRead.ok && finalRead.value.status === "found") {
      assert.equal(finalRead.value.snapshot.work[0]?.nextStep, "review");
      assert.deepEqual(finalRead.value.snapshot.work[0]?.wait, waiting.wait);
    }
    assert.equal(clock.now(), T0 + 120_000);
  },
);

Deno.test(
  "release read capability is independent of repair state across the same ticks",
  async () => {
    const store = new FakeStateStore();
    await store.writeRepair({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [],
      evidence: [],
      work: [MINIMAL_WORK],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    }, null);
    await store.writeRelease({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      releases: [],
      hostedRuntimes: [],
      hostedReleases: [],
      githubCooldowns: [],
    }, null);

    const releaseRead: Pick<StateReadView, "readRelease"> = store;
    // @ts-expect-error release reads never expose the repair snapshot
    releaseRead.readRepair;
    const release = await releaseRead.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    if (release.ok && release.value.status === "found") {
      assert.ok(!("work" in release.value.snapshot));
      assert.equal(release.value.snapshot.sequence, 1);
    }
    // Repair branch still holds its own records, untouched by the release read.
    const repair = await store.readRepair();
    assert.ok(repair.ok && repair.value.status === "found");
    if (repair.ok && repair.value.status === "found") {
      assert.ok(!("releases" in repair.value.snapshot));
      assert.equal(repair.value.snapshot.work.length, 1);
    }
    assert.equal(store.releaseWrites, 1);
  },
);

// ---------------------------------------------------------------------------
// Proposed gateway producer index mapping (docs/contracts.md §11): the
// synthetic wire fixture maps into the frozen IncidentSummaryV1 records. The
// conversion is test-only; m02 owns the real production adapter. No new shared
// port interface is added, and this fixture proves producer/consumer schema
// mapping only — never live discovery.
// ---------------------------------------------------------------------------

/** Exact wire keys; unknown keys fail closed at the mapping boundary. */
