import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  runActionsTargetCycles,
  scopeTargetConfigV1,
} from "../../src/host/actions.ts";
import { candidateBranch, reviewOperationKey } from "../../src/repair/keys.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { FakeGithub } from "../repair/helpers.ts";
import {
  makeRemoteCtx,
  reservation,
  SHA1,
  SHA2,
  SHA3,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";
import {
  APP_INSTALLATION,
  makeTargetHostRig,
  targetCycleInput,
} from "./actions-target-fixture.ts";

async function drainScenario(mode: "settled" | "fault" | "deadline") {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-target-drain-",
  });
  const slowEntered = Promise.withResolvers<void>();
  const slowRelease = Promise.withResolvers<void>();
  const fastMerged = Promise.withResolvers<void>();
  let slowSettled = false;
  let returned = false;
  let peakWrites = 0;
  let activeWrites = 0;
  let conflicts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  try {
    await Deno.mkdir(root + "/home");
    const remote = await makeRemoteCtx(root, testGitEnv(root + "/home"));
    const state = createRepairStateStore({
      scratchDir: root + "/state",
      remoteUrl: remote.remoteUrl,
    });
    const rig = makeTargetHostRig(["sentinel", "ai.ubq.fi"]);
    rig.configs = rig.configs.map((config) =>
      scopeTargetConfigV1(config, rig.configs[0].repository, APP_INSTALLATION, {
        issueOnly: true,
      })
    );
    const now = rig.clock.now();
    const ports = new Map<string, FakeGithub>();
    const charges = [];
    const work = [];
    for (const config of rig.configs) {
      const head = config.repository.name === "sentinel" ? SHA2 : SHA3;
      const id = `issue-${config.repository.owner}-${config.repository.name}-1`;
      const record = workRecord(id, {
        repository: config.repository,
        source: { kind: "issue", id: "1", revision: SHA1 },
        target: {
          base: SHA1,
          branch: candidateBranch(workRecord(id).id),
          checkpoint: null,
          head,
          pr: 7,
        },
        nextStep: "review",
        wait: {
          reason: "review_pending",
          since: now,
          until: now + 15 * 60_000,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 1 },
        updatedAt: now,
      });
      work.push(record);
      charges.push(
        reservation(`review-${id}`, {
          repository: config.repository,
          taskId: record.id,
          head,
          purpose: "review_request",
          outcome: "submitted",
          createdAt: now,
          settledAt: now,
        }),
      );
      const port = new FakeGithub({
        baseSha: SHA1,
        issues: [{ number: 1, title: "issue 1", body: "" }],
        candidateLifecycle: {
          refs: {
            [`refs/heads/${config.baseBranch}`]: SHA1,
            [`refs/heads/${record.target.branch}`]: head,
          },
          pullRequests: [{
            number: 7,
            title: "repair",
            body: "Resolves #1",
            state: "open",
            head,
            base: SHA1,
            mergeSha: null,
            headRef: record.target.branch!,
            baseRef: config.baseBranch,
            author: "ubiquity-sentinel[bot]",
            createdAt: now,
            updatedAt: now,
            mergedAt: null,
            reviewDecision: "none",
          }],
        },
      });
      port.releasedHead = head;
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
      const key = reviewOperationKey(7, head, 1);
      port.drainReviews = async (request) => {
        port.drains.push(request);
        if (config.repository.name === "sentinel") {
          slowEntered.resolve();
          await slowRelease.promise;
          slowSettled = true;
        }
        port.completeReview([], rig.clock.now());
        return portOk({
          ok: true,
          operations: [{
            operationKey: key,
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
        });
      };
      if (config.repository.name === "ai.ubq.fi") {
        const merge = port.mergePullRequest.bind(port);
        port.mergePullRequest = async (request) => {
          assert.equal(
            slowSettled,
            false,
            "the fast continuation does not await the unrelated owned producer",
          );
          if (mode === "fault") {
            fastMerged.resolve();
            throw new Error("fixture continuation failed");
          }
          const result = await merge(request);
          fastMerged.resolve();
          return result;
        };
      }
      ports.set(config.repository.name, port);
    }
    const seeded = await state.writeRepair(
      parseRepairStateSnapshotV1({
        version: "v1",
        kind: "repair_state_snapshot",
        stateHead: null,
        sequence: 1,
        updatedAt: now,
        incidents: [],
        evidence: [],
        work,
        reservations: charges,
        reviews: [],
        replays: [],
        releaseRequests: [],
        githubCooldowns: [],
        attemptMemory: [],
        lessons: [],
      }),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const read = state.readRepair.bind(state);
    const write = state.writeRepair.bind(state);
    state.writeRepair = async (next, expected) => {
      activeWrites++;
      peakWrites = Math.max(peakWrites, activeWrites);
      try {
        const current = await read();
        assert.ok(current.ok && current.value.status === "found");
        assert.equal(
          expected,
          current.value.head,
          "each ready continuation rereads the authoritative head",
        );
        const saved = await write(next, expected);
        if (saved.ok && saved.value.status === "conflict") conflicts++;
        return saved;
      } finally {
        activeWrites--;
      }
    };
    running = runActionsTargetCycles(
      targetCycleInput(rig, {
        state,
        budget: new RollingStartBudget({
          state,
          clock: rig.clock,
          configs: rig.configs,
        }),
        composeGithub: (config) => ports.get(config.repository.name)!,
      }),
    ).then((result) => {
      returned = true;
      return result;
    }, (error) => {
      returned = true;
      throw error;
    });
    void running.catch(() => {});
    await slowEntered.promise;
    const delivered = await Promise.race([
      fastMerged.promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 20_000);
      }),
    ]);
    const observed = await state.readRepair();
    assert.equal(
      delivered,
      true,
      "a ready target must deliver before waiting for all native drains: " +
        JSON.stringify({
          calls: ports.get("ai.ubq.fi")!.calls,
          work: observed.ok && observed.value.status === "found"
            ? observed.value.snapshot.work.map((row) => ({
              id: row.id,
              step: row.nextStep,
              blocker: row.blocker,
              wait: row.wait,
            }))
            : null,
        }),
    );
    assert.equal(returned, false, "the host still owns the unsettled review");
    if (mode === "deadline") rig.clock.advance(60 * 60_000);
    slowRelease.resolve();
    if (mode === "fault") {
      await assert.rejects(running, /fixture continuation failed/);
    } else await running;
    assert.equal(slowSettled, true);
    assert.equal(peakWrites, 1);
    assert.equal(conflicts, 0);
    const after = await state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.reservations.length,
      2,
      "no extra model admission is charged",
    );
    if (mode !== "fault") {
      assert.ok(ports.get("ai.ubq.fi")!.calls.includes("merge"));
    }
    if (mode === "deadline") {
      assert.equal(
        ports.get("sentinel")!.calls.includes("merge"),
        false,
        "no continuation effect starts after the original deadline",
      );
    }
    for (const port of ports.values()) {
      assert.equal(port.drains.length, 1);
      assert.equal(port.drains[0].deadline, now + 60 * 60_000);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    slowRelease.resolve();
    await running?.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("target drain: a completed later review merges while an earlier owned review remains unsettled", () =>
  drainScenario("settled"));
Deno.test("target drain: a failed continuation still settles every other owned review before throwing", () =>
  drainScenario("fault"));
Deno.test("target drain: expiry preserves the original deadline and starts no late continuation", () =>
  drainScenario("deadline"));
