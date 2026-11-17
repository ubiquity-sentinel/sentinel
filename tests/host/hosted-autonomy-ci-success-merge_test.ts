/**
 * The launcher half of the 2026-11-17 CI integrity rule: a pull request that
 * changes a CI-executable path merges only when its exact head carries a job
 * its own CI ran to `success` (`hasTargetCiSuccess`: never a skipped or
 * neutral job, a backup-CI stand-in or another app's check). An unreadable
 * read refuses; a pull request that changes no such path merges as before;
 * a delivery train never carries such a change.
 */
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy.ts";
import { protectedPathRefusal } from "../../ops/hosted-autonomy-pull-file-gates.ts";
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

Deno.test("CI success rule: a workflow pull request merges only with a job its own CI passed", async (t) => {
  const cases: Array<[string, boolean | null | undefined, number]> = [
    ["a passing job", true, 1],
    ["only skipped or neutral jobs", false, 0],
    ["an unreadable check listing", null, 0],
    ["a surface without the read", undefined, 0],
  ];
  for (const [name, success, merges] of cases) {
    await t.step(name, async () => {
      const { rig, github } = await deliverable();
      try {
        const heads: string[] = [];
        github.listPullFiles = () =>
          Promise.resolve(["src/app.ts", ".github/workflows/ci.yml"]);
        github.hasTargetCiSuccess = success === undefined
          ? undefined
          : (head) => {
            heads.push(head);
            return Promise.resolve(success);
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
        if (success !== undefined) assert.deepEqual(heads, [HEAD]);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("CI success rule: a pull request that changes no CI-executable path merges as before, with no success read", async () => {
  const { rig, github } = await deliverable();
  try {
    let reads = 0;
    github.listPullFiles = () => Promise.resolve(["src/app.ts", "docs/a.md"]);
    github.hasTargetCiSuccess = () => {
      reads++;
      return Promise.resolve(false);
    };
    const result = await run(rig, github);
    assert.equal(rig.merges, 1);
    assert.equal(result.status, "applied");
    assert.equal(reads, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("CI success rule: a delivery train never carries a CI-executable change", async () => {
  const surface = {
    listPullFiles: () => Promise.resolve([".github/actions/x/action.yml"]),
    hasTargetCiSuccess: () => Promise.resolve(true),
  } as unknown as Parameters<typeof protectedPathRefusal>[0];
  assert.equal(
    await protectedPathRefusal(surface, TARGET, 51, { train: true }),
    "train_ci_executable",
  );
  // The same pull request's own merge applies the success rule instead.
  assert.equal(
    await protectedPathRefusal(surface, TARGET, 51, { head: HEAD }),
    null,
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
async function successOver(runs: unknown[] | null): Promise<boolean | null> {
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
    return await surface.hasTargetCiSuccess!(HEAD);
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
    ...(app === null ? {} : { app: { slug: app } }),
  };
}

Deno.test("CI success rule: the surface reads a passing job of the head's own CI only", async () => {
  assert.equal(
    await successOver([checkRun(1, "skipped"), checkRun(2, "success")]),
    true,
  );
  assert.equal(await successOver([checkRun(1, "success", null)]), true);
  for (
    const runs of [
      [checkRun(1, "skipped"), checkRun(2, "neutral")],
      [checkRun(1, "success", "coderabbitai", "CodeRabbit")],
      [],
    ]
  ) assert.equal(await successOver(runs), false, JSON.stringify(runs));
  assert.equal(await successOver(null), null);
});
