/**
 * Owner rule 2026-10-30: a human merge completes a record. The runtime's
 * retired head park ("observed merged head identity mismatch") is re-admitted
 * to `review` when the record's own branch carries exactly one merged pull on
 * the repository's base branch; the record keeps its reviewed head, base,
 * counters, reservations and evidence.
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

Deno.test("human merge readmission: only the exact retired park is planned", () => {
  assert.deepEqual(planHumanMergeHeadReadmissions(repairSnapshot([parked()])), [
    candidate,
  ]);
  assert.deepEqual(
    planHumanMergeHeadReadmissions(repairSnapshot([deliveryRecord({})])),
    [],
    "an ordinary record is never planned",
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
    detail: "human_merge_head_moved",
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
