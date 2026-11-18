/**
 * The merge executors' own content gate (2026-11-17): no single caller is the
 * only barrier between a model-written change and a merge. The executor
 * re-reads the exact `base...head` comparison and refuses what Sentinel never
 * merges (`sentinelNeverMerges`), and a change to a CI-executable path merges
 * only when every job GitHub Actions passed on the base also passed on the
 * exact head. An unreadable or possibly truncated comparison never merges.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  mergeContentRefusal,
  neverMergedChange,
} from "../../src/github/merge-content-gate.ts";
import { httpRespond, SHA1, SHA2 } from "./helpers.ts";
import {
  blockedReason,
  happyScript,
  mergeCall,
  mergedPort,
  putCount,
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

/** Reads answering one comparison and the base's checks. */
function reads(
  paths: string[] | null | "down",
  base: GitHubCheckV1[] | "down" = [],
) {
  const calls: string[] = [];
  return {
    calls,
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

Deno.test("merge content gate: a target's CI change merges only when every base Actions job passed on the head", async () => {
  const WORKFLOW = ["src/app.ts", ".github/workflows/ci.yml"];
  const base = [
    actions("test", BASE, "success"),
    actions("lint", BASE, "success"),
    // A base commit status is no Actions job and is not expected.
    { ...actions("status", BASE, "success"), app: undefined },
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
    // No base job: one Actions success on the head is required.
    [[actions("ci", HEAD, "skipped")], [], "checks_pending"],
    [[actions("ci", HEAD, "success")], [], null],
    // An unreadable base never merges a CI change.
    [[actions("test", HEAD, "success")], "down", "checks_pending"],
  ];
  for (const [head, baseChecks, verdict] of cases) {
    const read = reads(WORKFLOW, baseChecks);
    assert.equal(
      await mergeContentRefusal(read, TARGET, BASE, HEAD, head),
      verdict,
      JSON.stringify(head.map((c) => [c.name, c.conclusion])),
    );
    assert.deepEqual(read.calls, [
      `compare ${BASE}...${HEAD}`,
      `checks ${BASE}`,
    ]);
  }
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
  for (
    const [entry, reason] of [
      [
        comparison(200, ["src/repair/workflow-trust.ts"]),
        "protection_required",
      ],
      [comparison(200, [".github/workflows/ci.yml"]), "protection_required"],
      [comparison(500, []), "checks_pending"],
    ] as const
  ) {
    const { port, transport } = mergedPort(happyScript({ extra: [entry] }));
    const result = await mergeCall(port);
    assert.equal(blockedReason(result), reason, JSON.stringify(result));
    assert.equal(putCount(transport), 0, "no merge call");
  }
});
