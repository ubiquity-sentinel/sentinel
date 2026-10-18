/** Authenticated, paginated native issue/PR relationships; URL text is never a link. */
import { canonicalStringify } from "../contracts/canonical.ts";
import { GitHubQueueDeliveryClient } from "./client-queue-delivery.ts";
import { repoPath } from "./client-response.ts";
import { createDeadline, type DeadlineV1 } from "./http.ts";
import type { QueueRead } from "./merge-queue-types.ts";
import { decodeQueueWire } from "./merge-queue-wire.ts";
import {
  type AssociationPage,
  ISSUE_PULL_ASSOCIATIONS_QUERY,
  type NativeAssociationPull,
  type NativeIssueIdentity,
  type NativeIssuePullAssociations,
  type NativePullClosingIssues,
  parseAssociationPullRest,
  parseIssuePullPage,
  parsePullClosingPage,
  PULL_CLOSING_ISSUES_QUERY,
} from "./pr-association-wire.ts";

export class GitHubPrAssociationsClient extends GitHubQueueDeliveryClient {
  private expired(until: number, deadline?: DeadlineV1): boolean {
    return !Number.isSafeInteger(until) || this.options.clock.now() >= until ||
      deadline?.fired() === true;
  }
  private async associationRead<T>(
    number: number,
    until: number,
    run: (deadline: DeadlineV1) => Promise<QueueRead<T>>,
  ): Promise<QueueRead<T>> {
    if (!Number.isSafeInteger(number) || number <= 0) {
      return { status: "invalid", reason: "malformed" };
    }
    if (this.expired(until)) {
      return { status: "unavailable", reason: "deadline" };
    }
    const deadline = createDeadline(until - this.options.clock.now());
    try {
      const result = await run(deadline);
      return this.expired(until, deadline)
        ? { status: "unavailable", reason: "deadline" }
        : result;
    } catch {
      return { status: "unavailable", reason: "transport" };
    } finally {
      deadline.dispose();
    }
  }
  private async associationPages<P, T extends NativeIssueIdentity>(
    number: number,
    until: number,
    deadline: DeadlineV1,
    query: string,
    parse: (input: unknown) => AssociationPage<P, T>,
  ): Promise<QueueRead<{ parent: P; nodes: T[] }>> {
    let after: string | null = null;
    let parent: P | undefined;
    let total: number | undefined;
    const cursors = new Set<string>(),
      ids = new Set<string>(),
      numbers = new Set<string>();
    const nodes: T[] = [];
    const maxPages = Math.min(this.maxPages, 64),
      maxItems = Math.min(this.maxItems, 4096);
    for (let count = 0; count < maxPages; count++) {
      if (this.expired(until, deadline)) {
        return { status: "unavailable", reason: "deadline" };
      }
      const raw = await this.queueGraphql(query, { number, after }, deadline);
      if (this.expired(until, deadline)) {
        return { status: "unavailable", reason: "deadline" };
      }
      if (raw.status !== "complete") return raw;
      const decoded = decodeQueueWire(() => parse(raw.value));
      if (decoded.status !== "complete") return decoded;
      const page = decoded.value;
      if (page.total > maxItems) {
        return { status: "unavailable", reason: "resource_bound" };
      }
      if (
        parent !== undefined &&
        (canonicalStringify(parent) !== canonicalStringify(page.parent) ||
          total !== page.total)
      ) {
        return { status: "unavailable", reason: "drift" };
      }
      parent = page.parent;
      total = page.total;
      for (const node of page.nodes) {
        const key =
          `${node.repository.owner}/${node.repository.name}#${node.number}`;
        if (ids.has(node.nodeId) || numbers.has(key)) {
          return { status: "invalid", reason: "duplicate" };
        }
        ids.add(node.nodeId);
        numbers.add(key);
        nodes.push(node);
      }
      if (nodes.length > total || nodes.length > maxItems) {
        return { status: "invalid", reason: "malformed" };
      }
      if (page.next === null) {
        return nodes.length === total
          ? { status: "complete", value: { parent, nodes } }
          : { status: "unavailable", reason: "incomplete" };
      }
      if (cursors.has(page.next) || nodes.length >= total) {
        return { status: "invalid", reason: "cursor" };
      }
      cursors.add(page.next);
      after = page.next;
    }
    return { status: "unavailable", reason: "resource_bound" };
  }
  readIssuePullAssociations(
    number: number,
    until: number,
  ): Promise<QueueRead<NativeIssuePullAssociations>> {
    return this.associationRead(number, until, async (deadline) => {
      const read = await this.associationPages(
        number,
        until,
        deadline,
        ISSUE_PULL_ASSOCIATIONS_QUERY,
        (raw) => parseIssuePullPage(raw, this.repository, number),
      );
      return read.status === "complete"
        ? {
          status: "complete",
          value: { issue: read.value.parent, pulls: read.value.nodes },
        }
        : read;
    });
  }
  readPullClosingIssues(
    number: number,
    until: number,
  ): Promise<QueueRead<NativePullClosingIssues>> {
    return this.associationRead(number, until, async (deadline) => {
      const read = await this.associationPages(
        number,
        until,
        deadline,
        PULL_CLOSING_ISSUES_QUERY,
        (raw) => parsePullClosingPage(raw, this.repository, number),
      );
      return read.status === "complete"
        ? {
          status: "complete",
          value: { pull: read.value.parent, issues: read.value.nodes },
        }
        : read;
    });
  }
  readAssociationPull(
    number: number,
    until: number,
  ): Promise<QueueRead<NativeAssociationPull>> {
    return this.associationRead(number, until, async (deadline) => {
      const raw = await this.sendCore(
        "GET",
        `${this.apiBaseUrl}/repos/${repoPath(this.repository)}/pulls/${number}`,
        null,
        undefined,
        deadline,
      );
      if (this.expired(until, deadline)) {
        return { status: "unavailable", reason: "deadline" };
      }
      if (raw.status !== "response") {
        return {
          status: "unavailable",
          reason: raw.status === "error" && raw.error.kind === "auth_failed"
            ? "auth"
            : raw.status === "error" && raw.error.kind === "rate_limited"
            ? "rate_limited"
            : "transport",
        };
      }
      if (raw.response.status !== 200) {
        return {
          status: "unavailable",
          reason: raw.response.status === 401
            ? "auth"
            : raw.response.status === 403
            ? "permission"
            : raw.response.status === 404
            ? "not_found"
            : "http",
        };
      }
      return decodeQueueWire(() =>
        parseAssociationPullRest(
          JSON.parse(raw.response.bodyText),
          this.repository,
          number,
        )
      );
    });
  }
}
