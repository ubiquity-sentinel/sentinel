/**
 * Owner rule 2026-10-30: a human merge completes a record. The runtime's
 * retired head park ("observed merged head identity mismatch") and its
 * moved-base park ("the merge landed off its reviewed base: ...") are
 * re-admitted to `review` when the record's own branch carries exactly one
 * merged pull on the repository's base branch; the record keeps its reviewed
 * head, base, counters, reservations and evidence. A park the runtime's own
 * trusted merge wrote stays refused.
 */
import assert from "node:assert/strict";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  applyHumanMergeReadmissions,
  decideHumanMergeHeadReadmission,
  type HumanMergeCandidateV1,
  planHumanMergeHeadReadmissions,
} from "../../ops/hosted-autonomy-human-merge-readmission.ts";
import type { HostedAutonomyHeadPullV1 } from "../../ops/hosted-autonomy-types.ts";
import { HUMAN_MERGE_HEAD_MISMATCH_BLOCKER } from "../../src/repair/human-merge.ts";
import { MERGED_OFF_TIP_PREFIX } from "../../src/repair/merge-off-tip.ts";
import { reservation, T0 } from "../state/helpers.ts";
import {
  BASE,
  blockedRecord,
  deliveryRecord,
  HEAD,
  SELF_REPO,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";

const BRANCH = "sentinel/repair/issue-ubiquity-sentinel-48";
const OFF_BASE_BLOCKER = `${MERGED_OFF_TIP_PREFIX}merge ` +
  "41cdcdf31e3f9cdaefcabe53469e1de5e4f5618e has parents " +
  "765268324fc101ef5cf82b12f1d38a9d2e1d9835,9f8e7d6c5b4a39281706f5e4d3c2b1a098765432, " +
  "not 3f6d0f5b0c6f1c4a2b8d9e7f6a5b4c3d2e1f0a9b,9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const NOW = T0 + 60_000;
const MOVED_HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

/** The exact diagnostics the retired runtime wrote: no PR, no intent. */
function parked(overrides: Record<string, unknown> = {}): WorkRecordV1 {
  return blockedRecord({
    target: {
      base: BASE,
      branch: BRANCH,
      checkpoint: null,
      head: HEAD,
      pr: null,
    },
    blocker: {
      kind: "other",
      message: HUMAN_MERGE_HEAD_MISMATCH_BLOCKER,
      since: T0 + 3000,
    },
    intent: null,
    wait: null,
    ...overrides,
  });
}

/** The moved-base park the runtime wrote: the reviewed pull is retained. */
function parkedOffBase(): WorkRecordV1 {
  return parked({
    target: {
      base: BASE,
      branch: BRANCH,
      checkpoint: null,
      head: HEAD,
      pr: 51,
    },
    blocker: { kind: "other", message: OFF_BASE_BLOCKER, since: T0 + 3000 },
  });
}

function mergedPull(
  overrides: Partial<HostedAutonomyHeadPullV1> = {},
): HostedAutonomyHeadPullV1 {
  return {
    number: 51,
    state: "closed",
    merged: true,
    headSha: MOVED_HEAD,
    headRef: BRANCH,
    baseRef: "development",
    author: "ubiquity-sentinel[bot]",
    ...overrides,
  };
}

const candidate: HumanMergeCandidateV1 = {
  id: TARGET,
  repository: SELF_REPO,
  branch: BRANCH,
  head: HEAD,
  pullRequest: null,
  parkedBy: "head_mismatch",
};

const offBaseCandidate: HumanMergeCandidateV1 = {
  ...candidate,
  pullRequest: 51,
  parkedBy: "merge_off_base",
};

const charge = (): BudgetReservationV1 =>
  reservation("human-merge-readmit-charge", {
    repository: SELF_REPO,
    taskId: TARGET,
    head: HEAD,
    attempt: 2,
    purpose: "review_request",
    outcome: "reserved",
    settledAt: null,
  });

/** The permanent backoff the completion step's queue guard wrote at review. */
function stuckReviewBackoff(): WorkRecordV1 {
  return deliveryRecord({
    nextStep: "review",
    blocker: null,
    wait: { reason: "backoff", since: T0 + 5000, until: null },
    intent: null,
  });
}

Deno.test("human merge readmission: only the exact retired park is planned", () => {
  assert.deepEqual(planHumanMergeHeadReadmissions(repairSnapshot([parked()])), [
    candidate,
  ]);
  assert.deepEqual(
    planHumanMergeHeadReadmissions(repairSnapshot([parkedOffBase()])),
    [offBaseCandidate],
    "the moved-base park keeps its reviewed pull and is planned too",
  );
  assert.deepEqual(
    planHumanMergeHeadReadmissions(repairSnapshot([deliveryRecord({})])),
    [],
    "an ordinary record is never planned",
  );
  assert.deepEqual(
    planHumanMergeHeadReadmissions(
      repairSnapshot([stuckReviewBackoff()]),
    ),
    [{
      id: TARGET,
      repository: SELF_REPO,
      branch: BRANCH,
      head: HEAD,
      pullRequest: 51,
      parkedBy: "review_backoff",
    }],
    "the stuck review backoff is planned for correction",
  );
  assert.deepEqual(
    planHumanMergeHeadReadmissions(repairSnapshot([deliveryRecord({
      nextStep: "review",
      blocker: null,
      wait: { reason: "backoff", since: T0 + 5000, until: T0 + 60_000 },
      intent: null,
    })])),
    [],
    "a bounded backoff is already retryable and is never rewritten",
  );
  const other = parked({
    blocker: {
      kind: "other",
      message: "observed merged head identity mismatch (old)",
      since: T0 + 3000,
    },
  });
  assert.deepEqual(planHumanMergeHeadReadmissions(repairSnapshot([other])), []);
  const busy = parked({
    intent: {
      kind: "review_request",
      key: "review:51:1",
      startedAt: T0,
      branch: BRANCH,
      expectedHead: HEAD,
      observedBase: BASE,
      pr: 51,
      requestId: "charge-1",
      resultId: null,
    },
  });
  assert.deepEqual(planHumanMergeHeadReadmissions(repairSnapshot([busy])), []);
});

Deno.test("human merge readmission: the merged pull on the base branch is restored", () => {
  const decision = decideHumanMergeHeadReadmission(
    candidate,
    [mergedPull()],
    "development",
  );
  assert.equal(decision.kind, "readmit");
  if (decision.kind !== "readmit") return;
  assert.equal(decision.readmission.pullRequest, 51);
  assert.equal(decision.readmission.detail, "human_merge_head_moved");
});

Deno.test("human merge readmission: a moved-base park readmits only a human merge", () => {
  const decision = decideHumanMergeHeadReadmission(
    offBaseCandidate,
    [mergedPull()],
    "development",
    "0x4007",
  );
  assert.equal(decision.kind, "readmit");
  if (decision.kind !== "readmit") return;
  assert.equal(decision.readmission.detail, "human_merge_merged_off_base");
  const refused = (mergedBy: string | null | undefined) => {
    const verdict = decideHumanMergeHeadReadmission(
      offBaseCandidate,
      [mergedPull()],
      "development",
      mergedBy,
    );
    return verdict.kind === "refused" ? verdict.reason : "readmit";
  };
  assert.equal(
    refused(undefined),
    "merge_actor_unreadable",
    "no merger read is not a human merge",
  );
  assert.equal(refused(null), "merge_actor_unreadable");
  assert.equal(
    refused("ubiquity-sentinel[bot]"),
    "merge_by_sentinel",
    "the runtime's own trusted off-base merge keeps its refusal",
  );
});

Deno.test("human merge readmission: the stuck review backoff re-admits only its merged human pull", () => {
  const stuck: HumanMergeCandidateV1 = {
    ...candidate,
    pullRequest: 51,
    parkedBy: "review_backoff",
  };
  const readmit = decideHumanMergeHeadReadmission(
    stuck,
    [mergedPull()],
    "development",
    "0x4007",
  );
  assert.equal(readmit.kind, "readmit");
  if (readmit.kind !== "readmit") return;
  assert.equal(readmit.readmission.detail, "human_merge_review_backoff");
  const refused = (mergedBy: string | null | undefined) => {
    const verdict = decideHumanMergeHeadReadmission(
      stuck,
      [mergedPull()],
      "development",
      mergedBy,
    );
    return verdict.kind === "refused" ? verdict.reason : "readmit";
  };
  assert.equal(refused(undefined), "merge_actor_unreadable");
  assert.equal(
    refused("ubiquity-sentinel[bot]"),
    "merge_by_sentinel",
    "a genuine queue-custody hold is never released",
  );
  assert.equal(
    decideHumanMergeHeadReadmission(
      stuck,
      [mergedPull({ number: 52 })],
      "development",
      "0x4007",
    ).kind,
    "refused",
    "a different pull never corrects the retained identity",
  );
  assert.equal(
    decideHumanMergeHeadReadmission(
      stuck,
      [mergedPull({ state: "open", merged: false })],
      "development",
      "0x4007",
    ).kind,
    "refused",
    "an open queue custody hold is never released",
  );
});

Deno.test("human merge readmission: the stuck review backoff clears its wait on the record", () => {
  const snapshot = repairSnapshot([stuckReviewBackoff()]);
  const applied = applyHumanMergeReadmissions(snapshot, [{
    id: TARGET,
    repository: SELF_REPO,
    pullRequest: 51,
    detail: "human_merge_review_backoff",
  }], NOW);
  const work = applied.work[0]!;
  assert.equal(work.nextStep, "review");
  assert.equal(work.wait, null, "the permanent wait is cleared");
  assert.equal(work.blocker, null);
  assert.equal(work.intent, null);
  assert.equal(work.target.pr, 51);
});

Deno.test("human merge readmission: an open, foreign or off-base pull is refused", () => {
  const refused = (
    pulls: readonly HostedAutonomyHeadPullV1[] | null,
    baseBranch: string | null = "development",
  ) => {
    const decision = decideHumanMergeHeadReadmission(
      candidate,
      pulls,
      baseBranch,
    );
    return decision.kind === "refused" ? decision.reason : "readmit";
  };
  assert.equal(refused(null), "pr_read_failed");
  assert.equal(refused([mergedPull()], null), "base_branch_unknown");
  assert.equal(refused([]), "pr_not_found");
  assert.equal(
    refused([mergedPull(), mergedPull({ number: 52 })]),
    "pr_ambiguous",
  );
  assert.equal(
    refused([mergedPull({ headRef: "sentinel/repair/other" })]),
    "pr_listing_mismatch",
  );
  assert.equal(
    refused([mergedPull({ state: "open", merged: false })]),
    "pr_not_merged",
  );
  assert.equal(
    refused([mergedPull({ baseRef: "main" })]),
    "pr_base_mismatch",
  );
  assert.equal(refused([mergedPull({ author: null })]), "pr_foreign");
  assert.equal(refused([mergedPull({ author: "someone" })]), "pr_foreign");
});

Deno.test("human merge readmission: the record returns to review with its ledger untouched", () => {
  const record = parked();
  const other = blockedRecord({ id: "issue-other" });
  const reservations = [charge()];
  const snapshot = repairSnapshot(
    [record, other],
    [],
    [],
    reservations,
  );
  const applied = applyHumanMergeReadmissions(snapshot, [{
    id: TARGET,
    repository: SELF_REPO,
    pullRequest: 51,
    detail: "human_merge_merged_off_base",
  }], NOW);
  const work = applied.work[0]!;
  assert.equal(work.nextStep, "review");
  assert.equal(work.target.pr, 51);
  assert.equal(work.target.head, HEAD);
  assert.equal(work.target.base, BASE);
  assert.equal(work.blocker, null);
  assert.equal(work.wait, null);
  assert.equal(work.intent, null);
  assert.equal(work.updatedAt, NOW);
  assert.deepEqual(work.counters, record.counters);
  assert.deepEqual(work.evidence, record.evidence);
  assert.deepEqual(applied.reservations, reservations);
  assert.deepEqual(applied.work[1], other, "other records stay byte-identical");
  assert.equal(
    applyHumanMergeReadmissions(snapshot, [], NOW),
    snapshot,
    "no verified re-admission writes nothing",
  );
});
