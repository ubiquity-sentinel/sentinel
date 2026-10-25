// Active delivery-train selection: deterministic by member count and train
// id over the existing refs on tip T, never by time or list order (C12).
import assert from "node:assert/strict";
import {
  deliveryTrainManifestV1,
  type DeliveryTrainMemberV1,
  deliveryTrainRefV1,
  deliveryTrainV1,
} from "../../src/contracts/delivery-train.ts";
import {
  type ExistingTrainV1,
  selectActiveTrainV1,
  trainBuildCandidatesV1,
} from "../../src/repair/train-plan.ts";
import {
  BASE,
  BRANCH,
  manifest,
  member,
  range,
  REPOSITORY,
  sha,
  shuffle,
} from "./train-fixtures.ts";

async function existing(
  prs: readonly number[],
  base = BASE,
): Promise<ExistingTrainV1> {
  const train = await deliveryTrainV1(manifest(prs, base));
  return { ref: deliveryTrainRefV1(train.trainId), train };
}

function select(
  trains: readonly ExistingTrainV1[],
  admissible: readonly DeliveryTrainMemberV1[] = range(1, 30).map((pr) =>
    member(pr)
  ),
  ejected: readonly DeliveryTrainMemberV1[] = [],
) {
  return selectActiveTrainV1({
    repository: REPOSITORY,
    branch: BRANCH,
    base: BASE,
    trains,
    admissible,
    ejected,
  });
}

Deno.test("train plan: the valid train with the most members on T is active; the rest are probes", async () => {
  const full = await existing(range(1, 10));
  const probeA = await existing(range(1, 2));
  const probeB = await existing(range(1, 5));
  const selection = select([probeA, full, probeB]);
  assert.equal(selection.active?.train.trainId, full.train.trainId);
  assert.deepEqual(
    selection.probes,
    [probeA.train.trainId, probeB.train.trainId].sort(),
  );
  assert.deepEqual([
    selection.evidence,
    selection.void,
    selection.obsolete,
    selection.invalid,
  ], [[], [], [], []]);
});

Deno.test("train plan: a member-count tie is broken by the smallest train id, whatever the list order", async () => {
  const trains = await Promise.all(
    [[1, 2], [3, 4], [5, 6], [7, 8], [1, 9]].map((prs) => existing(prs)),
  );
  const smallest = trains.map((t) => t.train.trainId).sort()[0];
  const admissible = range(1, 9).map((pr) => member(pr));
  for (
    const order of [
      trains,
      [...trains].reverse(),
      shuffle(trains),
      shuffle(shuffle(trains)),
    ]
  ) {
    for (
      const pool of [admissible, [...admissible].reverse(), shuffle(admissible)]
    ) {
      const selection = select(order, pool);
      assert.equal(selection.active?.train.trainId, smallest);
      assert.deepEqual(selection, select(trains, admissible));
    }
  }
});

Deno.test("train plan: a train with an inadmissible or changed member is void and never active", async () => {
  const big = await existing(range(1, 6));
  const small = await existing([1, 2]);
  const admissible = range(1, 6).map((pr) =>
    pr === 4 ? member(4, { head: sha(77) }) : member(pr)
  );
  const selection = select([big, small], admissible);
  assert.equal(selection.active?.train.trainId, small.train.trainId);
  assert.deepEqual(selection.void, [big.train.trainId]);
  const withoutFive = select(
    [big],
    range(1, 6).filter((pr) => pr !== 5).map((pr) => member(pr)),
  );
  assert.equal(withoutFive.active, null);
  assert.deepEqual(withoutFive.void, [big.train.trainId]);
  const receipt = select(
    [big],
    range(1, 6).map((pr) =>
      member(pr, pr === 2 ? { receiptId: "review-receipt:new" } : {})
    ),
  );
  assert.deepEqual(receipt.void, [big.train.trainId]);
});

Deno.test("train plan: trains on another base, repository or branch are obsolete", async () => {
  const onT = await existing([1, 2]);
  const moved = await existing(range(1, 8), sha(5));
  const foreignRepo = await deliveryTrainV1(
    deliveryTrainManifestV1({
      repository: { owner: "other", name: "repo" },
      branch: BRANCH,
      base: BASE,
      members: range(1, 9).map((pr) => member(pr)),
    }),
  );
  const foreignBranch = await deliveryTrainV1(
    deliveryTrainManifestV1({
      repository: REPOSITORY,
      branch: "develop",
      base: BASE,
      members: range(1, 9).map((pr) => member(pr)),
    }),
  );
  const selection = select([
    moved,
    { ref: deliveryTrainRefV1(foreignRepo.trainId), train: foreignRepo },
    { ref: deliveryTrainRefV1(foreignBranch.trainId), train: foreignBranch },
    onT,
  ]);
  assert.equal(selection.active?.train.trainId, onT.train.trainId);
  assert.deepEqual(
    selection.obsolete,
    [moved, { train: foreignRepo }, { train: foreignBranch }].map((t) =>
      t.train.trainId
    ).sort(),
  );
});

Deno.test("train plan: a ref that does not name its manifest's digest is invalid", async () => {
  const good = await existing([1, 2]);
  const other = await existing(range(1, 5));
  const misnamed = { ref: good.ref, train: other.train };
  const selection = select([misnamed, {
    ref: "refs/heads/sentinel-train/xyz",
    train: good.train,
  }]);
  assert.equal(selection.active, null);
  assert.deepEqual(
    selection.invalid,
    ["refs/heads/sentinel-train/xyz", good.ref].sort(),
  );
  const twice = select([good, good]);
  assert.equal(twice.active?.train.trainId, good.train.trainId);
  assert.deepEqual(twice.probes, []);
});

Deno.test("train plan: a red singleton of an ejected member is kept as evidence; its other trains are void", async () => {
  const full = await existing(range(1, 6));
  const prefix = await existing([1, 2, 3]);
  const singleton = await existing([3]);
  const rest = await existing([1, 2, 4, 5, 6]);
  const ejected = [member(3)];
  const selection = select(
    [full, prefix, singleton, rest],
    range(1, 6).map((pr) => member(pr)),
    ejected,
  );
  assert.equal(selection.active?.train.trainId, rest.train.trainId);
  assert.deepEqual(selection.evidence, [singleton.train.trainId]);
  assert.deepEqual(
    selection.void,
    [full.train.trainId, prefix.train.trainId].sort(),
  );
  // Once the ejected member's head changes (refreshed), the evidence is void.
  const refreshed = select(
    [singleton],
    [member(3, { head: sha(99) })],
    ejected,
  );
  assert.deepEqual([refreshed.evidence, refreshed.void], [[], [
    singleton.train.trainId,
  ]]);
});

Deno.test("train plan: a new train is built from the admissible members minus the ejected, in train order", () => {
  const admissible = shuffle(range(1, 8).map((pr) => member(pr)));
  assert.deepEqual(
    trainBuildCandidatesV1(admissible, [
      member(5),
      member(2, { head: sha(1234) }),
    ]).map((m) => m.pr),
    [1, 2, 3, 4, 6, 7, 8],
  );
});
