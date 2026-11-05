/** Issue #331: delivery shape changes, not the reviewed merge input. */
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { createHostedAutonomyMerge } from "../../ops/hosted-autonomy-github-merge.ts";
import {
  baseAndHeadAreMerged,
  mergedExactlyOn,
} from "../../ops/hosted-autonomy-delivery.ts";
import type { HostedAutonomyPullV1 } from "../../ops/hosted-autonomy-types.ts";
import { targetDeliveryMethodV1 } from "../../src/host/target-policy.ts";

const repository = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};
const scope = "ubiquity-sentinel/sentinel";
const head = "a".repeat(40);
const base = "b".repeat(40);
const revision = "c".repeat(40);
const title = "Keep base-refresh bookkeeping off default branches";
const pull = {
  number: 7,
  title,
  body: "Resolves #331",
  head: { sha: head },
};

async function withGitHub(
  options: { settings?: unknown; pull?: unknown; status?: number },
  body: (
    surface: ReturnType<typeof createHostedAutonomyGitHub>,
    writes: unknown[],
  ) => Promise<void>,
) {
  const original = globalThis.fetch;
  const writes: unknown[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "PUT") {
      assert.equal(path, `/repos/${scope}/pulls/7/merge`);
      writes.push(JSON.parse(String(init.body)));
      return Promise.resolve(Response.json(
        { merged: true, sha: revision },
        { status: options.status ?? 200 },
      ));
    }
    if (path === `/repos/${scope}/pulls/7`) {
      return Promise.resolve(Response.json(
        Object.hasOwn(options, "pull") ? options.pull : pull,
      ));
    }
    assert.equal(path, `/repos/${scope}`);
    return Promise.resolve(Response.json(
      Object.hasOwn(options, "settings")
        ? options.settings
        : { allow_squash_merge: true },
    ));
  }) as typeof fetch;
  try {
    await body(createHostedAutonomyGitHub("fixture-token", repository), writes);
  } finally {
    globalThis.fetch = original;
  }
}

const squashBody = {
  sha: head,
  merge_method: "squash",
  commit_title: title,
  commit_message: "Resolves #331",
};

Deno.test("squash delivery: exact title, closing message and expected-head guard", async () => {
  await withGitHub({}, async (surface, writes) => {
    assert.deepEqual(await surface.merge(7, head), {
      merged: true,
      sha: revision,
    });
    assert.deepEqual(writes, [squashBody]);
  });
});

Deno.test("squash delivery: carried evidence does not replace the exact message", async () => {
  await withGitHub({}, async (surface, writes) => {
    assert.equal((await surface.merge(7, head, "carried proof"))?.merged, true);
    assert.deepEqual(writes, [squashBody]);
  });
});

Deno.test("squash delivery: a repository forbidding squash keeps merge commits", async () => {
  await withGitHub(
    { settings: { allow_squash_merge: false } },
    async (surface, writes) => {
      assert.equal((await surface.merge(7, head))?.merged, true);
      assert.deepEqual(writes, [{ sha: head, merge_method: "merge" }]);
      await surface.merge(7, head, "carried proof");
      assert.deepEqual(writes[1], {
        sha: head,
        merge_method: "merge",
        commit_message: "carried proof",
      });
    },
  );
});

Deno.test("squash delivery: explicit trusted merge policy is honored", async () => {
  const calls: unknown[] = [];
  const merge = createHostedAutonomyMerge(
    (method, path, body) => {
      calls.push({ method, path, body });
      return Promise.resolve({ merged: true, sha: revision });
    },
    scope,
    "merge",
  );
  assert.equal((await merge(7, head))?.merged, true);
  assert.deepEqual(calls, [{
    method: "PUT",
    path: `/repos/${scope}/pulls/7/merge`,
    body: { sha: head, merge_method: "merge" },
  }]);
});

Deno.test("squash delivery: invalid trusted policy refuses before any API call", () => {
  for (const policy of ["rebase", "Squash", "", null, undefined, 1, {}]) {
    assert.throws(() =>
      createHostedAutonomyMerge(
        () => {
          assert.fail("invalid policy must make no API call");
        },
        scope,
        policy,
      ), TypeError);
  }
  for (
    const name of ["sentinel", "ai.ubq.fi", "passport.ubq.fi", "new-target"]
  ) {
    assert.equal(
      targetDeliveryMethodV1({
        owner: name === "sentinel" ? "ubiquity-sentinel" : "ubiquity",
        name,
      }),
      "squash",
    );
  }
});

Deno.test("squash delivery: unreadable or invalid repository settings never fall back", async () => {
  for (
    const settings of [null, {}, { allow_squash_merge: "true" }, {
      allow_squash_merge: null,
    }]
  ) {
    await withGitHub({ settings }, async (surface, writes) => {
      assert.equal(await surface.merge(7, head), null);
      assert.deepEqual(writes, []);
    });
  }
});

Deno.test("squash delivery: stale heads and missing message identity never write", async () => {
  for (
    const invalid of [
      null,
      { ...pull, number: 8 },
      { ...pull, head: { sha: base } },
      { ...pull, head: null },
      { ...pull, title: " " },
      { ...pull, title: null },
      { ...pull, body: "no closing issue" },
      { ...pull, body: "Resolves #0" },
    ]
  ) {
    await withGitHub({ pull: invalid }, async (surface, writes) => {
      assert.equal(await surface.merge(7, head), null);
      assert.deepEqual(writes, []);
    });
  }
});

Deno.test("squash delivery: expected-head rejection never retries with merge", async () => {
  await withGitHub({ status: 409 }, async (surface, writes) => {
    assert.equal(await surface.merge(7, head), null);
    assert.deepEqual(writes, [squashBody]);
  });
});

Deno.test("squash delivery: landing proof keeps exact head and base binding", () => {
  const landed: HostedAutonomyPullV1 = {
    number: 7,
    state: "closed",
    merged: true,
    mergeCommitSha: revision,
    headSha: head,
    baseRef: "development",
    baseSha: base,
    author: "ubiquity-sentinel[bot]",
    parents: [base],
    mergeMethod: "squash",
    revisionOnBaseBranch: true,
    baseAncestorOfRevision: true,
  };
  assert.equal(mergedExactlyOn(landed, base, head), true);
  assert.equal(baseAndHeadAreMerged(landed, base, head), true);
  for (
    const invalid of [
      { ...landed, headSha: revision },
      { ...landed, parents: [revision], baseAncestorOfRevision: false },
      { ...landed, parents: [] },
      { ...landed, parents: [base, revision] },
      { ...landed, mergeMethod: undefined },
    ]
  ) {
    assert.equal(mergedExactlyOn(invalid, base, head), false);
    assert.equal(baseAndHeadAreMerged(invalid, base, head), false);
  }
  assert.equal(
    mergedExactlyOn({ ...landed, parents: [revision] }, base, head),
    false,
  );
  assert.equal(
    mergedExactlyOn(
      { ...landed, parents: [base, head], mergeMethod: "merge" },
      base,
      head,
    ),
    true,
  );
});
