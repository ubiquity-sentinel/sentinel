import assert from "node:assert/strict";
import {
  CalendarCiMinutes,
  createCiMinuteController,
  proposedCiMinutePolicy,
  verifyCiMinuteSchedulingBasis,
} from "../../src/budget/ci-minutes.ts";
import {
  acceptedCiMinutePolicy,
  ciJobMinutes,
  ciMinuteDigest,
  ciMonth,
  ciPolicyDigest,
  ciTerminalEstimateDigest,
  parseCiMinuteLedger,
  validateCiMinuteTransition,
} from "../../src/contracts/ci-minute-budget.ts";
import type {
  CiEffectFactsV1,
  CiEffectV1,
  CiMinuteJobProofV1,
  CiMinuteLedgerV1,
  CiMinuteObservationV1,
  CiMinuteObserverV1,
  CiMinutePolicyV1,
  CiMinuteStoreV1,
} from "../../src/contracts/ci-minute-budget.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { makeRig, seededSnapshot } from "./loop-rig.ts";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import { executeBaseRefreshIntent } from "../../src/repair/loop-base-refresh.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { guardCiMinuteEffect } from "../../src/repair/loop-types.ts";
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
import { createCiMinuteReconciler } from "../../ops/ci-minute-reconciliation.ts";

const SHA = "a".repeat(40);
const PROOF = "b".repeat(64);
const EPOCH = Date.UTC(2028, 0, 31, 23);
function estimatedJob(job: CiMinuteJobProofV1): CiMinuteJobProofV1 {
  assert.ok(job.estimate);
  return {
    ...job,
    estimate: {
      ...job.estimate,
      terminalProofDigest: ciTerminalEstimateDigest(job),
    },
  };
}
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

Deno.test("CI round3 new publication executions exclude closed candidates without reassigning known proofs or guessing ambiguous matches", async () => {
  let now = EPOCH;
  const policy = {
    ...proposedCiMinutePolicy(),
    activated: true,
    storageAcceptance: PROOF,
    ceilingQualification: PROOF,
    targets: [{
      owner: "fixture",
      name: "project",
      repositoryId: 101,
      ceilingMinutes: 25,
    }],
  };
  const makeEffect = (publicationAfter?: number): CiEffectV1 => ({
    repository: { owner: "fixture", name: "project", installationId: 1 },
    kind: "pr_open",
    head: SHA,
    base: "b".repeat(40),
    ref: "refs/heads/task",
    pr: null,
    ...(publicationAfter === undefined ? {} : { publicationAfter }),
  });
  const id = (e: CiEffectV1) =>
    ciMinuteDigest({
      domain: "sentinel-ci-effect-v1",
      effect: e,
      workflowBlob: SHA,
      job: "validation",
      repositoryId: 101,
    });
  const first = makeEffect(), replacement = makeEffect(7);
  const old: CiMinuteJobProofV1 = {
    digest: ciMinuteDigest({
      repositoryId: 101,
      runId: 1,
      attempt: 1,
      jobId: 11,
    }),
    identity: { repositoryId: 101, runId: 1, attempt: 1, jobId: 11 },
    effectDigest: id(first),
    startedAt: EPOCH - 110000,
    completedAt: EPOCH - 60000,
    terminal: true,
    neverStarted: false,
    billedDurationMs: 0,
    conclusion: "success",
    estimate: {
      kind: "retained_estimate",
      minutes: 25,
      executionMonth: ciMonth(EPOCH).month,
      terminalProofDigest: "",
    },
  };
  old.estimate!.terminalProofDigest = ciTerminalEstimateDigest(old);
  const reservation = (e: CiEffectV1, createdAt: number) => ({
    effectDigest: id(e),
    policyDigest: ciPolicyDigest(policy),
    ceilingMinutes: 25,
    state: "reserved" as const,
    createdAt,
    settledAt: null,
    chargedMinutes: 25,
    proofDigest: null,
    binding: {
      effect: e,
      repositoryId: 101,
      workflowBlob: SHA,
      job: "validation",
    },
  });
  let ledger: CiMinuteLedgerV1 = {
    version: 1,
    month: ciMonth(now).month,
    policyDigest: ciPolicyDigest(policy),
    updatedAt: now,
    sequence: 1,
    baselineMinutes: 0,
    watermark: null,
    reservations: [{
      ...reservation(first, EPOCH - 121000),
      state: "terminal_estimated",
      settledAt: EPOCH - 60000,
      proofDigest: old.estimate!.terminalProofDigest,
      accounting: {
        kind: "retained_estimate",
        executionMonth: ciMonth(EPOCH).month,
        terminalProofDigest: old.estimate!.terminalProofDigest,
        startedAt: old.startedAt,
        completedAt: old.completedAt,
      },
    }, reservation(replacement, EPOCH - 1000)],
    proofs: [old],
    observed: [{ digest: old.digest, effectDigest: id(first), minutes: 25 }],
  };
  let head = "1".repeat(40) as GitSha, sequence = 1;
  const store: CiMinuteStoreV1 = {
    read: () =>
      Promise.resolve(portOk({ head, ledger: structuredClone(ledger) })),
    readPrior: () => Promise.resolve(portOk({ head, ledger: null })),
    write(input) {
      assert.equal(input.expectedHead, head);
      const next = parseCiMinuteLedger(input.ledger);
      validateCiMinuteTransition(ledger, next);
      ledger = next;
      head = String(++sequence).padStart(40, "0") as GitSha;
      return Promise.resolve(portOk({ status: "applied" as const, head }));
    },
  };
  const rows = [1, 2].map((runId) => ({
    id: runId,
    repository: { id: 101 },
    head_sha: SHA,
    run_attempt: 1,
    status: "completed",
    created_at: new Date(EPOCH - (runId === 1 ? 120000 : 500)).toISOString(),
    updated_at: new Date(EPOCH).toISOString(),
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_branch: "task",
  }));
  const request = (path: string): Promise<unknown | null> => {
    if (path.includes("/actions/runs?")) {
      const url = new URL("https://fixture.invalid" + path);
      const [from, through] = url.searchParams.get("created")!.split("..").map(
        Date.parse,
      );
      const found = rows.filter((row) =>
        Date.parse(row.created_at) >= from &&
        Date.parse(row.created_at) <= through
      );
      return Promise.resolve({
        total_count: found.length,
        workflow_runs: found,
      });
    }
    const runId = Number(/\/runs\/(\d+)/.exec(path)?.[1]),
      row = rows.find((r) => r.id === runId);
    if (!row) return Promise.resolve(null);
    if (path.endsWith("/timing")) {
      return Promise.resolve({
        billable: {
          UBUNTU: {
            jobs: 1,
            total_ms: 0,
            job_runs: [{ job_id: runId * 10 + 1, duration_ms: 0 }],
          },
        },
      });
    }
    if (path.includes("/jobs?")) {
      return Promise.resolve({
        total_count: 1,
        jobs: [{
          id: runId * 10 + 1,
          run_id: runId,
          run_attempt: 1,
          head_sha: SHA,
          status: "completed",
          conclusion: "success",
          runner_id: 1,
          labels: ["ubuntu-latest"],
          steps: [{ number: 1, status: "completed" }],
          started_at: new Date(runId === 1 ? EPOCH - 110000 : now - 400)
            .toISOString(),
          completed_at: new Date(runId === 1 ? EPOCH - 60000 : now)
            .toISOString(),
        }],
      });
    }
    return Promise.resolve(row);
  };
  const controller = () =>
    new CalendarCiMinutes({
      policy,
      clock: { now: () => now },
      store,
      authorizePolicy: () => Promise.resolve(true),
      resolve: () => Promise.resolve(null),
      observe: createCiMinuteReconciler({
        policy,
        clock: { now: () => now },
        request,
      }),
    });
  assert.equal((await controller().reconcile(now + 60000)).kind, "ready");
  assert.equal(ledger.reservations[0].effectDigest, id(first));
  assert.equal(ledger.reservations[0].chargedMinutes, 25);
  assert.equal(
    ledger.proofs?.find((proof) => proof.identity?.runId === 1)?.effectDigest,
    id(first),
  );
  assert.equal(
    ledger.proofs?.find((proof) => proof.identity?.runId === 2)?.effectDigest,
    id(replacement),
  );
  assert.equal(ledger.reservations[1].state, "terminal_estimated");
  now += 2000;
  ledger.reservations.push(
    reservation(makeEffect(8), now),
    reservation(makeEffect(9), now),
  );
  rows.push({
    ...rows[1],
    id: 3,
    created_at: new Date(now + 100).toISOString(),
    updated_at: new Date(now + 100).toISOString(),
  });
  now += 1000;
  assert.equal((await controller().reconcile(now + 60000)).kind, "ready");
  assert.equal(
    ledger.proofs?.find((proof) => proof.identity?.runId === 1)?.effectDigest,
    id(first),
  );
  assert.equal(
    ledger.proofs?.find((proof) => proof.identity?.runId === 2)?.effectDigest,
    id(replacement),
  );
  assert.equal(
    ledger.proofs?.find((proof) => proof.identity?.runId === 3)?.effectDigest,
    null,
  );
  assert.deepEqual(
    ledger.reservations.slice(2).map((row) => [row.state, row.chargedMinutes]),
    [["reserved", 25], ["reserved", 25]],
  );
});

function fixture(limit = 40, now = EPOCH, sourcePolicy?: CiMinutePolicyV1) {
  const policy = sourcePolicy ?? {
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
    readPrior(month) {
      const prior = [...months.keys()].filter((key) => key < month).sort().at(
        -1,
      );
      return Promise.resolve(
        portOk({
          head,
          ledger: prior === undefined
            ? null
            : structuredClone(months.get(prior)!),
        }),
      );
    },
    write(input) {
      if (input.expectedHead !== head) {
        return Promise.resolve(portOk({ status: "conflict" as const, head }));
      }
      const parsed = parseCiMinuteLedger(input.ledger);
      const prior = months.get(parsed.month);
      if (prior !== undefined) validateCiMinuteTransition(prior, parsed);
      months.set(parsed.month, parsed);
      head = String(++sequence).padStart(40, "0") as GitSha;
      return Promise.resolve(portOk({ status: "applied" as const, head }));
    },
  };
  let state: "not_applied" | "applied" | "unknown" = "not_applied";
  let complete = true;
  let authorized = true;
  let jobs: CiMinuteObservationV1["jobs"] = [];
  let changedFacts: Partial<CiEffectFactsV1> = {};
  let observer: CiMinuteObserverV1 = (month) =>
    Promise.resolve({ month, complete, watermark: now, jobs });
  const controller = new CalendarCiMinutes({
    policy,
    clock,
    store,
    authorizePolicy: (basis, deadline, facts) =>
      authorized
        ? sourcePolicy === undefined
          ? Promise.resolve(true)
          : verifyCiMinuteSchedulingBasis(basis, deadline, facts)
        : Promise.resolve(false),
    resolve(e) {
      const target = policy.targets.find((row) =>
        row.name === e.repository.name
      )!;
      const profile = sourcePolicy === undefined
        ? undefined
        : acceptedCiMinutePolicy().targets.find((row) =>
          row.repositoryId === target.repositoryId
        );
      return Promise.resolve({
        repositoryId: target.repositoryId,
        workflowBlob: profile?.workflowBlob ?? SHA,
        job: profile?.job ?? "validation",
        jobs: 1,
        runner: "ubuntu-latest",
        timeoutMinutes: profile?.timeoutMinutes ?? 20,
        ceilingMinutes: target.ceilingMinutes,
        qualificationDigest: policy.ceilingQualification!,
        triggered: true,
        effectState: state,
        ...changedFacts,
      });
    },
    observe: (...args) => observer(...args),
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
    facts(value: typeof changedFacts) {
      changedFacts = value;
    },
    observe(value: CiMinuteObserverV1) {
      observer = value;
    },
    ledger() {
      return months.get(ciMonth(now).month)!;
    },
    reserve(
      e = sourcePolicy === undefined ? effect() : {
        ...effect(),
        repository: {
          owner: "ubiquity",
          name: "prospector",
          installationId: 1,
        },
      },
    ) {
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
    store: { read: fail, readPrior: fail, write: fail },
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

Deno.test("CI authenticated positive timing retains the conservative estimate", async () => {
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
  assert.equal(f.ledger().reservations[0].state, "terminal_estimated");
  assert.equal(f.ledger().reservations[0].chargedMinutes, 20);
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

Deno.test("CI private CAS: normalized proof slices survive fresh coordinator instances", async () => {
  const now = Date.UTC(2028, 0, 5);
  const f = fixture(200, now);
  f.ledger().watermark = null;
  const observer: CiMinuteObserverV1 = (month, _deadline, ledger) => {
    const offset = ledger.proofs?.length ?? 0;
    const jobs = Array.from(
      { length: Math.min(3, 9 - offset) },
      (_, index) => ({
        digest: ciMinuteDigest({ job: offset + index }),
        effectDigest: null,
        startedAt: now - 5000,
        completedAt: now,
        neverStarted: false,
        terminal: true,
        billedDurationMs: 60000,
      }),
    );
    const complete = offset + jobs.length === 9;
    return Promise.resolve({
      month,
      complete,
      watermark: now,
      jobs,
      progress: complete ? null : {
        month,
        through: now,
        windowFrom: ciMonth(now).start,
        windowThrough: now,
        targetIndex: 0,
        cursor: null,
        jobs: [],
        completedAttempts: [],
      },
    });
  };
  for (let turn = 0; turn < 3; turn++) {
    const fresh = new CalendarCiMinutes({
      policy: f.policy,
      clock: f.clock,
      store: f.store,
      authorizePolicy: () => Promise.resolve(true),
      resolve: () => Promise.resolve(null),
      observe: observer,
    });
    const result = await fresh.reconcile(now + 60000);
    assert.equal(result.kind, turn === 2 ? "ready" : "pending");
    assert.equal(f.ledger().reservations.length, 0);
    assert.equal(f.ledger().proofs?.length, (turn + 1) * 3);
    if (turn < 2) assert.equal(f.ledger().watermark, null);
  }
  assert.equal(
    f.ledger().observed.reduce((sum, row) => sum + row.minutes, 0),
    9,
  );
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

function managedEffect(name = "prospector", head = SHA): CiEffectV1 {
  return {
    ...effect(name, head),
    repository: { owner: "ubiquity", name, installationId: 1 },
  };
}

Deno.test("CI acceptance reconciled base refresh can finish native state while other effects and expired deadlines remain closed", async () => {
  const rig = await makeRig("synthetic-reconciled-guard", {
    fixtureDirectory: ".data/ci-minute-tests",
  });
  const record = preservedIssueWork("synthetic-reconciled-guard", H0);
  const fail = () => {
    throw new Error("native reconciliation must not start a model");
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
    budget: { reserveModelStart: fail, settleModelStart: fail },
    ciMinutes: {
      active: true,
      reserve: () =>
        Promise.resolve({
          kind: "reconciled",
          reservationDigest: "a".repeat(64),
        }),
    },
  };
  const context: LoopContextV1 = {
    snapshot: seededSnapshot([record]),
    head: null,
    bounds: {
      runDeadline: rig.clock.now() + 1000,
      modelCutoff: rig.clock.now() + 1000,
    },
    executionBaseline: null,
  };
  try {
    assert.equal(
      await guardCiMinuteEffect(deps, context, record, "base_refresh"),
      null,
    );
    assert.equal(
      (await guardCiMinuteEffect(deps, context, record, "head_push"))?.kind,
      "deferred",
    );
    rig.clock.advance(1000);
    assert.equal(
      (await guardCiMinuteEffect(deps, context, record, "base_refresh"))?.kind,
      "margin",
    );
    assert.equal(rig.github.pushes.length, 0);
    assert.equal(rig.model.requests.length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI pacing accepted source basis binds every exact authenticated profile field", async () => {
  const policy = acceptedCiMinutePolicy();
  assert.equal(
    await verifyCiMinuteSchedulingBasis(policy, EPOCH + 60000),
    true,
  );
  for (const target of policy.targets) {
    const facts: CiEffectFactsV1 = {
      repositoryId: target.repositoryId,
      workflowBlob: target.workflowBlob,
      job: target.job,
      jobs: 1,
      runner: target.runner,
      timeoutMinutes: target.timeoutMinutes,
      ceilingMinutes: target.ceilingMinutes,
      qualificationDigest: policy.ceilingQualification!,
      triggered: true,
      effectState: "not_applied",
    };
    assert.equal(
      await verifyCiMinuteSchedulingBasis(policy, EPOCH + 60000, facts),
      true,
    );
    for (
      const changed of [
        { repositoryId: 1 },
        { workflowBlob: SHA },
        { job: "changed" },
        { jobs: 2 },
        { runner: "ubuntu-24.04" },
        { timeoutMinutes: target.timeoutMinutes + 1 },
        { ceilingMinutes: target.ceilingMinutes - 1 },
        { qualificationDigest: PROOF },
      ]
    ) {
      assert.equal(
        await verifyCiMinuteSchedulingBasis(policy, EPOCH + 60000, {
          ...facts,
          ...changed,
        }),
        false,
      );
    }
  }
  for (
    const changed of [
      { monthlyLimit: 1999 },
      { managedLimit: 1449 },
      { securityReserve: 149 },
      { unmanagedReserve: 399 },
      { calendar: "local_month" },
      { meterRefunds: true },
      { privateRemote: "https://example.invalid" },
      { bootstrap: "empty" },
    ]
  ) {
    assert.equal(
      await verifyCiMinuteSchedulingBasis(
        { ...policy, ...changed } as CiMinutePolicyV1,
        EPOCH + 60000,
      ),
      false,
    );
  }
  const f = fixture(1450, EPOCH, policy);
  f.facts({ timeoutMinutes: 21 });
  assert.equal((await f.reserve()).kind, "unavailable");
  assert.equal(f.ledger().reservations.length, 0);
});

Deno.test("CI pacing native driver bootstraps an unknown month as a persisted floor and resumes without an effect", async () => {
  const policy = acceptedCiMinutePolicy();
  const f = fixture(1450, EPOCH, policy);
  f.months.clear();
  let observations = 0;
  f.observe((month, _deadline, ledger) => {
    observations++;
    assert.equal(ledger.bootstrap?.floorMinutes, 1450);
    return Promise.resolve({
      month,
      complete: observations > 1,
      watermark: observations > 1 ? EPOCH : 0,
      jobs: [],
      catalog: {
        runs: [],
        cursor: 0,
        passThrough: observations > 1 ? EPOCH : null,
        complete: observations > 1,
      },
    });
  });
  const initial = await f.controller.reconcile(EPOCH + 60000);
  assert.equal(initial.kind, "pending");
  assert.equal(f.ledger().sequence, 2);
  assert.equal(f.ledger().baselineMinutes, 1450);
  assert.equal(f.ledger().watermark, null);
  assert.equal(f.ledger().reservations.length, 0);
  const later = await f.reserve();
  assert.equal(later.kind, "held");
  if (later.kind === "held") assert.equal(later.reason, "monthly_allowance");
  assert.equal(f.ledger().baselineMinutes, 1450);
  assert.equal(f.ledger().reservations.length, 0);
  const next = Date.UTC(2028, 1, 29, 23);
  f.now(next);
  f.observe((month) =>
    Promise.resolve({ month, complete: true, watermark: next, jobs: [] })
  );
  assert.equal((await f.reserve()).kind, "admitted");
  assert.equal(f.ledger().baselineMinutes, 0);
  assert.equal(f.months.get("2028-01")!.bootstrap?.floorMinutes, 1450);
});

Deno.test("CI pacing explicit started-zero proofs retain 25 and 35 estimated minutes and close only their proven month", async () => {
  const f = fixture(1450, EPOCH, acceptedCiMinutePolicy());
  const first = await f.reserve(managedEffect());
  const second = await f.reserve(managedEffect("passport.ubq.fi"));
  assert.equal(first.kind, "admitted");
  assert.equal(second.kind, "admitted");
  if (first.kind !== "admitted" || second.kind !== "admitted") return;
  f.jobs([first, second].map((result, index) => {
    const digest = ciMinuteDigest({ job: index });
    return estimatedJob({
      digest,
      effectDigest: result.reservationDigest,
      startedAt: EPOCH - 497000,
      completedAt: EPOCH,
      neverStarted: false,
      terminal: true,
      billedDurationMs: index === 0 ? 0 : 60000,
      estimate: {
        kind: "retained_estimate",
        minutes: index === 0 ? 25 : 35,
        executionMonth: "2028-01",
        terminalProofDigest: digest,
      },
    });
  }));
  assert.equal((await f.controller.reconcile(EPOCH + 60000)).kind, "ready");
  assert.deepEqual(
    f.ledger().reservations.map((
      row,
    ) => [row.state, row.chargedMinutes, row.accounting?.kind]),
    [
      ["terminal_estimated", 25, "retained_estimate"],
      ["terminal_estimated", 35, "retained_estimate"],
    ],
  );
  f.now(Date.UTC(2028, 1, 29, 23));
  f.jobs([]);
  assert.equal(
    (await f.reserve(managedEffect("prospector", "d".repeat(40)))).kind,
    "admitted",
  );
  assert.equal(f.ledger().reservations.length, 1);
  assert.deepEqual(
    f.months.get("2028-01")!.reservations.map((row) => row.chargedMinutes),
    [25, 35],
  );
});

Deno.test("CI pacing authenticated terminal never-started work is zero and cannot replay the same effect", async () => {
  const f = fixture(1450, EPOCH, acceptedCiMinutePolicy());
  const reservation = await f.reserve();
  assert.equal(reservation.kind, "admitted");
  if (reservation.kind !== "admitted") return;
  f.jobs([{
    digest: PROOF,
    effectDigest: reservation.reservationDigest,
    startedAt: null,
    completedAt: null,
    neverStarted: true,
    terminal: true,
    billedDurationMs: 0,
  }]);
  assert.equal((await f.controller.reconcile(EPOCH + 60000)).kind, "ready");
  assert.equal(f.ledger().reservations[0].chargedMinutes, 0);
  assert.equal(f.ledger().reservations[0].accounting?.kind, "never_started");
  assert.equal((await f.reserve()).kind, "unavailable");
});

Deno.test("CI pacing cross-boundary and unresolved work carry while a late prior-month terminal proof closes exposure", async () => {
  const f = fixture(1450, EPOCH, acceptedCiMinutePolicy());
  const first = await f.reserve();
  const second = await f.reserve(managedEffect("passport.ubq.fi"));
  assert.equal(first.kind, "admitted");
  assert.equal(second.kind, "admitted");
  if (first.kind !== "admitted" || second.kind !== "admitted") return;
  f.jobs([estimatedJob({
    digest: PROOF,
    effectDigest: first.reservationDigest,
    startedAt: Date.UTC(2027, 11, 31, 23, 59),
    completedAt: Date.UTC(2028, 0, 1, 0, 1),
    neverStarted: false,
    terminal: true,
    billedDurationMs: 0,
    estimate: {
      kind: "retained_estimate",
      minutes: 25,
      executionMonth: null,
      terminalProofDigest: PROOF,
    },
  })]);
  await f.controller.reconcile(EPOCH + 60000);
  f.now(Date.UTC(2028, 1, 29, 23));
  const digest = ciMinuteDigest({ job: "late" });
  f.jobs([estimatedJob({
    digest,
    effectDigest: second.reservationDigest,
    startedAt: EPOCH - 497000,
    completedAt: EPOCH,
    neverStarted: false,
    terminal: true,
    billedDurationMs: 0,
    estimate: {
      kind: "retained_estimate",
      minutes: 35,
      executionMonth: "2028-01",
      terminalProofDigest: digest,
    },
  })]);
  assert.equal(
    (await f.reserve(managedEffect("prospector", "e".repeat(40)))).kind,
    "admitted",
  );
  const rows = f.ledger().reservations;
  assert.equal(
    rows.find((row) => row.effectDigest === first.reservationDigest)?.state,
    "reserved",
  );
  assert.equal(
    rows.find((row) => row.effectDigest === first.reservationDigest)
      ?.chargedMinutes,
    25,
  );
  assert.equal(
    rows.find((row) => row.effectDigest === second.reservationDigest)
      ?.accounting?.executionMonth,
    "2028-01",
  );
  assert.equal(f.months.get("2028-01")!.reservations[1].chargedMinutes, 35);
});

Deno.test("CI pacing rollover resumes the same bounded initial-discovery cursor", async () => {
  const f = fixture(1450, EPOCH, acceptedCiMinutePolicy());
  f.ledger().watermark = null;
  f.ledger().progress = {
    month: "2028-01",
    through: EPOCH,
    windowFrom: 0,
    windowThrough: EPOCH,
    targetIndex: 0,
    jobs: [],
    completedAttempts: [],
    cursor: {
      queryDigest: PROOF,
      runPage: 2,
      runOffset: 1,
      attempt: 1,
      jobPage: 1,
      jobsSeen: 0,
      runDigest: PROOF,
    },
  };
  f.ledger().catalog = {
    runs: [1, 2].map((runId) => ({
      repositoryId: 1337190500,
      runId,
      head: SHA,
      createdAt: EPOCH - 60000,
      updatedAt: EPOCH,
      runAttempt: 1,
      checkedAttempt: 0,
      status: "unknown",
      terminalProofDigest: null,
      refreshRequired: true,
    })),
    cursor: 1,
    passThrough: null,
    complete: false,
  };
  const later = Date.UTC(2028, 1, 1);
  f.now(later);
  f.observe((month, _deadline, ledger) => {
    assert.equal(ledger.progress?.month, "2028-02");
    assert.equal(ledger.progress?.cursor?.runPage, 2);
    assert.equal(ledger.progress?.cursor?.queryDigest, PROOF);
    assert.equal(ledger.progress?.windowThrough, EPOCH);
    assert.equal(ledger.catalog?.cursor, 1);
    return Promise.resolve({
      month,
      complete: false,
      watermark: 0,
      observedAt: later,
      jobs: [],
      catalog: structuredClone(ledger.catalog!),
    });
  });
  assert.equal((await f.controller.reconcile(later + 60000)).kind, "pending");
  assert.equal(f.ledger().progress?.windowFrom, 0);
  assert.equal(f.ledger().progress?.cursor?.runOffset, 1);
});
