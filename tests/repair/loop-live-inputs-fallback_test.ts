/** Repair #405: failed batches must not serialize independent live reads. */
import assert from "node:assert/strict";
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { PassLiveInputs } from "../../src/repair/loop-live-inputs.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { PASS_SUMMARY_LINE_KIND } from "../../src/repair/pass-summary-line.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
} from "./helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";

function makeRig(count = 60) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const work = Array.from({ length: count }, (_, index) => {
    const id = `issue-fallback-${index}`;
    const branch = `sentinel/repair/${id}`;
    return workRecord(id, {
      source: { kind: "issue", id: String(100 + index), revision: SHA1 },
      related: { incidentId: null, issueNumber: 100 + index },
      target: {
        base: SHA1,
        branch,
        checkpoint: null,
        head: SHA2,
        pr: 1_000 + index,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      intent: {
        kind: "implementation",
        key: `impl:${index.toString(16).padStart(64, "0")}`,
        startedAt: T0,
        branch,
        expectedHead: null,
        observedBase: SHA1,
        pr: null,
        requestId: index.toString(16).padStart(64, "0"),
        resultId: null,
      },
    });
  });
  state.repair = seededSnapshot(work);
  state.repairHead = SHA1;
  const github = Object.assign(
    new FakeGithub({
      baseSha: SHA1,
      openIssues: [],
      pullRequest: { head: SHA2 },
    }),
    {
      readLiveInputs: () =>
        Promise.resolve(portError("unavailable", "batch unavailable")),
    },
  );
  const configs = [repositoryConfig()];
  const deps = {
    ciMinutes: INACTIVE_CI_MINUTES,
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: new FakeModel({ head: SHA2, changedPaths: ["src/app.ts"] }),
    budget: new RollingStartBudget({ clock, state, configs }),
    externalImplementations: true,
  };
  const bounds = {
    runDeadline: clock.now() + 90 * 60_000,
    modelCutoff: clock.now() + 90 * 60_000,
  };
  return { clock, state, github, deps, work, bounds };
}

/** Equal-latency fake API calls advance one second per concurrent wave. */
function network(clock: FakeClock) {
  const pending: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  let calls = 0;
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve) => {
        if (pending.length === 0) {
          queueMicrotask(async () => {
            // Drain ready continuations before the next network tick. Promise
            // wrapper depth must not manufacture extra fake latency waves.
            for (let i = 0; i < 100; i++) await Promise.resolve();
            clock.advance(1_000);
            for (const resume of pending.splice(0)) resume();
          });
        }
        pending.push(resolve);
      });
      return await operation();
    } finally {
      active--;
    }
  };
  return { read, stats: () => ({ active, peak, calls }) };
}

async function pass(rig: ReturnType<typeof makeRig>) {
  const lines: string[] = [];
  const stepped: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 90 * 60_000,
      stepLimit: 1_000,
      modelStartsEnabled: true,
      onStep: (id) => stepped.push(id),
    });
  } finally {
    console.log = original;
  }
  const summaries = lines.map((line) => JSON.parse(line)).filter((line) =>
    line.kind === PASS_SUMMARY_LINE_KIND
  );
  assert.equal(summaries.length, 1);
  return { stepped, summary: summaries[0] };
}

Deno.test("repair fallback: 60 PR records overlap issue reads with PR/check reads", async () => {
  const rig = makeRig();
  const net = network(rig.clock);
  const readIssue = rig.github.readIssue.bind(rig.github);
  const readPull = rig.github.readPullRequest.bind(rig.github);
  const readChecks = rig.github.readChecks.bind(rig.github);
  const readRef = rig.github.readRef.bind(rig.github);
  let absentPull: number | null = null;
  rig.github.readIssue = (number) => net.read(() => readIssue(number));
  rig.github.readPullRequest = (number) =>
    net.read(async () => {
      if (number === absentPull) return portOk(null);
      const read = await readPull(number);
      return read.ok && read.value !== null
        ? portOk({ ...read.value, number })
        : read;
    });
  rig.github.readChecks = (head) => net.read(() => readChecks(head));
  rig.github.readRef = (ref) => net.read(() => readRef(ref));

  const start = rig.clock.now();
  const first = await pass(rig);
  assert.equal(first.stepped.length, 60);
  assert.equal(first.summary.recordsRead, 60);
  assert.equal(first.summary.batchUnavailable, 1);
  assert.ok(
    rig.clock.now() - start <= 31_000,
    "60 records need at most 30 PR/check waves and one shared base-tip read, not 45 serial waves",
  );
  assert.deepEqual(net.stats(), { active: 0, peak: 8, calls: 181 });
  assert.equal(
    rig.state.repair!.work.filter((record) => record.stepInputs !== undefined)
      .length,
    60,
  );

  rig.clock.advance(5 * 60_000);
  const head = rig.state.repairHead;
  const unchanged = await pass(rig);
  assert.deepEqual(unchanged.stepped, []);
  assert.equal(unchanged.summary.recordsSkipped, 60);
  assert.equal(rig.state.repairHead, head, "unchanged inputs cost no write");

  // A changed PR observation must still wake its own record, never the fleet.
  absentPull = 1_000;
  rig.clock.advance(5 * 60_000);
  const changed = await pass(rig);
  assert.deepEqual(changed.stepped, [rig.work[0].id]);
  assert.equal(changed.summary.recordsSkipped, 59);
  assert.deepEqual(rig.state.repair!.reservations, [], "no model charges");
});

Deno.test("repair fallback: failed issue reads still drain the eight-request pool", async () => {
  const rig = makeRig(16);
  const readPull = rig.github.readPullRequest.bind(rig.github);
  const pending: (() => void)[] = [];
  let started = 0;
  rig.github.readIssue = () => {
    throw new Error("lost issue read");
  };
  rig.github.readPullRequest = async (number) => {
    started++;
    await new Promise<void>((resolve) => pending.push(resolve));
    return await readPull(number);
  };
  const live = new PassLiveInputs(rig.deps, rig.bounds);
  const priming = live.prime(rig.work);
  const drainMicrotasks = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  await drainMicrotasks();
  try {
    assert.equal(started, 8, "only eight fallback reads may be in flight");
    assert.equal(
      pending.length,
      8,
      "a thrown issue read must not abandon its PR read",
    );
    for (const resume of pending.splice(0)) resume();
    await drainMicrotasks();
    assert.equal(started, 16);
    assert.equal(pending.length, 8);
  } finally {
    for (const resume of pending.splice(0)) resume();
    await priming;
  }
  assert.equal(
    live.metrics.recordsRead,
    0,
    "failed inputs are never empty success",
  );
  for (const record of rig.work) {
    assert.equal(await live.inputsFor(record), null);
  }
});

Deno.test("repair fallback: either failed read chain is unavailable, while explicit absences stay valid", async () => {
  for (const port of ["issue", "pull", "checks"] as const) {
    for (const throws of [false, true]) {
      const rig = makeRig(1);
      const failure = () => {
        if (throws) throw new Error("lost read");
        return Promise.resolve(portError("unavailable", "failed read"));
      };
      if (port === "issue") rig.github.readIssue = failure;
      if (port === "pull") rig.github.readPullRequest = failure;
      if (port === "checks") rig.github.readChecks = failure;
      const live = new PassLiveInputs(rig.deps, rig.bounds);
      await live.prime(rig.work);
      assert.equal(await live.inputsFor(rig.work[0]), null, port);
      assert.equal(live.metrics.recordsRead, 0, port);
    }
  }

  const rig = makeRig(1);
  rig.github.readIssue = () => Promise.resolve(portOk(null));
  rig.github.readPullRequest = () => Promise.resolve(portOk(null));
  const live = new PassLiveInputs(rig.deps, rig.bounds);
  await live.prime(rig.work);
  assert.deepEqual(await live.inputsFor(rig.work[0]), {
    source: "fallback",
    issue: null,
    pull: null,
    baseTip: SHA1,
  });
  assert.equal(live.metrics.recordsRead, 1);
});

Deno.test("repair fallback: 60 records fill the eight-request budget across PR/check chains", async () => {
  const rig = makeRig();
  const net = network(rig.clock);
  const readIssue = rig.github.readIssue.bind(rig.github);
  const readPull = rig.github.readPullRequest.bind(rig.github);
  const readChecks = rig.github.readChecks.bind(rig.github);
  const readRef = rig.github.readRef.bind(rig.github);
  rig.github.readIssue = (number) => net.read(() => readIssue(number));
  rig.github.readPullRequest = (number) => net.read(() => readPull(number));
  rig.github.readChecks = (head) => net.read(() => readChecks(head));
  rig.github.readRef = (ref) => net.read(() => readRef(ref));

  const start = rig.clock.now();
  const first = await pass(rig);
  assert.equal(first.summary.recordsRead, 60);
  assert.equal(first.summary.batchUnavailable, 1);
  assert.equal(first.summary.recordsStepped, 60);
  assert.deepEqual(net.stats(), { active: 0, peak: 8, calls: 181 });
  assert.ok(
    rig.clock.now() - start <= 24_000,
    `the existing eight-request budget must stay busy across PR/check chains; took ${
      rig.clock.now() - start
    }ms`,
  );

  rig.clock.advance(5 * 60_000);
  const head = rig.state.repairHead;
  const unchanged = await pass(rig);
  assert.deepEqual(unchanged.stepped, []);
  assert.equal(unchanged.summary.recordsSkipped, 60);
  assert.equal(rig.state.repairHead, head, "unchanged inputs cost no write");
  assert.deepEqual(rig.state.repair!.reservations, [], "no model charges");
});

Deno.test("repair fallback: queued reads do not start after the run deadline", async () => {
  const rig = makeRig(16);
  const net = network(rig.clock);
  const readIssue = rig.github.readIssue.bind(rig.github);
  const readPull = rig.github.readPullRequest.bind(rig.github);
  const readRef = rig.github.readRef.bind(rig.github);
  rig.bounds.runDeadline = rig.clock.now() + 2_000;
  const readStarts: number[] = [];
  let checkReads = 0;
  const beforeRead = () => readStarts.push(rig.clock.now());
  rig.github.readIssue = (number) => {
    beforeRead();
    return net.read(() => readIssue(number));
  };
  rig.github.readPullRequest = (number) => {
    beforeRead();
    return net.read(() => readPull(number));
  };
  rig.github.readRef = (ref) => net.read(() => readRef(ref));
  rig.github.readChecks = () => {
    checkReads++;
    return Promise.resolve(portError("unavailable", "check read unavailable"));
  };

  const live = new PassLiveInputs(rig.deps, rig.bounds);
  await live.prime(rig.work);
  assert.deepEqual(net.stats(), { active: 0, peak: 8, calls: 9 });
  assert.ok(readStarts.every((start) => start < rig.bounds.runDeadline));
  assert.equal(checkReads, 0, "queued checks do not start after the deadline");
  assert.equal(
    live.metrics.recordsRead,
    0,
    "incomplete inputs stay unavailable",
  );
  for (const record of rig.work.slice(0, 8)) {
    assert.equal(await live.inputsFor(record), null);
  }
});
