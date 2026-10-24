/**
 * Issue #158 item 2: the launcher's merge gates never land a change to the
 * target's protected paths. The plain gate lists the pull request's files
 * (a rename's previous path included); the carried gate checks the exact
 * patch it already proves. An unreadable listing refuses.
 */
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy.ts";
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

const GATEWAY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;

async function withFiles<T>(
  pages: unknown[],
  body: (surface: ReturnType<typeof createHostedAutonomyGitHub>) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    const match = /\/pulls\/7\/files$/.exec(url.pathname);
    const page = Number(url.searchParams.get("page"));
    if (match !== null && page >= 1 && page <= pages.length) {
      return Promise.resolve(jsonResponse(pages[page - 1]));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  try {
    return await body(createHostedAutonomyGitHub("fixture-token", GATEWAY));
  } finally {
    globalThis.fetch = original;
  }
}

const file = (filename: string, extra: Record<string, unknown> = {}) => ({
  filename,
  status: "modified",
  ...extra,
});

Deno.test("protected merge: the surface lists every changed path, renames included", async () => {
  const full = Array.from({ length: 100 }, (_, i) => file(`src/f${i}.ts`));
  const paths = await withFiles(
    [full, [file("src/new.ts", {
      status: "renamed",
      previous_filename: "src/kv.ts",
    })]],
    (surface) => surface.listPullFiles!(7),
  );
  assert.equal(paths?.length, 102);
  assert.deepEqual(paths?.slice(-2), ["src/new.ts", "src/kv.ts"]);
});

Deno.test("protected merge: a malformed, unreadable or capped listing is unproven", async (t) => {
  const full = Array.from({ length: 100 }, (_, i) => file(`src/f${i}.ts`));
  const cases: Array<[string, unknown[]]> = [
    ["malformed entry", [[{ status: "modified" }]]],
    ["empty previous name", [[file("a.ts", { previous_filename: "" })]]],
    ["unreadable page", [full]],
    ["3000-file cap", Array.from({ length: 30 }, () => full)],
  ];
  for (const [name, pages] of cases) {
    await t.step(name, async () => {
      assert.equal(
        await withFiles(pages, (surface) => surface.listPullFiles!(7)),
        null,
      );
    });
  }
});

async function deliverable() {
  // A parked self head whose review authorizes delivery (P2 only).
  const record = blockedRecord({
    blocker: {
      kind: "review_quota",
      message: "review rounds exhausted without an accepted verdict (P2)",
      since: 1,
    },
    counters: { attempts: 4, retries: 1, reviewRounds: 3 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      checkpoint: null,
      head: HEAD,
      pr: 51,
    },
  });
  const receipt = authorizingReceipt({
    findings: [finding("P2")],
    unresolvedSeverities: ["P2"],
  });
  return await makeRig("autonomy-protected-merge", {
    repair: repairSnapshot([record], [receipt]),
    pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    afterMerge: pullFacts(),
  });
}

Deno.test("protected merge: a pull request touching a protected path never merges", async (t) => {
  const cases: Array<[string, readonly string[] | null, string]> = [
    [
      "protected path",
      ["README.md", ".github/workflows/ci.yml"],
      "protected_path",
    ],
    ["renamed from a protected path", [
      "docs/x.md",
      "ops/hosted-autonomy-queue-pass.ts",
    ], "protected_path"],
    ["unreadable listing", null, "protected_path_unverified"],
  ];
  for (const [name, files, refusal] of cases) {
    await t.step(name, async () => {
      const { rig, github } = await deliverable();
      try {
        github.listPullFiles = () => Promise.resolve(files);
        const result = await run(rig, github);
        assert.equal(rig.merges, 0);
        assert.ok(
          result.actions.some((action) => action.endsWith(`:${refusal}`)),
          JSON.stringify(result.actions),
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("protected merge: a pull request outside the protected paths still merges", async () => {
  const { rig, github } = await deliverable();
  try {
    let listed = 0;
    github.listPullFiles = (number) => {
      listed++;
      assert.equal(number, 51);
      return Promise.resolve(["README.md"]);
    };
    const result = await run(rig, github);
    assert.equal(listed, 1);
    assert.equal(rig.merges, 1);
    assert.equal(result.status, "applied");
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
