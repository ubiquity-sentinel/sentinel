import assert from "node:assert/strict";
import {
  CalendarCiMinutes,
  createCiMinuteController,
  proposedCiMinutePolicy,
} from "../../src/budget/ci-minutes.ts";
import {
  ciJobMinutes,
  ciMinuteDigest,
  ciMonth,
  ciPolicyDigest,
  parseCiMinuteLedger,
} from "../../src/contracts/ci-minute-budget.ts";
import type {
  CiEffectV1,
  CiMinuteLedgerV1,
  CiMinuteObservationV1,
  CiMinuteStoreV1,
} from "../../src/contracts/ci-minute-budget.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { createPrivateCiObservationReader } from "../../ops/hosted-autonomy-github-jobs.ts";
import { makeRig, seededSnapshot } from "./loop-rig.ts";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import { executeBaseRefreshIntent } from "../../src/repair/loop-base-refresh.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import {
  exactOpenPr,
  H0,
  H1,
  positiveLifecycle,
  preservedIssueWork,
} from "./loop-candidate-fixtures.ts";
import { repairConfigs } from "./helpers.ts";
import { baseRefreshIntentKey } from "../../src/repair/keys.ts";
import { SHA3, T0 } from "../state/helpers.ts";

const SHA = "a".repeat(40);
const PROOF = "b".repeat(64);
const EPOCH = Date.UTC(2028, 0, 31, 23);
function effect(name = "first", head = SHA): CiEffectV1 {
  return {
    repository: { owner: "fixture", name, installationId: 1 },
    kind: "pr_open",
    head,
    base: "c".repeat(40),
    ref: "refs/heads/task",
    pr: 1,
  };
}

function fixture(limit = 40, now = EPOCH) {
  const policy = {
    ...proposedCiMinutePolicy(),
    activated: true,
    monthlyLimit: limit,
    managedLimit: limit,
    securityReserve: 0,
    unmanagedReserve: 0,
    storageAcceptance: PROOF,
    ceilingQualification: PROOF,
    targets: [{
      owner: "fixture",
      name: "first",
      repositoryId: 101,
      ceilingMinutes: 20,
    }, {
      owner: "fixture",
      name: "second",
      repositoryId: 102,
      ceilingMinutes: 30,
    }],
  };
  const clock = { now: () => now };
  let sequence = 1;
  let head = String(sequence).padStart(40, "0") as GitSha;
  const months = new Map<string, CiMinuteLedgerV1>();
  const initial: CiMinuteLedgerV1 = {
    version: 1,
    month: ciMonth(now).month,
    policyDigest: ciPolicyDigest(policy),
    updatedAt: now,
    sequence: 1,
    baselineMinutes: 0,
    watermark: now,
    reservations: [],
    observed: [],
  };
  months.set(initial.month, initial);
  const store: CiMinuteStoreV1 = {
    read(month) {
      return Promise.resolve(
        portOk({ head, ledger: structuredClone(months.get(month) ?? null) }),
      );
    },
    write(input) {
      if (input.expectedHead !== head) {
        return Promise.resolve(portOk({ status: "conflict" as const, head }));
      }
      months.set(input.ledger.month, structuredClone(input.ledger));
      head = String(++sequence).padStart(40, "0") as GitSha;
      return Promise.resolve(portOk({ status: "applied" as const, head }));
    },
  };
  let state: "not_applied" | "applied" | "unknown" = "not_applied";
  let complete = true;
  let authorized = true;
  let jobs: CiMinuteObservationV1["jobs"] = [];
  const controller = new CalendarCiMinutes({
    policy,
    clock,
    store,
    authorizePolicy: () => Promise.resolve(authorized),
    resolve(e) {
      return Promise.resolve({
        repositoryId: e.repository.name === "first" ? 101 : 102,
        workflowBlob: SHA,
        job: "validation",
        jobs: 1,
        runner: "ubuntu-latest",
        timeoutMinutes: 20,
        ceilingMinutes: e.repository.name === "first" ? 20 : 30,
        qualificationDigest: PROOF,
        triggered: true,
        effectState: state,
      });
    },
    observe(month) {
      return Promise.resolve({ month, complete, watermark: now, jobs });
    },
  });
  return {
    policy,
    clock,
    store,
    months,
    controller,
    now(value: number) {
      now = value;
    },
    state(value: typeof state) {
      state = value;
    },
    complete(value: boolean) {
      complete = value;
    },
    authorized(value: boolean) {
      authorized = value;
    },
    jobs(value: typeof jobs) {
      jobs = value;
    },
    ledger() {
      return months.get(ciMonth(now).month)!;
    },
    reserve(e = effect()) {
      return controller.reserve(e, now + 60_000);
    },
  };
}

Deno.test("CI inactive capability performs no clock, state, resolver or CI work", async () => {
  let touched = 0;
  const fail = () => {
    touched++;
    throw new Error("inactive path touched authority");
  };
  const off = createCiMinuteController({
    policy: proposedCiMinutePolicy(),
    clock: { now: fail },
    store: { read: fail, write: fail },
    authorizePolicy: fail,
    resolve: fail,
    observe: fail,
  });
  assert.equal(off.active, false);
  assert.deepEqual(await off.reserve(effect(), 1), { kind: "inactive" });
  assert.equal(touched, 0);
});

Deno.test("CI shared CAS admits one of two targets competing for the final allowance", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.reserve(effect()),
    f.reserve(effect("second")),
  ]);
  assert.equal(results.filter((r) => r.kind === "admitted").length, 1);
  assert.equal(results.filter((r) => r.kind === "held").length, 1);
  assert.equal(f.ledger().reservations.length, 1);
  assert.ok(f.ledger().reservations[0].chargedMinutes >= 20);
});

Deno.test("CI replay reuses one charge; an unknown submission never grants another effect", async () => {
  const f = fixture();
  assert.equal((await f.reserve()).kind, "admitted");
  assert.equal((await f.reserve()).kind, "admitted");
  assert.equal(f.ledger().reservations.length, 1);
  f.state("unknown");
  assert.equal((await f.reserve()).kind, "unavailable");
  assert.equal(f.ledger().reservations[0].chargedMinutes, 20);
  f.state("applied");
  assert.equal((await f.reserve()).kind, "reconciled");
  assert.equal(f.ledger().reservations.length, 1);
});

Deno.test("CI changed heads and rerun attempts have distinct durable identities", async () => {
  const f = fixture(200);
  for (
    const e of [effect(), effect("first", "d".repeat(40)), {
      ...effect(),
      kind: "rerun" as const,
      runId: 10,
      attempt: 2,
    }, { ...effect(), kind: "rerun" as const, runId: 10, attempt: 3 }]
  ) {
    assert.equal((await f.reserve(e)).kind, "admitted");
  }
  assert.equal(
    new Set(f.ledger().reservations.map((r) => r.effectDigest)).size,
    4,
  );
});

Deno.test("CI calendar pacing returns an earning deadline without a new reservation", async () => {
  const now = Date.UTC(2028, 1, 1);
  const f = fixture(100, now);
  const result = await f.reserve();
  assert.equal(result.kind, "held");
  if (result.kind !== "held") return;
  assert.equal(result.reason, "calendar_allowance");
  assert.equal(result.retryAt, now + Math.ceil(29 * 86_400_000 * 20 / 100));
  assert.equal(f.ledger().reservations.length, 0);
  f.now(result.retryAt);
  assert.equal((await f.reserve()).kind, "admitted");
});

Deno.test("CI incomplete evidence and clock regression grant nothing", async () => {
  const f = fixture();
  f.complete(false);
  assert.equal((await f.reserve()).kind, "unavailable");
  f.complete(true);
  f.now(EPOCH - 1);
  const r = await f.reserve();
  assert.equal(r.kind, "held");
  assert.equal(f.ledger().reservations.length, 0);
});

Deno.test("CI authenticated terminal timing settles conservatively rounded actual cost", async () => {
  const f = fixture(100);
  const reserved = await f.reserve();
  assert.equal(reserved.kind, "admitted");
  if (reserved.kind !== "admitted") return;
  f.jobs([{
    digest: PROOF,
    effectDigest: reserved.reservationDigest,
    startedAt: EPOCH - 61_000,
    billedDurationMs: 61_000,
    completedAt: EPOCH,
    neverStarted: false,
    terminal: true,
  }]);
  await f.reserve(effect("first", "d".repeat(40)));
  assert.equal(f.ledger().reservations[0].state, "settled");
  assert.equal(f.ledger().reservations[0].chargedMinutes, 2);
  assert.equal(f.ledger().observed.length, 1);
});

Deno.test("CI zero/59/60/61-second started jobs round independently; no-start is not green evidence", () => {
  for (const [seconds, expected] of [[59, 1], [60, 1], [61, 2]]) {
    assert.equal(
      ciJobMinutes({
        digest: PROOF,
        effectDigest: null,
        startedAt: EPOCH,
        completedAt: EPOCH + seconds * 1000,
        billedDurationMs: seconds * 1000,
        terminal: true,
        neverStarted: false,
      }),
      expected,
    );
  }
  assert.equal(
    ciJobMinutes({
      digest: PROOF,
      effectDigest: null,
      startedAt: null,
      completedAt: null,
      terminal: true,
      neverStarted: true,
      billedDurationMs: 0,
    }),
    0,
  );
  assert.throws(() =>
    ciJobMinutes({
      digest: PROOF,
      effectDigest: null,
      startedAt: null,
      completedAt: null,
      terminal: false,
      neverStarted: true,
      billedDurationMs: 0,
    })
  );
});

Deno.test("CI month rollover carries an unconfirmed reservation instead of forgiving it", async () => {
  const f = fixture(100);
  assert.equal((await f.reserve()).kind, "admitted");
  f.now(Date.UTC(2028, 1, 29, 23));
  assert.equal(
    (await f.reserve(effect("first", "d".repeat(40)))).kind,
    "admitted",
  );
  assert.equal(f.ledger().reservations.length, 2);
  assert.equal(f.ledger().reservations[0].chargedMinutes, 20);
  assert.equal(f.months.get("2028-01")!.reservations.length, 1);
});

Deno.test("CI exhausted imported allowance and unrelated observed jobs constrain publication", async () => {
  const f = fixture(100);
  f.ledger().baselineMinutes = 100;
  const r = await f.reserve();
  assert.equal(r.kind, "held");
  assert.equal(f.ledger().reservations.length, 0);
  const g = fixture(40);
  g.jobs([{
    digest: PROOF,
    effectDigest: null,
    startedAt: EPOCH - 21 * 60_000,
    billedDurationMs: 21 * 60_000,
    completedAt: EPOCH,
    terminal: true,
    neverStarted: false,
  }]);
  assert.equal((await g.reserve()).kind, "held");
});

Deno.test("CI public ledger refuses raw source or activity identity fields", () => {
  const f = fixture();
  assert.throws(() =>
    parseCiMinuteLedger({ ...f.ledger(), source: "private repository" })
  );
  assert.ok(/^[0-9a-f]{64}$/.test(ciMinuteDigest(effect())));
  assert.equal(JSON.stringify(f.ledger()).includes("fixture"), false);
});

Deno.test("CI reference syntax grants no policy authority and an exceeded ceiling stops new effects", async () => {
  const f = fixture(100);
  f.authorized(false);
  assert.equal((await f.reserve()).kind, "unavailable");
  assert.equal(f.ledger().reservations.length, 0);
  f.authorized(true);
  const r = await f.reserve();
  assert.equal(r.kind, "admitted");
  if (r.kind !== "admitted") return;
  f.jobs([{
    digest: PROOF,
    effectDigest: r.reservationDigest,
    startedAt: EPOCH - 21 * 60_000,
    billedDurationMs: 21 * 60_000,
    completedAt: EPOCH,
    neverStarted: false,
    terminal: true,
  }]);
  assert.deepEqual(await f.reserve(effect("first", "d".repeat(40))), {
    kind: "unavailable",
    reason: "qualified_ceiling_exceeded",
  });
  assert.equal(f.ledger().reservations[0].chargedMinutes, 21);
  assert.equal(f.ledger().reservations.length, 1);
});

Deno.test("CI production consumer: held publication preserves candidate, then full CI/review/merge lifecycle resumes", async () => {
  let allow = false;
  const effects: CiEffectV1[] = [];
  const rig: Awaited<ReturnType<typeof makeRig>> = await makeRig(
    "ci-minute-lifecycle",
    {
      fixtureDirectory: ".data/ci-minute-tests",
      github: {
        nativeQueue: inactiveNativeQueueFixture(),
        candidateLifecycle: positiveLifecycle(),
      },
      ciMinutes: {
        active: true,
        reserve(e) {
          effects.push(e);
          return Promise.resolve(
            allow ? { kind: "admitted", reservationDigest: "f".repeat(64) } : {
              kind: "held",
              retryAt: rig.clock.now() + 120_000,
              reason: "calendar_allowance",
            },
          );
        },
      },
    },
  );
  try {
    await rig.run();
    const before = await rig.snapshot();
    const held = before.work.find((r) =>
      r.wait?.reason === "backoff" && r.target.head !== null
    );
    assert.ok(held, "produced candidate retained behind CI calendar hold");
    assert.ok(
      effects.length > 0,
      "CI capability, rather than native queue custody, caused this hold",
    );
    assert.notEqual(held.wait?.until, null);
    assert.equal(rig.github.pushes.length, 0);
    assert.equal(rig.github.calls.includes("merge"), false);
    const head = held.target.head, modelStarts = rig.model.requests.length;
    allow = true;
    rig.clock.advance(120_001);
    const diagnostics: unknown[] = [];
    for (let i = 0; i < 4 && !rig.github.calls.includes("merge"); i++) {
      const outcome = await rig.run();
      diagnostics.push({
        outcome,
        work: (await rig.snapshot()).work.map((r) => ({
          head: r.target.head,
          pr: r.target.pr,
          intent: r.intent,
          wait: r.wait,
          blocker: r.blocker,
          nextStep: r.nextStep,
        })),
        calls: rig.github.calls.slice(-10),
      });
      rig.github.completeReview([], rig.clock.now());
      rig.clock.advance(15 * 60_000 + 1);
    }
    assert.equal(
      rig.github.calls.includes("merge"),
      true,
      JSON.stringify({ diagnostics, effects }),
    );
    assert.equal(
      rig.model.requests.length,
      modelStarts,
      "held candidate is reused, not regenerated",
    );
    assert.ok(effects.some((e) => e.kind === "head_push" && e.head === head));
    assert.ok(effects.some((e) => e.kind === "pr_open"));
    assert.ok(effects.some((e) => e.kind === "merge"));
    const after = await rig.snapshot();
    const resumed = after.work.find((r) => r.id === held.id);
    assert.ok(resumed);
    assert.equal(resumed.target.head, head);
    assert.equal(resumed.counters.attempts, held.counters.attempts);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI base refresh hold: first pass and replay preserve intent, since and every counter", async () => {
  const record = preservedIssueWork("ci-refresh-fixture", H0);
  record.intent = {
    kind: "base_refresh",
    key: baseRefreshIntentKey(7, H0, SHA3),
    startedAt: T0,
    branch: record.target.branch,
    expectedHead: H0,
    observedBase: SHA3,
    pr: 7,
    requestId: null,
    resultId: null,
  };
  const originalIntent = structuredClone(record.intent),
    originalCounters = structuredClone(record.counters);
  const ciMinutes = {
    active: true,
    reserve: () =>
      Promise.resolve({
        kind: "held" as const,
        retryAt: T0 + 120_000,
        reason: "calendar_allowance",
      }),
  };
  const rig = await makeRig("ci-refresh-hold", {
    summaries: false,
    fixtureDirectory: ".data/ci-minute-tests",
    ciMinutes,
    github: {
      baseSha: SHA3,
      nativeQueue: inactiveNativeQueueFixture(),
      candidateLifecycle: {
        refs: { ["refs/heads/" + record.target.branch]: H0 },
        pullRequests: [exactOpenPr(7, H0, record.target.branch!)],
        prepareBaseRefresh: () => Promise.resolve(portOk(H1)),
        preserveCandidate: () => {
          throw new Error("held refresh must not preserve/push");
        },
      },
    },
  });
  try {
    const seeded = await rig.store.writeRepair(seededSnapshot([record]), null);
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const loaded = await rig.store.readRepair();
    assert.ok(loaded.ok && loaded.value.status === "found");
    const context: LoopContextV1 = {
      snapshot: loaded.value.snapshot,
      head: loaded.value.head,
      bounds: { runDeadline: T0 + 3_600_000, modelCutoff: T0 + 3_000_000 },
      executionBaseline: null,
    };
    const deps: RepairCycleDepsV1 = {
      clock: rig.clock,
      state: rig.store,
      configs: repairConfigs(),
      controllerSha: SHA3,
      github: rig.github,
      githubCooldown: rig.githubCooldown,
      incidents: rig.incidents,
      replay: rig.replay,
      model: rig.model,
      budget: {
        reserveModelStart() {
          throw new Error("no model start");
        },
        settleModelStart() {
          throw new Error("no model settle");
        },
      },
      ciMinutes,
      recordWaitCauses: true,
    };
    const first = await executeBaseRefreshIntent(
      deps,
      context,
      context.snapshot.work[0],
    );
    assert.equal(first.kind, "progress");
    const held = context.snapshot.work[0];
    assert.deepEqual(held.intent, originalIntent);
    assert.deepEqual(held.counters, originalCounters);
    assert.equal(held.wait?.cause?.code, "minute_budget");
    const since = held.wait?.since;
    rig.clock.advance(1_000);
    const second = await executeBaseRefreshIntent(deps, context, held);
    assert.equal(second.kind, "deferred");
    assert.deepEqual(context.snapshot.work[0].intent, originalIntent);
    assert.deepEqual(context.snapshot.work[0].counters, originalCounters);
    assert.equal(context.snapshot.work[0].wait?.since, since);
    assert.equal(rig.github.pushes.length, 0);
    assert.equal(rig.github.preservationRequests.length, 0);
    assert.equal(rig.model.requests.length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI private CAS: cursor and metered proof slices survive fresh coordinator instances", async () => {
  const now = Date.UTC(2028, 0, 5);
  const f = fixture(200, now);
  f.ledger().watermark = null;
  const request = async (path: string) => {
    await Promise.resolve(); // Model the asynchronous authenticated transport.
    const first = path.includes("/fixture/first/");
    if (path.includes("actions/runs?")) {
      return {
        total_count: first ? 9 : 0,
        workflow_runs: first
          ? Array.from(
            { length: 9 },
            (_, i) => ({
              id: i + 1,
              repository: { id: 101 },
              head_sha: SHA,
              run_attempt: 1,
              status: "completed",
              created_at: new Date(now - 60000).toISOString(),
            }),
          )
          : [],
      };
    }
    const id = Number(/runs\/(\d+)\//.exec(path)![1]);
    if (path.endsWith("/timing")) {
      return {
        run_duration_ms: 5000,
        billable: {
          UBUNTU: {
            jobs: 1,
            total_ms: 60000,
            job_runs: [{ job_id: id, duration_ms: 60000 }],
          },
        },
      };
    }
    return {
      total_count: 1,
      jobs: [{
        id,
        run_id: id,
        run_attempt: 1,
        head_sha: SHA,
        status: "completed",
        conclusion: "success",
        runner_id: 1,
        labels: ["ubuntu-latest"],
        steps: [{ number: 1, status: "completed" }],
        started_at: new Date(now - 5000).toISOString(),
        completed_at: new Date(now).toISOString(),
      }],
    };
  };
  let admitted = false;
  for (let turn = 0; turn < 8; turn++) {
    const observer = createPrivateCiObservationReader({
      policy: f.policy,
      request,
      now: f.clock.now,
    });
    const fresh = new CalendarCiMinutes({
      policy: f.policy,
      clock: f.clock,
      store: f.store,
      authorizePolicy: () => Promise.resolve(true),
      resolve: () =>
        Promise.resolve({
          repositoryId: 101,
          workflowBlob: SHA,
          job: "validation",
          jobs: 1,
          runner: "ubuntu-latest",
          timeoutMinutes: 20,
          ceilingMinutes: 20,
          qualificationDigest: PROOF,
          triggered: true,
          effectState: "not_applied",
        }),
      observe: observer,
    });
    const result = await fresh.reserve(effect(), now + 60000);
    if (result.kind === "admitted") {
      admitted = true;
      break;
    }
    assert.equal(result.kind, "held");
    assert.equal(f.ledger().watermark, null);
    assert.equal(f.ledger().reservations.length, 0);
    assert.ok(f.ledger().progress);
  }
  assert.equal(admitted, true);
  assert.equal(f.ledger().proofs?.length, 9);
  assert.equal(f.ledger().observed.reduce((n, r) => n + r.minutes, 0), 9);
  assert.equal(f.ledger().watermark, now);
  assert.equal(f.ledger().progress, null);
});

Deno.test("CI meter unknown: timestamps cannot replace unavailable provider durations", () => {
  assert.throws(() =>
    ciJobMinutes({
      digest: PROOF,
      effectDigest: null,
      startedAt: EPOCH,
      completedAt: EPOCH + 60000,
      neverStarted: false,
      terminal: true,
      billedDurationMs: null,
    })
  );
});

Deno.test("CI actual debt: a later authoritative metered overrun is retained and stops admission", async () => {
  const f = fixture(100);
  const first = await f.reserve();
  assert.equal(first.kind, "admitted");
  if (first.kind !== "admitted") return;
  const proof = {
    digest: PROOF,
    effectDigest: first.reservationDigest,
    startedAt: EPOCH - 1000,
    completedAt: EPOCH,
    neverStarted: false,
    terminal: true,
    billedDurationMs: 60000,
  };
  f.jobs([proof]);
  await f.reserve(effect("first", "d".repeat(40)));
  f.jobs([{ ...proof, billedDurationMs: 21 * 60000 }]);
  const result = await f.reserve(effect("first", "e".repeat(40)));
  assert.equal(result.kind, "unavailable");
  assert.equal(f.ledger().reservations[0].chargedMinutes, 21);
  assert.equal(
    f.ledger().proofs?.find((p) => p.digest === PROOF)?.billedDurationMs,
    21 * 60000,
  );
});

Deno.test("CI period unknown: cross-cycle proof retains full reservation and carry", async () => {
  const f = fixture(100);
  const first = await f.reserve();
  assert.equal(first.kind, "admitted");
  if (first.kind !== "admitted") return;
  f.jobs([{
    digest: PROOF,
    effectDigest: first.reservationDigest,
    startedAt: Date.UTC(2027, 11, 31, 23, 59),
    completedAt: Date.UTC(2028, 0, 1, 0, 1),
    neverStarted: false,
    terminal: true,
    billedDurationMs: 60000,
  }]);
  await f.reserve(effect("first", "d".repeat(40)));
  assert.equal(f.ledger().reservations[0].chargedMinutes, 20);
  assert.equal(f.ledger().reservations[0].state, "reserved");
  f.now(Date.UTC(2028, 1, 29, 23));
  f.jobs([]);
  await f.reserve(effect("first", "e".repeat(40)));
  assert.equal(f.ledger().reservations[0].chargedMinutes, 20);
  assert.equal(f.ledger().reservations[0].state, "reserved");
});

Deno.test("CI bogus started-zero meter: retain full reservation despite successful elapsed execution", async () => {
  const f = fixture(100);
  const r = await f.reserve();
  assert.equal(r.kind, "admitted");
  if (r.kind !== "admitted") return;
  f.jobs([{
    digest: PROOF,
    effectDigest: r.reservationDigest,
    startedAt: EPOCH - 497000,
    completedAt: EPOCH,
    terminal: true,
    neverStarted: false,
    billedDurationMs: 0,
  }]);
  const result = await f.reserve(effect("first", "d".repeat(40)));
  assert.equal(result.kind, "unavailable");
  assert.equal(f.ledger().reservations[0].chargedMinutes, 20);
  assert.equal(f.ledger().reservations[0].state, "reserved");
  assert.equal(f.ledger().reservations.length, 1);
});
