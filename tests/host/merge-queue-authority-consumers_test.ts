import assert from "node:assert/strict";
import { createHostedQueueAuthority } from "../../ops/hosted-autonomy-queue-authority.ts";
import { protectQueueState } from "../../ops/hosted-autonomy-queue-state.ts";
import { runHostedDeliveryPass } from "../../ops/hosted-autonomy-delivery-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type { HostedQueueCustodyContext } from "../../ops/hosted-autonomy-queue-context.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { portOk, type RepairStateWriter } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { authorityRig } from "./merge-queue-authority-fixtures.ts";
import {
  BASE,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  repositoryTask,
} from "./hosted-autonomy-fixtures.ts";
import { releaseSnapshot } from "./hosted-autonomy-rig.ts";
import { SHA3 } from "./merge-queue-proof-fixtures.ts";

Deno.test("real queue authority permits queued booking after a direct merge in the same protected pass", async () => {
  const rig = await authorityRig(true);
  const queued = rig.record;
  const task = rig.facts.task;
  assert.ok(task !== "unavailable");
  const other = foreignRecord();
  rig.replace(
    parseRepairStateSnapshotV1({
      ...rig.snapshot,
      work: [other, queued],
      reviews: [foreignReceipt(), ...rig.snapshot.reviews],
    }),
    rig.head,
  );
  const before = structuredClone(rig.snapshot);
  let merged = false;
  let merges = 0;
  let writes = 0;
  let authorizations = 0;
  const githubFor: HostedAutonomyDepsV1["githubFor"] = (repository) =>
    repository.name === queued.repository.name
      ? {
        ...rig.github,
        readIssueTask: () => Promise.resolve(task),
      }
      : {
        ...rig.github,
        readDefaultBranch: () => Promise.resolve("main"),
        readBaseTip: () => Promise.resolve(BASE),
        readIssueTask: (issue) =>
          Promise.resolve(repositoryTask(repository, issue)),
        readPull: () =>
          Promise.resolve(
            merged ? foreignPullFacts() : foreignPullFacts({
              state: "open",
              merged: false,
              mergeCommitSha: null,
            }),
          ),
        merge: () => {
          merges++;
          merged = true;
          return Promise.resolve({
            merged: true,
            sha: foreignPullFacts().mergeCommitSha,
          });
        },
      };
  const authority = createHostedQueueAuthority({
    ...rig.options,
    githubFor,
    configuration: rig.configuration,
  });
  const custody: HostedQueueCustodyContext = {
    ready: true,
    proofActivated: true,
    protectedRecordIds: new Set([queued.id]),
    resolveDelivery: authority.resolveDelivery,
    verifyProtectedWrite: (previous, next, head) => {
      authorizations++;
      return authority.verifyProtectedWrite(previous, next, head);
    },
  };
  const underlying = {
    ...rig.state,
    writeRepair: ((next, expectedHead) => {
      assert.equal(expectedHead, rig.head);
      assert.equal(next.stateHead, expectedHead);
      assert.equal(next.sequence, rig.snapshot.sequence + 1);
      writes++;
      rig.replace(parseRepairStateSnapshotV1(next), SHA3);
      return Promise.resolve(portOk({ status: "applied", head: rig.head }));
    }) satisfies RepairStateWriter["writeRepair"],
  };
  const deps: HostedAutonomyDepsV1 = {
    state: protectQueueState(underlying, custody),
    githubFor,
    clock: rig.clock,
    queueCustody: custody,
  };
  const context: HostedAutonomyPassContextV1 = {
    deps,
    snapshot: structuredClone(rig.snapshot),
    observedHead: rig.head,
    initialHead: rig.head,
    releaseSnapshot: releaseSnapshot(),
    actions: [],
    revisions: [],
    closedIssues: new Set(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set(),
    ...createHostedAutonomyScopes(deps),
  };
  const result = await runHostedDeliveryPass(context);
  assert.equal(result?.status, "applied", context.actions.join(" "));
  assert.equal(merges, 1, context.actions.join(" "));
  assert.equal(
    writes,
    1,
    "the direct merge must not batch an unrelated row edit",
  );
  assert.equal(
    authorizations,
    1,
    "the real protected writer must authorize booking",
  );
  assert.equal(context.foreignMerged.size, 1);
  assert.deepEqual(rig.snapshot.work[0], before.work[0]);
  const delivered = rig.snapshot.work.find((record) =>
    record.id === queued.id
  )!;
  assert.deepEqual(delivered.intent, queued.intent);
  assert.deepEqual(delivered.wait, queued.wait);
  assert.deepEqual(delivered.counters, queued.counters);
  assert.equal(rig.snapshot.releaseRequests.length, 1);
  assert.equal(rig.snapshot.releaseRequests[0].source.pullRequest, 7);
  assert.equal(delivered.evidence.length, queued.evidence.length + 1);
});
