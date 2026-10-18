/** Only exact merged-revision workflow bytes can authorize native queue delivery. */
import assert from "node:assert/strict";
import { resolveQueueAwareDelivery } from "../../ops/hosted-autonomy-queue-proof.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import type { QueueDeliveryReaderOptions } from "../../src/github/queue-delivery-reader.ts";
import {
  APP,
  directProofFacts,
  POLICY,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
} from "../host/merge-queue-proof-fixtures.ts";
import { eventsWire, response } from "./merge-queue-fixtures.ts";
import {
  AFTER_TREE,
  blob,
  commitWire,
  compareWire,
  pullFactsWire,
  readerFixture,
  treeWire,
  UNTIL,
  WORKFLOW_BLOB,
  WORKFLOW_BYTES,
  WORKFLOW_PATH,
  WORKFLOW_SHA256,
} from "./queue-delivery-reader-fixtures.ts";

const PROVENANCE: QueueDeliveryReaderOptions["provenance"] = ({ binding }) =>
  Promise.resolve({
    status: "complete",
    value: { binding, enqueuer: APP, evidenceIds: ["EV_1", "MQE_7"] },
  });
const PREDECESSOR_TREE = "7".repeat(40) as GitSha;
const MERGED_TREE = "8".repeat(40) as GitSha;
async function blobFact(content: string) {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  const hex = (buffer: ArrayBuffer) =>
    Array.from(
      new Uint8Array(buffer),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  const sha = hex(await crypto.subtle.digest("SHA-1", object)) as GitSha;
  return {
    sha,
    sha256: hex(await crypto.subtle.digest("SHA-256", bytes)),
    wire: {
      sha,
      size: bytes.length,
      encoding: "base64",
      content: btoa(content),
    },
  };
}
async function readFacts(f: Awaited<ReturnType<typeof readerFixture>>) {
  const read = await f.reader.read(f.request);
  assert.equal(read.status, "complete");
  if (read.status !== "complete") {
    throw new Error("Expected collected delivery facts");
  }
  return read.value;
}
function assertSamePatch(facts: Awaited<ReturnType<typeof readFacts>>) {
  assert.equal(facts.reviewedPatch.status, "complete");
  assert.equal(facts.integratedPatch.status, "complete");
  if (
    facts.reviewedPatch.status !== "complete" ||
    facts.integratedPatch.status !== "complete"
  ) throw new Error("Expected exact tree patches");
  assert.deepEqual(
    facts.integratedPatch.value.changes,
    facts.reviewedPatch.value.changes,
  );
  assert.deepEqual(
    facts.reviewedPatch.value.changes.map((change) => change.path),
    ["src/fix.ts"],
  );
}

Deno.test("native queue proof accepts authenticated pinned workflow bytes at the exact merge commit", async () => {
  const f = await readerFixture({ options: { provenance: PROVENANCE } });
  const facts = await readFacts(f);
  assert.deepEqual(facts.workflow, {
    status: "complete",
    value: { revision: SHA4, path: WORKFLOW_PATH, sha256: WORKFLOW_SHA256 },
  });
  assertSamePatch(facts);
  const proof = await resolveQueueAwareDelivery(facts, POLICY);
  assert.equal(proof.status, "verified");
  if (proof.status === "verified") assert.equal(proof.delivery.kind, "queue");
  assert.ok(
    f.requests.some((request) =>
      request.url.endsWith(`/git/blobs/${WORKFLOW_BLOB}`)
    ),
  );
  assert.ok(f.requests.every((request) => !request.url.includes("/contents/")));
});

Deno.test("a queue predecessor workflow change fails exact-M proof despite accepted B/H and equal PR patches", async () => {
  const changed = await blobFact("name: changed queue workflow\n");
  const f = await readerFixture({
    options: { provenance: PROVENANCE },
    intercept: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/compare/${SHA3}...${SHA4}`)) {
        const compare = compareWire(SHA3);
        return response({
          ...compare,
          merge_base_commit: {
            ...compare.merge_base_commit,
            commit: { tree: { sha: PREDECESSOR_TREE } },
          },
        });
      }
      if (path.endsWith(`/git/commits/${SHA4}`)) {
        return response({ sha: SHA4, tree: { sha: MERGED_TREE } });
      }
      if (path.endsWith(`/git/trees/${PREDECESSOR_TREE}`)) {
        return response(
          treeWire(PREDECESSOR_TREE, [
            blob("src/fix.ts", SHA1),
            blob(WORKFLOW_PATH, changed.sha),
          ]),
        );
      }
      if (path.endsWith(`/git/trees/${MERGED_TREE}`)) {
        return response(
          treeWire(MERGED_TREE, [
            blob("src/fix.ts", SHA2),
            blob(WORKFLOW_PATH, changed.sha),
          ]),
        );
      }
      if (path.endsWith(`/git/blobs/${changed.sha}`)) {
        return response(changed.wire);
      }
      return undefined;
    },
  });
  for (const revision of [SHA1, SHA2]) {
    assert.deepEqual(await f.client.readQueueWorkflowDigest(revision, UNTIL), {
      status: "complete",
      value: { revision, path: WORKFLOW_PATH, sha256: WORKFLOW_SHA256 },
    });
  }
  const facts = await readFacts(f);
  assertSamePatch(facts);
  assert.deepEqual(facts.workflow, {
    status: "complete",
    value: { revision: SHA4, path: WORKFLOW_PATH, sha256: changed.sha256 },
  });
  assert.equal(facts.groupRuns.status, "complete");
  if (facts.groupRuns.status === "complete") {
    assert.equal(facts.groupRuns.value[0].conclusion, "success");
  }
  assert.deepEqual(await resolveQueueAwareDelivery(facts, POLICY), {
    status: "rejected",
    reason: "workflow_mismatch",
  });
});

Deno.test("native workflow collector refuses missing bytes, forged blob content and a foreign Git commit", async (t) => {
  for (
    const fault of [
      "missing blob",
      "permission",
      "forged content",
      "foreign commit",
    ] as const
  ) {
    await t.step(fault, async () => {
      const f = await readerFixture({
        options: { provenance: PROVENANCE },
        intercept: (request, count) => {
          const path = new URL(request.url).pathname;
          // The first M Git-commit read belongs to patch collection. Corrupt
          // only the later workflow read, leaving both exact patches intact.
          if (
            fault === "foreign commit" &&
            path.endsWith(`/git/commits/${SHA4}`) && count === 2
          ) return response({ sha: SHA3, tree: { sha: AFTER_TREE } });
          if (!path.endsWith(`/git/blobs/${WORKFLOW_BLOB}`)) return undefined;
          if (fault === "missing blob") return response({}, 404);
          if (fault === "permission") return response({}, 403);
          if (fault === "forged content") {
            const content = WORKFLOW_BYTES.replace("accepted", "tampered");
            return response({
              sha: WORKFLOW_BLOB,
              encoding: "base64",
              size: content.length,
              content: btoa(content),
            });
          }
          return undefined;
        },
      });
      const facts = await readFacts(f);
      assertSamePatch(facts);
      assert.deepEqual(
        facts.workflow,
        fault === "missing blob"
          ? { status: "unavailable", reason: "not_found" }
          : fault === "permission"
          ? { status: "unavailable", reason: "permission" }
          : { status: "invalid", reason: "identity_mismatch" },
      );
      assert.deepEqual(await resolveQueueAwareDelivery(facts, POLICY), {
        status: "unavailable",
        reason: "workflow_unavailable",
      });
    });
  }
});

Deno.test("historical direct proof remains available when exact-M workflow bytes are unavailable", async () => {
  const original = await directProofFacts();
  const witnesses = [{
    binding: original.binding,
    revision: SHA4,
    witnessDigest: "c".repeat(64),
  }];
  const manifestDigest = await canonicalStringifySha256({
    domain: "sentinel.queue-historical-direct.v1",
    witnesses,
  });
  const policy = {
    ...POLICY,
    historicalDirectManifestDigest: manifestDigest,
    historicalDirectWitnesses: witnesses,
  };
  const f = await readerFixture({
    options: {
      policy,
      directWitness: ({ binding, revision }) =>
        Promise.resolve({
          status: "complete",
          value: {
            binding,
            revision,
            provenance: {
              kind: "historical_exact",
              manifestDigest,
              witnessDigest: "c".repeat(64),
            },
          },
        }),
    },
    intercept: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/graphql")) {
        const query = String(JSON.parse(request.body ?? "{}").query ?? "");
        return response(
          query.includes("timelineItems") ? eventsWire([]) : pullFactsWire({
            mergedBy: {
              __typename: APP.type,
              id: APP.nodeId,
              login: APP.login,
            },
          }),
        );
      }
      if (path.endsWith(`/commits/${SHA4}`) && !path.includes("/git/")) {
        return response(
          commitWire({ parents: [{ sha: SHA1 }, { sha: SHA2 }] }),
        );
      }
      if (path.endsWith("/actions/workflows/84/runs")) {
        return response({ total_count: 0, workflow_runs: [] });
      }
      if (path.endsWith(`/git/blobs/${WORKFLOW_BLOB}`)) {
        return response({}, 404);
      }
      return undefined;
    },
  });
  const facts = await readFacts(f);
  assert.equal(facts.anyQueueEvidence, false);
  assert.deepEqual(facts.queue, { status: "complete", value: null });
  assert.deepEqual(facts.workflow, {
    status: "unavailable",
    reason: "not_found",
  });
  const proof = await resolveQueueAwareDelivery(facts, policy);
  assert.equal(proof.status, "verified");
  if (proof.status === "verified") assert.equal(proof.delivery.kind, "direct");
});
