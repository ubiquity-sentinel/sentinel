/** Queue-owner CAS/readback, preserving all existing charges and unrelated rows. */
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";
import type { QueueCustodyResult } from "./hosted-autonomy-queue-context.ts";
import { queueProtectedIds } from "./hosted-autonomy-queue-context.ts";

export class QueueCustodyWriter {
  readonly actions: string[] = [];
  private beforeHead: GitSha | null = null;
  private verifiedHead: GitSha | null = null;
  constructor(
    private readonly deps: Pick<HostedAutonomyDepsV1, "state" | "clock">,
    public observed: NonNullable<QueueCustodyResult["observed"]>,
  ) {}

  async update(records: readonly WorkRecordV1[]): Promise<boolean> {
    if (records.length === 0) return true;
    const updates = new Map(records.map((record) => [record.id, record]));
    if (
      updates.size !== records.length ||
      records.some((record) =>
        !this.observed.snapshot.work.some((row) => row.id === record.id)
      )
    ) return false;
    const now = this.deps.clock.now();
    if (!Number.isSafeInteger(now) || now < this.observed.snapshot.updatedAt) {
      return false;
    }
    const { head, snapshot } = this.observed;
    let next: RepairStateSnapshotV1;
    try {
      next = parseRepairStateSnapshotV1({
        ...snapshot,
        stateHead: head,
        sequence: snapshot.sequence + 1,
        updatedAt: now,
        work: snapshot.work.map((row) => updates.get(row.id) ?? row),
      });
    } catch {
      return false;
    }
    const before = await this.deps.state.readRepair();
    if (
      !before.ok || before.value.status !== "found" ||
      before.value.head !== head ||
      canonicalStringify(before.value.snapshot) !== canonicalStringify(snapshot)
    ) return false;
    let written;
    try {
      written = await this.deps.state.writeRepair(next, head);
    } catch {
      return false;
    }
    if (!written.ok || written.value.status !== "applied") return false;
    let after;
    try {
      after = await this.deps.state.readRepair();
    } catch {
      return false;
    }
    if (
      !after.ok || after.value.status !== "found" ||
      after.value.head !== written.value.head ||
      canonicalStringify(after.value.snapshot) !== canonicalStringify(next)
    ) return false;
    this.beforeHead ??= head;
    this.verifiedHead = after.value.head;
    this.observed = { head: after.value.head, snapshot: after.value.snapshot };
    return true;
  }

  result(
    ready: boolean,
    protectedIds: ReadonlySet<string> = new Set(),
  ): QueueCustodyResult {
    const write: HostedAutonomyResultV1 | null = this.verifiedHead === null
      ? null
      : {
        kind: "hosted_autonomy",
        status: "applied",
        reason: "applied",
        beforeHead: this.beforeHead,
        appliedHead: this.verifiedHead,
        actions: this.actions,
        revisions: [],
      };
    return {
      ready,
      observed: this.observed,
      protectedRecordIds: queueProtectedIds(
        this.observed.snapshot,
        protectedIds,
      ),
      actions: this.actions,
      write,
    };
  }
}

export function queueHold(record: WorkRecordV1, now: number): WorkRecordV1 {
  if (record.wait?.reason === "backoff" && record.wait.until === null) {
    return record;
  }
  return {
    ...record,
    wait: { reason: "backoff", since: now, until: null },
    updatedAt: now,
  };
}
