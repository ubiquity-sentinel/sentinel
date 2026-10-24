import assert from "node:assert/strict";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { portError } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import {
  applyHostedClosures,
  buildHostedReleaseRequest,
  HOSTED_AUTONOMY_RETIRED,
  hostedDeliveryKey,
  isHardAutonomyFailure,
  planHostedClosures,
  revisionIntegratedIntoBase,
} from "../../ops/hosted-autonomy.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  closureTasks,
  deliveryRecord,
  finding,
  FOREIGN_RECEIPT_2,
  FOREIGN_REPO,
  FOREIGN_TARGET,
  FOREIGN_TASK_2,
  FOREIGN_TASK_BODY,
  FOREIGN_TASK_TITLE,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  foreignRecord2,
  HEAD,
  isSelfRepository,
  MERGE,
  repositoryTask,
  SELF_REPO,
  SHARED_ISSUE_NUMBER,
  TARGET,
  taskFor,
} from "./hosted-autonomy-fixtures.ts";
import {
  healthyProof,
  makeRig,
  releaseSnapshot,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

/** The one unresolved severity that still rejects a review (2026-10-24). */
const P0_FINDING = {
  ...finding("P1"),
  severity: "P0" as const,
  message: "P0 finding",
};

async function retirementClosureRig(merged = false, review = foreignReceipt()) {
  const retiring = deliveryRecord({
    nextStep: "work",
    target: {
      base: BASE,
      branch: "sentinel/retiring",
      checkpoint: null,
      head: null,
      pr: null,
    },
  });
  const unrelated = deliveryRecord({
    id: "preserved-unrelated" as WorkItemId,
    source: { kind: "issue", id: "999", revision: SHA1 },
    related: { incidentId: null, issueNumber: 999 },
    nextStep: "done",
  });
  const charge = reservation("preserved-foreign-charge", {
    repository: FOREIGN_REPO,
    taskId: FOREIGN_TARGET,
    head: HEAD,
    outcome: "submitted",
    settledAt: T0 + 2000,
  });
  const { rig, github } = await makeRig("retirement-closure", {
    repair: repairSnapshot(
      [retiring, foreignRecord(), unrelated],
      [review],
      [],
      [charge],
    ),
    pull: foreignPullFacts({
      state: merged ? "closed" : "open",
      merged,
      mergeCommitSha: merged ? MERGE : null,
    }),
    afterMerge: foreignPullFacts(),
  });
  const closedAt: { repository: RepositoryIdentityV1; issueNumber: number }[] =
    [];
  const checkedHeads: string[] = [];
  const foreign = {
    ...github,
    hasAllChecksGreen: (head: string) => {
      checkedHeads.push(head);
      return github.hasAllChecksGreen(head);
    },
    readIssueTask: (number: number) =>
      Promise.resolve(repositoryTask(FOREIGN_REPO, number)),
    closeIssue: (number: number) => {
      closedAt.push({ repository: FOREIGN_REPO, issueNumber: number });
      return github.closeIssue(number);
    },
  };
  rig.githubFor = (repository) =>
    isSelfRepository(repository)
      ? {
        ...github,
        readIssueOpen: () => Promise.resolve(false),
        readIssueTask: (number) =>
          Promise.resolve(repositoryTask(SELF_REPO, number)),
      }
      : foreign;
  return { rig, foreign, closedAt, checkedHeads, retiring, unrelated };
}

Deno.test(
  "hosted autonomy: a trusted merge onto a descendant of the reviewed base closes the record",
  async () => {
    // The owner merged the bot's PRs 890/892/894/895 as a stack on 2026-10-05:
    // each merge commit's first parent is the previous merge, not the reviewed
    // base snapshot. The exact head binding plus the proven base ancestry still
    // verify the delivery and close the record.
    const stacked = (ancestry: boolean) =>
      foreignPullFacts({
        parents: [SHA1, HEAD],
        baseAncestorOfRevision: ancestry,
      });
    const { rig } = await makeRig("autonomy-stacked-base", {
      repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
      pull: stacked(true),
    });
    const result = await run(rig);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.reason, "closed_issues");
    assert.ok(
      result.actions.includes(`delivery:${FOREIGN_TARGET}:foreign_merged`),
      JSON.stringify(result),
    );
    assert.ok(result.actions.includes(`close:${FOREIGN_TARGET}:issue=120`));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work.find((row) =>
      row.id === FOREIGN_TARGET
    );
    assert.equal(record?.nextStep, "done");
    await Deno.remove(rig.tmp, { recursive: true });

    // Without the ancestry proof the same stacked merge stays unverified: the
    // record is not closed.
    const unproven = await makeRig("autonomy-stacked-unproven", {
      repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
      pull: stacked(false),
    });
    const refused = await run(unproven.rig);
    assert.equal(refused.status, "skipped", JSON.stringify(refused));
    assert.ok(
      refused.actions.includes(
        `delivery:${FOREIGN_TARGET}:merge_not_observed`,
      ),
    );
    const afterRefusal = await unproven.rig.state.readRepair();
    if (!afterRefusal.ok || afterRefusal.value.status !== "found") {
      throw new Error("unreadable");
    }
    assert.equal(
      afterRefusal.value.snapshot.work.find((row) => row.id === FOREIGN_TARGET)
        ?.nextStep,
      "delivery",
    );
    await Deno.remove(unproven.rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: one pass settles every already-merged foreign delivery",
  async () => {
    // Already-merged verified deliveries are read-only: the pass keeps
    // scanning after one instead of breaking, so a backlog settles in one
    // run rather than one record per run.
    const stacked = () =>
      foreignPullFacts({
        parents: [SHA1, HEAD],
        baseAncestorOfRevision: true,
      });
    const { rig } = await makeRig("autonomy-sweep", {
      repair: repairSnapshot(
        [foreignRecord(), foreignRecord2()],
        [foreignReceipt(), FOREIGN_RECEIPT_2],
      ),
      pull: stacked(),
      issueTask: (number: number) =>
        Promise.resolve(number === 121 ? FOREIGN_TASK_2 : taskFor(number)),
    });
    const result = await run(rig);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.ok(
      result.actions.includes(`delivery:${FOREIGN_TARGET}:foreign_merged`),
      JSON.stringify(result),
    );
    assert.ok(
      result.actions.includes(
        "delivery:issue-ubiquity-ai.ubq.fi-121:foreign_merged",
      ),
      JSON.stringify(result),
    );
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const steps = new Map(
      read.value.snapshot.work.map((row) => [row.id, row.nextStep]),
    );
    assert.equal(steps.get(FOREIGN_TARGET), "done");
    assert.equal(
      steps.get("issue-ubiquity-ai.ubq.fi-121" as WorkItemId),
      "done",
    );
    assert.deepEqual([...rig.closed].sort(), [120, 121]);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test("hosted autonomy: verified retirement continues foreign closure on the new CAS head", async () => {
  const { rig, closedAt, checkedHeads, retiring, unrelated } =
    await retirementClosureRig();
  try {
    const before = await rig.state.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    if (!before.ok || before.value.status !== "found") {
      throw new Error("unreadable");
    }
    const writes: {
      parent: GitSha | null;
      next: RepairStateSnapshotV1;
      head: GitSha | null;
    }[] = [];
    const write = rig.state.writeRepair.bind(rig.state);
    rig.state.writeRepair = async (next, parent) => {
      const result = await write(next, parent);
      writes.push({
        parent,
        next,
        head: result.ok && result.value.status === "applied"
          ? result.value.head
          : null,
      });
      return result;
    };
    const result = await run(rig);
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    if (!after.ok || after.value.status !== "found") {
      throw new Error("unreadable");
    }
    assert.equal(
      after.value.snapshot.work.find((record) => record.id === retiring.id)
        ?.blocker?.message,
      HOSTED_AUTONOMY_RETIRED,
    );
    assert.equal(
      rig.merges,
      1,
      "the reviewed foreign candidate merged before retirement",
    );
    assert.ok(
      result.actions.includes(`delivery:${FOREIGN_TARGET}:foreign_merged`),
      JSON.stringify(result),
    );
    assert.deepEqual(
      rig.closed,
      [SHARED_ISSUE_NUMBER],
      "verified retirement must not defer the ready foreign closure",
    );
    assert.deepEqual(closedAt, [{
      repository: FOREIGN_REPO,
      issueNumber: SHARED_ISSUE_NUMBER,
    }]);
    assert.deepEqual(checkedHeads, [HEAD, HEAD]);
    assert.equal(result.reason, "closed_issues");
    assert.equal(rig.writes, 2);
    assert.equal(rig.merges, 1);
    assert.deepEqual(writes.map((entry) => entry.parent), [
      before.value.head,
      writes[0].head,
    ]);
    assert.equal(writes[1].next.stateHead, writes[0].head);
    assert.equal(result.beforeHead, writes[0].head);
    assert.equal(result.appliedHead, after.value.head);
    assert.equal(
      after.value.snapshot.sequence,
      before.value.snapshot.sequence + 2,
    );
    const delivered = after.value.snapshot.work.find((record) =>
      record.id === FOREIGN_TARGET
    );
    assert.equal(delivered?.nextStep, "done");
    assert.deepEqual(
      delivered?.target,
      before.value.snapshot.work.find((record) => record.id === FOREIGN_TARGET)
        ?.target,
    );
    assert.deepEqual(
      after.value.snapshot.reviews,
      before.value.snapshot.reviews,
    );
    assert.deepEqual(
      after.value.snapshot.reservations,
      before.value.snapshot.reservations,
    );
    assert.deepEqual(after.value.snapshot.releaseRequests, []);
    assert.deepEqual(
      after.value.snapshot.work.find((record) => record.id === unrelated.id),
      unrelated,
    );
    await run(rig);
    assert.equal(rig.writes, 2);
    assert.equal(rig.merges, 1);
    assert.deepEqual(rig.closed, [SHARED_ISSUE_NUMBER]);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("hosted autonomy: retirement continuation refuses unverified readback and foreign checks", async (t) => {
  for (
    const mode of [
      "unavailable-readback",
      "wrong-head",
      "wrong-snapshot",
      "unavailable-checks",
      "failed-checks",
      "stale-task",
      "adverse-review",
    ]
  ) {
    await t.step(mode, async () => {
      const { rig, foreign } = await retirementClosureRig(
        true,
        mode === "adverse-review"
          ? foreignReceipt({
            findings: [P0_FINDING],
            unresolvedSeverities: ["P0"],
          })
          : foreignReceipt(),
      );
      try {
        const read = rig.state.readRepair.bind(rig.state);
        const before = await read();
        assert.ok(before.ok && before.value.status === "found");
        if (!before.ok || before.value.status !== "found") {
          throw new Error("unreadable");
        }
        const beforeSnapshot = before.value.snapshot;
        if (mode === "unavailable-checks") {
          foreign.hasAllChecksGreen = () =>
            Promise.reject(new Error("checks unavailable"));
        } else if (mode === "failed-checks") {
          foreign.hasAllChecksGreen = () => Promise.resolve(false);
        } else if (mode === "stale-task") {
          foreign.readIssueTask = async () => {
            const task = {
              issueNumber: SHARED_ISSUE_NUMBER,
              title: FOREIGN_TASK_TITLE,
              body: FOREIGN_TASK_BODY + " changed",
            };
            return { ...task, digest: await reviewTaskStatementDigest(task) };
          };
        } else if (mode !== "adverse-review") {
          rig.state.readRepair = async () => {
            const actual = await read();
            if (
              rig.writes !== 1 || !actual.ok || actual.value.status !== "found"
            ) {
              return actual;
            }
            if (mode === "unavailable-readback") {
              return portError(
                "unavailable",
                "retirement readback unavailable",
              );
            }
            return {
              ...actual,
              value: {
                ...actual.value,
                ...(mode === "wrong-head"
                  ? { head: BASE }
                  : { snapshot: beforeSnapshot }),
              },
            };
          };
        }
        const result = await run(rig);
        assert.equal(
          result.reason,
          [
              "unavailable-checks",
              "failed-checks",
              "stale-task",
              "adverse-review",
            ].includes(mode)
            ? "retired_records"
            : "readback_unverified",
        );
        assert.equal(rig.writes, 1);
        assert.equal(rig.merges, 0);
        assert.deepEqual(rig.closed, []);
        const after = await read();
        assert.ok(after.ok && after.value.status === "found");
        if (!after.ok || after.value.status !== "found") {
          throw new Error("unreadable");
        }
        assert.equal(
          after.value.snapshot.work.find((record) =>
            record.id === FOREIGN_TARGET
          )?.nextStep,
          "delivery",
        );
        assert.deepEqual(
          after.value.snapshot.reviews,
          before.value.snapshot.reviews,
        );
        assert.deepEqual(
          after.value.snapshot.reservations,
          before.value.snapshot.reservations,
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("hosted autonomy: retirement continuation treats an unresolved P1 as a clean foreign review", async () => {
  // Owner directive 2026-10-24: only an unresolved P0 is adverse. The same
  // merged foreign delivery under a P1 review is verified and closed.
  const { rig, closedAt } = await retirementClosureRig(
    true,
    foreignReceipt({
      findings: [finding("P1")],
      unresolvedSeverities: ["P1"],
    }),
  );
  try {
    const result = await run(rig);
    assert.equal(result.reason, "closed_issues", JSON.stringify(result));
    assert.equal(rig.merges, 0, "the pull request was already merged");
    assert.deepEqual(rig.closed, [SHARED_ISSUE_NUMBER]);
    assert.deepEqual(closedAt, [{
      repository: FOREIGN_REPO,
      issueNumber: SHARED_ISSUE_NUMBER,
    }]);
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    if (!after.ok || after.value.status !== "found") {
      throw new Error("unreadable");
    }
    assert.equal(
      after.value.snapshot.work.find((record) => record.id === FOREIGN_TARGET)
        ?.nextStep,
      "done",
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test(
  "hosted autonomy: an accepted release closes the delivered issue and marks the record done",
  async () => {
    const request = await buildHostedReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      51,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (request === null) throw new Error("fixture request invalid");
    const { parseHostedReleaseRecordV1 } = await import(
      "../../src/contracts/hosted-supervisor.ts"
    );
    const accepted = parseHostedReleaseRecordV1({
      version: "v1",
      kind: "hosted_release",
      id: request.id,
      request,
      phase: "accepted",
      priorRevision: BASE,
      priorProof: healthyProof(BASE, 17, request.id, "prior"),
      candidateProof: healthyProof(MERGE, 18, request.id),
      rollbackProof: null,
      pointerIntent: null,
      createdAt: T0 + 2500,
      updatedAt: T0 + 3000,
    });
    const snapshot = repairSnapshot([blockedRecord()], [authorizingReceipt()], [
      request,
    ]);
    const released = new Map([
      [hostedDeliveryKey(SELF_REPO, 51, HEAD, BASE), accepted],
    ]);
    const plans = planHostedClosures(
      snapshot,
      released,
      new Map(),
      closureTasks(snapshot.work),
    );
    assert.deepEqual(plans, [
      { id: TARGET, issueNumber: 48, repository: SELF_REPO },
    ]);
    const next = applyHostedClosures(snapshot, SHA1, plans, T0 + 5000);
    assert.equal(next.work[0].nextStep, "done");
    assert.equal(next.work[0].blocker, null);
    assert.equal(next.work[0].intent, null);
    assert.equal(next.sequence, snapshot.sequence + 1);
    // An accepted release that delivered another head closes nothing.
    assert.deepEqual(
      planHostedClosures(
        snapshot,
        new Map([[hostedDeliveryKey(SELF_REPO, 51, SHA1, BASE), accepted]]),
        new Map(),
        closureTasks(snapshot.work),
      ),
      [],
    );
    // A legacy quality-only receipt never closes a delivered issue, and
    // neither does an unreadable trusted task context.
    const legacy = repairSnapshot(
      [blockedRecord()],
      [authorizingReceipt({ taskAcceptance: null })],
      [request],
    );
    assert.deepEqual(
      planHostedClosures(
        legacy,
        released,
        new Map(),
        closureTasks(legacy.work),
      ),
      [],
    );
    assert.deepEqual(
      planHostedClosures(legacy, released, new Map(), new Map()),
      [],
    );
  },
);

Deno.test(
  "hosted autonomy: integration evidence mirrors the runtime verifier",
  () => {
    const revision = MERGE;
    const shape = (status: string, baseSha: string, mergeSha: string) => ({
      status,
      base_commit: { sha: baseSha },
      merge_base_commit: { sha: mergeSha },
    });
    assert.equal(
      revisionIntegratedIntoBase(shape("ahead", revision, revision), revision),
      true,
    );
    assert.equal(
      revisionIntegratedIntoBase(
        shape("identical", revision, revision),
        revision,
      ),
      true,
    );
    assert.equal(
      revisionIntegratedIntoBase(shape("behind", revision, revision), revision),
      false,
    );
    assert.equal(
      revisionIntegratedIntoBase(
        shape("diverged", revision, revision),
        revision,
      ),
      false,
    );
    assert.equal(
      revisionIntegratedIntoBase(shape("ahead", SHA1, revision), revision),
      false,
    );
    assert.equal(revisionIntegratedIntoBase(null, revision), false);
    assert.equal(
      revisionIntegratedIntoBase({ status: "ahead" }, revision),
      false,
    );
    assert.equal(isHardAutonomyFailure("identity_rejected"), true);
    assert.equal(isHardAutonomyFailure("unexpected_failure"), true);
    assert.equal(isHardAutonomyFailure("write_conflict"), false);
    assert.equal(isHardAutonomyFailure("merge_refused"), false);
  },
);

Deno.test(
  "hosted autonomy: a non-terminal hosted release defers every pass",
  async () => {
    const pendingRequest = await buildHostedReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      51,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (pendingRequest === null) throw new Error("fixture request invalid");
    const { parseHostedReleaseRecordV1 } = await import(
      "../../src/contracts/hosted-supervisor.ts"
    );
    const { rig, github } = await makeRig("autonomy-release", {
      repair: repairSnapshot([blockedRecord()], [authorizingReceipt()]),
      release: releaseSnapshot([
        parseHostedReleaseRecordV1({
          version: "v1",
          kind: "hosted_release",
          id: pendingRequest.id,
          request: pendingRequest,
          phase: "requested",
          priorRevision: BASE,
          priorProof: null,
          candidateProof: null,
          rollbackProof: null,
          pointerIntent: null,
          createdAt: T0 + 2500,
          updatedAt: T0 + 2500,
        }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "release_not_terminal");
    assert.equal(rig.writes, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an abandoned hosted release is terminal and defers no pass",
  async () => {
    // Live runs 40083925576 and 40085831848: release f42d04c7 was abandoned
    // as included_in_successor, yet the runner counted only accepted,
    // rolled_back and owner_superseded as terminal, so every closure, retry
    // and delivery pass for every target was skipped release_not_terminal.
    const request = await buildHostedReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      51,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (request === null) throw new Error("fixture request invalid");
    const { parseHostedReleaseRecordV1 } = await import(
      "../../src/contracts/hosted-supervisor.ts"
    );
    const requested = {
      version: "v1",
      kind: "hosted_release",
      id: request.id,
      request,
      phase: "requested",
      priorRevision: BASE,
      priorProof: null,
      candidateProof: null,
      rollbackProof: null,
      pointerIntent: null,
      createdAt: T0 + 2500,
      updatedAt: T0 + 2500,
    } as const;
    const { rig, github } = await makeRig("autonomy-release-abandoned", {
      repair: repairSnapshot([blockedRecord()], [authorizingReceipt()]),
      release: releaseSnapshot([parseHostedReleaseRecordV1(requested)]),
    });
    // The validated writer only stores an abandonment with its successor
    // installation, so the read returns the same record as abandoned.
    const abandoned = parseHostedReleaseRecordV1({
      ...requested,
      phase: "abandoned",
      abandonment: {
        executionIds: ["40076699068:1:repair"],
        fromPhase: "requested",
        reason: "included_in_successor",
        recordedAt: T0 + 3000,
        successorRevision: MERGE,
      },
      updatedAt: T0 + 3000,
    });
    const readRelease = rig.state.readRelease.bind(rig.state);
    rig.state.readRelease = async () => {
      const read = await readRelease();
      if (!read.ok || read.value.status !== "found") return read;
      return {
        ...read,
        value: {
          ...read.value,
          snapshot: { ...read.value.snapshot, hostedReleases: [abandoned] },
        },
      };
    };
    const result = await run(rig, github);
    assert.notEqual(result.reason, "release_not_terminal");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);
