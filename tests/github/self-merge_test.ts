import assert from "node:assert/strict";
import { GitHubPortImpl } from "../../src/github/impl.ts";
import {
  FakeAuthProvider,
  FakeCooldownGate,
  FakeGitExecutor,
  PR_AUTHOR,
  REPO,
  REVIEWER,
  ScriptedHttpTransport,
} from "./helpers.ts";
import {
  blockedReason,
  CLOCK,
  happyScript,
  mergeRequest,
  trustedService,
} from "./merge-helpers.ts";

Deno.test("self merge: native capability reaches CI gate without requiring branch rules", async () => {
  const transport = new ScriptedHttpTransport(
    happyScript({ rules: [], rulesets: [] }),
  );
  const repository = { ...REPO, installationId: 0 };
  const port = new GitHubPortImpl({
    repository,
    http: transport.fetch.bind(transport),
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock: CLOCK,
    git: new FakeGitExecutor(),
    reviewService: trustedService(),
    trustedPrAuthor: PR_AUTHOR,
    trustedReviewer: REVIEWER,
    trustedResolutionAuthors: [],
    ...{ selfMergeEnabled: true },
  });
  const request = mergeRequest();
  request.review = { ...request.review, repository };
  const result = await Reflect.apply(port.mergePullRequest, port, [request, {
    taskId: "work-1",
    issueNumber: 7,
    headRef: "sentinel/fix-1",
    operationKey: `merge:1:${request.expectedHead}`,
    deadline: 1791889999999,
    proof: null,
    persist: () => Promise.resolve({ ok: true, value: undefined }),
  }]);
  assert.notEqual(
    blockedReason(result),
    "protection_required",
    "the trusted self capability must use native CI and conditional Git CAS",
  );
  assert.equal(
    result.ok,
    false,
    "missing native Git/CI proof must remain unavailable",
  );
});

import { selfMergeFixture } from "./self-merge-fixture.ts";

Deno.test("self merge: native tested tree and real conditional Git source CAS close exactly the own task", async () => {
  const rig = await selfMergeFixture();
  try {
    const result = await rig.port.mergePullRequest(rig.request, rig.execution);
    assert.ok(
      result.ok,
      JSON.stringify({
        result,
        stage: rig.execution.proof?.stage,
        pushes: rig.state.pushes,
        paths: rig.calls.slice(-8).map((c) => new URL(c.url).pathname),
      }),
    );
    if (!result.ok || result.value.outcome !== "merged") {
      throw new Error(JSON.stringify(result));
    }
    assert.equal(result.value.mergeSha, rig.merge);
    assert.equal(result.value.head, rig.head);
    assert.equal(
      result.value.selfMerge?.prState,
      "closed",
      "native closed-unmerged is retained without a fabricated merged flag",
    );
    assert.equal(result.value.selfMerge?.stage, "issue_closed");
    assert.deepEqual(
      await rig.executor.readRemoteRef("refs/heads/development"),
      { ok: true, value: rig.merge },
    );
    assert.equal(
      rig.calls.filter((c) =>
        c.method === "PATCH" && c.url.endsWith("/pulls/1")
      ).length,
      1,
    );
    assert.equal(
      rig.calls.filter((c) =>
        c.method === "PATCH" && c.url.endsWith("/issues/7")
      ).length,
      1,
    );
    assert.equal(rig.calls.some((c) => c.method === "PUT"), false);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("self merge: missing foreign failed and mismatched-tree native CI never publish", async (t) => {
  for (const mode of ["missing", "foreign", "failed", "tree"] as const) {
    await t.step(mode, async () => {
      const rig = await selfMergeFixture();
      try {
        if (mode === "missing") rig.state.missingCi = true;
        if (mode === "foreign") rig.state.foreignCi = true;
        if (mode === "failed") rig.state.failedCi = true;
        if (mode === "tree") rig.state.ci.testedTree = rig.base;
        const result = await rig.port.mergePullRequest(
          rig.request,
          rig.execution,
        );
        assert.equal(result.ok && result.value.outcome === "merged", false);
        assert.equal(rig.state.pushes.length, 0);
        assert.deepEqual(
          await rig.executor.readRemoteRef("refs/heads/development"),
          { ok: true, value: rig.base },
        );
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("self merge: a moved unrelated base is never overwritten", async () => {
  const rig = await selfMergeFixture();
  try {
    rig.state.race = true;
    const result = await rig.port.mergePullRequest(rig.request, rig.execution);
    assert.equal(result.ok, false);
    const target = await rig.executor.readRemoteRef("refs/heads/development");
    assert.ok(target.ok);
    if (target.ok) {
      assert.notEqual(target.value, rig.base);
      assert.notEqual(target.value, rig.merge);
    }
    assert.equal(rig.calls.some((c) => c.method === "PATCH"), false);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("self merge: interrupted source acknowledgement reconciles without repeating its push", async () => {
  const rig = await selfMergeFixture();
  try {
    rig.state.failPersist = "source_applied";
    const first = await rig.port.mergePullRequest(rig.request, rig.execution);
    assert.equal(first.ok, false);
    assert.deepEqual(
      await rig.executor.readRemoteRef("refs/heads/development"),
      { ok: true, value: rig.merge },
    );
    const second = await rig.port.mergePullRequest(rig.request, rig.execution);
    assert.ok(second.ok, JSON.stringify(second));
    if (second.ok) assert.equal(second.value.outcome, "merged");
    assert.equal(
      rig.state.pushes.filter((r) => r === "refs/heads/development").length,
      1,
    );
    assert.equal(
      rig.calls.filter((c) =>
        c.method === "PATCH" && c.url.endsWith("/pulls/1")
      ).length,
      1,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("self merge: a changed advertised base equal to the candidate is refused despite fast-forward ancestry", async () => {
  const rig = await selfMergeFixture();
  try {
    rig.state.ancestorRace = true;
    const result = await rig.port.mergePullRequest(rig.request, rig.execution);
    assert.equal(result.ok, false);
    assert.deepEqual(
      await rig.executor.readRemoteRef("refs/heads/development"),
      { ok: true, value: rig.head },
    );
    assert.equal(rig.calls.some((c) => c.method === "PATCH"), false);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("self merge: a forged workflow or emitter source identity cannot authorize CI", async (t) => {
  for (const source of ["workflow", "harness", "emitter"] as const) {
    await t.step(source, async () => {
      const rig = await selfMergeFixture();
      try {
        rig.state.ci.sources[source] = rig.base;
        const result = await rig.port.mergePullRequest(
          rig.request,
          rig.execution,
        );
        assert.equal(result.ok, false);
        assert.equal(rig.state.pushes.length, 0);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("self merge: wrong PR closure identity preserves source proof", async () => {
  const rig = await selfMergeFixture();
  try {
    rig.state.wrongCloseIdentity = true;
    const result = await rig.port.mergePullRequest(rig.request, rig.execution);
    assert.equal(result.ok, false);
    assert.equal(rig.execution.proof?.stage, "source_applied");
    const patches = rig.calls.filter((call) => call.method === "PATCH");
    assert.equal(patches.length, 1);
    assert.ok(patches[0].url.endsWith("/pulls/1"));
  } finally {
    await rig.cleanup();
  }
});
