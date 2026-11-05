/**
 * Owner-landing publication: a candidate that changes a protected path (not a
 * workflow or other CI-executable path) is published, tested and reviewed
 * like any candidate, and Sentinel never merges it; the owner's merge
 * completes the record. A workflow change keeps the pre-publication park.
 */
import assert from "node:assert/strict";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import type { GitHubPullRequestV1 } from "../../src/contracts/ports.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  issueRecord,
  LOCAL_SENTINEL_REPO,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
  SHA4,
} from "./loop-rig.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";
import { deliveryRecord } from "./loop-review-fixtures.ts";
import { REPO_2 } from "../budget/helpers.ts";

const PROTECTED = { protectedPaths: ["src/auth/", ".github/workflows/"] };

Deno.test(
  "owner landing: a protected non-workflow candidate is published and reviewed, never merged",
  async () => {
    const rig = await makeRig("ownerlanding", {
      configOverrides: { repository: REPO_2, ...PROTECTED },
      model: { changedPaths: ["src/app.ts", "src/auth/session.ts"] },
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      let work = (await rig.snapshot()).work[0]!;
      assert.equal(work.blocker, null, JSON.stringify(work.blocker));
      assert.equal(work.nextStep, "review");
      assert.equal(work.target.pr, 7);
      assert.equal(work.target.head, SHA3);
      assert.deepEqual(work.ownerLanding?.paths, ["src/auth/"]);
      assert.equal(rig.github.pushes.length, 1, "the candidate is pushed");
      assert.ok(rig.github.calls.includes("createPr"));
      assert.ok(rig.github.calls.includes("requestReview"));

      rig.clock.advance(100_000_000 + 1);
      rig.github.completeReview([], rig.clock.now());
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      work = (await rig.snapshot()).work[0]!;
      assert.equal(work.nextStep, "delivery");
      assert.equal(work.wait?.reason, "manual", "waits for the owner");
      assert.notEqual(work.wait?.until, null, "re-reads its PR later");
      assert.equal(work.intent, null, "no merge intent is written");
      assert.deepEqual(work.ownerLanding?.paths, ["src/auth/"]);
      assert.equal(rig.github.calls.filter((c) => c === "merge").length, 0);

      // The next poll re-reads the still-open PR and still never merges.
      rig.clock.advance(60 * 60_000);
      const third = await rig.run();
      assert.equal(third.status, "idle", JSON.stringify(third));
      work = (await rig.snapshot()).work[0]!;
      assert.equal(work.nextStep, "delivery");
      assert.equal(work.wait?.reason, "manual");
      assert.equal(rig.github.calls.filter((c) => c === "merge").length, 0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "owner landing: a workflow candidate still parks unpublished",
  async () => {
    const rig = await makeRig("ownerlandingworkflow", {
      configOverrides: { repository: REPO_2, ...PROTECTED },
      model: {
        changedPaths: ["src/auth/session.ts", ".github/workflows/ci.yml"],
      },
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const work = (await rig.snapshot()).work[0]!;
      assert.equal(work.nextStep, "blocked");
      assert.equal(work.blocker?.message, "candidate touches a protected path");
      assert.equal(work.target.pr, null);
      assert.equal(work.ownerLanding, undefined);
      assert.equal(rig.github.pushes.length, 0, "nothing is pushed");
      assert.ok(!rig.github.calls.includes("createPr"));
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

/** The owner's merge of an owner-landing PR (newer head after owner push). */
function ownerMergedPr(head: GitSha): GitHubPullRequestV1 {
  const id = asWorkItemId("issue-1");
  return {
    ...exactOpenPr(7, head, candidateBranch(id)),
    state: "merged" as const,
    mergeSha: SHA2,
    mergedBy: "0x4007",
  } as GitHubPullRequestV1;
}

for (
  const [name, mergedHead] of [
    ["the reviewed head", SHA3],
    ["a newer owner-pushed head", SHA4],
  ] as const
) {
  Deno.test(`owner landing: the owner's merge of ${name} completes the record as done`, async () => {
    const id = asWorkItemId("issue-1");
    const github = new RelationsFakeGithub({
      baseSha: SHA1,
      candidateLifecycle: {
        refs: { [`refs/heads/${candidateBranch(id)}`]: mergedHead },
        pullRequests: [ownerMergedPr(mergedHead)],
      },
    });
    github.latest.set(1, issueRecord(1, { state: "closed" }));
    const rig = await makeRig(`ownerlandingmerge${mergedHead.slice(0, 4)}`, {
      summaries: false,
      githubPort: github,
      localScope: true,
    });
    try {
      const record = {
        ...deliveryRecord(SHA3, {
          repository: LOCAL_SENTINEL_REPO,
          wait: { reason: "manual", since: T0 - 10, until: T0 - 1 },
        }),
        ownerLanding: { paths: ["src/auth/"], since: T0 - 100 },
      };
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const work = (await rig.snapshot()).work[0]!;
      assert.equal(work.nextStep, "done", JSON.stringify(work.blocker));
      assert.equal(work.blocker, null);
      assert.ok(
        work.evidence.some((ref) => ref.ref.includes("/human-merge-v1/7/")),
        "human-merge provenance is recorded",
      );
      assert.ok(!github.calls.includes("merge"), "Sentinel never merged it");
    } finally {
      await rig.ctx.cleanup();
    }
  });
}
