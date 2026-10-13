import assert from "node:assert/strict";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";
import {
  BASE,
  blockedRecord,
  FOREIGN_REPO,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
  MERGE,
} from "./hosted-autonomy-fixtures.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";

Deno.test("hosted runner: already merged foreign closure bookkeeping precedes unrelated retry grants", async (t) => {
  const identities = [{ issue: 628, pr: 997 }, { issue: 631, pr: 1000 }, {
    issue: 632,
    pr: 1001,
  }, { issue: 635, pr: 1004 }];
  const tasks = await Promise.all(identities.map(async ({ issue }) => {
    const statement = {
      issueNumber: issue,
      title: `Synthetic accepted issue ${issue}`,
      body: "Synthetic sanitized acceptance statement",
    };
    return { ...statement, digest: await reviewTaskStatementDigest(statement) };
  }));
  const records = identities.map(({ issue, pr }, i) =>
    foreignRecord({
      id: `issue-ubiquity-ai.ubq.fi-${issue}`,
      source: { kind: "issue", id: String(issue), revision: BASE },
      related: { incidentId: null, issueNumber: issue },
      target: {
        base: BASE,
        head: HEAD,
        branch: `sentinel/repair/issue-ubiquity-ai.ubq.fi-${issue}`,
        checkpoint: null,
        pr,
      },
      evidence: [{
        kind: "review_receipt",
        ref: `artifact:review-receipt/${"abcdef"[i].repeat(64)}`,
      }],
    })
  );
  const reviews = identities.map(({ issue, pr }, i) =>
    foreignReceipt({
      id: `review-receipt:${"abcdef"[i].repeat(64)}`,
      pullRequest: { number: pr, head: HEAD, base: BASE },
      taskAcceptance: {
        issueNumber: issue,
        taskDigest: tasks[i].digest,
        verdict: "fulfilled",
        evidence: ["Synthetic fulfilled acceptance"],
      },
    })
  );
  for (const backlog of [false, true]) {
    await t.step(
      backlog
        ? "ready closures with unrelated transient backlog"
        : "ready closures alone",
      async () => {
        const unrelated = blockedRecord({
          id: "issue-ubiquity-sentinel-900",
          source: { kind: "issue", id: "900", revision: BASE },
          related: { incidentId: null, issueNumber: 900 },
          target: {
            base: BASE,
            head: null,
            branch: null,
            checkpoint: null,
            pr: null,
          },
        });
        const { rig, github } = await makeRig("recovery-foreign-priority", {
          repair: repairSnapshot(
            backlog ? [...records, unrelated] : records,
            reviews,
          ),
        });
        rig.githubFor = () => ({
          ...github,
          readDefaultBranch: () => Promise.resolve("main"),
          readIssueOpen: (issue) => Promise.resolve(issue === 900),
          readIssueTask: (issue) =>
            Promise.resolve(
              tasks.find((task) => task.issueNumber === issue) ?? null,
            ),
          readPull: (pr) =>
            Promise.resolve(
              foreignPullFacts({
                number: pr,
                state: "closed",
                merged: true,
                mergeCommitSha: MERGE,
                parents: [BASE, HEAD],
                revisionOnBaseBranch: true,
              }),
            ),
          merge: () => {
            throw new Error("already-merged fixture must never merge");
          },
        });
        try {
          const result = await run(rig);
          console.log(
            JSON.stringify({
              scenario: backlog ? "with_backlog" : "without_backlog",
              reason: result.reason,
              actions: result.actions,
              closed: rig.closed,
            }),
          );
          const read = await rig.state.readRepair();
          assert.ok(read.ok && read.value.status === "found");
          if (!read.ok || read.value.status !== "found") {
            throw new Error("fixture unreadable");
          }
          assert.equal(
            read.value.snapshot.work.filter((record) =>
              record.repository.name === FOREIGN_REPO.name &&
              record.nextStep === "done"
            ).length,
            4,
            "four proven merged foreign records must finish delivery bookkeeping",
          );
          assert.deepEqual(read.value.snapshot.reviews, reviews);
          assert.equal(rig.merges, 0);
        } finally {
          await Deno.remove(rig.tmp, { recursive: true });
        }
      },
    );
  }
});
