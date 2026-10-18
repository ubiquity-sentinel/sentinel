import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import { resolveQueueLegacyDirect } from "../../src/github/queue-legacy-direct.ts";
import { treeChangesDigest } from "../../ops/hosted-autonomy-github-trees.ts";
import { MemoryState } from "../repair/helpers.ts";
import { APP, SHA4 } from "../host/merge-queue-proof-fixtures.ts";
import { pullWire } from "./helpers.ts";
import { PULL, response, SHA1, SHA2, SHA3 } from "./merge-queue-fixtures.ts";
import {
  AFTER_TREE,
  blob,
  readerFixture,
  treeWire,
} from "./queue-delivery-reader-fixtures.ts";

async function fixture(carried = false, mismatch = false) {
  const f = await readerFixture({
    intercept: (request, count) => {
      if (request.url.endsWith("/pulls/7")) {
        return response(pullWire({
          number: 7,
          state: "closed",
          head: { ref: PULL.headRef, sha: carried ? SHA3 : SHA2 },
          base: { ref: "development", sha: SHA1 },
          user: { login: APP.login },
          merged_at: "2026-09-07T02:00:00Z",
          merge_commit_sha: SHA4,
          merged_by: { type: APP.type, node_id: APP.nodeId, login: APP.login },
        }));
      }
      if (
        mismatch && request.url.includes(`/git/trees/${AFTER_TREE}`) &&
        count === 2
      ) {
        return response(
          treeWire(AFTER_TREE, [blob("src/fix.ts", SHA4, "100755")]),
        );
      }
      return undefined;
    },
  });
  f.client.readBranchRules = () => Promise.resolve(portOk([]));
  if (carried) {
    f.facts.record.target.head = SHA3;
    f.snapshot.work = [f.facts.record];
  }
  const state = new MemoryState();
  state.repair = f.snapshot;
  state.repairHead = SHA1;
  const options = {
    state,
    clock: f.clock,
    client: f.client,
    reader: f.reader,
    mode: "off" as const,
    proofActivated: false,
  };
  const request = {
    record: f.facts.record,
    receipt: f.facts.receipt,
    revision: SHA4,
    deadline: f.clock.now() + 60_000,
  };
  return { ...f, state, options, request };
}
Deno.test("legacy queue grant: exact receipt keeps full binding and makes no queue-permission reads", async () => {
  const f = await fixture();
  const grant = await resolveQueueLegacyDirect(f.options, f.request);
  assert.equal(grant.status, "complete");
  if (grant.status !== "complete") return;
  assert.deepEqual(grant.value, {
    status: "legacy_direct",
    binding: f.facts.binding,
    revision: SHA4,
  });
  assert.ok(f.requests.every((request) => !request.url.endsWith("/graphql")));
  assert.ok(!f.requests.some((request) => request.url.includes("/git/trees/")));
});
Deno.test("legacy queue grant: carried receipt requires exact full tree equality and names original B/H", async () => {
  const f = await fixture(true);
  const grant = await resolveQueueLegacyDirect(f.options, f.request);
  assert.equal(grant.status, "complete");
  if (grant.status !== "complete" || grant.value === null) {
    return assert.fail("missing carried grant");
  }
  assert.equal(grant.value.binding.head, SHA3);
  assert.deepEqual(grant.value.carried, {
    reviewedBase: SHA1,
    reviewedHead: SHA2,
    patchDigest: await treeChangesDigest([{
      path: "src/fix.ts",
      oldMode: "100644",
      oldSha: SHA1,
      newMode: "100644",
      newSha: SHA2,
    }]),
  });
  assert.equal(
    f.requests.filter((request) => request.url.includes("/git/trees/")).length,
    4,
  );
  assert.ok(f.requests.every((request) => !request.url.endsWith("/graphql")));
});
Deno.test("legacy queue grant: changed mode/blob in carried tree cannot reuse old receipt", async () => {
  const f = await fixture(true, true);
  assert.equal(
    (await resolveQueueLegacyDirect(f.options, f.request)).status,
    "unavailable",
  );
});
Deno.test("legacy queue grant: activated proof, retained custody or effective queue rule require strict path", async (t) => {
  for (const condition of ["activation", "custody", "rule"] as const) {
    await t.step(condition, async () => {
      const f = await fixture();
      if (condition === "activation") f.options.proofActivated = true;
      if (condition === "custody") {
        f.facts.record.wait = {
          reason: "backoff",
          since: f.clock.now(),
          until: null,
        };
      }
      if (condition === "rule") {
        f.client.readBranchRules = () =>
          Promise.resolve(portOk([{ type: "merge_queue" } as never]));
      }
      assert.deepEqual(await resolveQueueLegacyDirect(f.options, f.request), {
        status: "complete",
        value: null,
      });
    });
  }
});
Deno.test("legacy queue grant: mismatched exact revision, later receipt and foreign merge actor refuse", async (t) => {
  for (const condition of ["revision", "receipt", "actor"] as const) {
    await t.step(condition, async () => {
      const f = await fixture();
      if (condition === "revision") f.request.revision = SHA1;
      if (condition === "receipt") {
        f.request.receipt = { ...f.facts.receipt, id: "different-review" };
      }
      if (condition === "actor") {
        const read = f.client.readQueueLegacyPull.bind(f.client);
        f.client.readQueueLegacyPull = async (...args) => {
          const observed = await read(...args);
          if (observed.status === "complete") {
            observed.value.mergedBy = {
              type: "User",
              nodeId: "OWNER",
              login: "owner",
            };
          }
          return observed;
        };
      }
      assert.equal(
        (await resolveQueueLegacyDirect(f.options, f.request)).status,
        "unavailable",
      );
    });
  }
});
