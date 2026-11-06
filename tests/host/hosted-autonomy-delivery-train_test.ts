/**
 * Sentinel #330: ready reviewed records of one repository land as one
 * validated train per pass (one train ref, one CI run, k ordered merges),
 * through the real delivery pass with the real deterministic git composer
 * over a temporary target repository, a fake GitHub surface and an injected
 * clock.
 */
import assert from "node:assert/strict";
import type {
  CiEffectV1,
  CiMinuteControllerV1,
  CiMinuteLedgerV1,
} from "../../src/contracts/ci-minute-budget.ts";
import {
  ciMonth,
  ciPolicyDigest,
} from "../../src/contracts/ci-minute-budget.ts";
import { createCiMinuteController } from "../../src/budget/ci-minutes.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { PreparedWorkflowBlobV1 } from "../../src/github/review-snapshot.ts";
import { createPrivateCiEffectResolver } from "../../ops/hosted-autonomy-github-jobs.ts";
import { createMetricsCollectorV1 } from "../../src/contracts/throughput-metrics-collector.ts";
import { HOSTED_AUTONOMY_PASS_DEADLINE_MS } from "../../ops/hosted-autonomy-continuation.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";
import {
  git,
  makeTrainWorld,
  type MemberSpecV1,
  type TrainWorldV1,
} from "./delivery-train-rig.ts";
import { T0 } from "../state/helpers.ts";
import { GitDeliveryTrainStore } from "../../src/state/delivery-train-store.ts";
import { FOREIGN_REPO } from "./hosted-autonomy-fixtures.ts";
import {
  DELIVERY_TRAIN_CI_WAIT_MS,
  type DeliveryTrainLedgerV1,
} from "../../src/contracts/delivery-train-ledger.ts";
import {
  createTrainComposerFor,
  type TrainGitOptionsV1,
} from "../../ops/hosted-autonomy-train-git.ts";

const FIVE: MemberSpecV1[] = [0, 1, 2, 3, 4].map((index) => ({
  file: `feature-${index}.txt`,
  content: `feature ${index}\n`,
}));

const published = (line: string) => /^train:[0-9a-f]{24}:published:/.test(line);

async function trainPass(
  name: string,
  specs: readonly MemberSpecV1[],
  options: {
    clock?: { now(): number };
    prepare?: (world: TrainWorldV1) => void;
    ledger?: "memory" | "git";
    ciMinutes?: CiMinuteControllerV1;
    baseWorkflow?: string;
    onPreparedWorkflowReader?: TrainGitOptionsV1["onPreparedWorkflowReader"];
  } = {},
) {
  const tmp = await Deno.makeTempDir({ prefix: `sentinel-${name}-world-` });
  const world = await makeTrainWorld(tmp, specs, {
    ledger: options.ledger,
    baseWorkflow: options.baseWorkflow,
    now: () => options.clock?.now() ?? T0,
    onPreparedWorkflowReader: options.onPreparedWorkflowReader,
  });
  options.prepare?.(world);
  const { rig, github } = await makeRig(name, {
    repair: repairSnapshot(
      world.members.map((m) => m.record),
      world.members.map((m) => m.receipt),
    ),
  });
  const surface = world.surface(github);
  const metrics = createMetricsCollectorV1();
  const once = async (clock = options.clock) =>
    await run(rig, surface, {
      deliveryTrain: world.trainDeps,
      metrics,
      ...(options.ciMinutes === undefined
        ? {}
        : { ciMinutes: options.ciMinutes }),
      ...(clock === undefined ? {} : { clock }),
    });
  const cleanup = async () => {
    await Deno.remove(rig.tmp, { recursive: true });
    await Deno.remove(tmp, { recursive: true });
  };
  return { rig, world, metrics, once, cleanup };
}

async function steps(rig: Awaited<ReturnType<typeof makeRig>>["rig"]) {
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  return new Map(read.value.snapshot.work.map((r) => [r.id, r.nextStep]));
}

function counts(metrics: ReturnType<typeof createMetricsCollectorV1>) {
  const { trainsBuilt, targetCiRunsTriggered, mergesCompleted } = metrics
    .snapshot({
      cycle: { runId: 1, attempt: 1 },
      startedAtMs: 0,
      finishedAtMs: 1,
    }).counts;
  return { trainsBuilt, targetCiRunsTriggered, mergesCompleted };
}

Deno.test("CI round2 one-day held train starts its durable CI window at publication and preserves it across restart until real expiry", async () => {
  let now = T0, allowed = false;
  const fixture = await trainPass(
    "synthetic-calendar-window",
    FIVE.slice(0, 2),
    {
      ledger: "git",
      clock: { now: () => now },
      prepare: (world) => {
        world.ci = () => "pending";
      },
      ciMinutes: {
        active: true,
        reserve: () =>
          Promise.resolve(
            allowed
              ? { kind: "admitted", reservationDigest: "a".repeat(64) }
              : {
                kind: "held",
                retryAt: now + 86400000,
                reason: "calendar_allowance",
              },
          ),
      },
    },
  );
  try {
    await fixture.once();
    const held = (await fixture.world.ledger()).train;
    assert.ok(held);
    assert.equal(held.phase, "publishing");
    assert.equal(held.ciStartedAt, null);
    assert.equal(counts(fixture.metrics).targetCiRunsTriggered, 0);
    now += 86400000;
    allowed = true;
    await fixture.once();
    const published = (await fixture.world.ledger()).train;
    assert.ok(published);
    assert.equal(published.phase, "published");
    assert.equal(published.createdAt, held.createdAt);
    assert.equal(published.ciStartedAt, now);
    assert.equal(published.operationId, held.operationId);
    assert.equal(published.sha, held.sha);
    const startedAt = published.ciStartedAt;
    const root = fixture.world.bare.slice(
      0,
      fixture.world.bare.lastIndexOf("/"),
    );
    const restarted = new GitDeliveryTrainStore({
      scratchDir: `${root}/restart-ledger`,
      remoteUrl: `${root}/state-remote.git`,
    });
    const loaded = await restarted.read(FOREIGN_REPO);
    assert.ok(loaded?.ledger.train);
    assert.equal(loaded.ledger.train.ciStartedAt, startedAt);
    fixture.world.trainDeps.journal = restarted;
    for (const ciStartedAt of [null, published.createdAt - 1, "invalid"]) {
      const invalid: unknown = {
        ...loaded.ledger,
        train: { ...loaded.ledger.train, ciStartedAt },
      };
      assert.equal(
        await restarted.write({
          repository: FOREIGN_REPO,
          expectedHead: loaded.head,
          ledger: invalid as DeliveryTrainLedgerV1,
        }),
        null,
      );
    }
    now = startedAt! + DELIVERY_TRAIN_CI_WAIT_MS;
    await fixture.once();
    const pending = (await fixture.world.ledger()).train;
    assert.ok(pending);
    assert.equal(pending.phase, "published");
    assert.equal(pending.ciStartedAt, startedAt);
    assert.equal(pending.sha, held.sha);
    assert.equal(counts(fixture.metrics).targetCiRunsTriggered, 1);
    now++;
    const expired = await fixture.once();
    assert.equal((await fixture.world.ledger()).train, null);
    assert.ok(
      expired.actions.some((action) =>
        action.endsWith(":dissolved:ci_unavailable")
      ),
      JSON.stringify(expired.actions),
    );
    assert.deepEqual(fixture.world.merges, []);
    assert.equal(counts(fixture.metrics).targetCiRunsTriggered, 1);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("CI round2 held train can dissolve on base change without any CI start timestamp or dispatch", async () => {
  let observation: "initial" | "unavailable" | "moved" = "initial";
  const fixture = await trainPass("synthetic-held-change", FIVE.slice(0, 2), {
    ledger: "git",
    prepare: (world) => {
      const surface = world.surface;
      world.surface = (base) => ({
        ...surface(base),
        readBaseTip: () =>
          Promise.resolve(
            observation === "unavailable"
              ? null
              : observation === "moved"
              ? world.members[0].head
              : world.initialTip,
          ),
      });
    },
    ciMinutes: {
      active: true,
      reserve: () =>
        Promise.resolve({
          kind: "held",
          retryAt: T0 + 86400000,
          reason: "calendar_allowance",
        }),
    },
  });
  try {
    await fixture.once();
    const held = (await fixture.world.ledger()).train;
    assert.ok(held);
    assert.equal(held.ciStartedAt, null);
    const journal = fixture.world.trainDeps.journal;
    let ended = false;
    fixture.world.trainDeps.journal = {
      read: (repository) => journal.read(repository),
      write: async (input) => {
        const result = await journal.write(input);
        if (input.ledger.train === null && result?.status === "applied") {
          ended = true;
        }
        return result;
      },
    };
    observation = "unavailable";
    const unavailable = await fixture.once();
    const preserved = (await fixture.world.ledger()).train;
    assert.equal(preserved?.operationId, held.operationId);
    assert.equal(preserved?.sha, held.sha);
    assert.equal(preserved?.ciStartedAt, null);
    assert.equal(ended, false);
    assert.ok(
      unavailable.actions.some((action) => action.endsWith(":base_unreadable")),
      JSON.stringify(unavailable.actions),
    );
    observation = "moved";
    const result = await fixture.once();
    assert.ok(ended, JSON.stringify(result.actions));
    assert.notEqual(
      (await fixture.world.ledger()).train?.operationId,
      held.operationId,
    );
    assert.ok(
      result.actions.some((action) => action.endsWith(":dissolved:base_moved")),
      JSON.stringify(result.actions),
    );
    assert.equal(counts(fixture.metrics).targetCiRunsTriggered, 0);
    assert.deepEqual(await fixture.world.trainRefs(), []);
    assert.deepEqual(fixture.world.merges, []);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("CI acceptance train qualifies unpublished local commit before push and dispatch and restores identical SHA in a fresh directory", async () => {
  const readers = new Map<
    string,
    (head: GitSha, deadline: number) => Promise<PreparedWorkflowBlobV1 | null>
  >();
  const key = `${FOREIGN_REPO.owner}/${FOREIGN_REPO.name}`;
  const register: NonNullable<TrainGitOptionsV1["onPreparedWorkflowReader"]> = (
    repo,
    reader,
  ) => {
    readers.set(`${repo.owner}/${repo.name}`, reader);
  };
  const ciMinutes: CiMinuteControllerV1 = {
    active: true,
    reserve: (effect, deadline) => controller.reserve(effect, deadline),
  };
  const fixture = await trainPass("synthetic-prepared-ci", FIVE.slice(0, 2), {
    ciMinutes,
    baseWorkflow:
      "on: [push, workflow_dispatch]\njobs:\n  validation:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - run: true\n",
    onPreparedWorkflowReader: register,
  });
  const { world, once, cleanup } = fixture;
  const fresh = await Deno.makeTempDir({ prefix: "synthetic-train-restart-" });
  let acknowledged = false, pushes = 0, dispatches = 0, prepared = "";
  const policy = {
    version: 1 as const,
    activated: true,
    monthlyLimit: 2000,
    managedLimit: 1450,
    securityReserve: 150,
    unmanagedReserve: 400,
    targets: [{
      owner: FOREIGN_REPO.owner,
      name: FOREIGN_REPO.name,
      repositoryId: 101,
      ceilingMinutes: 25,
    }],
    storageAcceptance: "a".repeat(64),
    ceilingQualification: "b".repeat(64),
  };
  let ledger: CiMinuteLedgerV1 = {
    version: 1,
    month: ciMonth(T0).month,
    policyDigest: ciPolicyDigest(policy),
    updatedAt: T0,
    sequence: 0,
    baselineMinutes: 0,
    watermark: null,
    reservations: [],
    observed: [],
  };
  let head = "1".repeat(40) as GitSha, sequence = 1;
  const blob = await git(
    world.bare,
    "rev-parse",
    `${world.base}:.github/workflows/ci.yml`,
  );
  const decorate = (
    factory: NonNullable<typeof world.trainDeps.composerFor>,
  ): NonNullable<typeof world.trainDeps.composerFor> =>
  (repo) => {
    const composer = factory(repo);
    return composer === null ? null : {
      ...composer,
      async publish(input) {
        assert.equal(
          ledger.reservations.length,
          2,
          "push and dispatch are reserved before either effect",
        );
        assert.deepEqual(
          ledger.reservations.map((row) => row.chargedMinutes),
          [25, 25],
        );
        if (prepared !== "") {
          assert.equal(
            input.sha,
            prepared,
            "recovery must use the identical prepared commit",
          );
        }
        prepared = input.sha;
        pushes++;
        const result = await composer.publish(input);
        return acknowledged ? result : "ambiguous";
      },
      triggerCi() {
        assert.equal(ledger.reservations.length, 2);
        dispatches++;
        return Promise.resolve(true);
      },
    };
  };
  world.trainDeps.composerFor = decorate(world.trainDeps.composerFor!);
  const controller = createCiMinuteController({
    policy,
    clock: { now: () => T0 },
    authorizePolicy: (basis, _deadline, facts) =>
      Promise.resolve(
        ciPolicyDigest(basis) === ciPolicyDigest(policy) &&
          (facts === undefined ||
            facts.workflowBlob === blob && facts.jobs === 1 &&
              facts.runner === "ubuntu-latest" && facts.timeoutMinutes === 20),
      ),
    observe: (month) =>
      Promise.resolve({ month, complete: true, watermark: T0, jobs: [] }),
    resolve: createPrivateCiEffectResolver({
      policy,
      request: async (path) => {
        assert.equal(
          path.includes("/contents/"),
          false,
          "prepared train never requires remote workflow contents",
        );
        if (path.includes("/git/ref/")) {
          const ref = "refs/" + path.split("/git/ref/")[1];
          try {
            return {
              object: {
                sha: await git(world.bare, "rev-parse", "--verify", ref),
              },
            };
          } catch {
            return { object: { sha: world.initialTip } };
          }
        }
        if (path.includes("/actions/runs?")) {
          return {
            total_count: dispatches > 0 ? 1 : 0,
            workflow_runs: dispatches > 0
              ? [{ id: 1, head_sha: prepared }]
              : [],
          };
        }
        return { id: 101, private: true, default_branch: "development" };
      },
      readPreparedWorkflow: async (effect, deadline) => {
        if (pushes === 0) {
          let visible = false;
          try {
            await git(world.bare, "cat-file", "-e", `${effect.head}^{commit}`);
            visible = true;
          } catch { /* exact prepared object is still private */ }
          assert.equal(visible, false);
        }
        return readers.get(key)?.(effect.head as GitSha, deadline) ?? null;
      },
    }),
    store: {
      read: () =>
        Promise.resolve(portOk({ head, ledger: structuredClone(ledger) })),
      readPrior: () => Promise.resolve(portOk({ head, ledger: null })),
      write(input) {
        assert.equal(input.expectedHead, head);
        ledger = structuredClone(input.ledger);
        head = String(++sequence).padStart(40, "0") as GitSha;
        return Promise.resolve(portOk({ status: "applied" as const, head }));
      },
    },
  });
  try {
    const first = await once();
    assert.ok(prepared, JSON.stringify(first.actions));
    assert.equal((await world.ledger()).train?.phase, "publishing");
    assert.equal(dispatches, 0);
    const restart = createTrainComposerFor({
      scratch: fresh,
      tokenFor: () => "synthetic-token",
      remoteUrlFor: () => `file://${world.bare}`,
      now: () => T0,
      onPreparedWorkflowReader: register,
    });
    assert.ok(restart(FOREIGN_REPO));
    assert.equal(
      await readers.get(key)!(prepared as GitSha, T0 + 60000),
      null,
      "fresh directory has no prepared object yet",
    );
    world.trainDeps.composerFor = decorate(restart);
    acknowledged = true;
    const second = await once();
    assert.deepEqual(world.merges, [500, 501], JSON.stringify(second.actions));
    assert.equal(dispatches, 1);
    assert.equal(ledger.reservations.length, 2);
    assert.equal((await world.ledger()).train, null);
  } finally {
    await cleanup();
    await Deno.remove(fresh, { recursive: true });
  }
});

Deno.test("CI acceptance train refuses regenerated identity mismatch before CI admission or target publication", async () => {
  let admissions = 0;
  const fixture = await trainPass(
    "synthetic-train-mismatch",
    FIVE.slice(0, 2),
    {
      ciMinutes: {
        active: true,
        reserve: () => {
          admissions++;
          return Promise.resolve({
            kind: "admitted",
            reservationDigest: "a".repeat(64),
          });
        },
      },
    },
  );
  const original = fixture.world.trainDeps.composerFor!;
  let compositions = 0;
  fixture.world.trainDeps.composerFor = (repo) => {
    const composer = original(repo);
    return composer === null ? null : {
      ...composer,
      async compose(input) {
        const steps = await composer.compose(input);
        compositions++;
        return compositions === 1 || steps === null
          ? steps
          : steps.map((step, index) =>
            index === steps.length - 1 && step.status === "joined"
              ? { ...step, commit: "f".repeat(40) }
              : step
          );
      },
    };
  };
  try {
    const result = await fixture.once();
    assert.ok(
      result.actions.some((action) =>
        action.endsWith(":restore_identity_mismatch")
      ),
      JSON.stringify(result.actions),
    );
    assert.equal(admissions, 0);
    assert.deepEqual(await fixture.world.trainRefs(), []);
    assert.equal((await fixture.world.ledger()).train?.phase, "publishing");
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("train: five reviewed records land on one train ref, one CI run and five ordered merges", async () => {
  const { rig, world, metrics, once, cleanup } = await trainPass(
    "train-five",
    FIVE,
  );
  try {
    const result = await once();
    const { actions } = result;
    const text = JSON.stringify(actions);
    assert.deepEqual(world.merges, [500, 501, 502, 503, 504], text);
    assert.equal(actions.filter(published).length, 1, text);
    assert.equal(world.ciReads.size, 1, "one CI run on the one train commit");
    const [trainSha] = [...world.ciReads];
    assert.ok(
      actions.some((a) =>
        a.includes(":built:") && a.includes(`sha=${trainSha}`)
      ),
      text,
    );
    // The landed train's ref is deleted in the same pass, after the ledger.
    assert.ok(actions.some((a) => /^train:[0-9a-f]{24}:ref_retired$/.test(a)));
    assert.deepEqual(await world.trainRefs(), []);
    assert.deepEqual((await world.ledger()).stale, []);
    // The landed tip is exactly the CI-tested train tree.
    assert.equal(
      await git(world.bare, "rev-parse", `${world.tip()}^{tree}`),
      await git(world.bare, "rev-parse", `${trainSha}^{tree}`),
    );
    for (const m of world.members) {
      assert.ok(
        actions.some((line) =>
          line.startsWith(`delivery:${m.id}:train_member:`) &&
          line.includes(`reviewed=${m.head}@${world.base}`)
        ),
        text,
      );
      assert.ok(
        actions.some((line) => line.startsWith(`merge:${m.id}:pr=${m.pr}:`)),
        text,
      );
      assert.ok(actions.includes(`delivery:${m.id}:foreign_merged`), text);
    }
    assert.ok(
      actions.includes(
        "delivery-summary:trains_built=1:target_ci_runs=1:merges=5",
      ),
      text,
    );
    assert.deepEqual(counts(metrics), {
      trainsBuilt: 1,
      targetCiRunsTriggered: 1,
      mergesCompleted: 5,
    });
    const ledger = await world.ledger();
    assert.equal(ledger.train, null);
    assert.deepEqual(
      ledger.landings.map((l) => l.pullRequest),
      [500, 501, 502, 503, 504],
    );
    // Each landing is on the tip the previous member left.
    assert.equal(ledger.landings[0].landedOn, world.initialTip);
    for (let i = 1; i < ledger.landings.length; i++) {
      assert.equal(
        ledger.landings[i].landedOn,
        ledger.landings[i - 1].revision,
      );
    }
    const after = await steps(rig);
    for (const m of world.members) assert.equal(after.get(m.id), "done", text);
  } finally {
    await cleanup();
  }
});

Deno.test("train: a red train drops its newest member, retries once in the same pass and lands four", async () => {
  const specs = [...FIVE.slice(0, 4), { file: "broken.txt", content: "x\n" }];
  const { rig, world, metrics, once, cleanup } = await trainPass(
    "train-red",
    specs,
  );
  try {
    const { actions } = await once();
    const text = JSON.stringify(actions);
    assert.deepEqual(world.merges, [500, 501, 502, 503], text);
    assert.equal(actions.filter(published).length, 2, text);
    // Both the red train's ref and the landed retry's ref are deleted.
    assert.deepEqual(await world.trainRefs(), []);
    assert.equal(world.ciReads.size, 2, text);
    const dropped = world.members[4];
    const line = actions.find((a) =>
      a.startsWith(`delivery:${dropped.id}:train_dropped:`)
    );
    assert.match(line ?? "", /:train_dropped:run=700\d:check=unit tests$/);
    assert.ok(actions.some((a) => /^train:[0-9a-f]{24}:ci_red:run=/.test(a)));
    assert.ok(
      actions.some((a) => /^train:[0-9a-f]{24}:built:attempt=2:/.test(a)),
      text,
    );
    assert.deepEqual(counts(metrics), {
      trainsBuilt: 2,
      targetCiRunsTriggered: 2,
      mergesCompleted: 4,
    });
    const ledger = await world.ledger();
    assert.equal(ledger.train, null);
    assert.equal(ledger.drops.length, 1);
    assert.equal(ledger.drops[0].recordId, dropped.id);
    assert.equal(ledger.drops[0].head, dropped.head);
    assert.equal(ledger.drops[0].check, "unit tests");
    assert.match(String(ledger.drops[0].runId), /^700\d$/);
    const after = await steps(rig);
    for (const m of world.members.slice(0, 4)) {
      assert.equal(after.get(m.id), "done");
    }
    assert.equal(after.get(dropped.id), "delivery");
    // Back on the per-record path it waits behind the moved tip.
    assert.ok(actions.includes(`delivery:${dropped.id}:base_moved`), text);
  } finally {
    await cleanup();
  }
});

Deno.test("train: a conflicting member leaves the train without holding it; the other four land", async () => {
  const specs = [...FIVE.slice(0, 4)];
  // The tip changed shared.txt too: this member cannot merge cleanly.
  specs.splice(2, 0, { file: "shared.txt", content: "ONE\n" });
  const { rig, world, metrics, once, cleanup } = await trainPass(
    "train-conflict",
    specs,
  );
  try {
    const { actions } = await once();
    const text = JSON.stringify(actions);
    const conflicting = world.members[2];
    assert.ok(
      actions.includes(`delivery:${conflicting.id}:train_left:conflict`),
      text,
    );
    assert.deepEqual(world.merges, [500, 501, 503, 504], text);
    assert.equal(actions.filter(published).length, 1);
    assert.deepEqual(counts(metrics), {
      trainsBuilt: 1,
      targetCiRunsTriggered: 1,
      mergesCompleted: 4,
    });
    const after = await steps(rig);
    assert.equal(after.get(conflicting.id), "delivery");
    assert.ok(actions.includes(`delivery:${conflicting.id}:base_moved`), text);
  } finally {
    await cleanup();
  }
});

Deno.test("train: a member whose patch would change on the train leaves it", async () => {
  const specs = [...FIVE.slice(0, 2)];
  // A clean merge onto the moved shared.txt, but not the reviewed patch.
  specs.push({ file: "shared.txt", content: "zero\none\ntwo\nthree\n" });
  const { world, once, cleanup } = await trainPass("train-patch", specs);
  try {
    const { actions } = await once();
    const text = JSON.stringify(actions);
    assert.ok(
      actions.includes(
        `delivery:${world.members[2].id}:train_left:patch_changed`,
      ),
      text,
    );
    assert.deepEqual(world.merges, [500, 501], text);
  } finally {
    await cleanup();
  }
});

Deno.test("train: a deadline mid-train stops with every intent persisted and no unrecorded merge; the next pass resumes", async () => {
  let now = T0 + 5_000_000;
  const clock = { now: () => now };
  const { rig, world, once, cleanup } = await trainPass(
    "train-deadline",
    FIVE,
    {
      clock,
      prepare: (w) => {
        w.onMerge = (count) => {
          if (count === 2) now += HOSTED_AUTONOMY_PASS_DEADLINE_MS;
        };
      },
    },
  );
  try {
    const first = await once();
    const text = JSON.stringify(first.actions);
    assert.deepEqual(world.merges, [500, 501], text);
    assert.ok(
      first.actions.includes("continuation:delivery:deferred_deadline"),
      text,
    );
    const ledger = await world.ledger();
    assert.equal(ledger.train?.phase, "merging");
    assert.equal(ledger.train?.pendingMerge, null);
    assert.deepEqual(
      ledger.train?.members.map((m) => m.revision !== null),
      [true, true, false, false, false],
    );
    // Every merge made is a recorded landing.
    assert.deepEqual(ledger.landings.map((l) => l.pullRequest), [500, 501]);

    now += 60_000;
    const second = await once();
    const text2 = JSON.stringify(second.actions);
    assert.deepEqual(world.merges, [500, 501, 502, 503, 504], text2);
    assert.equal(
      [...first.actions, ...second.actions].filter(published).length,
      1,
      "the same train ref",
    );
    assert.deepEqual(await world.trainRefs(), []);
    assert.equal(world.ciReads.size, 1, "the one CI run is not repeated");
    assert.equal((await world.ledger()).train, null);
    const after = await steps(rig);
    for (const m of world.members) assert.equal(after.get(m.id), "done", text2);
  } finally {
    await cleanup();
  }
});

Deno.test("train: unavailable or pending train CI is not red; the train waits, holds its repository and lands once green", async () => {
  let verdict: boolean | null | "pending" = null;
  const { rig, world, once, cleanup } = await trainPass("train-wait", FIVE, {
    prepare: (w) => {
      w.ci = () => verdict;
    },
  });
  try {
    const first = await once();
    const text = JSON.stringify(first.actions);
    assert.deepEqual(world.merges, [], text);
    assert.ok(
      first.actions.some((a) => /^train:[0-9a-f]{24}:ci_unavailable$/.test(a)),
      text,
    );
    assert.ok(
      !first.actions.some((a) => a.includes("train_dropped")),
      "unavailable is never red",
    );
    for (const m of world.members) {
      assert.ok(
        first.actions.some((a) =>
          a.startsWith(`delivery:${m.id}:train_in_flight:op=`)
        ),
        text,
      );
    }
    assert.equal((await world.ledger()).train?.phase, "published");
    verdict = "pending";
    const second = await once();
    assert.ok(
      second.actions.some((a) => /^train:[0-9a-f]{24}:ci_pending$/.test(a)),
      JSON.stringify(second.actions),
    );
    assert.deepEqual(world.merges, []);
    verdict = true;
    const third = await once();
    assert.deepEqual(
      world.merges,
      [500, 501, 502, 503, 504],
      JSON.stringify(third.actions),
    );
    assert.equal(
      [...first.actions, ...second.actions, ...third.actions].filter(
        published,
      ).length,
      1,
      "published once",
    );
    const after = await steps(rig);
    for (const m of world.members) assert.equal(after.get(m.id), "done");
  } finally {
    await cleanup();
  }
});

Deno.test("train: the git sidecar ledger carries an open train across passes, the runtime reads its hold, and the landed train leaves no ref", async () => {
  let verdict: boolean | null = null;
  const { rig, world, once, cleanup } = await trainPass("train-git", FIVE, {
    ledger: "git",
    prepare: (w) => {
      w.ci = () => verdict;
    },
  });
  try {
    const store = world.journal as GitDeliveryTrainStore;
    const first = await once();
    assert.deepEqual(world.merges, [], JSON.stringify(first.actions));
    const open = await store.readHolds();
    assert.ok(open.ok, JSON.stringify(open));
    assert.equal(open.value.length, 1);
    assert.deepEqual(open.value[0].repository, FOREIGN_REPO);
    assert.deepEqual(
      open.value[0].members,
      world.members.map((m) => m.id),
    );
    assert.equal((await world.trainRefs()).length, 1, "published train ref");
    verdict = true;
    const second = await once();
    assert.deepEqual(
      world.merges,
      [500, 501, 502, 503, 504],
      JSON.stringify(second.actions),
    );
    const closed = await store.readHolds();
    assert.ok(closed.ok);
    assert.deepEqual(closed.value, []);
    const ledger = await world.ledger();
    assert.equal(ledger.train, null);
    assert.equal(ledger.landings.length, 5);
    assert.deepEqual(ledger.stale, []);
    assert.deepEqual(await world.trainRefs(), []);
    const after = await steps(rig);
    for (const m of world.members) assert.equal(after.get(m.id), "done");
  } finally {
    await cleanup();
  }
});

Deno.test("train: CI that cannot start is unavailable, never red; after the wait bound the members fall back to the per-record path", async () => {
  let now = T0 + 5_000_000;
  const clock = { now: () => now };
  const { world, once, cleanup } = await trainPass("train-not-started", FIVE, {
    clock,
    prepare: (w) => {
      w.ci = () => null;
    },
  });
  try {
    const first = await once();
    assert.ok(
      first.actions.some((a) => /^train:[0-9a-f]{24}:ci_unavailable$/.test(a)),
      JSON.stringify(first.actions),
    );
    now += DELIVERY_TRAIN_CI_WAIT_MS + 60_000;
    const second = await once();
    const text = JSON.stringify(second.actions);
    assert.ok(
      second.actions.some((a) =>
        /^train:[0-9a-f]{24}:dissolved:ci_unavailable$/.test(a)
      ),
      text,
    );
    assert.ok(!second.actions.some((a) => a.includes(":ci_red:")), text);
    assert.deepEqual(world.merges, []);
    const ledger = await world.ledger();
    assert.equal(ledger.train, null);
    assert.deepEqual(
      ledger.drops.map((d) => [d.recordId, d.check, d.runId]),
      world.members.map((m) => [m.id, "ci_unavailable", null]),
    );
    // The members are back on the per-record path (off the moved tip).
    for (const m of world.members) {
      assert.ok(second.actions.includes(`delivery:${m.id}:base_moved`), text);
    }
    assert.deepEqual(await world.trainRefs(), [], "the ended ref is deleted");
  } finally {
    await cleanup();
  }
});

Deno.test("CI admission: train push hold preserves publishing intent and creates no target ref", async () => {
  const effects: CiEffectV1[] = [];
  const f = await trainPass("ci-train-push-hold", FIVE, {
    ciMinutes: {
      active: true,
      reserve(e) {
        effects.push(e);
        return Promise.resolve({
          kind: "held",
          retryAt: Date.now() + 60_000,
          reason: "calendar_allowance",
        });
      },
    },
  });
  try {
    const result = await f.once();
    assert.ok(effects.some((e) => e.kind === "train_push"));
    assert.ok(result.actions.some((a) => a.includes(":ci_minute_hold")));
    assert.deepEqual(await f.world.trainRefs(), []);
    assert.equal(f.world.merges.length, 0);
    assert.equal((await f.world.ledger()).train?.phase, "publishing");
  } finally {
    await f.cleanup();
  }
});

Deno.test("CI admission: explicit train-dispatch hold happens before push or published phase", async () => {
  const effects: CiEffectV1[] = [];
  let dispatches = 0;
  const f = await trainPass("ci-train-dispatch-hold", FIVE, {
    ciMinutes: {
      active: true,
      reserve(e) {
        effects.push(e);
        return Promise.resolve(
          e.kind === "train_dispatch"
            ? {
              kind: "held",
              retryAt: Date.now() + 60_000,
              reason: "calendar_allowance",
            }
            : { kind: "admitted", reservationDigest: "f".repeat(64) },
        );
      },
    },
    prepare(world) {
      const original = world.trainDeps.composerFor;
      world.trainDeps.composerFor = (repository) => {
        const composer = original(repository);
        if (composer !== null) {
          composer.triggerCi = () => {
            dispatches++;
            return Promise.resolve(true);
          };
        }
        return composer;
      };
    },
  });
  try {
    await f.once();
    assert.deepEqual(effects.map((e) => e.kind), [
      "train_push",
      "train_dispatch",
    ]);
    assert.equal(dispatches, 0);
    assert.deepEqual(await f.world.trainRefs(), []);
    assert.equal((await f.world.ledger()).train?.phase, "publishing");
  } finally {
    await f.cleanup();
  }
});
