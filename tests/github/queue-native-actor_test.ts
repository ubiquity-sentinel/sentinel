import assert from "node:assert/strict";
import identity from "../fixtures/github/native-bot-identity.json" with {
  type: "json",
};
import {
  decodeQueueWire,
  parseGraphQLQueueActor,
  QUEUE_GRAPHQL_ACTOR_FIELDS,
} from "../../src/github/merge-queue-wire.ts";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import { resolveQueueAwareDelivery } from "../../ops/hosted-autonomy-queue-proof.ts";
import {
  commitWire,
  deliveryClient,
  UNTIL,
} from "./queue-delivery-reader-fixtures.ts";
import {
  entryWire,
  membershipWire,
  response,
  snapshotWire,
} from "./merge-queue-fixtures.ts";
import {
  directProofFacts,
  POLICY,
  queueProofFacts,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
} from "../host/merge-queue-proof-fixtures.ts";

// Sanitized actor fragments from ai.ubq.fi PR1089, confirmed by a read-only
// GraphQL author/id query and the retained REST commit author. Other facts below
// are local synthetic proof fixtures, not new historical-production grants.
const GRAPHQL = identity.graphql;
const REST = identity.rest;
const APP = { type: "Bot" as const, login: REST.login, nodeId: REST.node_id };

async function nativeActors(mergedBy: unknown = GRAPHQL) {
  const f = deliveryClient([
    response(membershipWire(null, {
      baseRefOid: SHA1,
      author: GRAPHQL,
      mergedBy,
      merged: true,
      mergeCommit: { oid: SHA4 },
    })),
    response(commitWire({ author: REST })),
    response(snapshotWire([entryWire({ enqueuer: GRAPHQL })])),
    response(snapshotWire([entryWire({ enqueuer: GRAPHQL })])),
  ]);
  const pull = await f.client.readQueuePull(7, UNTIL);
  const commit = await f.client.readQueueCommit(SHA4, UNTIL);
  const queue = await f.client.readQueue("development");
  assert.equal(pull.status, "complete");
  assert.equal(commit.status, "complete");
  assert.equal(queue.status, "complete");
  if (
    pull.status !== "complete" || commit.status !== "complete" ||
    queue.status !== "complete"
  ) throw Error("native setup");
  const query = JSON.parse(f.requests[0].body!).query as string;
  assert.ok(query.includes(`author { ${QUEUE_GRAPHQL_ACTOR_FIELDS} }`));
  assert.ok(query.includes(`mergedBy { ${QUEUE_GRAPHQL_ACTOR_FIELDS} }`));
  return {
    pull: pull.value,
    commit: commit.value,
    enqueuer: queue.value.entries[0].enqueuer,
  };
}

Deno.test("native unsuffixed GraphQL Bot reaches actual queue proof without changing REST pins", async () => {
  const native = await nativeActors();
  const facts = await queueProofFacts();
  facts.publicationAuthor = native.pull.author;
  facts.mergedBy = native.pull.mergedBy;
  facts.commit = { ...native.commit, parents: [SHA3, SHA2] };
  assert.equal(facts.queue.status, "complete");
  if (facts.queue.status !== "complete" || facts.queue.value === null) {
    throw Error("queue setup");
  }
  facts.queue = {
    status: "complete",
    value: { ...facts.queue.value, enqueuer: native.enqueuer },
  };
  const proof = await resolveQueueAwareDelivery(facts, {
    ...POLICY,
    appActor: APP,
    mergedActors: [APP],
  });
  assert.equal(proof.status, "verified", JSON.stringify(proof));
});

Deno.test("native unsuffixed GraphQL Bot reaches exact historical proof through the actual client", async () => {
  const native = await nativeActors();
  const facts = await directProofFacts();
  facts.publicationAuthor = native.pull.author;
  facts.mergedBy = native.pull.mergedBy;
  facts.commit = { ...native.commit, parents: [SHA1, SHA2] };
  const witnesses = [{
    binding: facts.binding,
    revision: SHA4,
    witnessDigest: "c".repeat(64),
  }];
  const manifestDigest = await canonicalStringifySha256({
    domain: "sentinel.queue-historical-direct.v1",
    witnesses,
  });
  assert.ok(facts.directWitness);
  facts.directWitness.provenance = {
    kind: "historical_exact",
    manifestDigest,
    witnessDigest: "c".repeat(64),
  };
  const proof = await resolveQueueAwareDelivery(facts, {
    ...POLICY,
    historicalDirectManifestDigest: manifestDigest,
    historicalDirectWitnesses: witnesses,
  });
  assert.equal(proof.status, "verified", JSON.stringify(proof));
});

Deno.test("strict direct actor identity does not accept equal Bot labels with different native nodes", async () => {
  const native = await nativeActors({ ...GRAPHQL, id: "BOT_foreign" });
  const facts = await directProofFacts();
  facts.publicationAuthor = native.pull.author;
  facts.mergedBy = native.pull.mergedBy;
  facts.commit = { ...native.commit, parents: [SHA1, SHA2] };
  const proof = await resolveQueueAwareDelivery(facts, POLICY);
  assert.equal(proof.status, "rejected", JSON.stringify(proof));
  const witnesses = [{
    binding: facts.binding,
    revision: SHA4,
    witnessDigest: "c".repeat(64),
  }];
  const manifestDigest = await canonicalStringifySha256({
    domain: "sentinel.queue-historical-direct.v1",
    witnesses,
  });
  assert.ok(facts.directWitness);
  facts.directWitness.provenance = {
    kind: "historical_exact",
    manifestDigest,
    witnessDigest: "c".repeat(64),
  };
  assert.equal(
    (await resolveQueueAwareDelivery(facts, {
      ...POLICY,
      historicalDirectManifestDigest: manifestDigest,
      historicalDirectWitnesses: witnesses,
    })).status,
    "rejected",
  );
});

Deno.test("GraphQL actor boundary preserves User and Node identity and bounds the canonical Bot login", async (t) => {
  for (const login of [GRAPHQL.login, REST.login]) {
    const parsed = parseGraphQLQueueActor({ ...GRAPHQL, login });
    assert.deepEqual(parsed, APP);
  }
  const user = { __typename: "User", id: "USER_owner", login: "owner" };
  assert.deepEqual(parseGraphQLQueueActor(user), {
    type: "User",
    nodeId: user.id,
    login: user.login,
  });
  assert.deepEqual(parseGraphQLQueueActor({ ...GRAPHQL, id: "BOT_foreign" }), {
    ...APP,
    nodeId: "BOT_foreign",
  }, "normalization never substitutes a trusted node ID");
  assert.equal(
    parseGraphQLQueueActor({ ...GRAPHQL, login: "b".repeat(95) }).login.length,
    100,
  );
  const invalid = [
    null,
    { ...GRAPHQL, id: null },
    { ...GRAPHQL, id: "" },
    { ...GRAPHQL, __typename: undefined },
    { ...GRAPHQL, __typename: "Organization" },
    { ...GRAPHQL, __typename: "User", login: REST.login },
    { ...GRAPHQL, __typename: "User", login: "ubiquity-sentinel[BOT]" },
    { ...GRAPHQL, login: "ubiquity-sentinel[bot][bot]" },
    { ...GRAPHQL, login: "ubiquity-sentіnel" },
    { ...GRAPHQL, login: "ubiquity-sentinel " },
    { ...GRAPHQL, login: "b".repeat(96) },
  ];
  for (const [index, wire] of invalid.entries()) {
    await t.step(String(index), () => {
      assert.equal(
        decodeQueueWire(() => parseGraphQLQueueActor(wire)).status,
        "invalid",
      );
    });
  }
});

Deno.test("actual native pull reader refuses missing or spoofed author identity before proof", async (t) => {
  for (
    const author of [
      { login: GRAPHQL.login },
      { ...GRAPHQL, id: null },
      { ...GRAPHQL, __typename: "User", login: REST.login },
    ]
  ) {
    await t.step(JSON.stringify(author), async () => {
      const f = deliveryClient([response(membershipWire(null, {
        baseRefOid: SHA1,
        author,
        mergedBy: GRAPHQL,
      }))]);
      assert.equal((await f.client.readQueuePull(7, UNTIL)).status, "invalid");
    });
  }
});

Deno.test("actual queue proof rejects a lookalike or a different native merger node", async (t) => {
  for (
    const changed of [
      { ...GRAPHQL, id: "BOT_foreign" },
      { ...GRAPHQL, login: "ubiquity-sentinel-copy" },
      { ...GRAPHQL, __typename: "User" },
    ]
  ) {
    await t.step(JSON.stringify(changed), async () => {
      const native = await nativeActors(changed);
      const facts = await queueProofFacts();
      facts.publicationAuthor = native.pull.author;
      facts.mergedBy = native.pull.mergedBy;
      facts.commit = { ...native.commit, parents: [SHA3, SHA2] };
      if (facts.queue.status !== "complete" || facts.queue.value === null) {
        throw Error("queue setup");
      }
      facts.queue = {
        status: "complete",
        value: { ...facts.queue.value, enqueuer: native.enqueuer },
      };
      assert.equal(
        (await resolveQueueAwareDelivery(facts, {
          ...POLICY,
          appActor: APP,
          mergedActors: [APP],
        })).status,
        "rejected",
      );
    });
  }
});
