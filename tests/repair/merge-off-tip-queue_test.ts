/**
 * The parent proof of an observed merge on ai.ubq.fi (stage-1 review,
 * 2026-10-25). The native queue target used to skip it for every merge the
 * loop observed later, as the queue's own merge. With the queue mode ceiling
 * off and its delivery proof not activated (the shipped configuration),
 * Sentinel merges there through the REST path, so a merge whose response was
 * lost after the base moved was booked on a tree no CI ran on. It is now
 * checked like any other target's.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { isNativeQueueTarget } from "../../src/github/native-queue-guard.ts";
import {
  QUEUE_MODE_CEILING,
  QUEUE_PROOF_ACTIVATED,
} from "../../src/github/queue-runtime-policy.ts";
import {
  observedMergeLanding,
  queueMayHaveMerged,
} from "../../src/repair/merge-off-tip.ts";
import type { RepairCycleDepsV1 } from "../../src/repair/loop-types.ts";
import { REPO, SHA1, SHA2, SHA3, workRecord } from "../state/helpers.ts";

const MERGE = "4".repeat(40) as GitSha;

function deps(parents: GitSha[], reads: string[]): RepairCycleDepsV1 {
  return {
    github: {
      readCommitParents: (sha: GitSha) => {
        reads.push(sha);
        return Promise.resolve(portOk(parents));
      },
    },
  } as unknown as RepairCycleDepsV1;
}

Deno.test("an observed ai.ubq.fi merge is parent-checked while the queue cannot merge", async () => {
  assert.equal(isNativeQueueTarget(REPO), true);
  assert.equal(QUEUE_MODE_CEILING, "off");
  assert.equal(QUEUE_PROOF_ACTIVATED, false);
  assert.equal(queueMayHaveMerged(REPO), false);
  const record = workRecord("issue-1", {
    repository: REPO,
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-1",
      checkpoint: null,
      head: SHA3,
      pr: 7,
    },
  });
  const reads: string[] = [];
  // The base moved to SHA2 before the merge landed.
  assert.deepEqual(
    await observedMergeLanding(deps([SHA2, SHA3], reads), record, SHA3, MERGE),
    {
      outcome: "merged_off_tip",
      head: SHA3,
      mergeSha: MERGE,
      parents: [SHA2, SHA3],
    },
  );
  assert.deepEqual(reads, [MERGE]);
  assert.deepEqual(
    await observedMergeLanding(deps([SHA1, SHA3], []), record, SHA3, MERGE),
    { outcome: "merged", head: SHA3, mergeSha: MERGE },
  );
});
