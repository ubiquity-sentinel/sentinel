import assert from "node:assert/strict";
import identity from "../fixtures/github/native-bot-identity.json" with {
  type: "json",
};
import { CanaryGitHub } from "../../ops/queue-canary-github.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
} from "../github/helpers.ts";
import { response } from "../github/merge-queue-fixtures.ts";
import { GRANT, SHA1, SHA3, T0 } from "./queue-canary-fixtures.ts";

Deno.test("canary final dequeue guard consumes the same normalized native actor and refuses identity drift", async (t) => {
  for (
    const mode of [
      "valid",
      "node",
      "lookalike",
      "user_spoof",
      "missing_node",
    ] as const
  ) {
    await t.step(mode, async () => {
      const grant = structuredClone(GRANT);
      grant.appActor = {
        type: "Bot",
        nodeId: identity.rest.node_id,
        login: identity.rest.login,
      };
      grant.prior = {
        runId: 99,
        sourceSha: SHA3,
        requestDigest: "a".repeat(64),
        artifactId: 77,
        artifactDigest: "b".repeat(64),
        entryId: "MQE_NATIVE",
        requestId: null,
      };
      const pull = {
        id: grant.pull.nodeId,
        number: grant.pull.number,
        baseRefName: grant.pull.baseRef,
        headRefName: grant.pull.headRef,
        headRefOid: grant.pull.head,
        repository: { name: "ai.ubq.fi", owner: { login: "ubiquity" } },
      };
      let reads = 0, mutations = 0;
      const requests: HttpRequestV1[] = [];
      const client = new CanaryGitHub({
        repository: grant.pull.repository,
        apiBaseUrl: "https://api.github.com",
        auth: new FakeAuthProvider(),
        clock: new FakeClock(T0),
        cooldownGate: new FakeCooldownGate(),
        http: (request) => {
          requests.push(request);
          assert.equal(request.url, "https://api.github.com/graphql");
          const query = JSON.parse(request.body!).query as string;
          if (query.startsWith("mutation")) {
            mutations++;
            return Promise.resolve(response({
              data: {
                dequeuePullRequest: { mergeQueueEntry: { id: "MQE_NATIVE" } },
              },
            }));
          }
          reads++;
          const changed = reads > 1;
          const enqueuer = {
            ...identity.graphql,
            ...(changed && mode === "node" ? { id: "BOT_foreign" } : {}),
            ...(changed && mode === "lookalike"
              ? { login: "ubiquity-sentinel-copy" }
              : {}),
            ...(changed && mode === "user_spoof"
              ? { __typename: "User", login: identity.rest.login }
              : {}),
            ...(changed && mode === "missing_node" ? { id: null } : {}),
          };
          return Promise.resolve(response({
            data: {
              repository: {
                name: "ai.ubq.fi",
                owner: { login: "ubiquity" },
                pullRequest: {
                  ...pull,
                  merged: false,
                  mergeCommit: null,
                  isInMergeQueue: true,
                  mergeQueueEntry: {
                    id: "MQE_NATIVE",
                    position: 1,
                    state: "QUEUED",
                    enqueuedAt: new Date(T0).toISOString(),
                    enqueuer,
                    baseCommit: { oid: SHA1 },
                    headCommit: { oid: SHA3 },
                    jump: false,
                    solo: false,
                    pullRequest: pull,
                  },
                },
              },
            },
          }));
        },
      }, "synthetic-host-read-token");
      const observed = await client.readPullMembership(grant.pull);
      assert.ok(observed.status === "complete" && observed.value.entry);
      assert.deepEqual(observed.value.entry.enqueuer, grant.appActor);
      const result = await client.dequeueCanary(grant, observed.value.entry);
      assert.equal(
        result.status,
        mode === "valid" ? "submitted" : "not_submitted",
      );
      assert.equal(mutations, mode === "valid" ? 1 : 0);
      assert.equal(reads, 2, "the final effect repeats native membership");
      assert.equal(requests.length, mode === "valid" ? 3 : 2);
    });
  }
});
