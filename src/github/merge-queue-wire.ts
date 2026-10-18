/** Strict GraphQL queue reads; partial or foreign responses prove nothing. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type {
  QueueActor,
  QueueAddedEvent,
  QueueEntry,
  QueueEvents,
  QueueInvalidReason,
  QueueMembership,
  QueuePullIdentity,
  QueueRead,
  QueueRemovedEvent,
} from "./merge-queue-types.ts";

class WireError extends Error {
  constructor(readonly reason: QueueInvalidReason) {
    super(reason);
  }
}
export function invalidQueueWire(reason: QueueInvalidReason): never {
  throw new WireError(reason);
}
export function decodeQueueWire<T>(read: () => T): QueueRead<T> {
  try {
    return { status: "complete", value: read() };
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof WireError ? error.reason : "malformed",
    };
  }
}
export function queueObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidQueueWire("malformed");
  }
  return value as Record<string, unknown>;
}
export function queueString(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    return invalidQueueWire("malformed");
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return invalidQueueWire("malformed");
  }
  return value;
}
export function queueInteger(value: unknown, min = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    return invalidQueueWire("malformed");
  }
  return value as number;
}
export function queueSha(value: unknown): GitSha {
  if (!isGitSha(value)) return invalidQueueWire("malformed");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalidQueueWire("malformed");
  return value;
}
function timestamp(value: unknown): number {
  const text = queueString(value, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(text)) {
    return invalidQueueWire("malformed");
  }
  return queueInteger(Date.parse(text), 0);
}
/** Canonical REST spelling for authenticated GraphQL actors; Node/type stay exact. */
export function parseGraphQLQueueActor(value: unknown): QueueActor {
  const row = queueObject(value);
  if (row.__typename !== "Bot" && row.__typename !== "User") {
    return invalidQueueWire("unsupported_actor");
  }
  const login = queueString(row.login, 100);
  if (row.__typename === "User" && /\[bot\]$/i.test(login)) {
    return invalidQueueWire("unsupported_actor");
  }
  let canonicalLogin = login;
  if (row.__typename === "Bot") {
    const slug = login.endsWith("[bot]") ? login.slice(0, -5) : login;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(slug)) {
      return invalidQueueWire("unsupported_actor");
    }
    canonicalLogin = queueString(`${slug}[bot]`, 100);
  }
  return {
    nodeId: queueString(row.id),
    login: canonicalLogin,
    type: row.__typename,
  };
}
function commit(value: unknown): GitSha | null {
  return value === null ? null : queueSha(queueObject(value).oid);
}
export function queueGraphqlData(body: unknown): Record<string, unknown> {
  const envelope = queueObject(body);
  if (
    envelope.errors !== undefined &&
    (!Array.isArray(envelope.errors) || envelope.errors.length !== 0)
  ) {
    return invalidQueueWire("graphql_error");
  }
  return queueObject(envelope.data);
}
function repository(
  value: unknown,
  expected: RepositoryIdentityV1,
): Record<string, unknown> {
  const row = queueObject(value);
  if (
    row.name !== expected.name ||
    queueObject(row.owner).login !== expected.owner
  ) {
    return invalidQueueWire("identity_mismatch");
  }
  return row;
}
export function parseQueuePull(
  value: unknown,
  expected: RepositoryIdentityV1,
): QueuePullIdentity {
  const row = queueObject(value);
  repository(row.repository, expected);
  return {
    repository: expected,
    number: queueInteger(row.number),
    nodeId: queueString(row.id),
    baseRef: queueString(row.baseRefName),
    headRef: queueString(row.headRefName),
    head: queueSha(row.headRefOid),
  };
}
export function sameQueuePull(
  left: QueuePullIdentity,
  right: QueuePullIdentity,
): boolean {
  return left.repository.owner === right.repository.owner &&
    left.repository.name === right.repository.name &&
    left.repository.installationId === right.repository.installationId &&
    left.number === right.number && left.nodeId === right.nodeId &&
    left.baseRef === right.baseRef && left.headRef === right.headRef &&
    left.head === right.head;
}
function samePullId(
  left: QueuePullIdentity,
  right: QueuePullIdentity,
): boolean {
  return left.number === right.number && left.nodeId === right.nodeId;
}
export function parseQueueEntry(
  value: unknown,
  expected: RepositoryIdentityV1,
): QueueEntry {
  const row = queueObject(value);
  const state = row.state;
  if (
    state !== "AWAITING_CHECKS" && state !== "LOCKED" &&
    state !== "MERGEABLE" &&
    state !== "QUEUED" && state !== "UNMERGEABLE"
  ) return invalidQueueWire("malformed");
  return {
    id: queueString(row.id),
    pull: parseQueuePull(row.pullRequest, expected),
    position: queueInteger(row.position),
    state,
    enqueuer: parseGraphQLQueueActor(row.enqueuer),
    enqueuedAt: timestamp(row.enqueuedAt),
    baseCommit: commit(row.baseCommit),
    headCommit: commit(row.headCommit),
    jump: boolean(row.jump),
    solo: boolean(row.solo),
  };
}
export interface QueuePage<T> {
  nodes: readonly T[];
  total: number;
  next: string | null;
}
export function parseQueueConnection<T>(
  value: unknown,
  parse: (value: unknown) => T,
): QueuePage<T> {
  const row = queueObject(value);
  if (!Array.isArray(row.nodes) || row.nodes.length > 100) {
    return invalidQueueWire("malformed");
  }
  const page = queueObject(row.pageInfo);
  const hasNext = boolean(page.hasNextPage);
  const cursor = page.endCursor === null
    ? null
    : queueString(page.endCursor, 1024);
  if (hasNext && (cursor === null || row.nodes.length === 0)) {
    return invalidQueueWire("cursor");
  }
  const total = queueInteger(row.totalCount, 0);
  if (row.nodes.length > total) return invalidQueueWire("malformed");
  return { nodes: row.nodes.map(parse), total, next: hasNext ? cursor : null };
}
export interface QueueSnapshotPage extends QueuePage<QueueEntry> {
  baseTip: GitSha;
  queueId: string | null;
}
export function parseQueueSnapshotPage(
  body: unknown,
  expected: RepositoryIdentityV1,
  baseRef: string,
): QueueRead<QueueSnapshotPage> {
  return decodeQueueWire(() => {
    const repo = repository(queueGraphqlData(body).repository, expected);
    const ref = queueObject(repo.ref);
    if (ref.name !== baseRef) return invalidQueueWire("identity_mismatch");
    const target = queueObject(ref.target);
    if (target.__typename !== "Commit") return invalidQueueWire("malformed");
    const baseTip = queueSha(target.oid);
    if (repo.mergeQueue === null) {
      return { baseTip, queueId: null, nodes: [], total: 0, next: null };
    }
    const queue = queueObject(repo.mergeQueue);
    const page = parseQueueConnection(queue.entries, (value) => {
      const entry = parseQueueEntry(value, expected);
      if (entry.pull.baseRef !== baseRef) {
        return invalidQueueWire("identity_mismatch");
      }
      return entry;
    });
    return { ...page, baseTip, queueId: queueString(queue.id) };
  });
}
export function parseQueueMembership(
  body: unknown,
  expected: QueuePullIdentity,
): QueueRead<QueueMembership> {
  return decodeQueueWire(() => {
    const repo = repository(
      queueGraphqlData(body).repository,
      expected.repository,
    );
    const row = queueObject(repo.pullRequest);
    const pull = parseQueuePull(row, expected.repository);
    if (!samePullId(pull, expected)) {
      return invalidQueueWire("identity_mismatch");
    }
    const entry = row.mergeQueueEntry === null
      ? null
      : parseQueueEntry(row.mergeQueueEntry, expected.repository);
    if (
      boolean(row.isInMergeQueue) !== (entry !== null) ||
      (entry !== null && !sameQueuePull(entry.pull, pull))
    ) return invalidQueueWire("identity_mismatch");
    const merged = boolean(row.merged);
    const mergedRevision = commit(row.mergeCommit);
    if (merged !== (mergedRevision !== null) || (merged && entry !== null)) {
      return invalidQueueWire("identity_mismatch");
    }
    return { pull, entry, mergedRevision };
  });
}
export interface QueueEventPage extends QueueEvents {
  total: number;
  next: string | null;
}
export function parseQueueEventPage(
  body: unknown,
  expected: QueuePullIdentity,
): QueueRead<QueueEventPage> {
  return decodeQueueWire(() => {
    const repo = repository(
      queueGraphqlData(body).repository,
      expected.repository,
    );
    const row = queueObject(repo.pullRequest);
    const pull = parseQueuePull(row, expected.repository);
    if (!sameQueuePull(pull, expected)) {
      return invalidQueueWire("identity_mismatch");
    }
    const added: QueueAddedEvent[] = [];
    const removed: QueueRemovedEvent[] = [];
    const page = parseQueueConnection(row.timelineItems, (value) => {
      const event = queueObject(value);
      const base = {
        id: queueString(event.id),
        at: timestamp(event.createdAt),
        actor: event.actor === null
          ? null
          : parseGraphQLQueueActor(event.actor),
      };
      if (event.__typename === "AddedToMergeQueueEvent") added.push(base);
      else if (event.__typename === "RemovedFromMergeQueueEvent") {
        removed.push({
          ...base,
          beforeCommit: event.beforeCommit === null
            ? null
            : queueSha(queueObject(event.beforeCommit).oid),
          reason: event.reason === null
            ? null
            : queueString(event.reason, 4096),
        });
      } else return invalidQueueWire("malformed");
      return base;
    });
    return { pull, added, removed, total: page.total, next: page.next };
  });
}

const PULL =
  "id number baseRefName headRefName headRefOid repository { name owner { login } }";
// Actor has no `id` field; only its concrete Node types expose one.
export const QUEUE_GRAPHQL_ACTOR_FIELDS =
  "__typename login ... on Bot { id } ... on User { id }";
const ENTRY =
  `id position state enqueuedAt jump solo enqueuer { ${QUEUE_GRAPHQL_ACTOR_FIELDS} } baseCommit { oid } headCommit { oid } pullRequest { ${PULL} }`;
export const QUEUE_SNAPSHOT_QUERY =
  `query($owner:String!,$name:String!,$branch:String!,$ref:String!,$after:String) {
  repository(owner:$owner,name:$name) { name owner { login } ref(qualifiedName:$ref) { name target { __typename oid } }
    mergeQueue(branch:$branch) { id entries(first:100,after:$after) { totalCount pageInfo { hasNextPage endCursor } nodes { ${ENTRY} } } }
  }
}`;
export const QUEUE_MEMBERSHIP_QUERY =
  `query($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { name owner { login } pullRequest(number:$number) { ${PULL} merged mergeCommit { oid } isInMergeQueue mergeQueueEntry { ${ENTRY} } } }
}`;
export const QUEUE_EVENTS_QUERY =
  `query($owner:String!,$name:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$name) { name owner { login } pullRequest(number:$number) { ${PULL}
    timelineItems(first:100,after:$after,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]) { totalCount pageInfo { hasNextPage endCursor } nodes {
      __typename ... on AddedToMergeQueueEvent { id createdAt actor { ${QUEUE_GRAPHQL_ACTOR_FIELDS} } }
      ... on RemovedFromMergeQueueEvent { id createdAt beforeCommit { oid } reason actor { ${QUEUE_GRAPHQL_ACTOR_FIELDS} } }
    } }
  } }
}`;
