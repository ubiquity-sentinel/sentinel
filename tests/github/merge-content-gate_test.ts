/**
 * The merge executors' own content gate (2026-11-17): no single caller is the
 * only barrier between a model-written change and a merge. The executor
 * re-reads the exact `base...head` change set and refuses what Sentinel never
 * merges (`sentinelNeverMerges`), and a change to a CI-executable path merges
 * only when every job GitHub Actions passed on the last merged pull request
 * into the base branch also passed on the exact head (2026-11-18). An
 * unreadable or possibly truncated change set never merges.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  mergeContentRefusal,
  neverMergedChange,
} from "../../src/github/merge-content-gate.ts";
import {
  FakeGitExecutor,
  httpRespond,
  makePort,
  SHA1,
  SHA2,
} from "./helpers.ts";
import {
  blockedReason,
  CLOCK,
  happyScript,
  mergeCall,
  putCount,
  trustedService,
} from "./merge-helpers.ts";

const TARGET = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 };
const SELF = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 1,
};
const BASE = SHA2;
const HEAD = SHA1;

function actions(
  name: string,
  head: GitSha,
  conclusion: GitHubCheckV1["conclusion"],
): GitHubCheckV1 {
  return {
    name,
    status: "completed",
    conclusion,
    head,
    startedAt: 1,
    completedAt: 2,
    app: "github-actions",
  };
}

const MERGED = "c".repeat(40) as GitSha;

/**
 * Reads answering one comparison, the checks of every commit (`base`: the
 * reference merged head's and the base's) and one merged listing.
 */
function reads(
  paths: string[] | null | "down",
  base: GitHubCheckV1[] | "down" = [],
  merged: GitSha[] = [MERGED],
) {
  const calls: string[] = [];
  return {
    calls,
    readMergedPullHeads(ref: string) {
      calls.push(`merged ${ref}`);
      return Promise.resolve(portOk({ heads: merged, complete: true }));
    },
    readChangedPaths(from: GitSha, to: GitSha) {
      calls.push(`compare ${from}...${to}`);
      return Promise.resolve(
        paths === "down"
          ? portError("unavailable", "compare failed")
          : portOk(paths === null ? null : [...paths]),
      );
    },
    readChecks(head: GitSha) {
      calls.push(`checks ${head}`);
      return Promise.resolve(
        base === "down"
          ? portError("unavailable", "checks failed")
          : portOk({ head, checks: [...base] }),
      );
    },
  };
}

const PASSING_HEAD = [actions("test", HEAD, "success")];

Deno.test("merge content gate: an ordinary change merges with one comparison read", async () => {
  const read = reads(["src/app.ts", "docs/x.md"]);
  assert.equal(
    await mergeContentRefusal(read, TARGET, BASE, HEAD, []),
    null,
  );
  assert.deepEqual(read.calls, [`compare ${BASE}...${HEAD}`]);
});

Deno.test("merge content gate: what Sentinel never merges is refused on targets and on itself", async () => {
  for (
    const [repository, paths] of [
      [TARGET, ["src/app.ts", ".env"]],
      [TARGET, ["src/app.ts", '".github/workflows/d\\303\\251ploy.yml"']],
      [SELF, ["src/app.ts", "src/repair/workflow-trust.ts"]],
      [SELF, ["src/app.ts", "src/github/merge-content-gate.ts"]],
      [SELF, ["src/app.ts", "ops/hosted-autonomy-pull-file-gates.ts"]],
      [SELF, ["src/app.ts", ".github/actions/ordinary/main.js"]],
    ] as const
  ) {
    assert.equal(neverMergedChange(repository, paths), true, paths[1]);
    assert.equal(
      await mergeContentRefusal(
        reads([...paths], PASSING_HEAD),
        repository,
        BASE,
        HEAD,
        PASSING_HEAD,
      ),
      "protection_required",
      paths[1],
    );
  }
});

Deno.test("merge content gate: an unreadable or possibly truncated comparison never merges", async () => {
  for (const paths of ["down", null] as const) {
    assert.equal(
      await mergeContentRefusal(reads(paths), TARGET, BASE, HEAD, []),
      "checks_pending",
      String(paths),
    );
  }
});

Deno.test("merge content gate: a target's CI change merges only when every job of the last merged pull request passed on the head", async () => {
  const WORKFLOW = ["src/app.ts", ".github/workflows/ci.yml"];
  const base = [
    actions("test", MERGED, "success"),
    actions("lint", MERGED, "success"),
    // A commit status is no Actions job and is not expected.
    { ...actions("status", MERGED, "success"), app: undefined },
  ];
  const cases: [GitHubCheckV1[], GitHubCheckV1[] | "down", string | null][] = [
    // The workflow edit drops the base's lint job for a trivial one.
    [
      [actions("test", HEAD, "success"), actions("trivial", HEAD, "success")],
      base,
      "checks_pending",
    ],
    [
      [actions("test", HEAD, "success"), actions("lint", HEAD, "skipped")],
      base,
      "checks_pending",
    ],
    [
      [actions("test", HEAD, "success"), actions("lint", HEAD, "success")],
      base,
      null,
    ],
    // No Actions job anywhere (first CI): one Actions success is required.
    [[actions("ci", HEAD, "skipped")], [], "checks_pending"],
    [[actions("ci", HEAD, "success")], [], null],
    // An unreadable reference never merges a CI change.
    [[actions("test", HEAD, "success")], "down", "checks_pending"],
  ];
  for (const [head, baseChecks, verdict] of cases) {
    const read = reads(WORKFLOW, baseChecks);
    assert.equal(
      await mergeContentRefusal(read, TARGET, BASE, HEAD, head, "main"),
      verdict,
      JSON.stringify(head.map((c) => [c.name, c.conclusion])),
    );
    const firstCi = Array.isArray(baseChecks) && baseChecks.length === 0;
    assert.deepEqual(read.calls, [
      `compare ${BASE}...${HEAD}`,
      "merged main",
      `checks ${MERGED}`,
      ...(firstCi ? [`checks ${BASE}`] : []),
    ]);
  }
  // Without the base branch the reference cannot be listed: never merges.
  assert.equal(
    await mergeContentRefusal(
      reads(WORKFLOW, base),
      TARGET,
      BASE,
      HEAD,
      [actions("test", HEAD, "success"), actions("lint", HEAD, "success")],
    ),
    "checks_pending",
  );
});

function comparison(status: number, files: string[]) {
  return {
    ...httpRespond(
      "GET",
      `/repos/ubiquity-sentinel/sentinel/compare/${BASE}...${HEAD}?per_page=1`,
      status,
      status === 200
        ? { files: files.map((filename) => ({ filename })) }
        : { message: "Server Error" },
    ),
    repeat: true,
  };
}

Deno.test("merge content gate: Sentinel's merge port refuses its own authority change before the merge call", async () => {
  // [local mirror diff (null: the mirror lacks a commit), comparison, reason]
  for (
    const [local, entry, reason] of [
      [["src/repair/workflow-trust.ts"], null, "protection_required"],
      [[".github/workflows/ci.yml"], null, "protection_required"],
      [
        null,
        comparison(200, ["src/repair/workflow-trust.ts"]),
        "protection_required",
      ],
      [
        null,
        comparison(200, [".github/workflows/ci.yml"]),
        "protection_required",
      ],
      [null, comparison(500, []), "checks_pending"],
    ] as const
  ) {
    const git = new FakeGitExecutor();
    git.changed = local === null ? null : [...local];
    const { port, transport } = makePort({
      clock: CLOCK,
      script: happyScript({ extra: entry === null ? [] : [entry] }),
      review: trustedService(),
      git,
    });
    const result = await mergeCall(port);
    assert.equal(blockedReason(result), reason, JSON.stringify(result));
    assert.equal(putCount(transport), 0, "no merge call");
  }
});

Deno.test("merge content gate (review probe: reads): an ordinary head in the mirror pays no comparison and is never held by it", async () => {
  // The comparison is down (500) or the base vanished from GitHub (404): the
  // local mirror's own diff decides, so an ordinary head still merges.
  for (const status of [500, 404]) {
    const git = new FakeGitExecutor();
    git.changed = ["src/app.ts"];
    const { port, transport } = makePort({
      clock: CLOCK,
      script: happyScript({
        extra: [{
          ...httpRespond(
            "GET",
            `/repos/ubiquity-sentinel/sentinel/compare/${SHA2}...${SHA1}?per_page=1`,
            status,
            { message: "x" },
          ),
          repeat: true,
        }],
      }),
      review: trustedService(),
      git,
    });
    const result = await mergeCall(port);
    assert.notEqual(blockedReason(result), "checks_pending", String(status));
    assert.equal(
      transport.requests.filter((request) => request.url.includes("/compare/"))
        .length,
      0,
      "no comparison read",
    );
  }
});
