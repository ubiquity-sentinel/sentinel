import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
/**
 * Serial-pass bounds (owner throughput, 2026-11-01, issue #297).
 *
 * A matrix-owned run (`externalImplementations`) used to STEP every live
 * record: each implementation-ready record paid its pre-admission reads and
 * then returned the deterministic "implementation admission belongs to the
 * matrix planner" deferral. With ~30 targets that walk consumed the run before
 * the planner could plan a wave. These cases exercise the ACTUAL
 * `runRepairCycle` consumer with the in-memory state, fake ports and an
 * injected clock: matrix-only records are never stepped (one summary line),
 * the serial pass yields one operation margin before the run deadline, and a
 * bootstrap execution never walks the model-disabled work queue (it still runs
 * intake, maintenance, health and pending candidate-preservation maintenance).
 * No model call, no network, no credentials and no real waiting.
 */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portError } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { OPERATION_MARGIN_MS } from "../../src/repair/loop-bounds.ts";
import {
  isMatrixImplementationReadyV1,
  matrixAdmissionOnlyIds,
} from "../../src/repair/loop-eligibility.ts";
import { baseRefreshIntentKey } from "../../src/repair/keys.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { createRepairInvocation } from "../../src/main.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import {
  MATRIX_SKIP_LINE_KIND,
  STEP_LINE_KIND,
} from "../../src/repair/step-line.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import {
  REPO,
  reviewReceipt,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

const MINUTE = 60_000;

/** A matrix-owned (planner-admitted) issue record: branch, no head yet. */
function matrixReadyRecord(index: number): WorkRecordV1 {
  return workRecord(`issue-${index}`, {
    source: { kind: "issue", id: String(index), revision: SHA1 },
    related: { incidentId: null, issueNumber: index + 1 },
    target: {
      base: SHA1,
      branch: `sentinel/repair/issue-${index}`,
      checkpoint: null,
      head: null,
      pr: null,
    },
  });
}

/** A record the serial pass must still step: its branch is not assigned yet. */
function freshRecord(index: number): WorkRecordV1 {
  return workRecord(`fresh-${index}`, {
    source: { kind: "issue", id: `${10_000 + index}`, revision: SHA1 },
    related: { incidentId: null, issueNumber: 10_000 + index },
    target: {
      base: SHA1,
      branch: null,
      checkpoint: null,
      head: null,
      pr: null,
    },
  });
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

/**
 * Deterministic step duration: every committed state write (one per selected
 * step) advances the injected run clock by a fixed amount, so awaited
 * wall-clock work is simulated without any real wait.
 */
class AdvancingMemoryState extends MemoryState {
  constructor(
    private readonly runClock: FakeClock,
    private readonly advanceMs: number,
  ) {
    super();
  }
  override writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ) {
    const result = super.writeRepair(next, expectedHead);
    this.runClock.advance(this.advanceMs);
    return result;
  }
}

interface RigV1 {
  clock: Clock;
  state: MemoryState;
  github: FakeGithub;
  deps: Parameters<typeof runRepairCycle>[0];
}

function makeRig(
  work: WorkRecordV1[],
  options: {
    /** Each committed state write advances the clock by this much. */
    stepMs?: number;
    externalImplementations?: boolean;
    github?: FakeGithub;
  } = {},
): RigV1 {
  const clock = new FakeClock(T0);
  const state = options.stepMs === undefined
    ? new MemoryState()
    : new AdvancingMemoryState(clock, options.stepMs);
  state.repair = seeded(work);
  state.repairHead = SHA1;
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const githubCooldown = new DurableGitHubCooldownGate({ state, clock });
  const budget = new RollingStartBudget({ clock, state, configs });
  const github = options.github ??
    new FakeGithub({ baseSha: SHA1, openIssues: [] });
  const deps = {
    ciMinutes: INACTIVE_CI_MINUTES,
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown,
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: new FakeModel({ head: SHA2, changedPaths: ["src/app.ts"] }),
    budget,
    externalImplementations: options.externalImplementations === true,
  };
  return { clock, state, github, deps };
}

/** Capture the advisory lines a run prints, without leaking to the test log. */
async function captureLogs<T>(run: () => Promise<T>): Promise<{
  result: T;
  lines: string[];
}> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.log = original;
  }
}

function parseLines(lines: string[], kind: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.includes(kind)) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.kind === kind) parsed.push(value);
    } catch {
      // Not an advisory JSON line.
    }
  }
  return parsed;
}

Deno.test("serial pass: a 300-record state with 250 matrix-only records is stepped in O(50) with one summary", async () => {
  const matrixOnly = Array.from(
    { length: 250 },
    (_, index) => matrixReadyRecord(index),
  );
  const serial = Array.from({ length: 50 }, (_, index) => freshRecord(index));
  const rig = makeRig([...matrixOnly, ...serial], {
    externalImplementations: true,
  });

  const { result, lines } = await captureLogs(() =>
    runRepairCycle(rig.deps, {
      deadline: T0 + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
    })
  );

  const steps = parseLines(lines, STEP_LINE_KIND);
  const summaries = parseLines(lines, MATRIX_SKIP_LINE_KIND);
  // Every non-matrix record is still stepped exactly once (branch assignment).
  assert.equal(steps.length, 50, JSON.stringify(result));
  assert.equal(summaries.length, 1, "exactly one summary event");
  assert.equal(summaries[0].records, 250);
  // No matrix-only record was ever selected.
  const stepped = new Set(steps.map((line) => line.recordId));
  for (const record of matrixOnly) {
    assert.equal(stepped.has(record.id), false, record.id);
  }
  assert.equal(result.status, "margin");
  assert.match(String(result.detail), /matrix-owned/);
});

Deno.test("serial pass: production entrypoint keeps one operation margin when the pass would overrun", async () => {
  const stepMs = MINUTE;
  const rig = makeRig(
    Array.from({ length: 40 }, (_, index) => freshRecord(index)),
    { stepMs, externalImplementations: true },
  );
  const deadline = T0 + 30 * MINUTE;
  // The production entrypoint reserves the one operation margin before the
  // cycle; a matrix-owned cycle must not stack a second reserve on top.
  const invocation = createRepairInvocation(rig.deps, {
    deadline,
    stepLimit: 1_000,
    modelStartsEnabled: true,
  });

  const { result } = await captureLogs(async () => {
    while ((await invocation.advance()).kind === "progress") { /* run */ }
    return await invocation.finish();
  });

  assert.equal(result.status, "margin", JSON.stringify(result));
  // The pass yielded with exactly the entrypoint's operation margin available.
  const remaining = deadline - rig.clock.now();
  assert.equal(
    remaining,
    OPERATION_MARGIN_MS,
    `remaining ${remaining}ms != ${OPERATION_MARGIN_MS}ms`,
  );
  // It also stopped mid-way: the serial intake work is not the bound.
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") return;
  const pending = read.value.snapshot.work.filter((record) =>
    record.target.branch === null
  );
  assert.ok(pending.length > 0, "the pass yielded before walking every record");
});

Deno.test("bootstrap pass: no work record is stepped; maintenance and health only", async () => {
  const records = Array.from({ length: 5 }, (_, index) => freshRecord(index));
  const rig = makeRig(records, { externalImplementations: false });

  const { result, lines } = await captureLogs(() =>
    runRepairCycle(rig.deps, {
      deadline: T0 + 30 * MINUTE,
      stepLimit: 32,
      modelStartsEnabled: false,
      bootstrap: true,
    })
  );

  assert.equal(result.status, "idle", JSON.stringify(result));
  assert.match(String(result.detail), /bootstrap/);
  // No step line, and every record is untouched (branch still unassigned).
  assert.deepEqual(parseLines(lines, STEP_LINE_KIND), []);
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") return;
  assert.deepEqual(
    read.value.snapshot.work.map((record) => record.target.branch),
    records.map(() => null),
  );
  // Health still reads its sources.
  assert.ok(rig.github.calls.includes("listOpenIssues"));
  assert.equal(rig.state.repairWrites, 0);
  // The repository identity is preserved by the seeded fixture.
  assert.equal(read.value.snapshot.work[0].repository.name, REPO.name);
});

Deno.test("bootstrap pass: the production entrypoint forwards bootstrap and steps no work record", async () => {
  const records = Array.from({ length: 5 }, (_, index) => freshRecord(index));
  const rig = makeRig(records, { externalImplementations: false });
  const invocation = createRepairInvocation(rig.deps, {
    deadline: T0 + 30 * MINUTE,
    stepLimit: 32,
    modelStartsEnabled: false,
    bootstrap: true,
  });

  const { result, lines } = await captureLogs(async () => {
    while ((await invocation.advance()).kind === "progress") { /* run */ }
    return await invocation.finish();
  });

  assert.equal(result.status, "idle", JSON.stringify(result));
  assert.match(String(result.detail), /bootstrap/);
  assert.deepEqual(parseLines(lines, STEP_LINE_KIND), []);
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") return;
  assert.deepEqual(
    read.value.snapshot.work.map((record) => record.target.branch),
    records.map(() => null),
  );
  assert.ok(rig.github.calls.includes("listOpenIssues"));
  assert.equal(rig.state.repairWrites, 0);
});

Deno.test("bootstrap pass: a failed source read stays a source error", async () => {
  class FailingGithub extends FakeGithub {
    override listOpenIssues() {
      this.calls.push("listOpenIssues");
      return Promise.resolve(portError("unavailable", "source down"));
    }
  }
  const rig = makeRig([], { externalImplementations: false });
  rig.deps.github = new FailingGithub({ baseSha: SHA1, openIssues: [] });

  const { result } = await captureLogs(() =>
    runRepairCycle(rig.deps, {
      deadline: T0 + 30 * MINUTE,
      stepLimit: 32,
      modelStartsEnabled: false,
      bootstrap: true,
    })
  );

  // A failed source read during bootstrap is still an unhealthy source, never
  // a successful idle health pass.
  assert.equal(result.status, "source_error", JSON.stringify(result));
});

/** A headed issue record: any lifecycle with a head, never matrix-admission-only. */
function headedRecord(
  id: string,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  const index = Number(id.replace(/\D/g, ""));
  const branch = `sentinel/repair/headed-${index}`;
  return workRecord(id, {
    source: { kind: "issue", id: `2${index}`, revision: SHA1 },
    related: { incidentId: null, issueNumber: 200 + index },
    target: {
      base: SHA1,
      branch,
      checkpoint: null,
      head: SHA2,
      pr: 7,
      candidateState: { preserved: null, publishedHead: SHA2 },
    },
    ...overrides,
  });
}

Deno.test("matrix-only skip: every record with a serial action is excluded", () => {
  const continuation = headedRecord("headed-1");
  const reviewObservation = headedRecord("headed-2", { nextStep: "review" });
  const delivery = headedRecord("headed-3", { nextStep: "delivery" });
  const ciCorrection = headedRecord("headed-4", {
    target: {
      base: SHA1,
      branch: "sentinel/repair/headed-4",
      checkpoint: null,
      head: SHA2,
      pr: 7,
    },
  });
  const baseRefresh = headedRecord("headed-5", {
    intent: {
      kind: "base_refresh",
      key: baseRefreshIntentKey(7, SHA2, SHA1),
      startedAt: T0,
      branch: "sentinel/repair/headed-5",
      expectedHead: SHA2,
      observedBase: SHA1,
      pr: 7,
      requestId: null,
      resultId: null,
    },
  });
  const fresh = matrixReadyRecord(900);
  const rig = makeRig(
    [
      continuation,
      reviewObservation,
      delivery,
      ciCorrection,
      baseRefresh,
      fresh,
    ],
    { externalImplementations: true },
  );
  // A completed P0 review of the exact head makes `ciCorrection` a reviewed
  // red head awaiting its CI correction: a non-matrix lifecycle.
  rig.state.repair!.reviews.push(
    reviewReceipt("review-ci-correction", {
      outcome: "completed",
      resultId: "result-ci-correction",
      observedReviewer: "chatgpt-codex-connector[bot]",
      completedAt: T0 + 1000,
      pullRequest: { number: 7, head: SHA2, base: SHA1 },
      findings: [{
        id: "review-ci-correction-finding-0",
        fingerprint: "d".repeat(64),
        severity: "P0",
        path: "src/app.ts",
        message: "current P0",
        resolutionEvidence: null,
        resolved: false,
      }],
      unresolvedSeverities: ["P0"],
    }),
  );
  const context = {
    snapshot: rig.state.repair!,
    head: SHA1,
    executionBaseline: null,
    bounds: { runDeadline: T0 + 60 * MINUTE, modelCutoff: T0 + 60 * MINUTE },
  };
  const config = rig.deps.configs[0];
  // Both headed records are planner-admitted shapes, which is exactly why the
  // narrower matrix-only predicate must still exclude them.
  assert.equal(
    isMatrixImplementationReadyV1(continuation, context.snapshot, config, T0),
    true,
  );
  assert.equal(
    isMatrixImplementationReadyV1(ciCorrection, context.snapshot, config, T0),
    true,
  );
  // Review observation, delivery and a pending base refresh are not work.
  for (const record of [reviewObservation, delivery, baseRefresh]) {
    assert.equal(
      isMatrixImplementationReadyV1(record, context.snapshot, config, T0),
      false,
      record.id,
    );
  }
  assert.deepEqual(
    [...matrixAdmissionOnlyIds(rig.deps, context)],
    [fresh.id],
    "only the fresh head-null record is matrix-admission-only",
  );
});

Deno.test("matrix-only skip: a green existing-head continuation still requests review", async () => {
  const head = SHA2;
  const id = "headed-9";
  const branch = "sentinel/repair/headed-9";
  const continuation = workRecord(id, {
    source: { kind: "issue", id: "29", revision: SHA1 },
    related: { incidentId: null, issueNumber: 209 },
    target: {
      base: SHA1,
      branch,
      checkpoint: null,
      head,
      pr: 7,
      candidateState: { preserved: null, publishedHead: head },
    },
  });
  const fresh = matrixReadyRecord(901);
  const rig = makeRig([continuation, fresh], {
    externalImplementations: true,
    github: new FakeGithub({
      baseSha: SHA1,
      openIssues: [],
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { [`refs/heads/${branch}`]: head },
        pullRequests: [exactOpenPr(7, head, branch)],
      },
    }),
  });

  const { result, lines } = await captureLogs(() =>
    runRepairCycle(rig.deps, {
      deadline: T0 + 90 * MINUTE,
      stepLimit: 100,
      modelStartsEnabled: true,
    })
  );

  const steps = parseLines(lines, STEP_LINE_KIND);
  const summaries = parseLines(lines, MATRIX_SKIP_LINE_KIND);
  assert.equal(result.status, "margin", JSON.stringify(result));
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].records, 1, "only the fresh record is declined");
  assert.deepEqual(
    steps.filter((line) => line.recordId === continuation.id).map((line) =>
      line.outcome
    ),
    ["progress"],
    "the continuation is stepped, not skipped",
  );
  assert.equal(rig.github.reviewRequestIdentities.length, 1);
  assert.equal(rig.github.reviewRequestIdentities[0].expectedHead, head);
  const after = await rig.state.readRepair();
  assert.ok(after.ok && after.value.status === "found");
  if (!after.ok || after.value.status !== "found") return;
  assert.equal(
    after.value.snapshot.work.find((row) => row.id === continuation.id)
      ?.nextStep,
    "review",
  );
});
