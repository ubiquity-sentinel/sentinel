import assert from "node:assert/strict";
import { composeLocalGitHub } from "../../src/host/local-github.ts";
import { LocalSessionTracker } from "../../src/host/local-client.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import { renderReviewJournalBody } from "../../src/github/review-journal.ts";
import { mergeRequest } from "../github/merge-helpers.ts";
import { membershipWire } from "../github/merge-queue-fixtures.ts";
import { reviewWire } from "../github/helpers.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import type { ReviewOwnerRegistrationV1 } from "../../src/github/review-owner-evidence.ts";

function localInput() {
  return {
    clock: new FakeClock(Date.now()),
    state: new MemoryState(),
    gate: {
      beforeRequest: () => Promise.resolve(portOk(undefined)),
      recordRateLimit: () => Promise.resolve(portOk(undefined)),
    },
    http: () => Promise.reject(new Error("no external API expected")),
    token: "synthetic-token",
    login: "ubiquity-sentinel[bot]",
    invocationId: "legacy-local-owner",
    stateRoot: "/unopened/state",
    sourcePath: "/unopened/source",
    scratch: "/unopened/scratch",
    reviewCheckout: "/unopened/review",
    reviewClientHome: "/unopened/client",
    reviewTmpDir: "/unopened/tmp",
    reviewDenoDir: "/unopened/deno",
    trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    codexExecutable: "/usr/bin/false",
    tracker: new LocalSessionTracker(),
  };
}

function ownerExecution() {
  return {
    id: "7:2:repair",
    runId: 7,
    runAttempt: 2,
    launcherSha: "a".repeat(40) as GitSha,
    revision: "b".repeat(40) as GitSha,
    generation: 74,
    purpose: "ordinary" as const,
    releaseId: null,
    createdAt: Date.now() - 1000,
  };
}

Deno.test("local GitHub review owner: native execution without private custody refuses before any effect", () => {
  assert.throws(() =>
    composeLocalGitHub(Object.assign(localInput(), {
      ownerExecution: ownerExecution(),
    }))
  );
});

Deno.test("local GitHub review owner: canonical absence retains the legacy composition", () => {
  assert.doesNotThrow(() => composeLocalGitHub(localInput()));
});

Deno.test("local GitHub review owner: separate supplied native resolver reaches the real journal consumer without settling legacy journals", async () => {
  for (const native of [false, true]) {
    const execution = ownerExecution();
    const journal = {
      version: "v1" as const,
      phase: "intent" as const,
      repository: { owner: "ubiquity-sentinel", name: "sentinel" },
      prNumber: 1,
      expectedHead: "c".repeat(40) as GitSha,
      expectedBase: "d".repeat(40) as GitSha,
      operationKey: "review:composed:1",
      publisher: "ubiquity-sentinel[bot]",
      requestId: "review-review:composed:1",
      requestedAt: Date.now(),
      ...(native ? { ownerExecution: execution } : {}),
    };
    const body = renderReviewJournalBody(journal);
    const requests: string[] = [];
    const http: HttpTransportV1 = (request) => {
      requests.push(request.method);
      const path = new URL(request.url).pathname;
      const reviews = path.endsWith("/reviews");
      return Promise.resolve({
        status: reviews ? 200 : 404,
        headers: new Headers(),
        bodyText: JSON.stringify(
          reviews
            ? [reviewWire({
              state: "PENDING",
              body,
              submitted_at: null,
              commit_id: journal.expectedHead,
              user: { login: journal.publisher },
            })]
            : {},
        ),
      });
    };
    const registrations: ReviewOwnerRegistrationV1[] = [];
    const port = composeLocalGitHub({
      ...localInput(),
      http,
      ownerSettlement: {
        read: (registration) => {
          registrations.push(registration);
          return Promise.resolve(portOk(null));
        },
      },
    });
    const result = await port.observeReview({
      operationKey: journal.operationKey,
      prNumber: 1,
      head: journal.expectedHead,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(registrations.length, native ? 1 : 0);
    if (native) assert.deepEqual(registrations[0]!.journal, journal);
    assert.equal(requests.every((method) => method === "GET"), true);
  }
});

Deno.test("local GitHub review owner: explicit self capability reaches native refusal while absent and foreign scopes keep ordinary merge", async () => {
  for (
    const [name, installationId, flag, activated] of [
      ["sentinel", 0, undefined, false],
      ["sentinel", 0, false, false],
      ["sentinel", 0, true, true],
      ["ai.ubq.fi", 42, true, false],
      ["sentinel", 42, true, false],
    ] as const
  ) {
    const request = mergeRequest();
    const owner = name === "sentinel" ? "ubiquity-sentinel" : "ubiquity";
    const repository = { owner, name, installationId };
    request.review = { ...request.review, repository };
    const input = localInput();
    // Empty state and rules plus a complete native non-membership observation
    // let the ordinary merge reach its own pull-request lookup.
    input.state.repair = seededSnapshot([]);
    const requests: string[] = [];
    const rulesPath = `/repos/${owner}/${name}/rules/branches/development`;
    const pullPath =
      `/repos/${owner}/${name}/pulls/${request.pullRequestNumber}`;
    const port = composeLocalGitHub({
      ...input,
      repository,
      login: request.review.expectedReviewer,
      ...(flag === undefined ? {} : { selfMergeEnabled: flag }),
      http: (read) => {
        const path = new URL(read.url).pathname;
        requests.push(`${read.method} ${path}`);
        if (path === "/graphql") {
          assert.equal(read.method, "POST");
          const query = JSON.parse(read.body ?? "{}");
          assert.match(query.query, /^query\(/);
          assert.match(query.query, /pullRequest\(number:\$number\)/);
          assert.deepEqual(query.variables, {
            owner: repository.owner,
            name: repository.name,
            number: request.pullRequestNumber,
          });
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify(membershipWire(null, {
              id: "PR_1",
              number: request.pullRequestNumber,
              headRefName: "sentinel/fix-1",
              headRefOid: request.expectedHead,
              baseRefOid: request.expectedBase,
              author: {
                __typename: "Bot",
                id: "BOT_SYNTHETIC_AUTHOR",
                login: request.review.expectedReviewer,
              },
              mergedBy: null,
            })),
          });
        }
        const rules = path === rulesPath;
        return Promise.resolve({
          status: rules ? 200 : 404,
          headers: new Headers(),
          bodyText: rules ? "[]" : "{}",
        });
      },
    });
    const result = await port.mergePullRequest(request, {
      taskId: "work-1" as never,
      issueNumber: 7,
      headRef: "sentinel/fix-1",
      operationKey: `merge:1:${request.expectedHead}`,
      deadline: Date.now() + 60000,
      proof: {} as never,
      persist: () => Promise.resolve(portOk(undefined)),
    });
    assert.deepEqual(
      requests,
      activated
        ? []
        : name === "ai.ubq.fi"
        ? [`GET ${rulesPath}`, `GET ${pullPath}`]
        : [`GET ${pullPath}`],
      JSON.stringify(result),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, activated ? "invalid" : "not_found");
    }
  }
});
