/**
 * The CI integrity rule for a head that changes a CI-executable path (owner
 * directive 2026-11-17): its own modified CI must run at least one job to
 * success on the exact head before a review round is spent or a merge
 * happens. Skipped or neutral jobs, or only a backup-CI stand-in, wait and
 * then park with their own reason; an unreadable comparison fails closed; a
 * head that changes no such path is judged exactly as before.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import { decideCiGate } from "../../src/repair/loop-checks.ts";
import { WORKFLOW_CI_SUCCESS_DETAIL } from "../../src/repair/ci-success-rule.ts";
import { PRE_REVIEW_CI_BOUND_MS } from "../../src/repair/ci-first-policy.ts";
import { SHA1, SHA3 } from "../state/helpers.ts";
import {
  check,
  ciFirstRig,
  reviewCharges,
  taskRecord,
} from "./ci-first-rig.ts";

const WORKFLOW = ["src/app.ts", ".github/workflows/ci.yml"];

function standIn(head: GitSha): GitHubCheckV1 {
  return {
    ...check("deno", head, "success"),
    backup: {
      receipt: "bci1:ubiquity/pay.ubq.fi@aaaaaaaaaaaa:" +
        ".github/workflows/ci.yml#deno:push:a1",
      context: "push",
      runnerId: "0123456789abcdef",
      legRunId: 5001,
      legJobId: 6001,
    },
  };
}

const SKIPPED = [
  check("ci", SHA3, "skipped"),
  check("lint", SHA3, "neutral"),
];

Deno.test("success rule: requireSuccess waits on skipped, neutral or stand-in evidence only", () => {
  const actions = (name: string, conclusion: GitHubCheckV1["conclusion"]) => ({
    ...check(name, SHA3, conclusion),
    app: "github-actions",
  });
  for (
    const checks of [
      SKIPPED,
      [actions("ci", "skipped")],
      [actions("ci", "neutral")],
      [standIn(SHA3)],
      [],
    ]
  ) {
    assert.equal(
      decideCiGate(checks, undefined, { requireSuccess: true }),
      "wait",
      JSON.stringify(checks),
    );
  }
  // Without the option every head decides exactly as before.
  assert.equal(decideCiGate(SKIPPED), "proceed");
  assert.equal(decideCiGate([standIn(SHA3)]), "proceed");
  for (
    const checks of [
      [...SKIPPED, check("test", SHA3, "success")],
      [actions("ci", "success"), actions("docs", "skipped")],
    ]
  ) {
    assert.equal(
      decideCiGate(checks, undefined, { requireSuccess: true }),
      "proceed",
    );
    assert.equal(decideCiGate(checks), "proceed");
  }
  // A review bot's success is no job the target's CI ran.
  assert.equal(
    decideCiGate(
      [...SKIPPED, {
        ...check("CodeRabbit", SHA3, "success"),
        app: "coderabbitai",
      }],
      undefined,
      { requireSuccess: true },
    ),
    "wait",
  );
  // A failure still blocks first.
  assert.deepEqual(
    decideCiGate([check("ci", SHA3, "failure")], undefined, {
      requireSuccess: true,
    }),
    { blocked: "CI checks failed: ci(failure)" },
  );
});

function setChangedPaths(
  rig: Awaited<ReturnType<typeof ciFirstRig>>["rig"],
  paths: string[] | null | "unavailable" | undefined,
): void {
  (rig.github as unknown as {
    options: { changedPaths?: string[] | null | "unavailable" };
  }).options.changedPaths = paths;
}

Deno.test("success rule: a workflow head whose CI only skipped is never reviewed, then parks with its reason", async () => {
  const { rig } = await ciFirstRig("csr-skip", { checks: { [SHA3]: SKIPPED } });
  setChangedPaths(rig, WORKFLOW);
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    let after = await rig.snapshot();
    let work = taskRecord(after);
    assert.equal(work.wait?.reason, "ci_pending", JSON.stringify(work));
    assert.equal(reviewCharges(after).length, 0, "no review round is spent");
    assert.ok(!rig.github.calls.includes("requestReview"));
    assert.deepEqual(rig.github.changedPathReads, [`${SHA1}...${SHA3}`]);
    rig.clock.advance(PRE_REVIEW_CI_BOUND_MS + 1);
    await rig.run();
    after = await rig.snapshot();
    work = taskRecord(after);
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.blocker?.message, WORKFLOW_CI_SUCCESS_DETAIL);
    assert.equal(reviewCharges(after).length, 0);
    assert.ok(!rig.github.calls.includes("requestReview"));
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("success rule: a stand-in success or an unreadable comparison does not satisfy it", async () => {
  for (
    const [prefix, checks, paths] of [
      ["csr-backup", [check("ci", SHA3, "skipped"), standIn(SHA3)], WORKFLOW],
      ["csr-unread", SKIPPED, "unavailable"],
      ["csr-partial", SKIPPED, null],
    ] as const
  ) {
    const { rig } = await ciFirstRig(prefix, {
      checks: { [SHA3]: [...checks] },
    });
    setChangedPaths(rig, paths === null ? null : paths);
    try {
      await rig.run();
      const after = await rig.snapshot();
      assert.equal(taskRecord(after).wait?.reason, "ci_pending", prefix);
      assert.equal(reviewCharges(after).length, 0, prefix);
      assert.ok(!rig.github.calls.includes("requestReview"), prefix);
    } finally {
      await rig.ctx.cleanup();
    }
  }
});

Deno.test("success rule: a head that changes no CI path, or one with a passing job, is reviewed as before", async () => {
  for (
    const [prefix, checks, paths, reads] of [
      ["csr-plain", SKIPPED, ["src/app.ts", "docs/x.md"], 1],
      ["csr-passed", [...SKIPPED, check("test", SHA3, "success")], WORKFLOW, 0],
    ] as const
  ) {
    const { rig } = await ciFirstRig(prefix, {
      checks: { [SHA3]: [...checks] },
    });
    setChangedPaths(rig, [...paths]);
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const after = await rig.snapshot();
      assert.equal(taskRecord(after).nextStep, "review", prefix);
      assert.equal(reviewCharges(after).length, 1, prefix);
      assert.equal(rig.github.changedPathReads.length, reads, prefix);
    } finally {
      await rig.ctx.cleanup();
    }
  }
});

Deno.test("success rule: at the merge gate a reviewed workflow head merges only with a passing job", async () => {
  for (
    const [prefix, checks, merges] of [
      ["csr-merge-skip", SKIPPED, 0],
      ["csr-merge-pass", [...SKIPPED, check("test", SHA3, "success")], 1],
    ] as const
  ) {
    const { rig } = await ciFirstRig(prefix, {
      checks: { [SHA3]: [...checks] },
      reviewed: true,
      reviewRounds: 1,
      nextStep: "delivery",
    });
    setChangedPaths(rig, WORKFLOW);
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const work = taskRecord(await rig.snapshot());
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        merges,
        prefix,
      );
      if (merges === 0) {
        assert.equal(work.nextStep, "delivery", prefix);
        assert.equal(work.wait?.reason, "ci_pending", prefix);
      }
    } finally {
      await rig.ctx.cleanup();
    }
  }
});
