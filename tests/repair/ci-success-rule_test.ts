/**
 * The CI integrity rule for a head that changes a CI-executable path (owner
 * directive 2026-11-17): every job name GitHub Actions ran to success on the
 * base must also run to success on the exact head (at least one when the
 * base has none) before a review round is spent or a merge happens. Only
 * GitHub Actions check runs count: never a commit status or app-less
 * observation, another app's check, a skipped or neutral job, or a backup-CI
 * stand-in. The rule applies on positive knowledge from the exact
 * comparison; an unreadable comparison decides exactly as before.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  decideCiGate,
  decideHeadCiGate,
} from "../../src/repair/loop-checks.ts";
import {
  ciChangeSatisfied,
  WORKFLOW_CI_SUCCESS_DETAIL,
} from "../../src/repair/ci-success-rule.ts";
import { PRE_REVIEW_CI_BOUND_MS } from "../../src/repair/ci-first-policy.ts";
import { REPO, SHA1, SHA3 } from "../state/helpers.ts";
import {
  check,
  ciFirstRig,
  reviewCharges,
  taskRecord,
} from "./ci-first-rig.ts";

const WORKFLOW = ["src/app.ts", ".github/workflows/ci.yml"];

/** A GitHub Actions check run. */
function actions(
  name: string,
  head: GitSha,
  conclusion: GitHubCheckV1["conclusion"],
): GitHubCheckV1 {
  return { ...check(name, head, conclusion), app: "github-actions" };
}

function standIn(head: GitSha): GitHubCheckV1 {
  return {
    ...actions("deno", head, "success"),
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
  actions("ci", SHA3, "skipped"),
  actions("lint", SHA3, "neutral"),
];

Deno.test("success rule: only GitHub Actions jobs count, and the base's passing jobs must pass on the head", () => {
  const wait = (checks: GitHubCheckV1[], base: GitHubCheckV1[] = []) =>
    assert.equal(
      decideCiGate(checks, REPO, { requireSuccess: true, baseChecks: base }),
      "wait",
      JSON.stringify(checks),
    );
  wait(SKIPPED);
  wait([standIn(SHA3)]);
  // A commit status (no app) or another app's success is no Actions job.
  wait([
    actions("test", SHA3, "skipped"),
    check("netlify/deploy-preview", SHA3, "success"),
  ]);
  wait([...SKIPPED, {
    ...check("CodeRabbit", SHA3, "success"),
    app: "coderabbitai",
  }]);
  // A workflow edit that drops the base's real tests for a trivial job.
  wait(
    [actions("trivial", SHA3, "success"), actions("test", SHA3, "skipped")],
    [actions("test", SHA1, "success"), actions("lint", SHA1, "success")],
  );
  // Every base success name passes on the head: proceed.
  assert.equal(
    decideCiGate(
      [actions("test", SHA3, "success"), actions("lint", SHA3, "success")],
      REPO,
      {
        requireSuccess: true,
        baseChecks: [
          actions("test", SHA1, "success"),
          actions("lint", SHA1, "success"),
        ],
      },
    ),
    "proceed",
  );
  // The first CI workflow: no base job, one Actions success on the head.
  assert.equal(
    decideCiGate([actions("ci", SHA3, "success")], REPO, {
      requireSuccess: true,
      baseChecks: [],
    }),
    "proceed",
  );
  assert.equal(
    ciChangeSatisfied([actions("ci", SHA3, "success")], [
      check("status-only", SHA1, "success"),
    ]),
    true,
    "a base commit status is not an expected Actions job",
  );
  // Without the option every head decides exactly as before.
  assert.equal(decideCiGate(SKIPPED), "proceed");
  assert.equal(decideCiGate([standIn(SHA3)]), "proceed");
  // A failure still blocks first.
  assert.deepEqual(
    decideCiGate([actions("ci", SHA3, "failure")], REPO, {
      requireSuccess: true,
    }),
    { blocked: "CI checks failed: ci(failure)" },
  );
});

Deno.test("success rule: an ordinary head decides exactly as before whatever the comparison says", async () => {
  for (
    const read of [
      () => Promise.resolve(portOk(["src/app.ts"])),
      () => Promise.resolve(portError("unavailable", "5xx")),
      () => Promise.resolve(portOk(null)),
    ]
  ) {
    const verdict = await decideHeadCiGate(
      { github: { readChangedPaths: read } as never },
      { target: { base: SHA1, head: SHA3 } } as never,
      SKIPPED,
      REPO,
    );
    assert.equal(verdict, decideCiGate(SKIPPED, REPO));
  }
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
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("success rule: a stand-in or status success does not satisfy it; an unreadable comparison decides as before", async () => {
  for (
    const [prefix, checks, paths, reviewed] of [
      [
        "csr-backup",
        [actions("ci", SHA3, "skipped"), standIn(SHA3)],
        WORKFLOW,
        false,
      ],
      [
        "csr-status",
        [actions("ci", SHA3, "skipped"), check("status", SHA3, "success")],
        WORKFLOW,
        false,
      ],
      ["csr-unread", SKIPPED, "unavailable", true],
      ["csr-partial", SKIPPED, null, true],
    ] as const
  ) {
    const { rig } = await ciFirstRig(prefix, {
      checks: { [SHA3]: [...checks] },
    });
    setChangedPaths(
      rig,
      paths === null ? null : paths === "unavailable" ? paths : [...paths],
    );
    try {
      await rig.run();
      const after = await rig.snapshot();
      assert.equal(reviewCharges(after).length, reviewed ? 1 : 0, prefix);
      if (!reviewed) {
        assert.equal(taskRecord(after).wait?.reason, "ci_pending", prefix);
      }
    } finally {
      await rig.ctx.cleanup();
    }
  }
});

Deno.test("success rule: a head that changes no CI path, or a workflow head with a passing Actions job, is reviewed as before", async () => {
  for (
    const [prefix, checks, paths] of [
      ["csr-plain", SKIPPED, ["src/app.ts", "docs/x.md"]],
      ["csr-passed", [...SKIPPED, actions("test", SHA3, "success")], WORKFLOW],
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
    } finally {
      await rig.ctx.cleanup();
    }
  }
});

Deno.test("success rule: at the merge gate a reviewed workflow head merges only with every base job passing on it", async () => {
  for (
    const [prefix, checks, merges] of [
      ["csr-merge-skip", SKIPPED, 0],
      ["csr-merge-pass", [...SKIPPED, actions("test", SHA3, "success")], 1],
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
