// Red-train bisection: one rerun, base attribution first, at most 3 prefix
// probes per round, the longest green prefix lands, a red singleton ejects,
// and 6-hour pending CI is re-requested without blame (C12 WP3.2).
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type DeliveryTrainId,
  deliveryTrainIdV1,
  deliveryTrainManifestV1,
  type DeliveryTrainMemberV1,
  deliveryTrainPrefixV1,
  deliveryTrainRefV1,
  type DeliveryTrainV1,
  deliveryTrainV1,
} from "../../src/contracts/delivery-train.ts";
import {
  decideTrainBisectV1,
  TRAIN_CI_REREQUEST_MS,
  type TrainBisectDecisionV1,
  type TrainCiFactV1,
  trainEjectedMembersV1,
  trainPrefixIdsV1,
  trainProbePointsV1,
} from "../../src/repair/train-bisect.ts";
import {
  computeTrainOverlayV1,
  trainBaseTreeFromEntries,
} from "../../src/repair/train-overlay.ts";
import {
  selectActiveTrainV1,
  trainBuildCandidatesV1,
} from "../../src/repair/train-plan.ts";
import {
  BASE,
  BRANCH,
  change,
  manifest,
  member,
  range,
  REPOSITORY,
  sha,
} from "./train-fixtures.ts";

const NOW = 1_800_000_000_000;
const RED = (rerun: boolean, failed = ["test"]): TrainCiFactV1 => ({
  state: "red",
  failed,
  rerun,
});
const GREEN: TrainCiFactV1 = { state: "green" };

function decide(
  k: number,
  facts: Record<number, TrainCiFactV1>,
  baseRed: readonly string[] | null = [],
  now = NOW,
): TrainBisectDecisionV1 {
  return decideTrainBisectV1({
    now,
    members: range(1, k).map((pr) => member(pr)),
    ci: new Map(Object.entries(facts).map(([j, fact]) => [Number(j), fact])),
    baseRed,
  });
}

Deno.test("train bisect: probe points are at most 3, evenly spread and strictly inside", () => {
  assert.deepEqual(trainProbePointsV1(0, 22), [5, 11, 16]);
  assert.deepEqual(trainProbePointsV1(5, 11), [6, 8, 9]);
  assert.deepEqual(trainProbePointsV1(0, 4), [1, 2, 3]);
  assert.deepEqual(trainProbePointsV1(0, 3), [1, 2]);
  assert.deepEqual(trainProbePointsV1(8, 9), []);
  for (let lo = 0; lo < 64; lo++) {
    for (let hi = lo + 1; hi <= 64; hi++) {
      const points = trainProbePointsV1(lo, hi);
      assert.ok(points.length <= 3);
      assert.equal(new Set(points).size, points.length);
      assert.ok(points.every((p) => p > lo && p < hi));
      assert.equal(points.length, Math.min(3, hi - lo - 1));
    }
  }
});

Deno.test("train bisect: a green train lands whole; missing CI is requested; pending waits", () => {
  assert.deepEqual(decide(4, { 4: GREEN }), {
    kind: "land",
    prefix: 4,
    suspect: null,
    search: { lo: 0, hi: 4, round: 0 },
  });
  const requested = decide(4, { 4: { state: "missing" } });
  assert.equal(requested.kind, "ci");
  if (requested.kind === "ci") assert.deepEqual(requested.request, [4]);
  const absent = decide(4, {});
  assert.equal(absent.kind === "ci" && absent.request[0], 4);
  const waiting = decide(4, { 4: { state: "pending", since: NOW - 60_000 } });
  assert.equal(waiting.kind === "ci" && waiting.waiting[0], 4);
});

Deno.test("train bisect: CI pending for 6 hours is re-requested on the same train without blame", () => {
  const due = decide(4, {
    4: { state: "pending", since: NOW - TRAIN_CI_REREQUEST_MS },
  });
  assert.equal(due.kind, "ci");
  if (due.kind === "ci") {
    assert.deepEqual([due.rerequest, due.build, due.rerun, due.waiting], [
      [4],
      [],
      [],
      [],
    ]);
  }
  const early = decide(4, {
    4: { state: "pending", since: NOW - TRAIN_CI_REREQUEST_MS + 1 },
  });
  assert.equal(early.kind === "ci" && early.waiting[0], 4);
  const probe = decide(22, {
    22: RED(true),
    5: { state: "pending", since: NOW - TRAIN_CI_REREQUEST_MS },
    11: GREEN,
    16: RED(true),
  });
  assert.equal(probe.kind, "ci");
  if (probe.kind === "ci") assert.deepEqual(probe.rerequest, [5]);
});

Deno.test("train bisect: a red train gets one rerun, and a flaky green on rerun lands", () => {
  const first = decide(6, { 6: RED(false) });
  assert.equal(first.kind, "ci");
  if (first.kind === "ci") {
    assert.deepEqual([first.rerun, first.build], [[6], []]);
  }
  assert.equal(decide(6, { 6: GREEN }).kind, "land");
  const confirmed = decide(6, { 6: RED(true) });
  assert.equal(confirmed.kind, "ci");
  if (confirmed.kind === "ci") {
    assert.deepEqual([confirmed.build, confirmed.rerun], [[1, 3, 4], []]);
  }
});

Deno.test("train bisect: same checks red on T wait and evict nobody", () => {
  for (const facts of [{ 6: RED(true) }, { 6: RED(true, ["lint", "test"]) }]) {
    assert.deepEqual(decide(6, facts, ["test"]), {
      kind: "wait_base_red",
      prefix: 6,
      checks: ["test"],
    });
  }
  assert.equal(decide(6, { 6: RED(false) }, ["test"]).kind, "ci");
  assert.equal(decide(6, { 6: RED(true, ["lint"]) }, ["test"]).kind, "ci");
  assert.deepEqual(decide(6, { 6: RED(true) }, null), {
    kind: "wait_facts",
    prefix: 6,
    reason: "base_ci_unknown",
  });
  assert.deepEqual(decide(6, { 6: RED(true, []) }), {
    kind: "wait_facts",
    prefix: 6,
    reason: "red_without_checks",
  });
  const probeBaseRed = decide(6, {
    6: RED(true, ["lint"]),
    1: GREEN,
    3: RED(true, ["test"]),
    4: RED(true),
  }, ["test"]);
  assert.deepEqual(probeBaseRed, {
    kind: "wait_base_red",
    prefix: 3,
    checks: ["test"],
  });
  assert.deepEqual(
    trainEjectedMembersV1([{ member: member(1), ci: RED(true) }], ["test"]),
    [],
  );
});

Deno.test("train bisect: the boundary search lands the longest green prefix and names the suspect", () => {
  const facts: Record<number, TrainCiFactV1> = {
    22: RED(true),
    5: GREEN,
    11: RED(true),
    16: RED(true),
  };
  const round2 = decide(22, facts);
  assert.equal(round2.kind, "ci");
  if (round2.kind === "ci") {
    assert.deepEqual(round2.build, [6, 8, 9]);
    assert.deepEqual(round2.search, { lo: 5, hi: 11, round: 1 });
  }
  const landed = decide(22, { ...facts, 6: GREEN, 8: GREEN, 9: RED(true) });
  assert.equal(landed.kind, "land");
  if (landed.kind === "land") {
    assert.equal(landed.prefix, 8);
    assert.equal(landed.suspect?.pr, 9);
  }
  // Non-monotone facts: a longer green prefix supersedes a shorter red one.
  const later = decide(22, {
    22: RED(true),
    5: RED(true),
    11: GREEN,
    16: RED(true),
    12: GREEN,
    13: GREEN,
    14: GREEN,
    15: GREEN,
  });
  assert.equal(later.kind === "land" && later.prefix, 15);
});

Deno.test("train bisect: a red singleton ejects its member, alone or as the first prefix", () => {
  assert.equal(decide(1, { 1: RED(false) }).kind, "ci");
  const alone = decide(1, { 1: RED(true) });
  assert.equal(alone.kind === "eject" && alone.member.pr, 1);
  const first = decide(3, { 3: RED(true), 1: RED(true), 2: RED(true) });
  assert.equal(first.kind === "eject" && first.member.pr, 1);
  assert.deepEqual(
    trainEjectedMembersV1([
      { member: member(1), ci: RED(true) },
      { member: member(2), ci: RED(false) },
      { member: member(3), ci: GREEN },
      { member: member(4), ci: null },
      { member: member(5), ci: { state: "pending", since: NOW } },
      { member: member(6), ci: RED(true, ["lint"]) },
    ], ["test"]).map((m) => m.pr),
    [6],
  );
});

Deno.test("train bisect: prefix ids name the digest of each prefix manifest", async () => {
  const train = manifest(range(1, 4));
  const ids = await trainPrefixIdsV1(train);
  assert.equal(ids.length, 4);
  assert.equal(ids[3], await deliveryTrainIdV1(train));
  assert.equal(
    ids[1],
    await deliveryTrainIdV1(deliveryTrainPrefixV1(train, 2)),
  );
  assert.equal(new Set(ids).size, 4);
});

/**
 * A level-triggered world over the pure modules: GitHub keeps only the
 * refs (with their CI) and the tip; every pass re-derives everything.
 */
class World {
  tip: GitSha = BASE;
  now = NOW;
  readonly refs = new Map<
    DeliveryTrainId,
    { train: DeliveryTrainV1; ci: TrainCiFactV1 }
  >();
  readonly pool = new Map<number, DeliveryTrainMemberV1>();
  readonly landed: number[][] = [];
  readonly ejected: number[] = [];
  readonly probesPerRound = new Map<string, number>();
  readonly decisions: TrainBisectDecisionV1["kind"][] = [];
  #landings = 0;

  constructor(
    prs: readonly number[],
    readonly red: (prs: readonly number[], attempt: number) => boolean,
    readonly baseRed: readonly string[] = [],
    readonly seedSuspect = true,
  ) {
    for (const pr of prs) this.pool.set(pr, member(pr));
  }

  async #create(prs: readonly number[]): Promise<void> {
    const train = await deliveryTrainV1(
      deliveryTrainManifestV1({
        repository: REPOSITORY,
        branch: BRANCH,
        base: this.tip,
        members: prs.map((pr) => member(pr)),
      }),
    );
    if (!this.refs.has(train.trainId)) {
      this.refs.set(train.trainId, { train, ci: { state: "missing" } });
    }
  }

  #runCi(id: DeliveryTrainId, attempt: number): void {
    const entry = this.refs.get(id)!;
    const prs = entry.train.manifest.members.map((m) => m.pr);
    entry.ci = this.red(prs, attempt) ? RED(attempt > 1) : GREEN;
  }

  async pass(): Promise<void> {
    this.now += 10 * 60_000;
    const admissible = [...this.pool.values()];
    const singletons = await Promise.all(admissible.map(async (m) => {
      const id = await deliveryTrainIdV1(
        deliveryTrainManifestV1({
          repository: REPOSITORY,
          branch: BRANCH,
          base: this.tip,
          members: [m],
        }),
      );
      return { member: m, ci: this.refs.get(id)?.ci ?? null };
    }));
    const ejected = trainEjectedMembersV1(singletons, this.baseRed);
    for (const m of ejected) {
      // The runtime refreshes an ejected member: its old head leaves the pool.
      this.ejected.push(m.pr);
      this.pool.delete(m.pr);
    }
    const trains = [...this.refs.values()].map(({ train }) => ({
      ref: deliveryTrainRefV1(train.trainId),
      train,
    }));
    const selection = selectActiveTrainV1({
      repository: REPOSITORY,
      branch: BRANCH,
      base: this.tip,
      trains,
      admissible: [...this.pool.values()],
      ejected,
    });
    for (const id of [...selection.void, ...selection.obsolete]) {
      this.refs.delete(id);
    }
    if (selection.active === null) {
      const candidates = trainBuildCandidatesV1(
        [...this.pool.values()],
        ejected,
      );
      if (candidates.length === 0) return;
      const plan = computeTrainOverlayV1({
        base: this.tip,
        tree: trainBaseTreeFromEntries(new Map()),
        protectedPaths: [],
        candidates: candidates.map((m) => ({
          member: m,
          changes: [change(`src/${m.pr}.ts`, null, ["100644", m.pr])],
        })),
      });
      await this.#create(plan.members.map((m) => m.pr));
      return;
    }
    const active = selection.active.train;
    const ids = await trainPrefixIdsV1(active.manifest);
    const ci = new Map<number, TrainCiFactV1>();
    ids.forEach((id, index) => {
      const entry = this.refs.get(id);
      if (entry !== undefined) ci.set(index + 1, entry.ci);
    });
    const decision = decideTrainBisectV1({
      now: this.now,
      members: active.manifest.members,
      ci,
      baseRed: this.baseRed,
    });
    this.decisions.push(decision.kind);
    const prs = active.manifest.members.map((m) => m.pr);
    if (decision.kind === "ci") {
      const key = `${this.tip}:${prs.join(",")}:${decision.search.round}`;
      this.probesPerRound.set(
        key,
        (this.probesPerRound.get(key) ?? 0) + decision.build.length,
      );
      for (const j of decision.build) await this.#create(prs.slice(0, j));
      for (const j of [...decision.request, ...decision.rerequest]) {
        this.#runCi(ids[j - 1], 1);
      }
      for (const j of decision.rerun) this.#runCi(ids[j - 1], 2);
    } else if (decision.kind === "land") {
      const delivered = prs.slice(0, decision.prefix);
      this.landed.push(delivered);
      delivered.forEach((pr) => this.pool.delete(pr));
      this.tip = sha(0xf000 + ++this.#landings);
      if (decision.suspect !== null && this.seedSuspect) {
        await this.#create([decision.suspect.pr]);
      }
    }
  }

  async run(passes = 120): Promise<void> {
    for (let i = 0; i < passes && this.pool.size > 0; i++) await this.pass();
  }
}

const culprit = (bad: number) => (prs: readonly number[]) => prs.includes(bad);

Deno.test("train bisect: k=22 with the culprit at 9 lands prefix 8, ejects 9, and 10-22 form the next train", async () => {
  for (const seedSuspect of [true, false]) {
    const world = new World(range(1, 22), culprit(9), [], seedSuspect);
    await world.run();
    assert.deepEqual(
      world.landed,
      [range(1, 8), range(10, 22)],
      `seed=${seedSuspect}`,
    );
    assert.deepEqual(world.ejected, [9]);
    assert.ok(
      [...world.probesPerRound.values()].every((n) => n <= 3),
      JSON.stringify([...world.probesPerRound]),
    );
    assert.ok(world.probesPerRound.size > 0);
  }
});

Deno.test("train bisect: a flaky first run is green on its rerun and the whole train lands", async () => {
  const world = new World(
    range(1, 22),
    (prs, attempt) => prs.length === 22 && attempt === 1,
  );
  await world.run();
  assert.deepEqual(world.landed, [range(1, 22)]);
  assert.deepEqual(world.ejected, []);
  assert.equal(world.probesPerRound.size, 1);
  assert.deepEqual([...world.probesPerRound.values()], [0]);
});

Deno.test("train bisect: a base red on the same checks evicts nobody and builds no probe", async () => {
  const world = new World(range(1, 22), () => true, ["test"]);
  await world.run(30);
  assert.deepEqual([world.landed, world.ejected], [[], []]);
  assert.equal(world.refs.size, 1);
  assert.ok(
    world.decisions.slice(-5).every((kind) => kind === "wait_base_red"),
  );
});

Deno.test("train bisect: two culprits are each ejected and every landed prefix is green", async () => {
  const bad = (prs: readonly number[]) => prs.includes(4) || prs.includes(15);
  const world = new World(range(1, 22), bad);
  await world.run();
  assert.deepEqual(world.ejected, [4, 15]);
  assert.deepEqual(
    world.landed.flat().sort((a, b) => a - b),
    range(1, 22).filter((pr) => pr !== 4 && pr !== 15),
  );
  assert.ok(world.landed.every((prs) => !bad(prs)));
  assert.ok([...world.probesPerRound.values()].every((n) => n <= 3));
});
