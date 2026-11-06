import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
/**
 * Batched live reads and the unchanged-input gate of the serial pass
 * (issue #326).
 *
 * These cases run the ACTUAL `runRepairCycle` consumer over in-memory state,
 * a fake multi-repository GitHub port and an injected clock (no network, no
 * model call, no real waiting). Every live record holds a pending matrix
 * artifact, so each step is the deterministic no-write deferral the issue
 * describes. The pass reads each repository's live inputs with ONE batched
 * query, stamps every settled record, and a later pass steps only the records
 * whose inputs changed or whose wait/stamp deadline elapsed; a failed batch
 * read falls back to the per-record reads and is reported unavailable.
 */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import type {
  LiveInputsRequestV1,
  LiveInputsV1,
} from "../../src/contracts/live-inputs.ts";
import {
  portError,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { PASS_SUMMARY_LINE_KIND } from "../../src/repair/pass-summary-line.ts";
import { STEP_INPUTS_MAX_SKIP_MS } from "../../src/repair/step-inputs.ts";
import { STEP_LINE_KIND } from "../../src/repair/step-line.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
} from "./helpers.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const MINUTE = 60_000;
const REPOS = ["alpha", "beta", "gamma"].map((name) => ({
  owner: "ubiquity",
  name,
  installationId: 7,
}));
type Repo = (typeof REPOS)[number];

/** A live record whose only step is the pending matrix-artifact deferral. */
function pendingArtifact(
  repo: Repo,
  index: number,
  extra: Record<string, unknown> = {},
): WorkRecordV1 {
  const id = `issue-${repo.name}-${index}`;
  const branch = `sentinel/repair/${id}`;
  const number = 100 + index;
  return workRecord(id, {
    repository: repo,
    source: { kind: "issue", id: String(number), revision: SHA1 },
    related: { incidentId: null, issueNumber: number },
    target: { base: SHA1, branch, checkpoint: null, head: null, pr: null },
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
    ...extra,
  });
}

/** Fake port answering the batched read for every repository it is asked. */
class BatchGithub extends FakeGithub {
  readonly batches: string[] = [];
  readonly closed = new Set<string>();
  failBatch = false;

  readLiveInputs(
    request: LiveInputsRequestV1,
  ): Promise<PortResultV1<LiveInputsV1>> {
    this.batches.push(request.repository.name);
    if (this.failBatch) {
      return Promise.resolve(portError("unavailable", "graphql unavailable"));
    }
    return Promise.resolve(portOk({
      issues: request.issues.map((number) => ({
        number,
        state: this.closed.has(`${request.repository.name}#${number}`)
          ? "closed" as const
          : "open" as const,
      })),
      pulls: request.pulls.map((number) => ({ number, pull: null })),
      branches: request.branches.map((branch) => ({ branch, tip: SHA1 })),
    }));
  }

  batchesOf(name: string): number {
    return this.batches.filter((entry) => entry === name).length;
  }
}

function seeded(work: WorkRecordV1[]): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
}

function makeRig(work: WorkRecordV1[]) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  state.repair = seeded(work);
  state.repairHead = SHA1;
  const configs: RepositoryConfigV1[] = REPOS.map((repo) =>
    repositoryConfig(
      repo as unknown as Parameters<typeof repositoryConfig>[0],
      { perHour: 5, perSevenDays: 20 },
      { sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 } },
    )
  );
  const github = new BatchGithub({ baseSha: SHA1, openIssues: [] });
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
  return { clock, state, github, deps };
}

type Rig = ReturnType<typeof makeRig>;

interface PassV1 {
  stepped: string[];
  summary: Record<string, unknown>;
  status: string;
}

async function pass(rig: Rig): Promise<PassV1> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  let status: string;
  try {
    const outcome = await runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
    });
    status = outcome.status;
  } finally {
    console.log = original;
  }
  const parsed = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const summaries = parsed.filter((line) =>
    line.kind === PASS_SUMMARY_LINE_KIND
  );
  assert.equal(summaries.length, 1, "exactly one pass summary");
  return {
    stepped: parsed.filter((line) => line.kind === STEP_LINE_KIND)
      .map((line) => String(line.recordId)),
    summary: summaries[0],
    status,
  };
}

/** 74 live records across the three repositories (25 + 25 + 24). */
function fleet(): WorkRecordV1[] {
  return REPOS.flatMap((repo, slot) =>
    Array.from(
      { length: slot === 2 ? 24 : 25 },
      (_, index) => pendingArtifact(repo, slot * 100 + index),
    )
  );
}

function stamped(rig: Rig): number {
  return rig.state.repair!.work.filter((record) =>
    record.stepInputs !== undefined
  ).length;
}

Deno.test("input gate: one batch per repository, then only changed records are stepped", async () => {
  const work = fleet();
  assert.equal(work.length, 74);
  const rig = makeRig(work);

  const first = await pass(rig);
  for (const repo of REPOS) assert.equal(rig.github.batchesOf(repo.name), 1);
  assert.equal(new Set(first.stepped).size, 74, JSON.stringify(first));
  assert.equal(stamped(rig), 74, "every settled record carries its stamp");
  assert.deepEqual(first.summary, {
    kind: PASS_SUMMARY_LINE_KIND,
    recordsRead: 74,
    recordsStepped: 74,
    recordsSkipped: 0,
    skipReasons: { unchanged_inputs: 0, waiting: 0 },
    batchReads: 3,
    batchUnavailable: 0,
  });
  // The batch replaced every per-record live read.
  assert.equal(
    rig.github.calls.filter((call) => call.startsWith("readIssue")).length,
    0,
  );

  // Three issues of one repository change state; nothing else moves.
  rig.clock.advance(5 * MINUTE);
  const changed = work.filter((record) => record.repository.name === "beta")
    .slice(0, 3);
  for (const record of changed) {
    rig.github.closed.add(`beta#${record.related.issueNumber}`);
  }
  const before = rig.state.repairHead;
  const second = await pass(rig);
  for (const repo of REPOS) assert.equal(rig.github.batchesOf(repo.name), 2);
  assert.deepEqual(
    [...new Set(second.stepped)].sort(),
    changed.map((record) => record.id).sort(),
  );
  assert.equal(second.summary.recordsStepped, 3);
  assert.equal(second.summary.recordsSkipped, 71);
  assert.deepEqual(second.summary.skipReasons, {
    unchanged_inputs: 71,
    waiting: 0,
  });
  assert.equal(second.status, "margin");
  assert.notEqual(rig.state.repairHead, before, "the three new stamps landed");

  // A third pass with nothing changed steps nothing and writes nothing.
  rig.clock.advance(5 * MINUTE);
  const head = rig.state.repairHead;
  const third = await pass(rig);
  assert.deepEqual(third.stepped, []);
  assert.equal(third.summary.recordsSkipped, 74);
  assert.equal(rig.state.repairHead, head, "a skipped record costs no write");
});

Deno.test("input gate: the clock passing a wait or stamp deadline steps the record again", async () => {
  const backoffUntil = T0 + 10 * MINUTE;
  const waiting = pendingArtifact(REPOS[0], 900, {
    wait: { reason: "backoff", since: T0, until: backoffUntil },
  });
  const rig = makeRig([...fleet().slice(0, 10), waiting]);

  const first = await pass(rig);
  assert.equal(first.stepped.includes(waiting.id), false);
  assert.equal(first.summary.recordsStepped, 10);
  assert.deepEqual(first.summary.skipReasons, {
    unchanged_inputs: 0,
    waiting: 1,
  });

  // The backoff deadline elapses: only the waiting record is stepped.
  rig.clock.advance(11 * MINUTE);
  const second = await pass(rig);
  assert.deepEqual(second.stepped, [waiting.id]);
  assert.deepEqual(second.summary.skipReasons, {
    unchanged_inputs: 10,
    waiting: 0,
  });

  // Past the stamp deadline every record is stepped again on equal inputs.
  rig.clock.advance(STEP_INPUTS_MAX_SKIP_MS);
  const third = await pass(rig);
  assert.equal(new Set(third.stepped).size, 11);
  assert.equal(third.summary.recordsSkipped, 0);
});

Deno.test("input gate: a failed batch falls back to per-record reads and is reported unavailable", async () => {
  const rig = makeRig(
    REPOS.flatMap((repo, slot) =>
      Array.from(
        { length: 4 },
        (_, index) => pendingArtifact(repo, slot * 100 + index),
      )
    ),
  );
  await pass(rig);
  assert.equal(stamped(rig), 12);

  rig.github.failBatch = true;
  rig.clock.advance(5 * MINUTE);
  const reads = () =>
    rig.github.calls.filter((call) => call.startsWith("readIssue")).length;
  const fallback = await pass(rig);
  // Unavailable is never an empty success: the batch stamps do not match the
  // per-record inputs, so every record is stepped, read one by one.
  assert.equal(fallback.summary.batchUnavailable, 3);
  assert.equal(fallback.summary.batchReads, 0);
  assert.equal(fallback.summary.recordsRead, 12);
  assert.equal(new Set(fallback.stepped).size, 12);
  assert.equal(reads(), 12);

  // The fallback stamps then skip unchanged records on the per-record reads.
  rig.clock.advance(5 * MINUTE);
  const again = await pass(rig);
  assert.deepEqual(again.stepped, []);
  assert.equal(again.summary.recordsSkipped, 12);
  assert.equal(again.summary.batchUnavailable, 3);
  assert.equal(reads(), 24);
});

Deno.test("input gate: unavailable batches bound fallback latency across a hot tier", async () => {
  const rig = makeRig(fleet());
  rig.github.failBatch = true;
  const readIssue = rig.github.readIssue.bind(rig.github);
  let active = 0;
  let peak = 0;
  let waves = 0;
  const waiting: (() => void)[] = [];
  // Advance one second per simultaneous wave, never sleep in real time.
  rig.github.readIssue = async (number) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => {
      if (waiting.length === 0) {
        queueMicrotask(() => {
          waves++;
          rig.clock.advance(1_000);
          for (const resume of waiting.splice(0)) resume();
        });
      }
      waiting.push(resolve);
    });
    active--;
    return await readIssue(number);
  };

  const first = await pass(rig);
  assert.equal(new Set(first.stepped).size, 74);
  assert.equal(stamped(rig), 74);
  assert.equal(first.summary.batchUnavailable, 3);
  assert.equal(first.summary.recordsRead, 74);
  assert.equal(peak, 4, "fallback reads must overlap but stay bounded");
  assert.equal(waves, 20, "25 + 25 + 24 records take 7 + 7 + 6 waves");
  assert.equal(
    rig.github.calls.filter((call) => call.startsWith("readRef:")).length,
    3,
    "concurrent records share one base-tip read per repository",
  );

  rig.clock.advance(5 * MINUTE);
  waves = 0;
  const again = await pass(rig);
  assert.deepEqual(again.stepped, []);
  assert.equal(again.summary.recordsSkipped, 74);
  assert.equal(again.summary.batchUnavailable, 3);
  assert.equal(waves, 20, "unchanged records retain the bounded fallback");
  assert.deepEqual(rig.state.repair!.reservations, [], "no model charge");
});

Deno.test("input gate: failed fallback issue reads never count as unchanged", async () => {
  const rig = makeRig(
    Array.from({ length: 8 }, (_, index) => pendingArtifact(REPOS[0], index)),
  );
  rig.github.failBatch = true;
  await pass(rig);
  assert.equal(stamped(rig), 8);

  const readIssue = rig.github.readIssue.bind(rig.github);
  rig.github.readIssue = (number) => {
    if (number === 100) {
      return Promise.resolve(portError("unavailable", "lost"));
    }
    if (number === 101) throw new Error("lost response");
    return readIssue(number);
  };
  rig.clock.advance(5 * MINUTE);
  const again = await pass(rig);
  assert.deepEqual(again.stepped.sort(), ["issue-alpha-0", "issue-alpha-1"]);
  assert.equal(again.summary.recordsRead, 6);
  assert.equal(again.summary.recordsSkipped, 6);
  assert.equal(again.summary.batchUnavailable, 1);
  assert.deepEqual(rig.state.repair!.reservations, []);
});

Deno.test("input gate: concurrent fallbacks share failed base-tip observations", async () => {
  for (const throws of [false, true]) {
    const rig = makeRig(
      Array.from({ length: 8 }, (_, index) => pendingArtifact(REPOS[0], index)),
    );
    rig.github.failBatch = true;
    let reads = 0;
    rig.github.readRef = () => {
      reads++;
      if (throws) throw new Error("lost response");
      return Promise.resolve(portError("unavailable", "lost"));
    };
    const first = await pass(rig);
    assert.equal(
      reads,
      1,
      "a failed shared read must not become a request storm",
    );
    assert.equal(first.stepped.length, 8);
    assert.equal(first.summary.recordsRead, 0);
    assert.equal(first.summary.batchUnavailable, 1);
    assert.equal(
      stamped(rig),
      0,
      "failed inputs are not empty successful inputs",
    );
    assert.equal(
      rig.github.calls.filter((call) => call.startsWith("readIssue:")).length,
      0,
    );
    assert.deepEqual(rig.state.repair!.reservations, []);
  }
});

Deno.test("input gate: fallback prefetch stops admitting reads at the run deadline", async () => {
  const rig = makeRig(fleet());
  rig.github.failBatch = true;
  const readIssue = rig.github.readIssue.bind(rig.github);
  let expire = true;
  rig.github.readIssue = async (number) => {
    await Promise.resolve();
    if (expire) {
      expire = false;
      rig.clock.advance(90 * MINUTE);
    }
    return await readIssue(number);
  };

  const result = await pass(rig);
  assert.equal(
    rig.github.calls.filter((call) => call.startsWith("readIssue:")).length,
    4,
    "only already-started fallback reads settle after the deadline",
  );
  assert.equal(rig.github.batches.length, 1, "no later repository read starts");
  assert.deepEqual(result.stepped, []);
  assert.equal(stamped(rig), 0, "no closing stamp write past the deadline");
  assert.deepEqual(rig.state.repair!.reservations, []);
});

Deno.test("input gate: a historical record without a stamp still parses and is stepped", async () => {
  const legacy = pendingArtifact(REPOS[1], 7);
  assert.equal("stepInputs" in legacy, false);
  const rig = makeRig([legacy]);
  const first = await pass(rig);
  assert.deepEqual(first.stepped, [legacy.id]);
  const stamp = rig.state.repair!.work[0].stepInputs;
  assert.ok(stamp !== undefined);
  assert.match(stamp.digest, /^[0-9a-f]{64}$/);
  assert.equal(stamp.deadline, T0 + STEP_INPUTS_MAX_SKIP_MS);
  // The stamp never moves the record's update time.
  assert.equal(rig.state.repair!.work[0].updatedAt, legacy.updatedAt);
});

Deno.test("input gate: independent repository batches overlap without extra steps or writes", async () => {
  const rig = makeRig(fleet());
  const read = rig.github.readLiveInputs.bind(rig.github);
  let active = 0;
  let peak = 0;
  rig.github.readLiveInputs = async (request) => {
    peak = Math.max(peak, ++active);
    const readyAt = rig.clock.now() + MINUTE;
    await Promise.resolve();
    rig.clock.advance(Math.max(0, readyAt - rig.clock.now()));
    active--;
    return await read(request);
  };

  const startedAt = rig.clock.now();
  const first = await pass(rig);
  assert.equal(
    rig.clock.now() - startedAt,
    2 * MINUTE,
    "probe plus one read round, not three serial rounds",
  );
  assert.equal(peak, 2, "remaining repository reads overlap after the probe");
  assert.equal(first.summary.batchReads, 3);
  assert.equal(first.summary.recordsStepped, 74);
  assert.equal(stamped(rig), 74);
  assert.equal(rig.state.repair!.reservations.length, 0);

  rig.clock.advance(5 * MINUTE);
  const head = rig.state.repairHead;
  const again = await pass(rig);
  assert.equal(again.summary.recordsSkipped, 74);
  assert.deepEqual(again.stepped, []);
  assert.equal(
    rig.state.repairHead,
    head,
    "unchanged inputs still cost no write",
  );
  assert.equal(rig.state.repair!.reservations.length, 0);
});

Deno.test("input gate: repository batches and outage fallbacks each share a four-read bound", async () => {
  const repos = Array.from({ length: 9 }, (_, index) => ({
    ...REPOS[0],
    name: `repository-${index}`,
  }));
  const rig = makeRig(
    repos.flatMap((repo, slot) =>
      Array.from(
        { length: 4 },
        (_, index) => pendingArtifact(repo, slot * 100 + index),
      )
    ),
  );
  const config = rig.deps.configs[0];
  rig.deps.configs.splice(
    0,
    rig.deps.configs.length,
    ...repos.map((repository) => ({ ...config, repository })),
  );
  const firstRepository = repos[0].name;
  rig.github.readLiveInputs = (request) => {
    rig.github.failBatch = request.repository.name !== firstRepository;
    return BatchGithub.prototype.readLiveInputs.call(rig.github, request);
  };
  const readBatch = rig.github.readLiveInputs.bind(rig.github);
  const readIssue = rig.github.readIssue.bind(rig.github);
  let activeBatches = 0;
  let peakBatches = 0;
  let activeFallbacks = 0;
  let peakFallbacks = 0;
  rig.github.readLiveInputs = async (request) => {
    assert.equal(
      activeFallbacks,
      0,
      "fallbacks do not multiply batch concurrency",
    );
    peakBatches = Math.max(peakBatches, ++activeBatches);
    const readyAt = rig.clock.now() + MINUTE;
    await Promise.resolve();
    rig.clock.advance(Math.max(0, readyAt - rig.clock.now()));
    activeBatches--;
    return await readBatch(request);
  };
  rig.github.readIssue = async (number) => {
    assert.equal(
      activeBatches,
      0,
      "fallbacks share one pool after batches settle",
    );
    peakFallbacks = Math.max(peakFallbacks, ++activeFallbacks);
    const readyAt = rig.clock.now() + MINUTE;
    await Promise.resolve();
    rig.clock.advance(Math.max(0, readyAt - rig.clock.now()));
    activeFallbacks--;
    return await readIssue(number);
  };

  const startedAt = rig.clock.now();
  const outcome = await pass(rig);
  assert.equal(peakBatches, 4);
  assert.equal(peakFallbacks, 4);
  assert.equal(
    rig.clock.now() - startedAt,
    11 * MINUTE,
    "three batch rounds plus eight bounded repository fallback rounds",
  );
  assert.equal(outcome.summary.batchUnavailable, 8);
  assert.equal(outcome.summary.batchReads, 1);
  assert.equal(outcome.summary.recordsRead, 36);
  assert.equal(
    outcome.summary.recordsStepped,
    36,
    "failed batches are not empty successes",
  );
  assert.equal(stamped(rig), 36);
  assert.equal(rig.state.repair!.reservations.length, 0);
});

Deno.test("input gate: concurrent batch admission stops at the run deadline", async () => {
  const repos = Array.from({ length: 9 }, (_, index) => ({
    ...REPOS[0],
    name: `repository-${index}`,
  }));
  const rig = makeRig(repos.map((repo, index) => pendingArtifact(repo, index)));
  const config = rig.deps.configs[0];
  rig.deps.configs.splice(
    0,
    rig.deps.configs.length,
    ...repos.map((repository) => ({ ...config, repository })),
  );
  const read = rig.github.readLiveInputs.bind(rig.github);
  rig.github.readLiveInputs = async (request) => {
    const result = read(request);
    if (request.repository.name !== repos[0].name) {
      const readyAt = rig.clock.now() + 90 * MINUTE;
      await Promise.resolve();
      rig.clock.advance(Math.max(0, readyAt - rig.clock.now()));
    }
    return await result;
  };

  const result = await pass(rig);
  assert.equal(
    rig.github.batches.length,
    5,
    "only the probe and four in-flight batches start",
  );
  assert.deepEqual(result.stepped, []);
  assert.equal(stamped(rig), 0, "no closing stamp write past the deadline");
  assert.deepEqual(rig.state.repair!.reservations, []);
});
