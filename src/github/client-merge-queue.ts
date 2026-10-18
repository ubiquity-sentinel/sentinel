/** Repository-scoped queue capability, using the existing auth/cooldown path. */
import { isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { GitHubApiClient } from "./client.ts";
import type { RawSendResult } from "./client-contracts.ts";
import { repoPath } from "./client-response.ts";
import { createDeadline, type DeadlineV1 } from "./http.ts";
import type {
  QueueAdmission,
  QueueDequeue,
  QueueEntry,
  QueueEvents,
  QueueMembership,
  QueueOperation,
  QueuePullIdentity,
  QueueRead,
  QueueSnapshot,
  QueueUnavailableReason,
} from "./merge-queue-types.ts";
import {
  decodeQueueWire,
  parseQueueEventPage,
  parseQueueMembership,
  parseQueueSnapshotPage,
  QUEUE_EVENTS_QUERY,
  QUEUE_MEMBERSHIP_QUERY,
  QUEUE_SNAPSHOT_QUERY,
  queueGraphqlData,
  queueObject,
  sameQueuePull,
} from "./merge-queue-wire.ts";
import {
  isQueueRequestId,
  parseQueueAdmission,
  parseQueueOperation,
  queueEnqueueBody,
  queueMutationAllowed,
} from "./merge-queue-protocol.ts";

function rawUnavailable(
  raw: Exclude<RawSendResult, { status: "response" }>,
): QueueUnavailableReason {
  if (raw.status === "lost") return "transport";
  return raw.error.kind === "auth_failed"
    ? "auth"
    : raw.error.kind === "rate_limited"
    ? "rate_limited"
    : raw.error.kind === "not_found"
    ? "not_found"
    : "transport";
}
function safeBranch(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return false;
  }
  return true;
}

/** Expose only queue methods to queue consumers, not this class's inherited ports. */
export class GitHubMergeQueueClient extends GitHubApiClient {
  private validPull(pull: QueuePullIdentity): boolean {
    return pull.repository.owner === this.repository.owner &&
      pull.repository.name === this.repository.name &&
      pull.repository.installationId === this.repository.installationId &&
      Number.isSafeInteger(pull.number) && pull.number > 0 &&
      typeof pull.nodeId === "string" && pull.nodeId.length > 0 &&
      pull.nodeId.length <= 256 &&
      safeBranch(pull.baseRef) && safeBranch(pull.headRef) &&
      isGitSha(pull.head);
  }

  protected async queueGraphql(
    query: string,
    variables: Record<string, unknown>,
    deadline: DeadlineV1,
  ): Promise<QueueRead<unknown>> {
    if (deadline.fired()) return { status: "unavailable", reason: "deadline" };
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/graphql`,
      {
        query,
        variables: {
          owner: this.repository.owner,
          name: this.repository.name,
          ...variables,
        },
      },
      undefined,
      deadline,
    );
    if (raw.status !== "response") {
      return { status: "unavailable", reason: rawUnavailable(raw) };
    }
    if (raw.response.status !== 200) {
      const reason = raw.response.status === 403
        ? "permission"
        : raw.response.status === 401
        ? "auth"
        : raw.response.status === 404
        ? "not_found"
        : "http";
      return { status: "unavailable", reason };
    }
    return decodeQueueWire(() => {
      const body: unknown = JSON.parse(raw.response.bodyText);
      queueGraphqlData(body);
      return body;
    });
  }

  private async scanQueue(
    baseRef: string,
    deadline: DeadlineV1,
  ): Promise<QueueRead<QueueSnapshot>> {
    const entries: QueueEntry[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    const prs = new Set<number>();
    const positions = new Set<number>();
    let cursor: string | null = null;
    let first: {
      baseTip: QueueSnapshot["baseTip"];
      queueId: string | null;
      total: number;
    } | null = null;
    for (let page = 0; page < this.maxPages; page++) {
      const read = await this.queueGraphql(QUEUE_SNAPSHOT_QUERY, {
        branch: baseRef,
        ref: `refs/heads/${baseRef}`,
        after: cursor,
      }, deadline);
      if (read.status !== "complete") return read;
      const parsed = parseQueueSnapshotPage(
        read.value,
        this.repository,
        baseRef,
      );
      if (parsed.status !== "complete") return parsed;
      const value = parsed.value;
      if (first === null) first = value;
      else if (
        first.baseTip !== value.baseTip || first.queueId !== value.queueId ||
        first.total !== value.total
      ) {
        return { status: "unavailable", reason: "drift" };
      }
      if (
        value.total > this.maxItems ||
        entries.length + value.nodes.length > this.maxItems
      ) {
        return { status: "unavailable", reason: "resource_bound" };
      }
      for (const entry of value.nodes) {
        if (
          ids.has(entry.id) || prs.has(entry.pull.number) ||
          positions.has(entry.position)
        ) {
          return { status: "invalid", reason: "duplicate" };
        }
        ids.add(entry.id);
        prs.add(entry.pull.number);
        positions.add(entry.position);
        entries.push(entry);
      }
      if (value.next === null) {
        if (entries.length !== value.total) {
          return { status: "unavailable", reason: "incomplete" };
        }
        entries.sort((left, right) => left.position - right.position);
        return {
          status: "complete",
          value: {
            repository: this.repository,
            baseRef,
            baseTip: value.baseTip,
            queueId: value.queueId,
            entries,
            observedAt: this.options.clock.now(),
          },
        };
      }
      if (cursors.has(value.next)) {
        return { status: "invalid", reason: "cursor" };
      }
      cursors.add(value.next);
      cursor = value.next;
    }
    return { status: "unavailable", reason: "resource_bound" };
  }

  /** Two complete identical reads detect inter-page changes; guards still recheck effects. */
  async readQueue(baseRef: string): Promise<QueueRead<QueueSnapshot>> {
    if (!safeBranch(baseRef)) return { status: "invalid", reason: "malformed" };
    const deadline = createDeadline(this.requestDeadlineMs);
    try {
      const first = await this.scanQueue(baseRef, deadline);
      if (first.status !== "complete") return first;
      const second = await this.scanQueue(baseRef, deadline);
      if (second.status !== "complete") return second;
      const stable = (value: QueueSnapshot) =>
        canonicalStringify({ ...value, observedAt: 0 });
      return stable(first.value) === stable(second.value)
        ? second
        : { status: "unavailable", reason: "drift" };
    } finally {
      deadline.dispose();
    }
  }

  protected async queueMembership(
    pull: QueuePullIdentity,
    deadline: DeadlineV1,
  ): Promise<QueueRead<QueueMembership>> {
    const read = await this.queueGraphql(QUEUE_MEMBERSHIP_QUERY, {
      number: pull.number,
    }, deadline);
    return read.status === "complete"
      ? parseQueueMembership(read.value, pull)
      : read;
  }
  async readPullMembership(
    pull: QueuePullIdentity,
  ): Promise<QueueRead<QueueMembership>> {
    if (!this.validPull(pull)) {
      return { status: "invalid", reason: "identity_mismatch" };
    }
    const deadline = createDeadline(this.requestDeadlineMs);
    try {
      return await this.queueMembership(pull, deadline);
    } finally {
      deadline.dispose();
    }
  }

  private async scanEvents(
    pull: QueuePullIdentity,
    deadline: DeadlineV1,
  ): Promise<QueueRead<QueueEvents>> {
    const added: QueueEvents["added"][number][] = [];
    const removed: QueueEvents["removed"][number][] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let total: number | null = null;
    for (let page = 0; page < this.maxPages; page++) {
      const read = await this.queueGraphql(QUEUE_EVENTS_QUERY, {
        number: pull.number,
        after: cursor,
      }, deadline);
      if (read.status !== "complete") return read;
      const parsed = parseQueueEventPage(read.value, pull);
      if (parsed.status !== "complete") return parsed;
      const value = parsed.value;
      if (total !== null && total !== value.total) {
        return { status: "unavailable", reason: "drift" };
      }
      total = value.total;
      if (total > this.maxItems) {
        return { status: "unavailable", reason: "resource_bound" };
      }
      for (const event of [...value.added, ...value.removed]) {
        if (ids.has(event.id)) {
          return { status: "invalid", reason: "duplicate" };
        }
        ids.add(event.id);
      }
      added.push(...value.added);
      removed.push(...value.removed);
      if (ids.size > this.maxItems) {
        return { status: "unavailable", reason: "resource_bound" };
      }
      if (value.next === null) {
        return ids.size === total
          ? { status: "complete", value: { pull, added, removed } }
          : { status: "unavailable", reason: "incomplete" };
      }
      if (cursors.has(value.next)) {
        return { status: "invalid", reason: "cursor" };
      }
      cursors.add(value.next);
      cursor = value.next;
    }
    return { status: "unavailable", reason: "resource_bound" };
  }
  async readPullQueueEvents(
    pull: QueuePullIdentity,
  ): Promise<QueueRead<QueueEvents>> {
    if (!this.validPull(pull)) {
      return { status: "invalid", reason: "identity_mismatch" };
    }
    const deadline = createDeadline(this.requestDeadlineMs);
    try {
      const first = await this.scanEvents(pull, deadline);
      if (first.status !== "complete") return first;
      const second = await this.scanEvents(pull, deadline);
      if (second.status !== "complete") return second;
      return canonicalStringify(first.value) ===
          canonicalStringify(second.value)
        ? second
        : { status: "unavailable", reason: "drift" };
    } finally {
      deadline.dispose();
    }
  }

  async enqueue(pull: QueuePullIdentity): Promise<QueueAdmission> {
    if (!this.validPull(pull) || !queueMutationAllowed(pull)) {
      return { status: "not_submitted", reason: "unsupported" };
    }
    const raw = await this.sendCore(
      "PUT",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/pulls/${pull.number}/merge-async`,
      queueEnqueueBody(pull),
    );
    if (raw.status === "response") {
      return parseQueueAdmission(raw.response, pull);
    }
    if (
      raw.status === "error" &&
      (raw.error.kind === "auth_failed" || raw.error.kind === "rate_limited")
    ) {
      return { status: "not_submitted", reason: rawUnavailable(raw) };
    }
    return { status: "ambiguous", requestId: null };
  }

  async poll(
    pull: QueuePullIdentity,
    requestId: string,
  ): Promise<QueueRead<QueueOperation>> {
    if (!this.validPull(pull) || !isQueueRequestId(requestId)) {
      return { status: "invalid", reason: "identity_mismatch" };
    }
    const raw = await this.sendCore(
      "GET",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/pulls/${pull.number}/merge-async/${requestId}`,
      null,
    );
    return raw.status === "response"
      ? parseQueueOperation(raw.response, pull, requestId)
      : { status: "unavailable", reason: rawUnavailable(raw) };
  }

  async dequeue(
    input: { pull: QueuePullIdentity; entryId: string },
  ): Promise<QueueDequeue> {
    const { pull, entryId } = input;
    if (
      !this.validPull(pull) || !queueMutationAllowed(pull) ||
      typeof entryId !== "string" || entryId.length === 0 ||
      entryId.length > 256
    ) {
      return { status: "not_submitted", reason: "unsupported" };
    }
    const deadline = createDeadline(this.requestDeadlineMs);
    try {
      const before = await this.queueMembership(pull, deadline);
      if (before.status !== "complete") {
        return { status: "not_submitted", reason: "incomplete" };
      }
      if (
        !sameQueuePull(before.value.pull, pull) ||
        before.value.entry?.id !== entryId ||
        before.value.entry.enqueuer.login !== "ubiquity-sentinel[bot]" ||
        before.value.entry.enqueuer.type !== "Bot"
      ) return { status: "not_submitted", reason: "drift" };
      const raw = await this.sendCore(
        "POST",
        `${this.apiBaseUrl}/graphql`,
        {
          query:
            "mutation($id:ID!) { dequeuePullRequest(input:{id:$id}) { mergeQueueEntry { id } } }",
          variables: { id: pull.nodeId },
        },
        undefined,
        deadline,
      );
      if (raw.status !== "response" || raw.response.status !== 200) {
        return { status: "ambiguous" };
      }
      const parsed = decodeQueueWire(() =>
        queueObject(
          queueObject(
            queueGraphqlData(JSON.parse(raw.response.bodyText))
              .dequeuePullRequest,
          ).mergeQueueEntry,
        ).id
      );
      if (parsed.status !== "complete" || parsed.value !== entryId) {
        return { status: "ambiguous" };
      }
      const after = await this.queueMembership(pull, deadline);
      return after.status === "complete" &&
          sameQueuePull(after.value.pull, pull) && after.value.entry === null
        ? { status: "submitted" }
        : { status: "ambiguous" };
    } finally {
      deadline.dispose();
    }
  }
}
