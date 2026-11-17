/**
 * Owner-landing publication (owner directive 2026-11-17, "give sentinel full
 * access"): on Sentinel's own repository a candidate that changes a protected
 * path is published, tested and reviewed like any candidate, and Sentinel
 * never merges it; the owner's merge completes the record. On any other
 * target such a change, a workflow included, is an ordinary pull request.
 * A credential path keeps the pre-publication park everywhere.
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
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";

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

/** A non-Sentinel target (owner directive 2026-11-17, "full access"). */
const TARGET_REPO = {
  owner: "ubiquity",
  name: "pay.ubq.fi",
  installationId: 9,
};

Deno.test(
  "owner landing: Sentinel's own workflow candidate publishes for its owner, never merged",
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
      assert.equal(work.blocker, null, JSON.stringify(work.blocker));
      assert.equal(work.nextStep, "review");
      assert.deepEqual(work.ownerLanding?.paths, [
        ".github/workflows/",
        "src/auth/",
      ]);
      assert.equal(rig.github.pushes.length, 1, "the candidate is pushed");
      assert.ok(rig.github.calls.includes("createPr"));
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "owner landing: a target's workflow candidate is an ordinary pull request that merges after review and CI",
  async () => {
    const rig = await makeRig("ownerlandingtargetworkflow", {
      configOverrides: { repository: TARGET_REPO, ...PROTECTED },
      model: {
        changedPaths: ["src/auth/session.ts", ".github/workflows/ci.yml"],
      },
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      let work = (await rig.snapshot()).work[0]!;
      assert.equal(work.blocker, null, JSON.stringify(work.blocker));
      assert.equal(work.nextStep, "review");
      assert.equal(work.ownerLanding, undefined, "no owner-landing flag");
      assert.equal(rig.github.pushes.length, 1, "the candidate is pushed");
      assert.ok(rig.github.calls.includes("createPr"));
      rig.clock.advance(100_000_000 + 1);
      rig.github.completeReview([], rig.clock.now());
      await rig.run();
      work = (await rig.snapshot()).work[0]!;
      assert.notEqual(work.wait?.reason, "manual", "no owner wait");
      assert.equal(
        rig.github.calls.filter((c) => c === "merge").length,
        1,
        "ordinary delivery merges the workflow candidate",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "owner landing: a target's credential-file candidate still parks unpublished",
  async () => {
    const rig = await makeRig("ownerlandingcredential", {
      configOverrides: {
        repository: TARGET_REPO,
        protectedPaths: [...PROTECTED.protectedPaths, ".env"],
      },
      model: { changedPaths: [".github/workflows/ci.yml", ".env"] },
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

Deno.test(
  "owner landing: a later candidate without protected paths clears the flag and merges normally",
  async () => {
    const rig = await makeRig("ownerlandingcleared", {
      configOverrides: { repository: REPO_2, ...PROTECTED },
      model: {
        heads: [SHA3, SHA4],
        changedPaths: ["src/app.ts", "src/auth/session.ts"],
      },
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      let work = (await rig.snapshot()).work[0]!;
      assert.equal(work.nextStep, "review");
      assert.deepEqual(work.ownerLanding?.paths, ["src/auth/"]);

      // The correction's full base..head diff no longer touches `src/auth/`:
      // the flag is replaced from the current diff, not widened.
      rig.model["options"].changedPaths = ["src/app.ts"];
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.completeReview([{
        id: "finding-1",
        severity: "P0",
        path: "src/app.ts",
        message: "required fix",
        fingerprint: "a".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      }], rig.clock.now());
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      work = (await rig.snapshot()).work[0]!;
      assert.equal(rig.model.requests.length, 2);
      assert.equal(work.nextStep, "review");
      assert.equal(work.target.head, SHA4);
      assert.equal(work.ownerLanding, undefined, "the flag is cleared");

      rig.clock.advance(100_000_000 + 1);
      rig.github.completeReview([], rig.clock.now());
      const third = await rig.run();
      assert.equal(third.status, "idle", JSON.stringify(third));
      work = (await rig.snapshot()).work[0]!;
      assert.notEqual(work.wait?.reason, "manual", "no owner wait");
      assert.equal(
        rig.github.calls.filter((c) => c === "merge").length,
        1,
        "ordinary delivery merges the unprotected candidate",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

/** The Sentinel self target's protected list plus one non-authority prefix. */
const SELF_PROTECTED = [
  ...createLocalRepositoryConfig().protectedPaths,
  "docs/private/",
];

for (
  const [name, path, prefix] of [
    [
      "an authority file publishes for the owner",
      "src/repair/owner-landing.ts",
      "src/repair/owner-landing.ts",
    ],
    [
      "a non-authority protected path publishes for the owner",
      "docs/private/notes.md",
      "docs/private/",
    ],
  ] as const
) {
  Deno.test(`owner landing: a Sentinel self-candidate touching ${name}`, async () => {
    const rig = await makeRig(`ownerlandingself${prefix.length}`, {
      configOverrides: {
        repository: {
          ...LOCAL_SENTINEL_REPO,
          installationId: REPO_2.installationId,
        },
        protectedPaths: SELF_PROTECTED,
      },
      model: { changedPaths: ["src/app.ts", path] },
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const work = (await rig.snapshot()).work[0]!;
      assert.equal(work.blocker, null, JSON.stringify(work.blocker));
      assert.equal(work.nextStep, "review");
      assert.deepEqual(work.ownerLanding?.paths, [prefix]);
      assert.equal(rig.github.pushes.length, 1);
    } finally {
      await rig.ctx.cleanup();
    }
  });
}
