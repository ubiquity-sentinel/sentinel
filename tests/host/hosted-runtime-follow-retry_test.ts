/**
 * Bounded retry of transient follow reads (2026-11-13: dispatcher runs
 * 43504030921 and 43520076144 deferred on one non-200 read and on a listing
 * still inconsistent after three reads). Every pause goes through the injected
 * fake, which advances the fake clock instead of waiting.
 */
import assert from "node:assert/strict";
import type { HttpResponseV1 } from "../../src/github/http.ts";
import { runHostedRuntimeFollow } from "../../src/host/hosted-runtime-follow.ts";
import {
  ciRun,
  D,
  FollowFake,
  L,
  OLDER,
  P,
  response,
} from "./hosted-runtime-follow-fixtures.ts";

const stateTree = (url: URL) =>
  url.pathname.includes("/git/trees/") &&
  url.searchParams.get("recursive") === "1";
const runtimeBlob = (url: URL) =>
  url.pathname.endsWith(`/git/blobs/${"4".repeat(40)}`);
const ciListing = (url: URL) => url.pathname.endsWith("/353613034/runs");
const developmentRef = (url: URL) =>
  url.pathname.endsWith("/git/ref/heads/development");

/** Answer the first `times` matching reads with `outcome`, then serve them. */
function failReads(
  api: FollowFake,
  match: (url: URL) => boolean,
  times: number,
  outcome: () => HttpResponseV1,
): () => number {
  let seen = 0;
  api.intercept = (request, url) => {
    if (request.method !== "GET" || !match(url) || seen >= times) {
      return undefined;
    }
    seen++;
    return outcome();
  };
  return () => seen;
}

function readsOf(api: FollowFake, match: (url: URL) => boolean): number {
  return api.requests.filter((request) =>
    request.method === "GET" && match(new URL(request.url))
  ).length;
}

Deno.test("follow retries a transient 5xx, 429 or lost read with backoff and still advances", async (t) => {
  const cases: Array<
    [string, (url: URL) => boolean, number, () => HttpResponseV1, number[]]
  > = [
    ["502 state tree", stateTree, 1, () => response({}, 502), [1_000]],
    ["503 runtime blob three times", runtimeBlob, 3, () => response({}, 503), [
      1_000,
      2_000,
      4_000,
    ]],
    [
      "429 honours its Retry-After",
      ciListing,
      1,
      () => response({}, 429, new Headers({ "retry-after": "3" })),
      [3_000],
    ],
    ["lost ref read", developmentRef, 1, () => {
      throw new Error("connection reset with private material");
    }, [1_000]],
  ];
  for (const [name, match, times, outcome, pauses] of cases) {
    await t.step(name, async () => {
      const api = new FollowFake();
      const seen = failReads(api, match, times, outcome);
      const result = await api.follow();
      assert.equal(result.journal.decision, "advanced", result.journal.reason);
      assert.equal(result.journal.reason, "ci_green_descendant");
      assert.equal(result.journal.candidateSha, OLDER);
      assert.equal(api.launcher, OLDER);
      assert.equal(api.mutations, 1);
      assert.equal(seen(), times);
      assert.deepEqual(api.pauses, pauses);
      assert.ok(!JSON.stringify(result).includes("private material"));
    });
  }
});

Deno.test("follow re-lists a CI listing that stays inconsistent past three reads, then advances", async () => {
  const api = new FollowFake();
  const seen = failReads(
    api,
    (url) => ciListing(url) && url.searchParams.get("head_sha") === D,
    4,
    () => response({ total_count: 2, workflow_runs: [ciRun(D, 30)] }),
  );
  const result = await api.follow();
  assert.equal(result.journal.decision, "advanced", result.journal.reason);
  assert.equal(api.launcher, OLDER);
  assert.equal(seen(), 4);
  assert.deepEqual(api.pauses, [1_000, 2_000, 4_000, 8_000]);
});

Deno.test("follow never retries an authorization, missing, conflicting or long-throttled read", async (t) => {
  const cases: Array<[string, HttpResponseV1, string]> = [
    ["401", response({}, 401), "github_read_unavailable"],
    ["403", response({}, 403), "github_read_unavailable"],
    ["404", response({}, 404), "github_read_unavailable"],
    ["409", response({}, 409), "ref_conflict"],
    [
      "429 beyond the Retry-After cap",
      response({}, 429, new Headers({ "retry-after": "60" })),
      "github_read_unavailable",
    ],
    [
      "503 with an HTTP-date Retry-After",
      response(
        {},
        503,
        new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      ),
      "github_read_unavailable",
    ],
  ];
  for (const [name, outcome, reason] of cases) {
    await t.step(name, async () => {
      const api = new FollowFake();
      failReads(api, stateTree, 10, () => outcome);
      const result = await api.follow();
      assert.equal(result.journal.decision, "deferred");
      assert.equal(result.journal.reason, reason);
      assert.equal(readsOf(api, stateTree), 1);
      assert.deepEqual(api.pauses, []);
      assert.equal(api.mutations, 0);
      assert.equal(api.launcher, L);
      assert.equal(result.safeToDispatch, true);
    });
  }
});

Deno.test("follow never retries the ref mutation, even on a 5xx answer", async () => {
  const api = new FollowFake();
  let posts = 0;
  api.intercept = (request, url) => {
    if (request.method !== "POST" || url.pathname !== "/graphql") {
      return undefined;
    }
    posts++;
    return response({}, 502);
  };
  const result = await api.follow();
  assert.equal(result.journal.decision, "failed");
  assert.equal(result.journal.reason, "github_read_unavailable");
  assert.equal(posts, 1);
  assert.deepEqual(api.pauses, []);
  assert.equal(result.safeToDispatch, false);
  assert.equal(result.exitCode, 1);
});

Deno.test("follow retry pauses stop at the shared 30 s budget, then defer", async () => {
  const api = new FollowFake();
  const failures = new Map<string, number>();
  api.intercept = (request) => {
    if (request.method !== "GET") return undefined;
    const count = failures.get(request.url) ?? 0;
    if (count >= 2) return undefined;
    failures.set(request.url, count + 1);
    return response({}, 503);
  };
  const result = await api.follow();
  assert.equal(result.journal.decision, "deferred");
  assert.equal(result.journal.reason, "github_read_unavailable");
  // Ten reads each recover after 1 s and 2 s; the eleventh is refused.
  assert.deepEqual(
    api.pauses,
    Array.from({ length: 10 }, () => [1_000, 2_000]).flat(),
  );
  assert.equal(api.mutations, 0);
  assert.equal(api.launcher, L);
});

Deno.test("follow integrity verdicts are decided on their first read and never paused", async (t) => {
  const cases: Array<[string, (api: FollowFake) => void, string]> = [
    ["CI not green", (api) => {
      api.ci.set(OLDER, [ciRun(OLDER, 20, { conclusion: "failure" })]);
    }, "no_eligible_candidate"],
    ["not descended from the installed revision", (api) => {
      api.installed = "9".repeat(40);
    }, "no_eligible_candidate"],
    ["launcher off the development ancestry", (api) => {
      api.parents.set(OLDER, [P]);
    }, "launcher_diverged"],
    ["workflow files differ from the launcher", (api) => {
      api.ci.set(D, [ciRun(D, 5)]);
      api.ci.set(OLDER, [ciRun(OLDER, 6)]);
      api.workflowTrees.set(D, "d".repeat(40));
      api.workflowTrees.set(OLDER, "d".repeat(40));
    }, "workflow_change_needs_owner_advance"],
    ["CI changed before the CAS", (api) => {
      let reads = 0;
      api.intercept = (_request, url) =>
        url.pathname.endsWith("/actions/runs/20") && ++reads === 2
          ? response(ciRun(OLDER, 20, { conclusion: "failure" }))
          : undefined;
    }, "ci_changed"],
  ];
  for (const [name, arrange, reason] of cases) {
    await t.step(name, async () => {
      const api = new FollowFake();
      arrange(api);
      const result = await api.follow();
      assert.equal(result.journal.decision, "deferred");
      assert.equal(result.journal.reason, reason);
      assert.deepEqual(api.pauses, []);
      assert.equal(api.mutations, 0);
      assert.equal(api.launcher, L);
    });
  }
});

Deno.test("follow retry pauses never outlive the overall scan deadline", async () => {
  let reads = 0;
  const result = await runHostedRuntimeFollow({
    http: () => {
      reads++;
      return Promise.resolve(response({}, 503));
    },
    token: "fake-token",
    flag: "on",
    deadlineMs: 50,
    log: () => {},
    pause: () => new Promise<void>(() => {}),
  });
  assert.equal(result.journal.decision, "deferred");
  assert.equal(result.journal.reason, "follow_deadline");
  assert.equal(reads, 1);
  assert.equal(result.safeToDispatch, false);
});
