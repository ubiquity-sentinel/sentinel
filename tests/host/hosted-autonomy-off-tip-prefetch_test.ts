/**
 * A review/delivery record outside the Gateway whose reviewed base is not
 * the tip the delivery pass already read for its repository can only be
 * refused `base_moved` by every merge gate, so the pass reads only its pull
 * request (for the lost write of a merge that moved the tip itself), never
 * its source issue, mirroring the spent records behind the tip (#156 (6)).
 * An unread tip is never read for it, and a merged pull request is still
 * booked exactly as before.
 */
import assert from "node:assert/strict";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy.ts";
import { SHA2 } from "../state/helpers.ts";
import {
  BASE,
  deliveryRecord,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  MERGE,
  pullFacts,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  readRequests,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

/** The rig's surface, counting the reads this rule is about. */
function counting(github: HostedAutonomyGitHubV1) {
  const reads = { task: 0, pull: 0, tip: 0 };
  const surface: HostedAutonomyGitHubV1 = {
    ...github,
    readIssueTask: (number: number) => {
      reads.task++;
      return github.readIssueTask!(number);
    },
    readPull: (number: number, baseBranch: string | null) => {
      reads.pull++;
      return github.readPull(number, baseBranch);
    },
    readBaseTip: (branch: string) => {
      reads.tip++;
      return github.readBaseTip(branch);
    },
  };
  return { reads, surface };
}

Deno.test("off-tip prefetch: a self delivery off the read tip reports base_moved without its issue read", async () => {
  const { rig, github } = await makeRig("off-tip-self-open", {
    repair: repairSnapshot([deliveryRecord()]),
    pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    baseTip: SHA2,
  });
  const { reads, surface } = counting(github);
  try {
    const result = await run(rig, surface);
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:base_moved`),
      JSON.stringify(result.actions),
    );
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.equal(result.reason, "base_moved");
    // Only the closure pass reads the source issue (for its own closure
    // plan); the delivery pass reads none.
    assert.equal(reads.task, 1, "the delivery pass reads no source issue");
    assert.equal(reads.pull, 1, "the delivery pass reads its pull request");
    assert.equal(rig.merges, 0);
    assert.equal(rig.writes, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("off-tip prefetch: a merged self pull request that moved the tip is still booked", async () => {
  // The lost write of a merge the record's own pull request made: the tip is
  // that merge, so the reviewed base is no longer the tip.
  const { rig, github } = await makeRig("off-tip-self-merged", {
    repair: repairSnapshot([deliveryRecord()]),
    pull: pullFacts(),
    baseTip: MERGE,
  });
  const { reads, surface } = counting(github);
  try {
    const result = await run(rig, surface);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(rig.merges, 0);
    assert.equal((await readRequests(rig)).length, 1);
    // The merged pull request goes on to the ordinary booking path, whose
    // task read still authorizes the record (beside the closure pass's own).
    assert.equal(reads.task, 2);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("off-tip prefetch: an unread foreign tip is never read early and the record keeps its path", async () => {
  const { rig, github } = await makeRig("off-tip-foreign-unread", {
    repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
    pull: foreignPullFacts({
      state: "open",
      merged: false,
      mergeCommitSha: null,
    }),
    baseTip: SHA2,
  });
  const { reads, surface } = counting(github);
  try {
    const result = await run(rig, surface);
    assert.notEqual(SHA2, BASE);
    assert.ok(
      result.actions.some((action) => action.endsWith(":base_moved")),
      JSON.stringify(result.actions),
    );
    // No tip was read for this repository before the record, so it keeps
    // the ordinary path: the same reads as before the rule (its task, its
    // pull request, then the gate's tip read refusing `base_moved`).
    assert.deepEqual(reads, { task: 3, pull: 3, tip: 2 });
    assert.equal(rig.merges, 0);
    assert.equal(rig.writes, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
