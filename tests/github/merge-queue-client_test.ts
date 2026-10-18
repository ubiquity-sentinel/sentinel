import assert from "node:assert/strict";
import { portError } from "../../src/contracts/ports.ts";
import {
  entryWire,
  eventsWire,
  eventWire,
  membershipWire,
  pendingWire,
  PULL,
  pullWire,
  queueClient,
  REQUEST_ID,
  response,
  SHA1,
  SHA2,
  SHA3,
  snapshotWire,
} from "./merge-queue-fixtures.ts";

Deno.test("queue reads every page and enqueuer; entry group head stays distinct from PR head", async () => {
  const second = entryWire({
    id: "MQE_8",
    position: 2,
    pullRequest: pullWire({ id: "PR_8", number: 8 }),
    enqueuer: { __typename: "User", id: "USER_1", login: "owner" },
  });
  const pages = [
    response(snapshotWire([entryWire()], 2, "c1")),
    response(snapshotWire([second], 2)),
  ];
  const { client, requests } = queueClient([...pages, ...pages]);
  const read = await client.readQueue("development");
  assert.equal(read.status, "complete");
  if (read.status !== "complete") return;
  assert.equal(read.value.entries.length, 2);
  assert.equal(read.value.entries[1].enqueuer.login, "owner");
  assert.equal(read.value.entries[0].pull.head, SHA2);
  assert.equal(read.value.entries[0].headCommit, SHA3);
  assert.equal(requests.length, 4);
  assert.equal(JSON.parse(requests[1].body!).variables.after, "c1");
  assert.match(requests[0].body!, /\.\.\. on Bot \{ id \}/);
});

Deno.test("queue malformed, partial, foreign and unstable reads are never empty", async (t) => {
  const cases = [
    {
      name: "partial GraphQL data",
      replies: [
        response({
          ...snapshotWire([]),
          errors: [{ message: "private upstream details" }],
        }),
      ],
    },
    { name: "missing nodes", replies: [response(snapshotWire([], 1))] },
    {
      name: "duplicate PR",
      replies: [
        response(
          snapshotWire([entryWire(), entryWire({ id: "other", position: 2 })]),
        ),
      ],
    },
    {
      name: "duplicate position",
      replies: [
        response(
          snapshotWire([
            entryWire(),
            entryWire({
              id: "other",
              pullRequest: pullWire({ id: "PR_8", number: 8 }),
            }),
          ]),
        ),
      ],
    },
    {
      name: "foreign repository",
      replies: [
        response(
          snapshotWire([
            entryWire({
              pullRequest: pullWire({
                repository: { name: "sentinel", owner: { login: "ubiquity" } },
              }),
            }),
          ]),
        ),
      ],
    },
    {
      name: "missing actor",
      replies: [response(snapshotWire([entryWire({ enqueuer: null })]))],
    },
    {
      name: "cursor cycle",
      replies: [
        response(snapshotWire([entryWire()], 3, "c1")),
        response(
          snapshotWire(
            [entryWire({
              id: "MQE_8",
              position: 2,
              pullRequest: pullWire({ id: "PR_8", number: 8 }),
            })],
            3,
            "c1",
          ),
        ),
      ],
    },
    {
      name: "base changes",
      replies: [
        response(snapshotWire([])),
        response(snapshotWire([], 0, null, SHA3)),
      ],
    },
    {
      name: "entry changes",
      replies: [
        response(snapshotWire([entryWire()])),
        response(snapshotWire([entryWire({ state: "LOCKED" })])),
      ],
    },
    { name: "permission", replies: [response({ message: "private" }, 403)] },
    { name: "transport", replies: [new Error("private credentials")] },
  ];
  for (const test of cases) {
    await t.step(test.name, async () => {
      const { client } = queueClient(test.replies);
      const result = await client.readQueue("development");
      assert.notEqual(result.status, "complete");
      assert.doesNotMatch(JSON.stringify(result), /private/);
    });
  }
});

Deno.test("authenticated absent queue is distinct from permission denial and bounded truncation", async () => {
  const absent = queueClient([
    response(snapshotWire(null)),
    response(snapshotWire(null)),
  ]);
  const result = await absent.client.readQueue("development");
  assert.equal(result.status, "complete");
  if (result.status === "complete") assert.equal(result.value.queueId, null);
  const cut = queueClient([response(snapshotWire([entryWire()], 2, "c1"))], {
    maxPages: 1,
  });
  assert.deepEqual(await cut.client.readQueue("development"), {
    status: "unavailable",
    reason: "resource_bound",
  });
  const count = queueClient([response(snapshotWire([entryWire()], 2, "c1"))], {
    maxItems: 1,
  });
  assert.deepEqual(await count.client.readQueue("development"), {
    status: "unavailable",
    reason: "resource_bound",
  });
});

Deno.test("membership returns observed head and exact absence; contradictions fail closed", async () => {
  const observed = queueClient([
    response(membershipWire(null, { headRefOid: SHA3 })),
  ]);
  const read = await observed.client.readPullMembership(PULL);
  assert.equal(read.status, "complete");
  if (read.status === "complete") {
    assert.equal(read.value.pull.head, SHA3);
    assert.equal(read.value.entry, null);
  }
  for (
    const wire of [
      membershipWire(null, { isInMergeQueue: true }),
      membershipWire(
        entryWire({ pullRequest: pullWire({ headRefOid: SHA3 }) }),
      ),
      membershipWire(null, { merged: true }),
    ]
  ) {
    assert.equal(
      (await queueClient([response(wire)]).client.readPullMembership(PULL))
        .status,
      "invalid",
    );
  }
  const merged = await queueClient([
    response(
      membershipWire(null, { merged: true, mergeCommit: { oid: SHA3 } }),
    ),
  ]).client.readPullMembership(PULL);
  assert.equal(merged.status, "complete");
});

Deno.test("queue timeline uses nullable Actor and exhausts removals without interpreting free text", async () => {
  const first = response(eventsWire([eventWire()], 2, "c1"));
  const second = response(
    eventsWire([
      eventWire("RemovedFromMergeQueueEvent", "EV_2", {
        actor: null,
        reason: "new undocumented reason",
      }),
    ], 2),
  );
  const { client } = queueClient([first, second, first, second]);
  const result = await client.readPullQueueEvents(PULL);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.value.added[0].actor?.type, "Bot");
  assert.equal(result.value.removed[0].actor, null);
  assert.equal(result.value.removed[0].beforeCommit, SHA2);
  assert.equal(result.value.removed[0].reason, "new undocumented reason");
  const incomplete = queueClient([response(eventsWire([eventWire()], 2))]);
  assert.deepEqual(await incomplete.client.readPullQueueEvents(PULL), {
    status: "unavailable",
    reason: "incomplete",
  });
});

Deno.test("async enqueue always requests queue without bypass, persists UUID-shaped evidence, never retries", async (t) => {
  for (const status of [202, 409]) {
    await t.step(String(status), async () => {
      const { client, requests } = queueClient([
        response(pendingWire(), status),
      ]);
      assert.deepEqual(await client.enqueue(PULL), {
        status: "pending",
        requestId: REQUEST_ID,
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "PUT");
      assert.equal(
        new URL(requests[0].url).pathname,
        "/repos/ubiquity/ai.ubq.fi/pulls/7/merge-async",
      );
      assert.deepEqual(JSON.parse(requests[0].body!), {
        sha: SHA2,
        merge_action: "merge_queue",
        bypass_rules: false,
      });
    });
  }
  for (
    const details of [
      { expected_head_sha: SHA1 },
      { merge_action: "default" },
      { bypass_rules: true },
      { uuid: "wrong" },
      { merge_method: "squash" },
    ]
  ) {
    const { client, requests } = queueClient([
      response(pendingWire(details), 409),
    ]);
    assert.deepEqual(await client.enqueue(PULL), {
      status: "ambiguous",
      requestId: null,
    });
    assert.equal(requests.length, 1);
  }
  for (
    const reply of [new Error("private"), response({}, 500), response({}, 202)]
  ) {
    const { client, requests } = queueClient([reply]);
    assert.deepEqual(await client.enqueue(PULL), {
      status: "ambiguous",
      requestId: null,
    });
    assert.equal(requests.length, 1);
  }
});

Deno.test("enqueue hints and refusals are not merge proofs; foreign mutations send nothing", async () => {
  for (const status of ["enqueued", "merged"]) {
    const client = queueClient([
      response({
        status,
        details: {
          message: "synthetic",
          ...(status === "merged" ? { sha: SHA3 } : {}),
        },
      }),
    ]).client;
    assert.deepEqual(await client.enqueue(PULL), {
      status: `hint_${status}`,
      requestId: null,
    });
  }
  const refused = queueClient([
    response(
      { status: "failed", details: { message: "private refusal" } },
      400,
    ),
  ]);
  assert.deepEqual(await refused.client.enqueue(PULL), {
    status: "refused",
    reason: "not_mergeable",
  });
  const scope = queueClient([]);
  for (
    const pull of [{ ...PULL, baseRef: "queue-canary" }, {
      ...PULL,
      repository: { ...PULL.repository, name: "sentinel" },
    }]
  ) {
    assert.equal((await scope.client.enqueue(pull)).status, "not_submitted");
    assert.equal(
      (await scope.client.dequeue({ pull, entryId: "MQE_7" })).status,
      "not_submitted",
    );
  }
  assert.equal(scope.requests.length, 0);
});

Deno.test("async poll binds PR and UUID; 404 is unavailable, never expired/absent queue", async () => {
  const { client, requests } = queueClient([
    response(pendingWire()),
    response({}, 404),
  ]);
  assert.deepEqual(await client.poll(PULL, REQUEST_ID), {
    status: "complete",
    value: { status: "pending", requestId: REQUEST_ID },
  });
  assert.equal(
    new URL(requests[0].url).pathname,
    `/repos/ubiquity/ai.ubq.fi/pulls/7/merge-async/${REQUEST_ID}`,
  );
  assert.deepEqual(await client.poll(PULL, REQUEST_ID), {
    status: "unavailable",
    reason: "not_found",
  });
  assert.equal((await client.poll(PULL, "../bad")).status, "invalid");
  assert.equal(requests.length, 2);
});

Deno.test("dequeue requires exact own entry, freshly rechecks head, then proves absence", async () => {
  const success = queueClient([
    response(membershipWire()),
    response({
      data: { dequeuePullRequest: { mergeQueueEntry: { id: "MQE_7" } } },
    }),
    response(membershipWire(null)),
  ]);
  assert.deepEqual(
    await success.client.dequeue({ pull: PULL, entryId: "MQE_7" }),
    { status: "submitted" },
  );
  assert.deepEqual(JSON.parse(success.requests[1].body!).variables, {
    id: "PR_7",
  });
  for (
    const wire of [
      membershipWire(
        entryWire({
          enqueuer: { __typename: "User", id: "U_1", login: "owner" },
        }),
      ),
      membershipWire(entryWire({ id: "MQE_other" })),
      membershipWire(null, { headRefOid: SHA3 }),
    ]
  ) {
    const { client, requests } = queueClient([response(wire)]);
    assert.equal(
      (await client.dequeue({ pull: PULL, entryId: "MQE_7" })).status,
      "not_submitted",
    );
    assert.equal(requests.length, 1);
  }
  const lost = queueClient([response(membershipWire()), new Error("lost")]);
  assert.deepEqual(
    await lost.client.dequeue({ pull: PULL, entryId: "MQE_7" }),
    { status: "ambiguous" },
  );
  assert.equal(lost.requests.length, 2);
});

Deno.test("queue respects durable cooldown and bounded authentication without network", async () => {
  const blocked = queueClient([], {
    cooldownGate: {
      beforeRequest: () =>
        Promise.resolve(portError("rate_limited", "synthetic")),
      recordRateLimit: () => {
        throw new Error("must not record");
      },
    },
  });
  assert.deepEqual(await blocked.client.enqueue(PULL), {
    status: "not_submitted",
    reason: "rate_limited",
  });
  assert.equal(blocked.requests.length, 0);
  const hung = queueClient([], {
    requestDeadlineMs: 5,
    auth: { authorizationHeader: () => new Promise(() => {}) },
  });
  assert.deepEqual(await hung.client.readQueue("development"), {
    status: "unavailable",
    reason: "auth",
  });
  assert.equal(hung.requests.length, 0);
});
