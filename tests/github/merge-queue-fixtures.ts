/** Synthetic queue/API fixtures; no network, state writes or credentials. */
import type { GitHubApiClientOptionsV1 } from "../../src/github/client-contracts.ts";
import { GitHubMergeQueueClient } from "../../src/github/client-merge-queue.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import type { QueuePullIdentity } from "../../src/github/merge-queue-types.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  SHA1,
  SHA2,
  SHA3,
  T0,
} from "./helpers.ts";

export { SHA1, SHA2, SHA3, T0 };
export const QUEUE_REPO = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 42,
};
export const PULL: QueuePullIdentity = {
  repository: QUEUE_REPO,
  number: 7,
  nodeId: "PR_7",
  baseRef: "development",
  headRef: "sentinel/repair/issue-1",
  head: SHA2,
};
export const REQUEST_ID = "c8bde880-3b8a-4f84-8036-d30a43cf7c12";
export function pullWire(overrides: Record<string, unknown> = {}) {
  return {
    id: PULL.nodeId,
    number: PULL.number,
    baseRefName: PULL.baseRef,
    headRefName: PULL.headRef,
    headRefOid: PULL.head,
    repository: { name: QUEUE_REPO.name, owner: { login: QUEUE_REPO.owner } },
    ...overrides,
  };
}
export function entryWire(overrides: Record<string, unknown> = {}) {
  return {
    id: "MQE_7",
    position: 1,
    state: "QUEUED",
    enqueuedAt: new Date(T0).toISOString(),
    enqueuer: {
      __typename: "Bot",
      id: "BOT_7",
      login: "ubiquity-sentinel[bot]",
    },
    baseCommit: { oid: SHA1 },
    headCommit: { oid: SHA3 },
    jump: false,
    solo: false,
    pullRequest: pullWire(),
    ...overrides,
  };
}
export function pageWire(
  nodes: unknown[],
  totalCount = nodes.length,
  next: string | null = null,
) {
  return {
    nodes,
    totalCount,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
  };
}
export function repositoryWire(extra: Record<string, unknown>) {
  return {
    data: {
      repository: {
        name: QUEUE_REPO.name,
        owner: { login: QUEUE_REPO.owner },
        ...extra,
      },
    },
  };
}
export function snapshotWire(
  nodes: unknown[] | null = [entryWire()],
  total?: number,
  next: string | null = null,
  base = SHA1,
) {
  return repositoryWire({
    ref: { name: "development", target: { __typename: "Commit", oid: base } },
    mergeQueue: nodes === null
      ? null
      : { id: "MQ_1", entries: pageWire(nodes, total, next) },
  });
}
export function membershipWire(
  entry: unknown | null = entryWire(),
  overrides: Record<string, unknown> = {},
) {
  return repositoryWire({
    pullRequest: {
      ...pullWire(),
      merged: false,
      mergeCommit: null,
      isInMergeQueue: entry !== null,
      mergeQueueEntry: entry,
      ...overrides,
    },
  });
}
export function eventWire(
  type = "AddedToMergeQueueEvent",
  id = "EV_1",
  overrides: Record<string, unknown> = {},
) {
  return {
    __typename: type,
    id,
    createdAt: new Date(T0).toISOString(),
    actor: { __typename: "Bot", id: "BOT_7", login: "ubiquity-sentinel[bot]" },
    ...(type === "RemovedFromMergeQueueEvent"
      ? { reason: "synthetic reason", beforeCommit: { oid: SHA2 } }
      : {}),
    ...overrides,
  };
}
export function eventsWire(
  nodes: unknown[],
  total?: number,
  next: string | null = null,
) {
  return repositoryWire({
    pullRequest: { ...pullWire(), timelineItems: pageWire(nodes, total, next) },
  });
}
export function pendingWire(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    details: {
      message: "synthetic pending",
      uuid: REQUEST_ID,
      merge_method: "default",
      merge_action: "merge_queue",
      expected_head_sha: SHA2,
      bypass_rules: false,
      ...overrides,
    },
  };
}
export function response(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponseV1 {
  return {
    status,
    headers: new Headers(headers),
    bodyText: JSON.stringify(value),
  };
}
export function queueClient(
  replies: readonly (HttpResponseV1 | Error)[],
  overrides: Partial<GitHubApiClientOptionsV1> = {},
) {
  const requests: HttpRequestV1[] = [];
  const auth = new FakeAuthProvider();
  const cooldown = new FakeCooldownGate();
  const options: GitHubApiClientOptionsV1 = {
    repository: QUEUE_REPO,
    apiBaseUrl: "https://api.github.com",
    clock: new FakeClock(),
    auth,
    cooldownGate: cooldown,
    ...overrides,
    http: (request) => {
      const reply = replies[requests.length];
      requests.push(request);
      if (reply instanceof Error) return Promise.reject(reply);
      if (reply === undefined) {
        return Promise.reject(new Error("unexpected synthetic request"));
      }
      return Promise.resolve(reply);
    },
  };
  const client = new GitHubMergeQueueClient(options);
  return { client, requests, auth, cooldown, options };
}
