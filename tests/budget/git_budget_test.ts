// Budget controller tests against the real GitStateStore and disposable local
// bare remotes: one global cap across repositories with a restarted store,
// simultaneous identical and distinct admissions at cap (exactly one winner),
// a successful push with a lost response reconciling to a single durable
// reservation, read/transport failures never admitting, and unrelated state
// preservation plus idempotent settlement. No production state branch,
// no network and no model calls exist in this suite.
import assert from "node:assert/strict";

import {
  deriveReservationId,
  HOUR_WINDOW_MS,
  type ReserveModelStartRequestV1,
  RollingStartBudget,
} from "../../src/budget/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { implementationIntent } from "../../src/repair/loop-implementation.ts";
import { startAttempt } from "../../src/repair/transitions.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
} from "../../src/repair/keys.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { createRepairStateStore, DenoGitRunner } from "../../src/state/mod.ts";
import type { GitRunnerV1 } from "../../src/state/mod.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  BarrierRunner,
  FailedPushRunner,
  incidentSummary,
  LostPushResponseRunner,
  makeRemoteCtx,
  REPO,
  SHA2,
  SHA3,
  T0,
  testGitEnv,
  ThrowingRunner,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  REPO_2,
  repositoryConfig,
  reserveRequest,
  seededReservation,
} from "./helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/budget\/git_budget_test\.ts$/,
  "",
);

interface Ctx {
  tmp: string;
  env: Record<string, string>;
  remoteUrl: string;
  cleanup(): Promise<void>;
}

async function makeCtx(prefix: string): Promise<Ctx> {
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-budget-test-${prefix}-`,
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  return {
    tmp,
    env,
    remoteUrl: remote.remoteUrl,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

function storeAt(
  ctx: Ctx,
  name: string,
  runner?: GitRunnerV1,
): ReturnType<typeof createRepairStateStore> {
  return createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-${name}`,
    remoteUrl: ctx.remoteUrl,
    runner,
  });
}

const CAPS = { perHour: 1, perSevenDays: 3 } as const;
const configs = () => [
  repositoryConfig(REPO, CAPS),
  repositoryConfig(REPO_2, CAPS),
];

function budgetAt(
  clock: FakeClock,
  state: ReturnType<typeof createRepairStateStore>,
  configSet: ReturnType<typeof configs> = configs(),
): RollingStartBudget {
  return new RollingStartBudget({ clock, state, configs: configSet });
}

Deno.test("budget: one global cap across repositories survives a restart", async () => {
  const ctx = await makeCtx("cross-repo");
  try {
    const clock = new FakeClock(T0);
    const first = budgetAt(clock, storeAt(ctx, "a"));
    const admitted = await first.reserveModelStart(
      reserveRequest("task:a", { repository: REPO }),
    );
    assert.equal(admitted.status, "admitted", JSON.stringify(admitted));
    assert.equal(admitted.status === "admitted", true);
    const admittedHead = admitted.status === "admitted"
      ? admitted.stateHead
      : null;
    assert.ok(admittedHead);

    // A restarted store (fresh scratch) in another repository shares the cap.
    const restarted = budgetAt(clock, storeAt(ctx, "b"));
    const deferred = await restarted.reserveModelStart(
      reserveRequest("task:b", { repository: REPO_2 }),
    );
    assert.equal(deferred.status, "deferred", JSON.stringify(deferred));
    if (deferred.status === "deferred") {
      assert.equal(deferred.reason, "cap_limit");
      assert.equal(deferred.retryAt, T0 + HOUR_WINDOW_MS);
    }

    // After one hour the window has no charges left: admission proceeds and
    // the durable record carries the second repository.
    clock.advance(HOUR_WINDOW_MS + 1);
    const admitted2 = await restarted.reserveModelStart(
      reserveRequest("task:b2", { repository: REPO_2 }),
    );
    assert.equal(admitted2.status, "admitted", JSON.stringify(admitted2));

    const read = await storeAt(ctx, "c").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      const repos = read.value.snapshot.reservations.map((r) =>
        `${r.repository.owner}/${r.repository.name}`
      ).sort();
      assert.deepEqual(
        repos,
        [
          "ubiquity/ai.ubq.fi",
          "ubiquity-sentinel/sentinel",
        ].sort(),
      );
    }
  } finally {
    await ctx.cleanup();
  }
});

/** Real state fixture; only the external admission acknowledgement is injected. */
async function atomicFixture(ctx: Ctx, clock: FakeClock, conflict = false) {
  const store = storeAt(ctx, "atomic-seed");
  const work = workRecord("task:atomic", { updatedAt: T0 });
  if (conflict) {
    work.counters.attempts = 6;
    work.counters.retries = 3;
    work.target.branch = candidateBranch(work.id);
    work.target.head = SHA2;
    work.target.pr = 7;
    work.intent = {
      kind: "base_refresh",
      key: baseRefreshIntentKey(7, SHA2, SHA3),
      startedAt: T0,
      branch: work.target.branch,
      expectedHead: SHA2,
      observedBase: SHA3,
      pr: 7,
      requestId: null,
      resultId: null,
      failure: conflictMarker(SHA3, T0),
    };
  }
  const snapshot: RepairStateSnapshotV1 = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [incidentSummary("inc:untouched")],
    evidence: [],
    work: [work, workRecord("w:untouched", { updatedAt: T0 })],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
  const seed = await store.writeRepair(snapshot, null);
  assert.ok(seed.ok && seed.value.status === "applied");
  const loaded = await store.readRepair();
  assert.ok(loaded.ok && loaded.value.status === "found");
  const before = loaded.value.snapshot.work.find((row) => row.id === work.id)!;
  const request: ReserveModelStartRequestV1 = reserveRequest(work.id, {
    attempt: before.counters.attempts + 1,
    purpose: before.counters.attempts === 0 ? "implementation" : "retry",
  });
  const id = await deriveReservationId(request);
  const nextWork = startAttempt(before, clock.now());
  nextWork.intent = {
    ...implementationIntent(id, nextWork, clock.now()),
    ...(conflict ? { failure: conflictMarker(SHA3, clock.now()) } : {}),
  };
  request.implementationTransition = {
    expectedStateHead: loaded.value.head,
    expectedWork: before,
    nextWork,
  };
  return { request, before: loaded.value, id };
}

Deno.test("budget atomic implementation: real Git stores charge and counted conflict intent in one commit", async () => {
  const ctx = await makeCtx("atomic-conflict");
  try {
    const clock = new FakeClock(T0 + 1000);
    const fixture = await atomicFixture(ctx, clock, true);
    clock.advance(17);
    const result = await budgetAt(clock, storeAt(ctx, "admit"))
      .reserveModelStart(fixture.request);
    assert.equal(result.status, "admitted", JSON.stringify(result));
    const fresh = await storeAt(ctx, "empty-reader").readRepair();
    assert.ok(fresh.ok && fresh.value.status === "found");
    const state = fresh.value.snapshot;
    const work = state.work.find((row) => row.id === fixture.request.taskId)!;
    assert.equal(state.sequence, fixture.before.snapshot.sequence + 1);
    assert.equal(state.reservations.length, 1);
    assert.equal(work.counters.attempts, 7);
    assert.equal(work.counters.retries, 3);
    assert.equal(work.intent?.requestId, fixture.id);
    assert.equal(work.intent?.startedAt, state.reservations[0].createdAt);
    assert.equal(work.intent?.failure?.atMs, state.reservations[0].createdAt);
    assert.equal(work.updatedAt, T0 + 1017);
    assert.deepEqual(
      work.target,
      fixture.request.implementationTransition!.expectedWork.target,
    );
    assert.deepEqual(state.incidents, fixture.before.snapshot.incidents);
    assert.deepEqual(
      state.work.find((row) => row.id === "w:untouched"),
      fixture.before.snapshot.work.find((row) => row.id === "w:untouched"),
    );
    assert.deepEqual(
      work.evidence,
      fixture.request.implementationTransition!.expectedWork.evidence,
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget atomic implementation: refusal, lost acknowledgements and concurrent CAS preserve both records", async (t) => {
  for (
    const mode of [
      "before_write",
      "lost_push_response",
      "unresolved_ack",
      "concurrent",
    ] as const
  ) {
    await t.step(mode, async () => {
      const ctx = await makeCtx(`atomic-${mode}`);
      try {
        const clock = new FakeClock(T0 + 1000);
        const fixture = await atomicFixture(ctx, clock);
        let result;
        if (mode === "concurrent") {
          const runner = new BarrierRunner(
            new DenoGitRunner(`${ctx.tmp}/git-home`),
          );
          const outcomes = await Promise.all([
            budgetAt(clock, storeAt(ctx, "a", runner)).reserveModelStart(
              fixture.request,
            ),
            budgetAt(clock, storeAt(ctx, "b", runner)).reserveModelStart(
              fixture.request,
            ),
          ]);
          assert.deepEqual(outcomes.map((row) => row.status).sort(), [
            "admitted",
            "conflict",
          ]);
          result = outcomes.find((row) => row.status === "admitted")!;
        } else {
          const runner = new DenoGitRunner(`${ctx.tmp}/git-home`);
          const store = storeAt(
            ctx,
            "admit",
            mode === "before_write"
              ? new FailedPushRunner(runner)
              : mode === "lost_push_response"
              ? new LostPushResponseRunner(runner)
              : runner,
          );
          if (mode === "unresolved_ack") {
            const write = store.writeRepair.bind(store);
            store.writeRepair = async (next, expected) => {
              const applied = await write(next, expected);
              assert.ok(applied.ok && applied.value.status === "applied");
              return portOk({ status: "ambiguous", currentHead: null });
            };
          }
          result = await budgetAt(clock, store).reserveModelStart(
            fixture.request,
          );
        }
        const fresh = await storeAt(ctx, "readback").readRepair();
        assert.ok(fresh.ok && fresh.value.status === "found");
        if (mode === "before_write") {
          assert.notEqual(result.status, "admitted");
          assert.equal(fresh.value.head, fixture.before.head);
          assert.deepEqual(fresh.value.snapshot, fixture.before.snapshot);
        } else {
          assert.equal(
            result.status,
            mode === "unresolved_ack" ? "ambiguous" : "admitted",
          );
          const work = fresh.value.snapshot.work.find((row) =>
            row.id === fixture.request.taskId
          )!;
          assert.equal(fresh.value.snapshot.reservations.length, 1);
          assert.equal(work.counters.attempts, 1);
          assert.equal(work.intent?.requestId, fixture.id);
          assert.equal(
            fresh.value.snapshot.sequence,
            fixture.before.snapshot.sequence + 1,
          );
          const duplicate = await budgetAt(clock, storeAt(ctx, "restart"))
            .reserveModelStart(fixture.request);
          assert.equal(
            duplicate.status,
            "duplicate",
            "lost acknowledgement never grants a second start",
          );
        }
      } finally {
        await ctx.cleanup();
      }
    });
  }
});

Deno.test("budget atomic implementation: stale or malformed companions never alter real Git state", async (t) => {
  const ctx = await makeCtx("atomic-refusals");
  try {
    const clock = new FakeClock(T0 + 1000);
    const fixture = await atomicFixture(ctx, clock);
    const mutations: [string, (request: ReserveModelStartRequestV1) => void][] =
      [
        ["stale head", (q) => {
          q.implementationTransition!.expectedStateHead = SHA2;
        }],
        ["changed prior", (q) => {
          q.implementationTransition!.expectedWork.classification.priority = 9;
        }],
        ["changed target", (q) => {
          q.implementationTransition!.nextWork.target.base = SHA2;
        }],
        ["wrong task", (q) => {
          q.taskId = fixture.before.snapshot.work.find((row) =>
            row.id === "w:untouched"
          )!.id;
        }],
        ["wrong installation", (q) => {
          q.implementationTransition!.nextWork.repository.installationId++;
        }],
        ["wrong charge", (q) => {
          q.implementationTransition!.nextWork.intent!.requestId = "f".repeat(
            64,
          );
        }],
        ["wrong key", (q) => {
          q.implementationTransition!.nextWork.intent!.key = "impl:" +
            "f".repeat(64);
        }],
        ["wrong branch", (q) => {
          q.implementationTransition!.nextWork.intent!.branch =
            "sentinel/repair/other";
        }],
        ["counter jump", (q) => {
          q.implementationTransition!.nextWork.counters.attempts++;
        }],
        ["invented CI retry", (q) => {
          q.implementationTransition!.nextWork.counters.retries++;
        }],
        ["changed evidence", (q) => {
          q.implementationTransition!.nextWork.evidence = [{
            kind: "review_receipt",
            ref: "artifact:extra",
          }];
        }],
        ["changed intent base", (q) => {
          q.implementationTransition!.nextWork.intent!.observedBase = SHA2;
        }],
      ];
    for (const [name, mutate] of mutations) {
      await t.step(name, async () => {
        const request = structuredClone(fixture.request);
        mutate(request);
        const result = await budgetAt(
          clock,
          storeAt(ctx, `refuse-${name.replaceAll(" ", "-")}`),
        ).reserveModelStart(request);
        assert.equal(
          result.status,
          name === "stale head" ? "conflict" : "invalid",
          JSON.stringify(result),
        );
        const fresh = await storeAt(ctx, `verify-${name.replaceAll(" ", "-")}`)
          .readRepair();
        assert.ok(fresh.ok && fresh.value.status === "found");
        assert.equal(fresh.value.head, fixture.before.head);
        assert.deepEqual(fresh.value.snapshot, fixture.before.snapshot);
      });
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: simultaneous identical admissions grant exactly one start", async () => {
  const ctx = await makeCtx("cas-identical");
  try {
    const clock = new FakeClock(T0);
    const runner = new BarrierRunner(new DenoGitRunner(`${ctx.tmp}/git-home`));
    const a = budgetAt(clock, storeAt(ctx, "a", runner));
    const b = budgetAt(clock, storeAt(ctx, "b", runner));
    const request = reserveRequest("task:same");
    const [ra, rb] = await Promise.all([
      a.reserveModelStart(request),
      b.reserveModelStart(request),
    ]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, ["admitted", "conflict"]);
    const winner = ra.status === "admitted" ? ra : rb;
    const loser = ra.status === "conflict" ? ra : rb;
    assert.ok(winner.status === "admitted" && loser.status === "conflict");
    if (winner.status === "admitted" && loser.status === "conflict") {
      assert.equal(loser.currentHead, winner.stateHead);
    }

    // The losing caller's reconciling retry must yield duplicate, not a start.
    const retry = await budgetAt(clock, storeAt(ctx, "c"))
      .reserveModelStart(request);
    assert.equal(retry.status, "duplicate");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: simultaneous distinct admissions at cap grant exactly one start", async () => {
  const ctx = await makeCtx("cas-distinct");
  try {
    const clock = new FakeClock(T0);
    const runner = new BarrierRunner(new DenoGitRunner(`${ctx.tmp}/git-home`));
    const a = budgetAt(clock, storeAt(ctx, "a", runner));
    const b = budgetAt(clock, storeAt(ctx, "b", runner));
    const [ra, rb] = await Promise.all([
      a.reserveModelStart(reserveRequest("task:x1")),
      b.reserveModelStart(reserveRequest("task:x2")),
    ]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, ["admitted", "conflict"]);
    // The ref holds exactly one reservation.
    const read = await storeAt(ctx, "c").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.snapshot.reservations.length, 1);
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: successful push with lost response yields one durable reservation", async () => {
  const ctx = await makeCtx("lost-response");
  try {
    const clock = new FakeClock(T0);
    const runner = new LostPushResponseRunner(
      new DenoGitRunner(`${ctx.tmp}/git-home`),
    );
    const controller = budgetAt(clock, storeAt(ctx, "a", runner));
    const request = reserveRequest("task:lost");
    const admitted = await controller.reserveModelStart(request);
    assert.equal(admitted.status, "admitted", JSON.stringify(admitted));
    assert.equal(runner.pushAttempts, 1, "never a blind second push");

    // Repeating the identical request reconciles: duplicate, no second start.
    const again = await controller.reserveModelStart(request);
    assert.equal(again.status, "duplicate");
    const read = await storeAt(ctx, "b").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.snapshot.reservations.length, 1);
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: throwing transport never admits and nothing is applied", async () => {
  const ctx = await makeCtx("throwing");
  try {
    const clock = new FakeClock(T0);
    const failing = budgetAt(
      clock,
      storeAt(
        ctx,
        "a",
        new ThrowingRunner(
          new DenoGitRunner(`${ctx.tmp}/git-home`),
          () => true,
        ),
      ),
    );
    const request = reserveRequest("task:throw");
    const result = await failing.reserveModelStart(request);
    assert.equal(result.status, "unavailable", JSON.stringify(result));

    // Authoritative state was never created; a healthy path can still apply.
    const absent = await storeAt(ctx, "b").readRepair();
    assert.ok(absent.ok && absent.value.status === "absent");
    const healthy = budgetAt(clock, storeAt(ctx, "c"));
    const admitted = await healthy.reserveModelStart(request);
    assert.equal(admitted.status, "admitted");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: invalid identity inputs are invalid at the real state boundary and write nothing", async () => {
  const ctx = await makeCtx("invalid-boundary");
  try {
    const clock = new FakeClock(T0);
    const controller = budgetAt(clock, storeAt(ctx, "a"));
    const badHead = await controller.reserveModelStart(
      reserveRequest("task:inv1", { head: "nope" as never }),
    );
    assert.equal(badHead.status, "invalid");
    const zeroAttempt = await controller.reserveModelStart(
      reserveRequest("task:inv2", { attempt: 0 }),
    );
    assert.equal(zeroAttempt.status, "invalid");
    const badRepo = await controller.reserveModelStart({
      ...reserveRequest("task:inv3"),
      repository: {
        owner: "bad owner!",
        name: "x",
        installationId: 1,
      } as never,
    });
    assert.equal(badRepo.status, "invalid");
    const badPurpose = await controller.reserveModelStart(
      reserveRequest("task:inv4", { purpose: "boss" as never }),
    );
    assert.equal(badPurpose.status, "invalid");

    // None of the rejected requests ever created or wrote the state branch.
    const absent = await storeAt(ctx, "b").readRepair();
    assert.ok(absent.ok && absent.value.status === "absent");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: null weekly cap uses only the rolling hour and preserves every charge", async () => {
  const ctx = await makeCtx("null-weekly");
  try {
    const clock = new FakeClock(T0);
    const store = storeAt(ctx, "a");
    const LIMITS = { perHour: 120, perSevenDays: null } as const;
    const configSet = [
      repositoryConfig(REPO, LIMITS),
      repositoryConfig(REPO_2, LIMITS),
    ];
    // 119 charges inside the rolling hour; 200 more inside the week but
    // outside the hour (more than the retired 168 weekly cap).
    const inHour = Array.from(
      { length: 119 },
      (_value, index) =>
        seededReservation(`in-hour-${String(index).padStart(3, "0")}`, {
          createdAt: T0 - 1_000,
        }),
    );
    const olderInWeek = Array.from(
      { length: 200 },
      (_value, index) =>
        seededReservation(`older-${String(index).padStart(3, "0")}`, {
          createdAt: T0 - 2 * HOUR_WINDOW_MS - index * 60_000,
        }),
    );
    const seeded = [...inHour, ...olderInWeek];
    const seed: RepairStateSnapshotV1 = {
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [],
      evidence: [],
      work: [],
      reservations: seeded,
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    };
    const written = await store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    const controller = budgetAt(clock, store, configSet);
    const admitted = await controller.reserveModelStart(
      reserveRequest("task:open120", { repository: REPO_2 }),
    );
    assert.ok(admitted.status === "admitted", JSON.stringify(admitted));

    // The durable state carries every historical charge byte-for-byte plus
    // the one appended admission.
    const read = await storeAt(ctx, "b").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      const persisted = read.value.snapshot.reservations;
      assert.equal(persisted.length, seeded.length + 1);
      const persistedById = new Map(
        persisted.map((entry) => [entry.id, entry] as const),
      );
      for (const entry of seeded) {
        const row = persistedById.get(entry.id);
        assert.ok(row, `missing persisted reservation ${entry.id}`);
        assert.equal(canonicalStringify(row), canonicalStringify(entry));
      }
      const admittedRow = persistedById.get(admitted.reservation.id);
      assert.ok(
        admittedRow,
        `missing admitted reservation ${admitted.reservation.id}`,
      );
      assert.equal(
        canonicalStringify(admittedRow),
        canonicalStringify(admitted.reservation),
      );
      assert.equal(
        admittedRow.repository.installationId,
        REPO_2.installationId,
      );
    }

    // The hour is full: the next start defers until the oldest relevant
    // in-hour charge exits, regardless of the older weekly history.
    const deferred = await controller.reserveModelStart(
      reserveRequest("task:open121"),
    );
    assert.equal(deferred.status, "deferred", JSON.stringify(deferred));
    if (deferred.status === "deferred") {
      assert.equal(deferred.reason, "cap_limit");
      assert.equal(deferred.retryAt, T0 - 1_000 + HOUR_WINDOW_MS);
    }
    clock.set(T0 - 1_000 + HOUR_WINDOW_MS);
    const afterExit = await controller.reserveModelStart(
      reserveRequest("task:open122"),
    );
    assert.equal(afterExit.status, "admitted", JSON.stringify(afterExit));
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: unrelated state collections survive; settlement is idempotent in real git", async () => {
  const ctx = await makeCtx("preserve");
  try {
    const store = storeAt(ctx, "a");
    const seed: RepairStateSnapshotV1 = {
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [incidentSummary("inc:1")],
      evidence: [],
      work: [workRecord("w:1")],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    };
    const seeded = await store.writeRepair(seed, null);
    assert.ok(seeded.ok && seeded.value.status === "applied");

    const clock = new FakeClock(T0 + 1_000);
    const controller = budgetAt(clock, store);
    const admitted = await controller.reserveModelStart(
      reserveRequest("task:preserve"),
    );
    assert.equal(admitted.status, "admitted", JSON.stringify(admitted));
    assert.ok(admitted.status === "admitted");
    if (admitted.status !== "admitted") throw new Error("unreachable");
    const id = admitted.reservation.id;

    const settled = await controller.settleModelStart({
      id,
      outcome: "submitted",
      proofRef: null,
    });
    assert.equal(settled.status, "settled", JSON.stringify(settled));
    const settledHead = settled.status === "settled" ? settled.stateHead : null;
    assert.ok(settledHead);

    // Equal repeated settlement: idempotent, no new commit, timestamp intact.
    const idempotent = await controller.settleModelStart({
      id,
      outcome: "submitted",
      proofRef: null,
    });
    assert.equal(idempotent.status, "idempotent");
    if (idempotent.status === "idempotent") {
      assert.equal(idempotent.stateHead, settledHead);
      assert.equal(idempotent.reservation.settledAt, T0 + 1_000);
      assert.equal(idempotent.reservation.createdAt, T0 + 1_000);
    }

    const read = await storeAt(ctx, "b").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.deepEqual(
        read.value.snapshot.work.map((w) => w.id),
        ["w:1"],
      );
      assert.deepEqual(
        read.value.snapshot.incidents.map((i) => i.id),
        ["inc:1"],
      );
      assert.equal(read.value.snapshot.reservations.length, 1);
      assert.equal(read.value.snapshot.reservations[0]?.outcome, "submitted");
      assert.equal(read.value.snapshot.reservations[0]?.settledAt, T0 + 1_000);
    }
  } finally {
    await ctx.cleanup();
  }
});
