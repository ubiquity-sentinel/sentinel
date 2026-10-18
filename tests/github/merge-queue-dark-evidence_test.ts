import assert from "node:assert/strict";
import { GitHubMergeQueueEvidenceClient } from "../../src/github/client-merge-queue-evidence.ts";
import {
  membershipWire,
  PULL,
  queueClient,
  response,
} from "./merge-queue-fixtures.ts";
import { SHA4 } from "./helpers.ts";

Deno.test("dark queue client has no group proof without an accepted workflow pin", async () => {
  const fixture = queueClient([response(membershipWire())]);
  const client = new GitHubMergeQueueEvidenceClient(fixture.options, null);
  assert.deepEqual(await client.readMergeGroupRuns(SHA4), {
    status: "unavailable",
    reason: "unsupported",
  });
  assert.equal(fixture.requests.length, 0);
  assert.equal((await client.readPullMembership(PULL)).status, "complete");
  assert.equal(fixture.requests.length, 1);
});
