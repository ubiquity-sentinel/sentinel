/** Credential-free repair planning. Hosted scheduling remains a trusted concern. */
import type { GitSha } from "../contracts/brands.ts";
import {
  assertRepairDeltaScope,
  type RepairDeltaPlanV1,
  sameRepairRepository,
  signRepairDelta,
} from "../contracts/repair-delta.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { OPERATION_MARGIN_MS } from "../repair/loop-bounds.ts";

/** Trusted preparation calls this once after its batched state read. */
export function planRepairFanout(input: {
  runId: string;
  head: GitSha;
  snapshot: RepairStateSnapshotV1;
  repositories: readonly RepositoryIdentityV1[];
  runDeadline: number;
}): RepairDeltaPlanV1[] {
  const plans: RepairDeltaPlanV1[] = [];
  for (const repository of input.repositories) {
    if (
      plans.some((plan) => sameRepairRepository(plan.repository, repository))
    ) {
      throw new Error("duplicate repair repository");
    }
    const records = input.snapshot.work.filter((record) =>
      record.nextStep !== "done" &&
      sameRepairRepository(record.repository, repository)
    );
    if (records.length === 0) continue;
    plans.push(structuredClone({
      runId: input.runId,
      baseHead: input.head,
      repository,
      runDeadline: input.runDeadline,
      records,
    }));
  }
  return plans;
}

/** No state transport/ref, App key, model or GitHub writer crosses this API. */
export async function runRepairDeltaCell(input: {
  plan: RepairDeltaPlanV1;
  clock: { now(): number };
  compute: (input: {
    repository: RepositoryIdentityV1;
    records: readonly WorkRecordV1[];
    runDeadline: number;
    operationDeadline: number;
  }) => Promise<WorkRecordV1[]>;
  sign: (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;
}): Promise<string> {
  // Neither a planner nor a yielding compute port can mutate the signed binding.
  const plan = structuredClone(input.plan);
  const startedAt = input.clock.now();
  const operationDeadline = plan.runDeadline - OPERATION_MARGIN_MS;
  if (!(startedAt < operationDeadline)) {
    throw new Error("repair cell has no operation margin remaining");
  }
  const changes = await input.compute(structuredClone({
    repository: plan.repository,
    records: plan.records,
    runDeadline: plan.runDeadline,
    operationDeadline,
  }));
  const completedAt = input.clock.now();
  if (!(completedAt < operationDeadline)) {
    throw new Error("repair cell exceeded shared run deadline");
  }
  assertRepairDeltaScope(plan, changes);
  return signRepairDelta({
    version: "v1",
    kind: "repair_delta",
    runId: plan.runId,
    baseHead: plan.baseHead,
    repository: plan.repository,
    runDeadline: plan.runDeadline,
    startedAt,
    completedAt,
    changes,
  }, input.sign);
}
