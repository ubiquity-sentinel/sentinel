import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  candidateBranch,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import { RETIRED_MERGED_MESSAGE } from "../../src/repair/selection.ts";
import { runHostedClosurePass } from "../../ops/hosted-autonomy-closure-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { SHA1, T0 } from "../state/helpers.ts";
import {
  BASE,
  finding,
  FOREIGN_PR,
  FOREIGN_REPO,
  FOREIGN_TASK,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
  SELF_REPO,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";

const PASSPORT = { ...FOREIGN_REPO, name: "passport.ubq.fi" };

function passportRecord(issue = 120, pullRequest = FOREIGN_PR): WorkRecordV1 {
  const id = `issue-ubiquity-passport.ubq.fi-${issue}` as WorkItemId;
  return foreignRecord({
    id,
    repository: PASSPORT,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    target: {
      base: BASE,
      branch: candidateBranch(id),
      checkpoint: null,
      head: HEAD,
      pr: pullRequest,
    },
  });
}

function passportReceipt(overrides: Record<string, unknown> = {}) {
  return foreignReceipt({ repository: PASSPORT, ...overrides });
}

async function closureRig(
  records: WorkRecordV1[],
  reviews: ReviewReceiptV1[],
) {
  const { rig, github } = await makeRig("closure-prefilter", {
    repair: repairSnapshot(records, reviews),
  });
  const reads = new Map<number, number>();
  const pulls: number[] = [];
  const checks: string[] = [];
  github.hasAllChecksGreen = (head) => {
    checks.push(head);
    return Promise.resolve(true);
  };
  github.readIssueTask = (issue) => {
    reads.set(issue, (reads.get(issue) ?? 0) + 1);
    return Promise.resolve(FOREIGN_TASK);
  };
  github.readPull = (number) => {
    pulls.push(number);
    return Promise.resolve(foreignPullFacts({
      number,
      author: "ubiquity-sentinel[bot]",
      mergedBy: "ubiquity-sentinel[bot]",
    }));
  };
  const deps: HostedAutonomyDepsV1 = {
    state: rig.state,
    githubFor: (repository) =>
      repository.owner === PASSPORT.owner &&
        repository.name === PASSPORT.name &&
        repository.installationId === PASSPORT.installationId
        ? github
        : null,
    clock: { now: () => T0 + 5_000_000 },
  };
  const repair = await rig.state.readRepair();
  const release = await rig.state.readRelease();
  if (
    !repair.ok || repair.value.status !== "found" ||
    !release.ok || release.value.status !== "found"
  ) throw new Error("unreadable real state");
  const context: HostedAutonomyPassContextV1 = {
    deps,
    snapshot: repair.value.snapshot,
    observedHead: repair.value.head,
    initialHead: repair.value.head,
    releaseSnapshot: release.value.snapshot,
    actions: [],
    revisions: [],
    closedIssues: new Set(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set(),
    ...createHostedAutonomyScopes(deps),
  };
  return { rig, github, reads, pulls, checks, context };
}

Deno.test("hosted closure: impossible exact receipts cost no task read beside a valid delivery", async () => {
  const valid = passportRecord();
  const cases: Record<string, unknown>[] = [
    { pullRequest: { number: 1400, head: HEAD, base: BASE } },
    { pullRequest: { number: 401, head: SHA1, base: BASE } },
    { pullRequest: { number: 402, head: HEAD, base: SHA1 } },
    { repository: SELF_REPO },
    { repository: { ...PASSPORT, installationId: 8 } },
    {
      outcome: "pending",
      resultId: null,
      completedAt: null,
      observedReviewer: null,
      taskAcceptance: null,
    },
    { findings: [finding("P0")], unresolvedSeverities: ["P0"] },
  ];
  const impossible = cases.map((_, index) =>
    passportRecord(300 + index, 400 + index)
  );
  const reviews = cases.map((overrides, index) =>
    passportReceipt({
      id: `review-receipt:${String(index + 1).repeat(64)}`,
      pullRequest: { number: 400 + index, head: HEAD, base: BASE },
      ...overrides,
    })
  );
  const noReceipt = passportRecord(399, 499);
  const { rig, reads, pulls, checks, context } = await closureRig(
    [valid, ...impossible, noReceipt],
    [passportReceipt(), ...reviews],
  );
  try {
    const result = await runHostedClosurePass(context);
    assert.equal(result?.reason, "closed_issues");
    assert.equal(rig.writes, 1, "only the verified closure writes real state");
    assert.equal(rig.merges, 0);
    assert.deepEqual(rig.closed, [120]);
    assert.deepEqual(
      checks,
      [HEAD],
      "the valid closure still reads exact-head CI",
    );
    assert.ok(
      (reads.get(120) ?? 0) >= 4,
      "eligible closure retains fresh task reads",
    );
    assert.equal(
      [...impossible, noReceipt].reduce(
        (count, record) =>
          count + (reads.get(record.related.issueNumber!) ?? 0),
        0,
      ),
      0,
      "impossible receipts must consume zero task reads",
    );
    for (const record of [...impossible, noReceipt]) {
      assert.equal(reads.get(record.related.issueNumber!), undefined);
      assert.ok(!pulls.includes(record.target.pr!));
    }
    const after = await rig.state.readRepair();
    if (!after.ok || after.value.status !== "found") {
      throw new Error("unreadable");
    }
    assert.equal(after.value.head, result?.appliedHead, "exact CAS readback");
    assert.deepEqual(
      after.value.snapshot.reservations,
      context.snapshot.reservations,
    );
    const delivered = after.value.snapshot.work.find((row) =>
      row.id === valid.id
    );
    assert.equal(delivered?.nextStep, "done");
    assert.deepEqual(delivered?.counters, valid.counters);
    for (const record of [...impossible, noReceipt]) {
      assert.deepEqual(
        after.value.snapshot.work.find((row) => row.id === record.id),
        record,
      );
    }
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("hosted closure: eligible Passport task drift at the final read still refuses", async (t) => {
  const body = `${FOREIGN_TASK.body} (changed after planning)`;
  const drifted = {
    ...FOREIGN_TASK,
    body,
    digest: await reviewTaskStatementDigest({
      issueNumber: FOREIGN_TASK.issueNumber,
      title: FOREIGN_TASK.title,
      body,
    }),
  };
  for (const unavailable of [false, true]) {
    await t.step(unavailable ? "unavailable" : "changed text", async () => {
      const record = passportRecord();
      const { rig, github, context } = await closureRig(
        [record],
        [passportReceipt()],
      );
      let reads = 0;
      github.readIssueTask = () => {
        reads++;
        return Promise.resolve(
          reads < 4 ? FOREIGN_TASK : unavailable ? null : drifted,
        );
      };
      try {
        await runHostedClosurePass(context);
        assert.ok(reads >= 4, "reach the immediately-preceding closure read");
        assert.equal(rig.writes, 0);
        assert.equal(rig.merges, 0);
        assert.deepEqual(rig.closed, []);
        assert.ok(
          context.actions.includes(`close:${record.id}:issue=120:refused`),
        );
        const after = await rig.state.readRepair();
        if (!after.ok || after.value.status !== "found") {
          throw new Error("unreadable");
        }
        assert.equal(after.value.head, context.initialHead);
        assert.deepEqual(after.value.snapshot.work, [record]);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("hosted closure: historical publication is reconstructed before the exact-receipt filter", async (t) => {
  const original = passportRecord();
  const receipt = passportReceipt();
  const operationKey = `impl:${"a".repeat(64)}`;
  const ref = await candidatePreservationRef(
    PASSPORT,
    original.id,
    operationKey,
  );
  for (const validRef of [true, false]) {
    await t.step(
      validRef ? "exact preservation" : "wrong preservation",
      async () => {
        const record = foreignRecord({
          ...original,
          nextStep: "blocked",
          blocker: {
            kind: "other",
            message: RETIRED_MERGED_MESSAGE,
            since: T0 + 2000,
          },
          evidence: [{
            kind: "review_receipt",
            ref: `artifact:review-receipt/${receipt.id}`,
          }],
          target: {
            ...original.target,
            pr: null,
            candidateState: {
              preserved: {
                operationKey,
                ref: validRef
                  ? ref
                  : `refs/heads/sentinel-candidates/${"0".repeat(64)}`,
                head: HEAD,
                base: BASE,
              },
              publishedHead: HEAD,
            },
          },
        });
        const { rig, reads, context } = await closureRig([record], [receipt]);
        try {
          await runHostedClosurePass(context);
          const after = await rig.state.readRepair();
          if (!after.ok || after.value.status !== "found") {
            throw new Error("unreadable");
          }
          if (validRef) {
            assert.deepEqual(rig.closed, [120]);
            assert.equal(rig.writes, 1);
            assert.ok((reads.get(120) ?? 0) >= 4);
            assert.equal(after.value.snapshot.work[0].nextStep, "done");
            assert.equal(after.value.snapshot.work[0].target.pr, FOREIGN_PR);
            assert.deepEqual(
              after.value.snapshot.work[0].counters,
              record.counters,
            );
          } else {
            assert.deepEqual(rig.closed, []);
            assert.equal(rig.writes, 0);
            assert.equal(reads.size, 0);
            assert.deepEqual(after.value.snapshot.work, [record]);
          }
        } finally {
          await Deno.remove(rig.tmp, { recursive: true });
        }
      },
    );
  }
});
