/** Shared repair-state fixtures for the parked-candidate maintenance tests. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  portOk,
  type PortResultV1,
  type RepairStateWriter,
  type StateReadResultV1,
  type StateReadView,
  type StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { validateRepairTransition } from "../../src/state/state-repair-transition.ts";
import { healthyProof, releaseSnapshot } from "./hosted-autonomy-rig.ts";
import { SHA1, T0 } from "../state/helpers.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  darkQueueCoordinatorFixture,
  darkQueueFixture,
  historicalDarkQueueFixture,
} from "./hosted-autonomy-dark-queue-fixture.ts";

/** Explicit offline no-rule authority; unexpected native queue effects still fail. */
export async function withDarkQueueAuthority(
  deps: HostedAutonomyDepsV1,
): Promise<HostedAutonomyDepsV1> {
  return {
    ...deps,
    queueCustody: darkQueueFixture(deps),
    queue: await darkQueueCoordinatorFixture(deps),
  };
}

/** Historical direct grants are valid only in an explicitly dormant policy graph. */
export async function withHistoricalQueueAuthority(
  deps: HostedAutonomyDepsV1,
): Promise<HostedAutonomyDepsV1> {
  const custody = historicalDarkQueueFixture(deps);
  return {
    ...deps,
    queueCustody: custody,
    queue: await darkQueueCoordinatorFixture(deps, custody),
  };
}

export function snapshotOf(
  records: WorkRecordV1[],
  reservations: unknown[],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 5,
    updatedAt: T0 + 1000,
    incidents: [],
    evidence: [],
    work: records,
    reservations,
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

/** Expected-head CAS with the real store's snapshot and transition rules. */
export class TransitionState
  implements
    Pick<StateReadView, "readRepair" | "readRelease">,
    RepairStateWriter {
  head = "1".repeat(40) as GitSha;
  writes = 0;
  constructor(
    public snapshot: RepairStateSnapshotV1,
    private readonly release: ReleaseStateSnapshotV1 = releaseSnapshot(),
  ) {}
  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    return Promise.resolve(portOk({
      status: "found",
      snapshot: this.release,
      head: SHA1,
      ref: null,
    }));
  }
  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    return Promise.resolve(portOk({
      status: "found",
      snapshot: structuredClone(this.snapshot),
      head: this.head,
      ref: null,
    }));
  }
  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.writes++;
    if (expectedHead !== this.head || next.stateHead !== this.head) {
      return Promise.resolve(
        portOk({ status: "conflict", currentHead: this.head }),
      );
    }
    const parsed = parseRepairStateSnapshotV1(structuredClone(next));
    assert.equal(parsed.sequence, this.snapshot.sequence + 1);
    assert.equal(validateRepairTransition(this.snapshot, parsed), null);
    this.snapshot = parsed;
    this.head = (this.writes.toString(16).padStart(2, "0")).repeat(
      20,
    ) as GitSha;
    return Promise.resolve(portOk({ status: "applied", head: this.head }));
  }
}

/** One settled ordinary execution of an exact runtime pointer. */
export interface SettlementFixture {
  revision: string;
  generation: number;
  createdAt: number;
  observedAt: number;
}

/** A healthy run proof for one exact ordinary execution. */
export function settlementProof(row: SettlementFixture) {
  const proof = healthyProof(row.revision, row.generation, "unused");
  return {
    ...proof,
    execution: {
      ...proof.execution,
      id: `${row.createdAt}:1:repair`,
      runId: row.createdAt,
      purpose: "ordinary",
      releaseId: null,
      createdAt: row.createdAt,
    },
    startedAt: row.createdAt + 100,
    finishedAt: row.createdAt + 200,
    terminalAt: row.createdAt + 200,
    observedAt: row.observedAt,
  };
}

/**
 * The release custody with the hosted runtime pointer at one exact revision
 * and generation, carrying the given last healthy and last settled proofs.
 */
export function releaseAt(input: {
  revision: string;
  generation: number;
  healthy?: SettlementFixture | null;
  settled?: SettlementFixture | null;
}): ReleaseStateSnapshotV1 {
  const release = releaseSnapshot();
  const healthy = input.healthy ? settlementProof(input.healthy) : null;
  const settled = input.settled ? settlementProof(input.settled) : healthy;
  return parseReleaseStateSnapshotV1({
    ...release,
    hostedRuntimes: release.hostedRuntimes.map((row) => ({
      ...row,
      activeRevision: input.revision,
      generation: input.generation,
      lastHealthyProof: healthy,
      lastExecutionProof: input.settled === null ? null : settled,
      createdAt: T0 - 1_000_000,
      nextOrdinaryAt: T0 - 1_000_000,
      updatedAt: T0 - 1_000_000,
    })),
  });
}
