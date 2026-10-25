/**
 * Base compare-and-swap in the repair loop: a merge that landed off its
 * reviewed base is never booked as a delivery (live 2026-10-24: Passport PRs
 * 154 and 171 merged off their reviewed bases), and a merge the port refused
 * on a moved base backs off with its intent until the next run's
 * reconciliation replaces it with the base refresh.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubPort } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";
import { MERGED_OFF_TIP_PREFIX } from "../../src/repair/merge-off-tip.ts";
import {
  mergeIntentKey,
  reviewOperationKey,
  reviewReceiptId,
} from "../../src/repair/keys.ts";
import { REPO_2 } from "../budget/helpers.ts";
import { assertGen80Parses, gen80Available } from "../state/gen77-contracts.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import type { FakeGithubOptionsV1 } from "./helpers.ts";
import { exactOpenPr } from "./loop-candidate-fixtures.ts";
import { makeRig, seededSnapshot, SHA4 } from "./loop-rig.ts";
import { completedReceipt, deliveryRecord } from "./loop-review-fixtures.ts";

const BRANCH = "sentinel/repair/issue-1";

async function seededRig(
  prefix: string,
  github: FakeGithubOptionsV1,
  intentAt: number | null = null,
) {
  const rig = await makeRig(prefix, {
    summaries: false,
    configOverrides: { repository: REPO_2 },
    github,
  });
  const receipt = completedReceipt(7, SHA3, SHA1, {
    repository: REPO_2,
    id: await reviewReceiptId(reviewOperationKey(7, SHA3, 1), SHA3),
  });
  const record = deliveryRecord(SHA3, {
    repository: REPO_2,
    intent: intentAt === null ? null : {
      kind: "merge",
      key: mergeIntentKey(7, SHA3),
      startedAt: intentAt,
      branch: BRANCH,
      expectedHead: SHA3,
      observedBase: SHA1,
      pr: 7,
      requestId: receipt.requestId,
      resultId: receipt.resultId,
    },
  });
  const written = await rig.store.writeRepair(
    seededSnapshot([record], { reviews: [receipt] }),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  return { rig, record, receipt };
}

function parentsReader(
  github: GitHubPort,
  answer: (sha: GitSha) => Awaited<
    ReturnType<NonNullable<GitHubPort["readCommitParents"]>>
  >,
): GitSha[] {
  const reads: GitSha[] = [];
  github.readCommitParents = (sha) => {
    reads.push(sha);
    return Promise.resolve(answer(sha));
  };
  return reads;
}

Deno.test("merge base CAS: an off-tip merge result parks the record and books no delivery", async () => {
  const { rig } = await seededRig("cas-off-tip", {
    mergeOutcome: {
      outcome: "merged_off_tip",
      head: SHA3,
      mergeSha: SHA4,
      parents: [SHA2, SHA3],
    },
    candidateLifecycle: {
      refs: { [`refs/heads/${BRANCH}`]: SHA3 },
      pullRequests: [exactOpenPr(7, SHA3, BRANCH)],
    },
  });
  try {
    const outcome = await rig.entry();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 1);
    assert.equal(state.releaseRequests.length, 0, "never booked");
    const work = state.work[0];
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.intent, null, "the resolved merge intent is cleared");
    assert.equal(work.blocker?.kind, "other");
    assert.equal(
      work.blocker?.message,
      `${MERGED_OFF_TIP_PREFIX}merge ${SHA4} has parents ${SHA2},${SHA3}, not ${SHA1},${SHA3}`,
    );
    assert.equal(work.target.pr, 7, "the merged PR identity is retained");
    assert.equal(
      rig.github.calls.filter((c) => c.startsWith("closeIssue")).length,
      0,
    );
    // The park is an existing transition the rollback runtime still parses.
    if (await gen80Available()) await assertGen80Parses(state);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("merge base CAS: a merge intent reconciled against a merged pull request is booked only on its reviewed base", async () => {
  const merged = {
    ...exactOpenPr(7, SHA3, BRANCH),
    state: "merged" as const,
    mergeSha: SHA4,
    mergedAt: T0,
  };
  const lifecycle = {
    refs: { [`refs/heads/${BRANCH}`]: SHA3 },
    pullRequests: [merged],
  };

  // Off its reviewed base (an earlier run's lost merge response or state
  // write): parked, never a release request.
  const off = await seededRig("cas-reconcile-off", {
    candidateLifecycle: lifecycle,
  }, T0);
  try {
    const reads = parentsReader(
      off.rig.github,
      () => portOk([SHA2, SHA3]),
    );
    const outcome = await off.rig.entry();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await off.rig.snapshot();
    assert.deepEqual(reads, [SHA4]);
    assert.equal(state.releaseRequests.length, 0, "never booked");
    assert.equal(state.work[0].nextStep, "blocked");
    assert.equal(state.work[0].intent, null);
    assert.equal(
      state.work[0].blocker?.message,
      `${MERGED_OFF_TIP_PREFIX}merge ${SHA4} has parents ${SHA2},${SHA3}, not ${SHA1},${SHA3}`,
    );
    assert.equal(
      off.rig.github.calls.filter((call) => call === "merge").length,
      0,
    );
    if (await gen80Available()) await assertGen80Parses(state);
  } finally {
    await off.rig.ctx.cleanup();
  }

  // An unreadable merge commit is re-read after one poll with the intent
  // kept: never booked unproven.
  const unread = await seededRig("cas-reconcile-unread", {
    candidateLifecycle: lifecycle,
  }, T0);
  try {
    parentsReader(
      unread.rig.github,
      () => portError("unavailable", "commit read failed"),
    );
    await unread.rig.entry();
    const state = await unread.rig.snapshot();
    assert.equal(state.releaseRequests.length, 0);
    assert.equal(state.work[0].nextStep, "delivery");
    assert.equal(state.work[0].intent?.kind, "merge");
    assert.equal(state.work[0].wait?.reason, "unavailable");
    assert.equal(
      state.work[0].wait?.until,
      unread.rig.clock.now() + CHECK_POLL_MS,
    );
  } finally {
    await unread.rig.ctx.cleanup();
  }

  // Exactly [reviewed base, head]: the merge is booked as before.
  const exact = await seededRig("cas-reconcile-exact", {
    candidateLifecycle: lifecycle,
  }, T0);
  try {
    parentsReader(exact.rig.github, () => portOk([SHA1, SHA3]));
    await exact.rig.entry();
    const state = await exact.rig.snapshot();
    assert.equal(state.releaseRequests.length, 1);
    assert.equal(state.releaseRequests[0].revision, SHA4);
    assert.equal(state.work[0].blocker, null);
  } finally {
    await exact.rig.ctx.cleanup();
  }
});

Deno.test("merge base CAS: a merge refused on a moved base backs off and the next run refreshes instead", async () => {
  // A fresh merge intent (a merge sent within the last poll may still be
  // landing) is re-armed; the port refuses it because the base moved.
  const { rig } = await seededRig("cas-moved-base", {
    baseSha: SHA2,
    mergeOutcome: { outcome: "blocked", reason: "base_mismatch", head: SHA3 },
    candidateLifecycle: {
      refs: { [`refs/heads/${BRANCH}`]: SHA3 },
      pullRequests: [exactOpenPr(7, SHA3, BRANCH)],
    },
  }, T0);
  try {
    const prepared: GitSha[] = [];
    rig.github.prepareBaseRefresh = (request) => {
      prepared.push(request.expectedBase);
      return Promise.resolve(portError("unavailable", "prepared unavailable"));
    };
    await rig.entry();
    let state = await rig.snapshot();
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 1);
    assert.equal(state.releaseRequests.length, 0);
    assert.equal(state.work[0].intent?.kind, "merge", "the intent is kept");
    assert.equal(state.work[0].wait?.reason, "backoff");
    assert.deepEqual(prepared, []);

    rig.clock.advance(CHECK_POLL_MS + 1);
    await rig.entry();
    state = await rig.snapshot();
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      1,
      "the refused merge is not re-armed on the moved base",
    );
    assert.equal(state.work[0].intent?.kind, "base_refresh");
    assert.equal(state.work[0].intent?.observedBase, SHA2);
    assert.equal(state.work[0].target.base, SHA1, "still the reviewed base");
    assert.equal(state.releaseRequests.length, 0);
    assert.equal(rig.model.requests.length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});
