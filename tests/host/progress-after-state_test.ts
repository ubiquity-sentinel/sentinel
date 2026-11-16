/**
 * Progress comments' after-state reads in the target flow's `finish`
 * (idle-cycle attribution, 2026-11-16: the serial repair job read the whole
 * repair state once per target after every cycle had ended, only to compare
 * progress; that was the whole `finish` phase, 15-47 s of an idle run over 30
 * targets). After the last advance only a settled invocation's post-drain
 * continuation can write repair state, so the targets share one after-state
 * read until a finish may have written. Every target's comments still receive
 * the authoritative state as of its own settlement.
 */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  runActionsRepairHost,
  runActionsTargetCycles,
  scopeTargetConfigV1,
} from "../../src/host/actions.ts";
import { runActionsMatrixAggregateCycles } from "../../src/host/matrix-aggregate.ts";
import { candidateBranch, reviewOperationKey } from "../../src/repair/keys.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { FakeGithub } from "../repair/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import {
  makeRemoteCtx,
  reservation,
  SHA1,
  SHA3,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";
import {
  APP_INSTALLATION,
  FOREIGN_REPO,
  makeTargetHostRig,
  targetCycleInput,
  THIRD_REPO,
} from "./actions-target-fixture.ts";
import { rig } from "./matrix-actions-fixtures.ts";

interface ProgressCallV1 {
  target: string;
  /** Repair-state reads through the flow's state before this call. */
  reads: number;
  after: string;
  /** An independent fresh read of the authoritative state at this call. */
  authoritative: string;
  records: readonly WorkRecordV1[];
}

type Reader = {
  readRepair: ReturnType<typeof createRepairStateStore>["readRepair"];
};

async function authoritative(store: Reader): Promise<WorkRecordV1[]> {
  const read = await store.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  return read.value.snapshot.work;
}

/** Records the comments' inputs, then posts through the real reporter. */
function recording(
  calls: ProgressCallV1[],
  reads: () => number,
  witness: Reader,
  post: (
    config: RepositoryConfigV1,
    before: readonly WorkRecordV1[],
    after: readonly WorkRecordV1[],
  ) => Promise<unknown> = () => Promise.resolve(),
) {
  return async (
    config: RepositoryConfigV1,
    before: readonly WorkRecordV1[],
    after: readonly WorkRecordV1[],
  ) => {
    calls.push({
      target: config.repository.name,
      reads: reads(),
      after: canonicalStringify(after),
      authoritative: canonicalStringify(await authoritative(witness)),
      records: after,
    });
    return await post(config, before, after);
  };
}

function parked(
  repository: RepositoryConfigV1["repository"],
  issue: number,
  now: number,
): WorkRecordV1[] {
  const id = (step: string) =>
    `issue-${repository.owner}-${repository.name}-${issue}-${step}`;
  const common = (number: number) => ({
    repository,
    source: { kind: "issue", id: String(number), revision: SHA1 },
    related: { incidentId: null, issueNumber: number },
    createdAt: now,
    updatedAt: now,
  });
  return [
    workRecord(id("done"), { ...common(issue), nextStep: "done" }),
    workRecord(id("blocked"), {
      ...common(issue + 1),
      nextStep: "blocked",
      blocker: { kind: "other", message: "fixture parked", since: now },
    }),
    workRecord(id("waiting"), {
      ...common(issue + 2),
      wait: { reason: "backoff", since: now, until: now + 3 * 60 * 60_000 },
    }),
  ];
}

Deno.test("progress after-state: an idle serial pass reads it once for every target, unchanged", async () => {
  const r = await rig();
  try {
    for (const port of r.github.values()) {
      port.listOpenIssues = () => Promise.resolve(portOk([]));
    }
    const now = r.clock.now();
    const seeded = await r.store.writeRepair(
      parseRepairStateSnapshotV1(seededSnapshot([
        ...parked(
          { owner: "ubiquity-sentinel", name: "sentinel", installationId: 0 },
          11,
          now,
        ),
        ...parked(
          {
            owner: "ubiquity",
            name: "ai.ubq.fi",
            installationId: APP_INSTALLATION,
          },
          21,
          now,
        ),
      ], { updatedAt: now })),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const before = await r.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const calls: ProgressCallV1[] = [];
    let reads = 0;
    let writes = 0;
    const deps = await r.job("progress-idle", "repair");
    const result = await runActionsRepairHost({
      ...deps,
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("an idle pass infers none")),
      },
      runTargetCycles: (input) => {
        const read = input.state.readRepair.bind(input.state);
        const write = input.state.writeRepair.bind(input.state);
        input.state.readRepair = () => {
          reads++;
          return read();
        };
        input.state.writeRepair = (next, expected) => {
          writes++;
          return write(next, expected);
        };
        assert.ok(input.progressComments, "the trusted serial host comments");
        return runActionsMatrixAggregateCycles({
          ...input,
          progressComments: recording(
            calls,
            () => reads,
            r.store,
            input.progressComments,
          ),
        }, { recover: () => Promise.resolve([]) });
      },
    });
    assert.equal(result.status, "ran");
    assert.deepEqual(calls.map((call) => call.target).sort(), [
      "ai.ubq.fi",
      "sentinel",
    ]);
    for (const call of calls) {
      assert.equal(
        call.after,
        call.authoritative,
        call.target + " compares against the authoritative after-state",
      );
    }
    assert.equal(writes, 0, "an idle pass writes no repair state");
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(after.value.head, before.value.head);
    assert.equal(
      canonicalStringify(after.value.snapshot),
      canonicalStringify(before.value.snapshot),
    );
    assert.deepEqual(
      calls.map((call) => call.reads - calls[0].reads),
      [0, 0],
      "one after-state read serves every idle target",
    );
  } finally {
    await r.cleanup();
  }
});

/**
 * Three targets; only ai.ubq.fi holds a submitted review whose drain completes
 * in `finish`, so its post-drain continuation applies the review and merges
 * (the target-drain fixture's delivery shape) while the other two are idle.
 */
async function continuationScenario() {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-progress-after-",
  });
  try {
    await Deno.mkdir(root + "/home");
    const remote = await makeRemoteCtx(root, testGitEnv(root + "/home"));
    const state = createRepairStateStore({
      scratchDir: root + "/state",
      remoteUrl: remote.remoteUrl,
    });
    const witness = createRepairStateStore({
      scratchDir: root + "/witness",
      remoteUrl: remote.remoteUrl,
    });
    const rig = makeTargetHostRig(["sentinel", FOREIGN_REPO, THIRD_REPO]);
    rig.configs = rig.configs.map((config) =>
      scopeTargetConfigV1(config, rig.configs[0].repository, APP_INSTALLATION, {
        issueOnly: true,
      })
    );
    const now = rig.clock.now();
    const delivering = rig.configs[1].repository;
    const id = `issue-${delivering.owner}-${delivering.name}-1`;
    const record = workRecord(id, {
      repository: delivering,
      source: { kind: "issue", id: "1", revision: SHA1 },
      target: {
        base: SHA1,
        branch: candidateBranch(workRecord(id).id),
        checkpoint: null,
        head: SHA3,
        pr: 7,
      },
      nextStep: "review",
      wait: { reason: "review_pending", since: now, until: now + 15 * 60_000 },
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
      updatedAt: now,
    });
    const port = new FakeGithub({
      baseSha: SHA1,
      issues: [{ number: 1, title: "issue 1", body: "" }],
      candidateLifecycle: {
        refs: {
          [`refs/heads/${rig.configs[1].baseBranch}`]: SHA1,
          [`refs/heads/${record.target.branch}`]: SHA3,
        },
        pullRequests: [{
          number: 7,
          title: "repair",
          body: "Resolves #1",
          state: "open",
          head: SHA3,
          base: SHA1,
          mergeSha: null,
          headRef: record.target.branch!,
          baseRef: rig.configs[1].baseBranch,
          author: "ubiquity-sentinel[bot]",
          createdAt: now,
          updatedAt: now,
          mergedAt: null,
          reviewDecision: "none",
        }],
      },
    });
    port.releasedHead = SHA3;
    port.lastReviewTask = {
      issueNumber: 1,
      title: "issue 1",
      body: "",
      digest: await reviewTaskStatementDigest({
        issueNumber: 1,
        title: "issue 1",
        body: "",
      }),
    };
    port.drainReviews = (request) => {
      port.drains.push(request);
      port.completeReview([], rig.clock.now());
      return Promise.resolve(portOk({
        ok: true,
        operations: [{
          operationKey: reviewOperationKey(7, SHA3, 1),
          outcome: "settled",
          processSettled: true,
          durable: true,
          phase: "published",
          fault: null,
        }],
        faults: [],
        deadline: request.deadline,
        interrupted: false,
        completedAt: rig.clock.now(),
      }));
    };
    const seeded = await state.writeRepair(
      parseRepairStateSnapshotV1(seededSnapshot([record], {
        updatedAt: now,
        reservations: [
          reservation(`review-${id}`, {
            repository: delivering,
            taskId: record.id,
            head: SHA3,
            purpose: "review_request",
            outcome: "submitted",
            createdAt: now,
            settledAt: now,
          }),
        ],
      })),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    let reads = 0;
    const read = state.readRepair.bind(state);
    state.readRepair = () => {
      reads++;
      return read();
    };
    const calls: ProgressCallV1[] = [];
    await runActionsTargetCycles(targetCycleInput(rig, {
      state,
      budget: new RollingStartBudget({
        state,
        clock: rig.clock,
        configs: rig.configs,
      }),
      composeGithub: (config) =>
        config.repository.name === FOREIGN_REPO ? port : new FakeGithub(),
      progressComments: recording(calls, () => reads, witness),
    }));
    return { calls, port, id };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("progress after-state: a continuation's write reaches its own and every later target's comments", async () => {
  const { calls, port, id } = await continuationScenario();
  assert.ok(port.calls.includes("merge"), "the finish continuation merges");
  assert.deepEqual(calls.map((call) => call.target).sort(), [
    FOREIGN_REPO,
    "sentinel",
    THIRD_REPO,
  ]);
  for (const call of calls) {
    assert.equal(
      call.after,
      call.authoritative,
      call.target + " compares against the authoritative after-state",
    );
  }
  const own = calls.find((call) => call.target === FOREIGN_REPO)!;
  const delivered = own.records.find((row) => row.id === id);
  assert.ok(delivered !== undefined);
  assert.notEqual(
    delivered.nextStep,
    "review",
    "the delivering target compares against its post-continuation record",
  );
});

Deno.test("progress after-state: targets reread only after a finish that may have written", async () => {
  const { calls } = await continuationScenario();
  // Settlement order varies; at most one read before the continuation's write
  // and one after it, never one per target.
  assert.ok(
    new Set(calls.map((call) => call.reads)).size <= 2,
    JSON.stringify(calls.map((call) => [call.target, call.reads])),
  );
});
