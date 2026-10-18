import assert from "node:assert/strict";
import { resolveQueueAwareDelivery } from "../../ops/hosted-autonomy-queue-proof.ts";
import { APP, POLICY, SHA4 } from "../host/merge-queue-proof-fixtures.ts";
import { checkRunWire, issueWire } from "./helpers.ts";
import {
  PULL,
  response,
  SHA1,
  SHA2,
  SHA3,
  T0,
} from "./merge-queue-fixtures.ts";
import {
  AFTER_TREE,
  BEFORE_TREE,
  blob,
  commitWire,
  compareWire,
  deliveryClient,
  pullFactsWire,
  readerFixture,
  treeWire,
  UNTIL,
} from "./queue-delivery-reader-fixtures.ts";

Deno.test("queue fact client authenticates the native PR identity and observed head", async () => {
  const { client, requests } = deliveryClient([
    response(pullFactsWire({ headRefOid: SHA3 })),
  ]);
  const result = await client.readQueuePull(7, UNTIL);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.value.membership.pull, { ...PULL, head: SHA3 });
  assert.equal(result.value.base, SHA1);
  assert.equal(result.value.author, APP.login);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.ok(requests[0].headers.get("authorization"));
  assert.equal(JSON.parse(requests[0].body!).variables.number, 7);
});

Deno.test("queue fact client rejects foreign PRs, partial data and unavailable authentication", async (t) => {
  const partial = {
    ...pullFactsWire(),
    errors: [{ message: "private upstream detail" }],
  };
  for (
    const [name, reply] of [
      ["wrong number", response(pullFactsWire({ number: 8 }))],
      [
        "wrong repository",
        response(
          pullFactsWire({
            repository: { name: "sentinel", owner: { login: "ubiquity" } },
          }),
        ),
      ],
      ["partial GraphQL", response(partial)],
      ["auth", response({ message: "private upstream detail" }, 401)],
      ["permission", response({ message: "private upstream detail" }, 403)],
    ] as const
  ) {
    await t.step(name, async () => {
      const result = await deliveryClient([reply]).client.readQueuePull(
        7,
        UNTIL,
      );
      assert.notEqual(result.status, "complete");
      assert.doesNotMatch(JSON.stringify(result), /private/);
    });
  }
  const expired = deliveryClient([]);
  assert.deepEqual(await expired.client.readQueuePull(7, T0), {
    status: "unavailable",
    reason: "deadline",
  });
  assert.equal(expired.requests.length, 0);
});

Deno.test("queue commit observation preserves ordered parents and exact revision", async () => {
  const good = await deliveryClient([response(commitWire())]).client
    .readQueueCommit(SHA4, UNTIL);
  assert.equal(good.status, "complete");
  if (good.status === "complete") {
    assert.deepEqual(good.value.parents, [SHA3, SHA2]);
    assert.deepEqual(good.value.author, APP);
  }
  for (
    const body of [
      commitWire({ sha: SHA3 }),
      commitWire({ parents: [{ sha: "short" }] }),
      commitWire({
        author: { type: "Organization", node_id: "ORG", login: "owner" },
      }),
    ]
  ) {
    assert.equal(
      (await deliveryClient([response(body)]).client.readQueueCommit(
        SHA4,
        UNTIL,
      )).status,
      "invalid",
    );
  }
});

Deno.test("queue ancestry uses the exact compare base and does not treat divergence as ancestry", async () => {
  for (
    const [status, mergeBase, expected] of [
      ["ahead", SHA1, true],
      ["identical", SHA1, true],
      ["behind", SHA3, false],
      ["diverged", SHA3, false],
    ] as const
  ) {
    const { client, requests } = deliveryClient([
      response(compareWire(SHA1, mergeBase, status)),
    ]);
    assert.deepEqual(await client.readQueueAncestry(SHA1, SHA2, UNTIL), {
      status: "complete",
      value: { ancestor: SHA1, descendant: SHA2, isAncestor: expected },
    });
    assert.ok(requests[0].url.endsWith(`/compare/${SHA1}...${SHA2}`));
  }
  assert.equal(
    (await deliveryClient([response(compareWire(SHA3))]).client
      .readQueueAncestry(SHA1, SHA2, UNTIL)).status,
    "invalid",
  );
});

Deno.test("queue patch compares complete recursive trees including modes, binary blobs and removals", async () => {
  const before = [
    blob("bin/data", SHA1),
    blob("bin/run", SHA1),
    blob("old", SHA3),
    blob("link", SHA1, "120000"),
  ];
  const after = [
    blob("bin/data", SHA2),
    blob("bin/run", SHA1, "100755"),
    blob("new", SHA3),
    blob("link", SHA1, "120000"),
  ];
  const { client, requests } = deliveryClient([
    response(compareWire(SHA1, SHA3)),
    response({ sha: SHA2, tree: { sha: AFTER_TREE } }),
    response(treeWire(BEFORE_TREE, before)),
    response(treeWire(AFTER_TREE, after)),
  ]);
  assert.deepEqual(await client.readQueuePatch(SHA1, SHA2, UNTIL), {
    status: "complete",
    value: {
      base: SHA1,
      head: SHA2,
      mergeBase: SHA3,
      changes: [
        {
          path: "bin/data",
          oldMode: "100644",
          oldSha: SHA1,
          newMode: "100644",
          newSha: SHA2,
        },
        {
          path: "bin/run",
          oldMode: "100644",
          oldSha: SHA1,
          newMode: "100755",
          newSha: SHA1,
        },
        {
          path: "new",
          oldMode: null,
          oldSha: null,
          newMode: "100644",
          newSha: SHA3,
        },
        {
          path: "old",
          oldMode: "100644",
          oldSha: SHA3,
          newMode: null,
          newSha: null,
        },
      ],
    },
  });
  assert.ok(requests[2].url.endsWith(`/git/trees/${BEFORE_TREE}?recursive=1`));
  assert.ok(requests[3].url.endsWith(`/git/trees/${AFTER_TREE}?recursive=1`));
});

Deno.test("queue patch truncation, duplicate paths, foreign trees and partial HTTP failure grant no patch", async (t) => {
  for (
    const [name, before] of [
      ["truncated", treeWire(BEFORE_TREE, [], true)],
      ["duplicate", treeWire(BEFORE_TREE, [blob("x", SHA1), blob("x", SHA2)])],
      ["foreign tree", treeWire(AFTER_TREE, [])],
      [
        "inconsistent mode",
        treeWire(BEFORE_TREE, [{ ...blob("x", SHA1), mode: "160000" }]),
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const { client } = deliveryClient([
        response(compareWire()),
        response({ sha: SHA2, tree: { sha: AFTER_TREE } }),
        response(before),
        response(treeWire(AFTER_TREE, [])),
      ]);
      assert.deepEqual(await client.readQueuePatch(SHA1, SHA2, UNTIL), {
        status: "unavailable",
        reason: "incomplete",
      });
    });
  }
  const { client, requests } = deliveryClient([
    response(compareWire()),
    response({}, 403),
  ]);
  assert.deepEqual(await client.readQueuePatch(SHA1, SHA2, UNTIL), {
    status: "unavailable",
    reason: "permission",
  });
  assert.equal(requests.length, 2);
});

Deno.test("queue binding reads the live task and latest receipt without queue permissions", async () => {
  const f = await readerFixture({
    intercept: (request) =>
      request.url.endsWith("/graphql") ? response({}, 403) : undefined,
  });
  const newer = {
    ...f.facts.receipt,
    id: "latest-review",
    requestId: "latest-request",
    completedAt: T0 + 3000,
    observedAt: T0 + 3000,
  };
  f.snapshot.reviews.push(newer);
  const result = await f.reader.readBinding(f.request);
  assert.equal(result.status, "complete");
  if (result.status === "complete") {
    assert.equal(result.value.binding.reviewReceiptId, newer.id);
    assert.equal(result.value.binding.reviewRequestId, newer.requestId);
    assert.deepEqual(result.value.task, f.request.currentTask);
  }
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].url.endsWith("/issues/1"));
});

Deno.test("queue authorization basis binds native head, all required CI and current task acceptance", async () => {
  const good = await readerFixture();
  const basis = await good.reader.readAuthorizationBasis(good.request);
  assert.equal(basis.status, "complete");
  if (basis.status === "complete") {
    assert.equal(basis.value.headCiGreen, true);
    assert.equal(basis.value.reviewAuthorized, true);
  }
  const drift = await readerFixture({
    intercept: (request) =>
      request.url.endsWith("/graphql")
        ? response(pullFactsWire({ headRefOid: SHA3 }))
        : undefined,
  });
  assert.deepEqual(await drift.reader.readAuthorizationBasis(drift.request), {
    status: "unavailable",
    reason: "drift",
  });
  const changed = await readerFixture({
    intercept: (request) =>
      request.url.endsWith("/issues/1")
        ? response(
          issueWire({
            number: 1,
            title: "New task",
            body: "Different acceptance",
            labels: [{ name: "sentinel:skip" }],
          }),
        )
        : undefined,
  });
  const result = await changed.reader.readAuthorizationBasis(changed.request);
  assert.equal(result.status, "complete");
  if (result.status === "complete") {
    assert.equal(result.value.reviewAuthorized, false);
    assert.equal(result.value.optedOut, true);
  }
});

Deno.test("queue delivery reader gathers exact native evidence for the shared verifier", async () => {
  const f = await readerFixture({
    options: {
      provenance: ({ binding }) =>
        Promise.resolve({
          status: "complete",
          value: { binding, enqueuer: APP, evidenceIds: ["EV_1"] },
        }),
    },
  });
  const result = await f.reader.read(f.request);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.value.commit?.parents, [SHA3, SHA2]);
  assert.equal(result.value.anyQueueEvidence, true);
  const proved = await resolveQueueAwareDelivery(result.value, POLICY);
  assert.equal(proved.status, "verified");
  if (proved.status === "verified") assert.equal(proved.delivery.kind, "queue");
});

Deno.test("queue authorization requires every named Actions check and rejects a foreign CI producer", async () => {
  for (
    const app of [{ id: 15368, slug: "github-actions" }, {
      id: 7,
      slug: "lookalike",
    }]
  ) {
    const f = await readerFixture({
      intercept: (request) =>
        request.url.includes(`/commits/${SHA2}/check-runs`)
          ? response({
            total_count: 1,
            check_runs: [
              checkRunWire({ name: "validate", head_sha: SHA2, app }),
            ],
          })
          : undefined,
    });
    const result = await f.reader.readAuthorizationBasis(f.request);
    if (app.id === 15368) {
      assert.equal(result.status, "complete");
      if (result.status === "complete") {
        assert.equal(result.value.headCiGreen, false);
      }
    } else assert.notEqual(result.status, "complete");
  }
});

Deno.test("queue delivery reader cannot manufacture provenance or acceptance from missing pins", async () => {
  const absent = await readerFixture();
  const read = await absent.reader.read(absent.request);
  assert.equal(read.status, "complete");
  if (read.status === "complete") {
    assert.equal(read.value.queue.status, "unavailable");
    assert.equal(read.value.directWitness, null);
    assert.notEqual(
      (await resolveQueueAwareDelivery(read.value, POLICY)).status,
      "verified",
    );
  }
  const nullProvenance = await readerFixture({
    options: {
      provenance: () => Promise.resolve({ status: "complete", value: null }),
    },
  });
  const nullRead = await nullProvenance.reader.read(nullProvenance.request);
  assert.equal(nullRead.status, "complete");
  if (nullRead.status === "complete") {
    assert.equal(nullRead.value.queue.status, "unavailable");
  }
  const noWorkflow = await readerFixture({ workflowId: null });
  assert.deepEqual(await noWorkflow.reader.read(noWorkflow.request), {
    status: "unavailable",
    reason: "unsupported",
  });
  const unpinned = await readerFixture({
    options: {
      provenance: ({ binding }) =>
        Promise.resolve({
          status: "complete",
          value: { binding, enqueuer: APP, evidenceIds: ["EV_1"] },
        }),
    },
  });
  const facts = await unpinned.reader.read(unpinned.request);
  assert.equal(facts.status, "complete");
  if (facts.status === "complete") {
    assert.notEqual(
      (await resolveQueueAwareDelivery(facts.value, {
        ...POLICY,
        canaryDigest: null,
      })).status,
      "verified",
    );
  }
});

Deno.test("queue delivery rechecks task, receipt, native head and state binding before returning facts", async (t) => {
  await t.step("task changed during collection", async () => {
    const f = await readerFixture({
      intercept: (request, count) =>
        request.url.endsWith("/issues/1") && count > 1
          ? response(
            issueWire({ number: 1, title: "Changed", body: "Changed" }),
          )
          : undefined,
    });
    assert.deepEqual(await f.reader.read(f.request), {
      status: "unavailable",
      reason: "drift",
    });
  });
  await t.step("head changed during collection", async () => {
    const f = await readerFixture({
      intercept: (request, count) =>
        request.url.endsWith("/graphql") &&
          request.body?.includes("baseRefOid") && count > 2
          ? response(pullFactsWire({ headRefOid: SHA3 }))
          : undefined,
    });
    assert.deepEqual(await f.reader.read(f.request), {
      status: "unavailable",
      reason: "drift",
    });
  });
  await t.step("stale caller receipt", async () => {
    const f = await readerFixture();
    f.request.receipt = { ...f.request.receipt, id: "superseded" };
    assert.deepEqual(await f.reader.read(f.request), {
      status: "unavailable",
      reason: "drift",
    });
  });
  await t.step("latest review changes during collection", async () => {
    const f = await readerFixture({
      intercept: (request) => {
        if (request.url.includes(`/git/trees/${AFTER_TREE}`)) {
          f.snapshot.reviews = [{
            ...f.facts.receipt,
            id: "new-review",
            requestId: "new-request",
            completedAt: T0 + 3000,
            observedAt: T0 + 3000,
          }];
        }
        return undefined;
      },
    });
    assert.deepEqual(await f.reader.read(f.request), {
      status: "unavailable",
      reason: "drift",
    });
  });
  await t.step("record does not match snapshot", async () => {
    const f = await readerFixture();
    f.request.record = { ...f.request.record, updatedAt: T0 + 9000 };
    assert.deepEqual(await f.reader.readBinding(f.request), {
      status: "unavailable",
      reason: "drift",
    });
    assert.equal(f.requests.length, 0);
  });
});
