/**
 * Private in-memory fork of one repository's hot repair state (issue #328).
 *
 * A fan-out repository pass runs the ordinary step loop against this fork
 * instead of the shared state store: the fork answers reads with the planned
 * base snapshot (only the repository's own work records) and applies the
 * loop's expected-head writes to its own memory under private synthetic
 * heads. Nothing it holds is ever written to the shared store; the trusted
 * writer later receives only the bounded delta built from it. Release reads
 * delegate to the read-only view the fork was created over.
 */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  portError,
  portOk,
  type PortResultV1,
  type StateReadResultV1,
  type StateReadView,
  type StateWriteResultV1,
} from "../contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";

type RepairStateDepsV1 = RepairCycleDepsV1["state"];

export interface RepairForkCheckpointV1 {
  snapshot: RepairStateSnapshotV1;
  head: GitSha;
}

const FORK_REF = "refs/heads/sentinel-state/repair";

export class RepairForkState implements RepairStateDepsV1 {
  private snapshot: RepairStateSnapshotV1;
  private currentHead: GitSha;
  private issued = 0;
  /** Every synthetic head this fork issued; none may leave the fork. */
  readonly syntheticHeads = new Set<string>();
  /** Record ids the pass no longer steps; reads leave them out. */
  readonly hidden = new Set<string>();
  writes = 0;
  readonly readHostedRelease?: StateReadView["readHostedRelease"];
  readonly readLocalRelease?: StateReadView["readLocalRelease"];

  constructor(
    base: RepairForkCheckpointV1,
    private readonly view: StateReadView,
  ) {
    this.snapshot = base.snapshot;
    this.currentHead = base.head;
    if (view.readHostedRelease !== undefined) {
      this.readHostedRelease = (request) => view.readHostedRelease!(request);
    }
    if (view.readLocalRelease !== undefined) {
      this.readLocalRelease = (request) => view.readLocalRelease!(request);
    }
  }

  /** A fresh head that cannot collide with a real or an earlier fork head. */
  private nextHead(): GitSha {
    this.issued++;
    const head = ("f0" + this.issued.toString(16)).padEnd(40, "0") as GitSha;
    this.syntheticHeads.add(head);
    return head;
  }

  get head(): GitSha {
    return this.currentHead;
  }

  checkpoint(): RepairForkCheckpointV1 {
    return { snapshot: this.snapshot, head: this.currentHead };
  }

  /**
   * Return to `checkpoint` under a NEW head, so a context still holding a
   * head issued after the checkpoint can never write over the restored state.
   */
  restore(checkpoint: RepairForkCheckpointV1): void {
    this.snapshot = checkpoint.snapshot;
    this.currentHead = this.nextHead();
  }

  /**
   * Replace existing rows of the current snapshot under a NEW head (the pass
   * keeps settled stamps an interval it discarded had folded in).
   */
  amend(rows: readonly WorkRecordV1[]): void {
    if (rows.length === 0) return;
    const replacements = new Map(rows.map((row) => [row.id, row]));
    this.snapshot = {
      ...this.snapshot,
      work: this.snapshot.work.map((row) => replacements.get(row.id) ?? row),
    };
    this.currentHead = this.nextHead();
  }

  /** The fork's current snapshot including hidden rows (delta building). */
  current(): RepairStateSnapshotV1 {
    return this.snapshot;
  }

  private visible(): RepairStateSnapshotV1 {
    if (this.hidden.size === 0) return this.snapshot;
    return {
      ...this.snapshot,
      work: this.snapshot.work.filter((record) => !this.hidden.has(record.id)),
    };
  }

  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    return Promise.resolve(portOk({
      status: "found",
      snapshot: this.visible(),
      head: this.currentHead,
      ref: FORK_REF,
    }));
  }

  readRelease(): ReturnType<StateReadView["readRelease"]> {
    return this.view.readRelease();
  }

  /**
   * Expected-head compare-and-swap on the fork, with the shared store's
   * sequence rule. Rows the pass hid stay hidden: a write that omits them
   * keeps them as they were, so a later checkpoint never loses them.
   */
  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    if (expectedHead !== this.currentHead) {
      return Promise.resolve(portOk({
        status: "conflict",
        currentHead: this.currentHead,
      }));
    }
    let parsed: RepairStateSnapshotV1;
    try {
      parsed = parseRepairStateSnapshotV1(next);
    } catch {
      return Promise.resolve(portError("invalid", "invalid fork snapshot"));
    }
    if (parsed.sequence !== this.snapshot.sequence + 1) {
      return Promise.resolve(portOk({
        status: "conflict",
        currentHead: this.currentHead,
      }));
    }
    const kept = this.snapshot.work.filter((record) =>
      this.hidden.has(record.id) &&
      !parsed.work.some((row) => row.id === record.id)
    );
    this.snapshot = kept.length === 0 ? parsed : {
      ...parsed,
      work: [...parsed.work, ...kept].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      ),
    };
    this.currentHead = this.nextHead();
    this.writes++;
    return Promise.resolve(
      portOk({ status: "applied", head: this.currentHead }),
    );
  }

  /** True when `value` carries any head this fork issued. */
  leaksSyntheticHead(value: unknown): boolean {
    const text = canonicalStringify(value);
    for (const head of this.syntheticHeads) {
      if (text.includes(head)) return true;
    }
    return false;
  }
}
