import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type {
  QueueAdmission,
  QueueEntry,
  QueueMembership,
  QueueRead,
  QueueSnapshot,
} from "../../src/github/merge-queue-types.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import type { HostedQueueCoordinatorDeps } from "../../ops/hosted-autonomy-queue-contracts.ts";
import { MemoryState } from "../repair/helpers.ts";
import { reservation } from "../state/helpers.ts";
import { PULL, QUEUE_REPO, SHA1, T0 } from "../github/merge-queue-fixtures.ts";
import {
  APP,
  queueAuthorizationFacts,
  queueProofFacts,
} from "./merge-queue-proof-fixtures.ts";

export { APP, PULL, QUEUE_REPO, SHA1, T0 };
export function nativeEntry(): QueueEntry {
  return {
    id: "MQE_7",
    pull: PULL,
    position: 1,
    state: "QUEUED",
    enqueuer: APP,
    enqueuedAt: T0 + 2000,
    baseCommit: SHA1,
    headCommit: null,
    jump: false,
    solo: false,
  };
}
export async function orchestrationRig() {
  const proof = await queueProofFacts();
  const state = new MemoryState();
  state.repairHead = SHA1;
  state.repair = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [proof.record],
    reviews: [proof.receipt],
    reservations: [
      reservation("charged", {
        taskId: proof.record.id,
        repository: QUEUE_REPO,
        outcome: "ambiguous",
        settledAt: T0,
      }),
    ],
    releaseRequests: [],
    replays: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  let now = T0 + 2000;
  let member: QueueRead<QueueMembership> = {
    status: "complete",
    value: { pull: PULL, entry: null, mergedRevision: null },
  };
  let scan: QueueRead<QueueSnapshot> = {
    status: "complete",
    value: {
      repository: QUEUE_REPO,
      baseRef: "development",
      baseTip: SHA1,
      queueId: "MQ_1",
      entries: [],
      observedAt: now,
    },
  };
  let rules: QueueRead<boolean> = { status: "complete", value: false };
  let admission: QueueAdmission = {
    status: "pending",
    requestId: "c8bde880-3b8a-4f84-8036-d30a43cf7c12",
  };
  const calls: string[] = [];
  const auth = await queueAuthorizationFacts();
  let onEnqueue = () => {};
  const queue: HostedQueueCoordinatorDeps = {
    repository: QUEUE_REPO,
    config: {
      mode: "off",
      proofActivated: true,
      appActor: APP,
      probation: true,
    },
    readEffectiveQueueRule: () => {
      calls.push("rules");
      return Promise.resolve(rules);
    },
    surface: {
      readQueue: () => {
        calls.push("queue");
        return Promise.resolve(scan);
      },
      readPullMembership: () => {
        calls.push("membership");
        return Promise.resolve(member);
      },
      readPullEvidence: () =>
        Promise.resolve({ status: "unavailable", reason: "unsupported" }),
      enqueue: () => {
        calls.push("enqueue");
        onEnqueue();
        return Promise.resolve(admission);
      },
      poll: (_pull, requestId) => {
        calls.push("poll");
        return Promise.resolve({
          status: "complete",
          value: { status: "pending", requestId },
        });
      },
      dequeue: () => {
        calls.push("dequeue");
        return Promise.resolve({ status: "submitted" });
      },
    },
    authorization: {
      readAuthorization: (request) => {
        calls.push("authorization");
        return Promise.resolve({
          status: "complete",
          value: {
            binding: request.binding ?? proof.binding,
            pull: PULL,
            facts: auth,
          },
        });
      },
      readRemoval: () =>
        Promise.resolve({ status: "unavailable", reason: "unsupported" }),
    },
  };
  const deps: HostedAutonomyDepsV1 = {
    state,
    queue,
    clock: { now: () => now },
    githubFor: () => null,
  };
  // The runner's release gate sees a terminal, immutable healthy-runtime fixture.
  state.setRelease({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  });
  return {
    proof,
    state,
    deps,
    queue,
    calls,
    auth,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    member: (value: typeof member) => {
      member = value;
    },
    scan: (value: typeof scan) => {
      scan = value;
    },
    rules: (value: typeof rules) => {
      rules = value;
    },
    admission: (value: QueueAdmission) => {
      admission = value;
    },
    onEnqueue: (value: () => void) => {
      onEnqueue = value;
    },
    join: (entry = nativeEntry()) => {
      member = {
        status: "complete",
        value: { pull: PULL, entry, mergedRevision: null },
      };
      scan = {
        status: "complete",
        value: {
          repository: QUEUE_REPO,
          baseRef: "development",
          baseTip: SHA1,
          queueId: "MQ_1",
          entries: [entry],
          observedAt: now,
        },
      };
    },
    leave: () => {
      member = {
        status: "complete",
        value: { pull: PULL, entry: null, mergedRevision: null },
      };
      scan = {
        status: "complete",
        value: {
          repository: QUEUE_REPO,
          baseRef: "development",
          baseTip: SHA1,
          queueId: "MQ_1",
          entries: [],
          observedAt: now,
        },
      };
    },
  };
}
