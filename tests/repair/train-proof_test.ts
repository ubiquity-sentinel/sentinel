// Train landing recognition for C1's booking rule (C12 WP3.2).
import assert from "node:assert/strict";
import {
  deliveryTrainCommitMessageV1,
  deliveryTrainManifestV1,
  deliveryTrainParentsV1,
  deliveryTrainV1,
} from "../../src/contracts/delivery-train.ts";
import {
  type TrainLandingClaimV1,
  verifyTrainLandingV1,
} from "../../src/repair/train-proof.ts";
import {
  BASE,
  BRANCH,
  manifest,
  member,
  REPOSITORY,
  sha,
} from "./train-fixtures.ts";

const C = sha(0xc0ffee);

async function claim(
  overrides: Partial<TrainLandingClaimV1> = {},
): Promise<TrainLandingClaimV1> {
  const train = await deliveryTrainV1(manifest([2, 5, 9]));
  return {
    repository: REPOSITORY,
    branch: BRANCH,
    recordId: member(5).recordId,
    pr: 5,
    head: member(5).head,
    commit: {
      sha: C,
      parents: deliveryTrainParentsV1(train.manifest),
      message: deliveryTrainCommitMessageV1(train),
    },
    tip: C,
    commitReachable: null,
    ...overrides,
  };
}

Deno.test("train proof: a member landed at the tip or an ancestor of it is verified", async () => {
  const atTip = await verifyTrainLandingV1(await claim());
  assert.equal(atTip.ok, true);
  if (atTip.ok) {
    assert.equal(atTip.member.pr, 5);
    assert.equal(atTip.landed, C);
    assert.deepEqual(atTip.manifest, manifest([2, 5, 9]));
    assert.equal(
      atTip.trainId,
      (await deliveryTrainV1(manifest([2, 5, 9]))).trainId,
    );
  }
  const below = await verifyTrainLandingV1(
    await claim({ tip: sha(0xd00d), commitReachable: true }),
  );
  assert.equal(below.ok, true);
});

Deno.test("train proof: every mismatch refuses with its reason", async () => {
  const base = await claim();
  const reason = async (overrides: Partial<TrainLandingClaimV1>) => {
    const verdict = await verifyTrainLandingV1({ ...base, ...overrides });
    return verdict.ok ? "ok" : verdict.reason;
  };
  const other = await deliveryTrainV1(
    deliveryTrainManifestV1({
      repository: { owner: "other", name: "repo" },
      branch: BRANCH,
      base: BASE,
      members: [member(5)],
    }),
  );
  assert.equal(
    await reason({
      commit: { ...base.commit, message: "Merge pull request #5 from x/y" },
    }),
    "not_train",
  );
  assert.equal(
    await reason({
      commit: {
        ...base.commit,
        message: base.commit.message.replace("Delivers #102", "Delivers #103"),
      },
    }),
    "manifest_invalid",
  );
  assert.equal(
    await reason({
      commit: {
        ...base.commit,
        message: deliveryTrainCommitMessageV1(other),
        parents: [BASE, member(5).head],
      },
    }),
    "foreign_train",
  );
  assert.equal(await reason({ branch: "develop" }), "foreign_train");
  assert.equal(
    await reason({
      commit: { ...base.commit, parents: [BASE, member(5).head] },
    }),
    "parents_mismatch",
  );
  assert.equal(
    await reason({
      commit: { ...base.commit, parents: [...base.commit.parents].reverse() },
    }),
    "parents_mismatch",
  );
  assert.equal(await reason({ head: sha(4242) }), "not_member");
  assert.equal(await reason({ pr: 6 }), "not_member");
  assert.equal(await reason({ recordId: member(9).recordId }), "not_member");
  assert.equal(
    await reason({ tip: sha(0xd00d), commitReachable: false }),
    "not_landed",
  );
  assert.equal(
    await reason({ tip: sha(0xd00d), commitReachable: null }),
    "ancestry_unknown",
  );
});
