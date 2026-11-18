/**
 * The launcher half of the 2026-11-17 CI integrity rule: a pull request that
 * changes a CI-executable path merges only when every job name GitHub
 * Actions ran to `success` on its base also ran to `success` on its exact
 * head (at least one when the base has none; `targetCiSuccessNames`: never
 * a skipped or neutral job, a commit status, a backup-CI stand-in or another
 * app's check). An unreadable read, or a head without its base, refuses; a
 * pull request that changes no such path merges as before; a delivery train
 * never carries such a change. This gate alone holds such a head, so it
 * survives a runtime rollback.
 */
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy.ts";
import {
  actionsSuccessNames,
  protectedPathRefusal,
} from "../../ops/hosted-autonomy-pull-file-gates.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  finding,
  HEAD,
  jsonResponse,
  pullFacts,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { actionsSuccessNames as runtimeSuccessNames } from "../../src/repair/ci-success-rule.ts";

const TARGET = {
  owner: "ubiquity",
  name: "generic-target",
  installationId: 7,
} as const;

async function deliverable() {
  // A parked head whose review authorizes delivery (P2 only).
  const record = blockedRecord({
    repository: TARGET,
    blocker: {
      kind: "review_quota",
      message: "review rounds exhausted without an accepted verdict (P2)",
      since: 1,
    },
    counters: { attempts: 4, retries: 1, reviewRounds: 3 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-generic-target-48",
      checkpoint: null,
      head: HEAD,
      pr: 51,
    },
  });
  const receipt = authorizingReceipt({
    repository: TARGET,
    findings: [finding("P2")],
    unresolvedSeverities: ["P2"],
  });
  return await makeRig("autonomy-ci-success-merge", {
    repair: repairSnapshot([record], [receipt]),
    defaultBranch: "development",
    pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    afterMerge: pullFacts(),
  });
}

type Names = readonly string[] | null;

Deno.test("CI success rule: a workflow pull request merges only when every base job passed on its head", async (t) => {
  const cases: Array<[string, Names, Names | "unread", number]> = [
    ["every base job passed", ["lint", "test"], ["lint", "test"], 1],
    ["the base's tests replaced by a trivial job", ["trivial"], ["test"], 0],
    ["a base job skipped on the head", ["lint"], ["lint", "test"], 0],
    ["the first CI workflow with a passing job", ["ci"], [], 1],
    ["no job passed at all", [], [], 0],
    ["an unreadable head listing", null, "unread", 0],
    ["an unreadable base listing", ["test"], null, 0],
  ];
  for (const [name, head, base, merges] of cases) {
    await t.step(name, async () => {
      const { rig, github } = await deliverable();
      try {
        const reads: string[] = [];
        github.listPullFiles = () =>
          Promise.resolve(["src/app.ts", ".github/workflows/ci.yml"]);
        github.targetCiSuccessNames = (sha) => {
          reads.push(sha);
          return Promise.resolve(
            sha === HEAD ? head : base === "unread" ? ["test"] : base,
          );
        };
        const result = await run(rig, github);
        assert.equal(rig.merges, merges);
        if (merges === 0) {
          assert.ok(
            result.actions.some((action) =>
              action.endsWith(":ci_success_required")
            ),
            JSON.stringify(result.actions),
          );
        } else {
          assert.equal(result.status, "applied");
        }
        assert.deepEqual(reads, head === null ? [HEAD] : [HEAD, BASE]);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("CI success rule: a surface without the read never merges a workflow change", async () => {
  const { rig, github } = await deliverable();
  try {
    github.listPullFiles = () => Promise.resolve([".github/workflows/ci.yml"]);
    github.targetCiSuccessNames = undefined;
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.ok(
      result.actions.some((action) => action.endsWith(":ci_success_required")),
      JSON.stringify(result.actions),
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("CI success rule: a pull request that changes no CI-executable path merges as before, with no success read", async () => {
  const { rig, github } = await deliverable();
  try {
    let reads = 0;
    github.listPullFiles = () => Promise.resolve(["src/app.ts", "docs/a.md"]);
    github.targetCiSuccessNames = () => {
      reads++;
      return Promise.resolve([]);
    };
    const result = await run(rig, github);
    assert.equal(rig.merges, 1);
    assert.equal(result.status, "applied");
    assert.equal(reads, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("CI success rule: a delivery train never carries a CI-executable change; a head without its base refuses", async () => {
  const surface = {
    listPullFiles: () => Promise.resolve([".github/actions/x/action.yml"]),
    targetCiSuccessNames: () => Promise.resolve(["test"]),
  } as unknown as Parameters<typeof protectedPathRefusal>[0];
  assert.equal(
    await protectedPathRefusal(surface, TARGET, 51, { train: true }),
    "train_ci_executable",
  );
  // The same pull request's own merge applies the success rule instead.
  assert.equal(
    await protectedPathRefusal(surface, TARGET, 51, { head: HEAD, base: BASE }),
    null,
  );
  assert.equal(
    await protectedPathRefusal(surface, TARGET, 51, { head: HEAD }),
    "ci_success_required",
  );
  const plain = {
    listPullFiles: () => Promise.resolve(["src/app.ts"]),
  } as unknown as Parameters<typeof protectedPathRefusal>[0];
  assert.equal(
    await protectedPathRefusal(plain, TARGET, 51, { train: true }),
    null,
  );
});

/** The production surface over one stubbed check-run listing of HEAD. */
async function successOver(runs: unknown[] | null): Promise<Names> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    if (
      runs !== null &&
      url.pathname.endsWith(`/commits/${HEAD}/check-runs`) &&
      url.searchParams.get("page") === "1"
    ) {
      return Promise.resolve(
        jsonResponse({ total_count: runs.length, check_runs: runs }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  try {
    const surface = createHostedAutonomyGitHub("fixture-token", TARGET);
    return await surface.targetCiSuccessNames!(HEAD);
  } finally {
    globalThis.fetch = original;
  }
}

function checkRun(
  id: number,
  conclusion: string,
  app: string | null = "github-actions",
  name = `job-${id}`,
): Record<string, unknown> {
  return {
    id,
    name,
    head_sha: HEAD,
    status: "completed",
    conclusion,
    // A later id started later.
    started_at: new Date(Date.UTC(2026, 10, 17, 0, id)).toISOString(),
    ...(app === null ? {} : { app: { slug: app } }),
  };
}

Deno.test("CI success rule: the surface lists the latest passing GitHub Actions jobs of the commit only", async () => {
  assert.deepEqual(
    await successOver([checkRun(1, "skipped"), checkRun(2, "success")]),
    ["job-2"],
  );
  for (
    const runs of [
      [checkRun(1, "skipped"), checkRun(2, "neutral")],
      // A run with no app (a status-like observation) is no Actions job.
      [checkRun(1, "success", null)],
      [checkRun(1, "success", "coderabbitai", "CodeRabbit")],
      // The latest run of a name decides it.
      [checkRun(1, "success", undefined, "test"), {
        ...checkRun(2, "failure", undefined, "test"),
      }],
      [],
    ]
  ) assert.deepEqual(await successOver(runs), [], JSON.stringify(runs));
  assert.deepEqual(
    await successOver([
      checkRun(3, "success", undefined, "test"),
      checkRun(2, "failure", undefined, "test"),
      checkRun(1, "success", undefined, "lint"),
    ]),
    ["lint", "test"],
  );
  assert.equal(await successOver(null), null);
});

Deno.test("CI success rule: a backup-CI stand-in is never an Actions success; the runtime reads the same set", () => {
  assert.deepEqual(
    actionsSuccessNames([
      { ...checkRun(1, "success", undefined, "deno"), sentinel_backup: {} },
      checkRun(2, "success", undefined, "lint"),
    ]),
    ["lint"],
  );
  // The launcher and the runtime agree, latest run per name included: a
  // later non-Actions run of the same name hides an earlier Actions success
  // in both.
  const runs = [
    checkRun(1, "success", undefined, "test"),
    checkRun(2, "success", "other-app", "test"),
    checkRun(3, "success", undefined, "lint"),
    checkRun(4, "skipped", undefined, "e2e"),
  ];
  const observed = runs.map((run) => ({
    name: String(run.name),
    status: "completed" as const,
    conclusion: run.conclusion as "success" | "skipped",
    head: HEAD as GitSha,
    startedAt: Date.parse(String(run.started_at)),
    completedAt: Date.parse(String(run.started_at)),
    ...(run.app === undefined
      ? {}
      : { app: String((run.app as { slug: string }).slug) }),
  }));
  assert.deepEqual(actionsSuccessNames(runs), ["lint"]);
  assert.deepEqual([...runtimeSuccessNames(observed)].sort(), ["lint"]);
});
