/**
 * Sentinel #330: ready reviewed records of one repository land as one
 * validated train per pass (one train ref, one CI run, k ordered merges),
 * through the real delivery pass with the real deterministic git composer
 * over a temporary target repository, a fake GitHub surface and an injected
 * clock.
 */
import assert from "node:assert/strict";
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
import type { GitDeliveryTrainStore } from "../../src/state/delivery-train-store.ts";
import { FOREIGN_REPO } from "./hosted-autonomy-fixtures.ts";
import { DELIVERY_TRAIN_CI_WAIT_MS } from "../../src/contracts/delivery-train-ledger.ts";

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
  } = {},
) {
  const tmp = await Deno.makeTempDir({ prefix: `sentinel-${name}-world-` });
  const world = await makeTrainWorld(tmp, specs, { ledger: options.ledger });
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
