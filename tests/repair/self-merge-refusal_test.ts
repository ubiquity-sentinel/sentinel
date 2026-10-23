/**
 * A self-merge refusal the trusted port answers before any write (CI pipeline
 * identity, preserved CI binding or tested tree mismatch) parks the record for
 * the owner; a transport failure keeps the bounded unavailable wait.
 */
import assert from "node:assert/strict";
import { portError } from "../../src/contracts/ports.ts";
import { reviewOperationKey, reviewReceiptId } from "../../src/repair/keys.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";
import { SHA1, SHA3 } from "../state/helpers.ts";
import { exactOpenPr } from "./loop-candidate-fixtures.ts";
import { completedReceipt, deliveryRecord } from "./loop-review-fixtures.ts";
import { LOCAL_SENTINEL_REPO, makeRig, seededSnapshot } from "./loop-rig.ts";

async function refusalRig(name: string, error: ReturnType<typeof portError>) {
  const rig = await makeRig(name, {
    summaries: false,
    localScope: true,
    github: {
      candidateLifecycle: {
        refs: { "refs/heads/sentinel/repair/issue-1": SHA3 },
        pullRequests: [exactOpenPr(7, SHA3, "sentinel/repair/issue-1")],
      },
    },
  });
  const record = deliveryRecord(SHA3, { repository: LOCAL_SENTINEL_REPO });
  const receipt = completedReceipt(7, SHA3, SHA1, {
    repository: LOCAL_SENTINEL_REPO,
    id: await reviewReceiptId(reviewOperationKey(7, SHA3, 1), SHA3),
  });
  const written = await rig.store.writeRepair(
    seededSnapshot([record], { reviews: [receipt] }),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  let merges = 0;
  rig.github.mergePullRequest = () => {
    merges++;
    return Promise.resolve(error);
  };
  return { rig, merges: () => merges };
}

Deno.test("self merge: a pre-write trusted validation refusal parks the record for the owner", async () => {
  const { rig, merges } = await refusalRig(
    "self-merge-refusal",
    portError("invalid", "self merge trusted CI pipeline changed"),
  );
  try {
    await rig.run();
    const state = await rig.snapshot();
    assert.equal(merges(), 1);
    assert.equal(state.work[0].nextStep, "blocked");
    assert.equal(state.work[0].wait, null);
    assert.equal(state.work[0].intent, null);
    assert.equal(
      state.work[0].blocker?.message,
      "self merge refused by trusted validation; owner action required: self merge trusted CI pipeline changed",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("self merge: a transport failure keeps the bounded unavailable wait and the merge intent", async () => {
  const { rig, merges } = await refusalRig(
    "self-merge-unavailable",
    portError("unavailable", "merge transport unavailable"),
  );
  try {
    await rig.run();
    const state = await rig.snapshot();
    assert.equal(merges(), 1);
    assert.equal(state.work[0].nextStep, "delivery");
    assert.equal(state.work[0].wait?.reason, "unavailable");
    assert.equal(
      (state.work[0].wait?.until ?? 0) - (state.work[0].wait?.since ?? 0),
      CHECK_POLL_MS,
    );
    assert.equal(state.work[0].intent?.kind, "merge");
  } finally {
    await rig.ctx.cleanup();
  }
});
