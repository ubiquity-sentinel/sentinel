// Launcher squash delivery (#331): the hosted merge surface squashes a green
// foreign head where the trusted policy and the target allow it, with the
// pull request title and its `Resolves #N` line under the same expected-head
// guard, and books the squash by its exact merge SHA, single parent [tip] and
// the head's own tree. All fixtures are synthetic; fetch is stubbed.
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy.ts";
import {
  baseAndHeadAreMerged,
  mergedExactlyOn,
} from "../../ops/hosted-autonomy-delivery.ts";
import { hostedMergeBody } from "../../ops/hosted-autonomy-merge-shape.ts";
import type { HostedAutonomyPullV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  BASE,
  checkRun,
  checkRunPage,
  FOREIGN_BRANCH,
  FOREIGN_PR,
  FOREIGN_REPO,
  FOREIGN_TARGET,
  FOREIGN_TASK_BODY,
  FOREIGN_TASK_TITLE,
  foreignReceipt,
  foreignRecord,
  HEAD,
  isForeignPath,
  jsonResponse,
  MERGE,
  SHARED_ISSUE_NUMBER,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";

const TREE = "7".repeat(40);
const OTHER_TREE = "8".repeat(40);
const TITLE = "Fix the foreign task";

interface Stub {
  readonly puts: Record<string, unknown>[];
}

function stubForeign(headTree: string): Stub {
  const puts: Record<string, unknown>[] = [];
  let mergedNow = false;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!isForeignPath(url)) {
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    if (method === "PUT" && url.endsWith(`/pulls/${FOREIGN_PR}/merge`)) {
      puts.push(JSON.parse(String(init?.body ?? "{}")));
      mergedNow = true;
      return Promise.resolve(jsonResponse({ merged: true, sha: MERGE }));
    }
    if (method === "PATCH" && url.endsWith(`/issues/${SHARED_ISSUE_NUMBER}`)) {
      return Promise.resolve(
        jsonResponse({ state: "closed", number: SHARED_ISSUE_NUMBER }),
      );
    }
    if (url.includes(`/pulls/${FOREIGN_PR}/files`)) {
      return Promise.resolve(jsonResponse([
        { filename: "README.md", status: "modified" },
      ]));
    }
    if (url.includes(`/pulls/${FOREIGN_PR}`)) {
      return Promise.resolve(jsonResponse({
        state: mergedNow ? "closed" : "open",
        merged: mergedNow,
        merge_commit_sha: mergedNow ? MERGE : null,
        title: TITLE,
        body: `Resolves #${SHARED_ISSUE_NUMBER}`,
        head: { sha: HEAD },
        base: { ref: FOREIGN_BRANCH },
        user: { login: "ubiquity-sentinel[bot]" },
        number: FOREIGN_PR,
      }));
    }
    const listed = /\/commits\/([0-9a-f]{40})\/check-runs/.exec(url)?.[1];
    const payload = listed !== undefined
      ? checkRunPage([
        checkRun("validate", { head_sha: listed }),
        checkRun("verify-artifact", { head_sha: listed }),
      ], 2)
      : url.endsWith(`/commits/${MERGE}`)
      // The squash commit: a single parent, the reviewed base.
      ? { commit: { tree: { sha: TREE } }, parents: [{ sha: BASE }] }
      : url.endsWith(`/commits/${HEAD}`)
      ? { commit: { tree: { sha: headTree } }, parents: [{ sha: BASE }] }
      : url.includes("/compare/")
      ? {
        status: "ahead",
        base_commit: { sha: MERGE },
        merge_base_commit: { sha: MERGE },
      }
      : url.includes("/git/ref/")
      ? { ref: `refs/heads/${FOREIGN_BRANCH}`, object: { sha: BASE } }
      : url.includes("/actions/runs")
      ? { workflow_runs: [] }
      : url.includes("/issues/")
      ? {
        state: "open",
        number: SHARED_ISSUE_NUMBER,
        title: FOREIGN_TASK_TITLE,
        body: FOREIGN_TASK_BODY,
      }
      : {
        default_branch: FOREIGN_BRANCH,
        allow_squash_merge: true,
        allow_merge_commit: true,
      };
    return Promise.resolve(jsonResponse(payload));
  }) as typeof fetch;
  return { puts };
}

Deno.test("hosted squash delivery: a green foreign head squashes with the exact message and books the squash SHA", async () => {
  const original = globalThis.fetch;
  try {
    const stub = stubForeign(TREE);
    const { rig } = await makeRig("autonomy-foreign-squash", {
      repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
      resolver: (repository) =>
        createHostedAutonomyGitHub("fixture-token", repository),
    });
    const result = await run(rig);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.deepEqual([...result.revisions], [MERGE]);
    assert.ok(
      result.actions.includes(`delivery:${FOREIGN_TARGET}:foreign_merged`),
      JSON.stringify(result.actions),
    );
    assert.deepEqual(stub.puts, [{
      sha: HEAD,
      merge_method: "squash",
      commit_title: TITLE,
      commit_message: `Resolves #${SHARED_ISSUE_NUMBER}`,
    }]);
    await Deno.remove(rig.tmp, { recursive: true });
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("hosted squash delivery: a squash whose tree is not the head's tree is never booked", async () => {
  const original = globalThis.fetch;
  try {
    stubForeign(OTHER_TREE);
    const { rig } = await makeRig("autonomy-foreign-squash-tree", {
      repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
      resolver: (repository) =>
        createHostedAutonomyGitHub("fixture-token", repository),
    });
    const result = await run(rig);
    assert.deepEqual([...result.revisions], []);
    assert.ok(
      result.actions.includes(
        `delivery:${FOREIGN_TARGET}:merged_off_tip:sha=${MERGE}`,
      ),
      JSON.stringify(result.actions),
    );
    await Deno.remove(rig.tmp, { recursive: true });
  } finally {
    globalThis.fetch = original;
  }
});

function request(responses: Record<string, unknown>) {
  const seen: string[] = [];
  const fn = (_method: string, path: string) => {
    seen.push(path);
    return Promise.resolve(responses[path] ?? null);
  };
  return { fn, seen };
}

const REPO_PATH = `/repos/${FOREIGN_REPO.owner}/${FOREIGN_REPO.name}`;

Deno.test("hosted merge body: forbid-squash keeps merge, invalid policy and unreadable setting refuse", async () => {
  const forbid = request({
    [REPO_PATH]: { allow_squash_merge: false, allow_merge_commit: true },
  });
  assert.deepEqual(
    await hostedMergeBody(forbid.fn, FOREIGN_REPO, FOREIGN_PR, HEAD, "proof"),
    { sha: HEAD, merge_method: "merge", commit_message: "proof" },
  );
  const key = `${FOREIGN_REPO.owner}/${FOREIGN_REPO.name}`.toLowerCase();
  const invalid = request({});
  assert.equal(
    await hostedMergeBody(
      invalid.fn,
      FOREIGN_REPO,
      FOREIGN_PR,
      HEAD,
      undefined,
      {
        [key]: { mergeMethod: "rebase" },
      },
    ),
    null,
  );
  assert.deepEqual(invalid.seen, [], "an invalid policy reads nothing");
  const unreadable = request({});
  assert.equal(
    await hostedMergeBody(unreadable.fn, FOREIGN_REPO, FOREIGN_PR, HEAD),
    null,
  );
  const explicit = request({});
  assert.deepEqual(
    await hostedMergeBody(
      explicit.fn,
      FOREIGN_REPO,
      FOREIGN_PR,
      HEAD,
      undefined,
      {
        [key]: { mergeMethod: "merge" },
      },
    ),
    { sha: HEAD, merge_method: "merge" },
  );
  // A squash whose pull head moved is refused before the merge call.
  const moved = request({
    [REPO_PATH]: { allow_squash_merge: true, allow_merge_commit: true },
    [`${REPO_PATH}/pulls/${FOREIGN_PR}`]: {
      title: TITLE,
      body: null,
      head: { sha: BASE },
    },
  });
  assert.equal(
    await hostedMergeBody(moved.fn, FOREIGN_REPO, FOREIGN_PR, HEAD),
    null,
  );
});

Deno.test("hosted landing proof: a squash is exact only on [tip] with the head's own tree", () => {
  const pull = (over: Partial<HostedAutonomyPullV1>): HostedAutonomyPullV1 => ({
    number: FOREIGN_PR,
    state: "closed",
    merged: true,
    mergeCommitSha: MERGE,
    headSha: HEAD,
    baseRef: FOREIGN_BRANCH,
    baseSha: BASE,
    author: null,
    parents: [BASE],
    mergeTree: TREE,
    headTree: TREE,
    revisionOnBaseBranch: true,
    baseAncestorOfRevision: true,
    ...over,
  });
  assert.equal(mergedExactlyOn(pull({}), BASE, HEAD), true);
  assert.equal(baseAndHeadAreMerged(pull({}), BASE, HEAD), true);
  for (
    const bad of [
      pull({ headTree: OTHER_TREE }),
      pull({ mergeTree: null, headTree: null }),
      pull({ mergeTree: undefined, headTree: undefined }),
      pull({ parents: [HEAD] }),
      pull({ headSha: BASE }),
    ]
  ) {
    assert.equal(mergedExactlyOn(bad, BASE, HEAD), false);
    assert.equal(baseAndHeadAreMerged(bad, BASE, HEAD), false);
  }
  // The merge-commit shape is unchanged.
  assert.equal(
    mergedExactlyOn(pull({ parents: [BASE, HEAD] }), BASE, HEAD),
    true,
  );
});
