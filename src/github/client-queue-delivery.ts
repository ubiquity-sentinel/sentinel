import type { GitHubPullRequestV1 } from "../contracts/ports.ts";
import { parsePullWire } from "./wire.ts";
/** Authenticated, read-only native facts for queue guards and delivery proof. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type { QueueTreePatchFact } from "../../ops/hosted-autonomy-queue-proof.ts";
import {
  parseRecursiveTree,
  treeChanges,
} from "../../ops/hosted-autonomy-github-trees.ts";
import { GitHubMergeQueueEvidenceClient } from "./client-merge-queue-evidence.ts";
import { repoPath } from "./client-response.ts";
import { createDeadline, type DeadlineV1 } from "./http.ts";
import type {
  QueueActor,
  QueueMembership,
  QueueRead,
} from "./merge-queue-types.ts";
import {
  decodeQueueWire,
  invalidQueueWire,
  parseQueueMembership,
  parseQueuePull,
  QUEUE_MEMBERSHIP_QUERY,
  queueGraphqlData,
  queueObject,
  queueSha,
  queueString,
} from "./merge-queue-wire.ts";

export interface QueuePullObservation {
  membership: QueueMembership;
  base: GitSha;
  author: string;
  mergedBy: QueueActor | null;
}
export interface QueueCommitObservation {
  sha: GitSha;
  parents: readonly GitSha[];
  author: QueueActor | null;
}
const PULL_FACTS_QUERY = QUEUE_MEMBERSHIP_QUERY.replace(
  "isInMergeQueue",
  "baseRefOid author { login } mergedBy { __typename login ... on Bot { id } ... on User { id } } isInMergeQueue",
);
function actor(value: unknown, graphql = false): QueueActor | null {
  if (value === null) return null;
  const row = queueObject(value);
  const type = graphql ? row.__typename : row.type;
  if (type !== "Bot" && type !== "User") {
    return invalidQueueWire("unsupported_actor");
  }
  return {
    nodeId: queueString(graphql ? row.id : row.node_id),
    login: queueString(row.login, 100),
    type,
  };
}

export class GitHubQueueDeliveryClient extends GitHubMergeQueueEvidenceClient {
  private async bounded<T>(
    until: number,
    run: (deadline: DeadlineV1) => Promise<QueueRead<T>>,
  ): Promise<QueueRead<T>> {
    const remaining = until - this.options.clock.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return { status: "unavailable", reason: "deadline" };
    }
    const deadline = createDeadline(remaining);
    try {
      return await run(deadline);
    } finally {
      deadline.dispose();
    }
  }
  private async json(
    path: string,
    deadline: DeadlineV1,
  ): Promise<QueueRead<unknown>> {
    if (deadline.fired()) return { status: "unavailable", reason: "deadline" };
    const raw = await this.sendCore(
      "GET",
      `${this.apiBaseUrl}/repos/${repoPath(this.repository)}${path}`,
      null,
      undefined,
      deadline,
    );
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
    return decodeQueueWire(() => JSON.parse(raw.response.bodyText));
  }
  /** Exact native identity and membership in one response; no caller-invented node ID. */
  readQueuePull(
    number: number,
    until: number,
  ): Promise<QueueRead<QueuePullObservation>> {
    if (!Number.isSafeInteger(number) || number <= 0) {
      return Promise.resolve({ status: "invalid", reason: "malformed" });
    }
    return this.bounded(until, async (deadline) => {
      const read = await this.queueGraphql(
        PULL_FACTS_QUERY,
        { number },
        deadline,
      );
      if (read.status !== "complete") return read;
      const identity = decodeQueueWire(() => {
        const row = queueObject(
          queueObject(queueGraphqlData(read.value).repository).pullRequest,
        );
        return {
          pull: parseQueuePull(row, this.repository),
          base: queueSha(row.baseRefOid),
          author: queueString(queueObject(row.author).login, 100),
          mergedBy: actor(row.mergedBy, true),
        };
      });
      if (identity.status !== "complete") return identity;
      if (identity.value.pull.number !== number) {
        return { status: "invalid", reason: "identity_mismatch" };
      }
      const membership = parseQueueMembership(read.value, identity.value.pull);
      if (membership.status !== "complete") return membership;
      return {
        status: "complete",
        value: {
          membership: membership.value,
          base: identity.value.base,
          author: identity.value.author,
          mergedBy: identity.value.mergedBy,
        },
      };
    });
  }
  /** REST-only legacy observation: no merge-queue App permission is required. */
  readQueueLegacyPull(
    number: number,
    until: number,
  ): Promise<
    QueueRead<{ pull: GitHubPullRequestV1; mergedBy: QueueActor | null }>
  > {
    if (!Number.isSafeInteger(number) || number <= 0) {
      return Promise.resolve({ status: "invalid", reason: "malformed" });
    }
    return this.bounded(until, async (deadline) => {
      const read = await this.json(`/pulls/${number}`, deadline);
      if (read.status !== "complete") return read;
      return decodeQueueWire(() => {
        const row = queueObject(read.value);
        const pull = parsePullWire(row, "$");
        if (pull.number !== number) {
          return invalidQueueWire("identity_mismatch");
        }
        return { pull, mergedBy: actor(row.merged_by) };
      });
    });
  }
  readQueueCommit(
    revision: GitSha,
    until: number,
  ): Promise<QueueRead<QueueCommitObservation>> {
    if (!isGitSha(revision)) {
      return Promise.resolve({ status: "invalid", reason: "malformed" });
    }
    return this.bounded(until, async (deadline) => {
      const read = await this.json(`/commits/${revision}`, deadline);
      if (read.status !== "complete") return read;
      return decodeQueueWire(() => {
        const row = queueObject(read.value);
        if (
          row.sha !== revision || !Array.isArray(row.parents) ||
          row.parents.length > 16
        ) return invalidQueueWire("identity_mismatch");
        return {
          sha: revision,
          parents: row.parents.map((p) => queueSha(queueObject(p).sha)),
          author: actor(row.author),
        };
      });
    });
  }
  readQueueAncestry(
    ancestor: GitSha,
    descendant: GitSha,
    until: number,
  ): Promise<
    QueueRead<{ ancestor: GitSha; descendant: GitSha; isAncestor: boolean }>
  > {
    if (!isGitSha(ancestor) || !isGitSha(descendant)) {
      return Promise.resolve({ status: "invalid", reason: "malformed" });
    }
    return this.bounded(until, async (deadline) => {
      const read = await this.json(
        `/compare/${ancestor}...${descendant}`,
        deadline,
      );
      if (read.status !== "complete") return read;
      return decodeQueueWire(() => {
        const row = queueObject(read.value);
        if (queueSha(queueObject(row.base_commit).sha) !== ancestor) {
          return invalidQueueWire("identity_mismatch");
        }
        const mergeBase = queueSha(queueObject(row.merge_base_commit).sha);
        if (
          !["ahead", "behind", "diverged", "identical"].includes(
            String(row.status),
          )
        ) return invalidQueueWire("malformed");
        return {
          ancestor,
          descendant,
          isAncestor: mergeBase === ancestor &&
            (row.status === "ahead" || row.status === "identical"),
        };
      });
    });
  }
  readQueuePatch(
    base: GitSha,
    head: GitSha,
    until: number,
  ): Promise<QueueRead<QueueTreePatchFact>> {
    if (!isGitSha(base) || !isGitSha(head)) {
      return Promise.resolve({ status: "invalid", reason: "malformed" });
    }
    return this.bounded(until, async (deadline) => {
      const compare = await this.json(`/compare/${base}...${head}`, deadline);
      if (compare.status !== "complete") return compare;
      const merge = decodeQueueWire(() => {
        const row = queueObject(compare.value);
        if (queueSha(queueObject(row.base_commit).sha) !== base) {
          return invalidQueueWire("identity_mismatch");
        }
        const commit = queueObject(row.merge_base_commit);
        return {
          sha: queueSha(commit.sha),
          tree: queueSha(queueObject(queueObject(commit.commit).tree).sha),
        };
      });
      if (merge.status !== "complete") return merge;
      const commit = await this.json(`/git/commits/${head}`, deadline);
      if (commit.status !== "complete") return commit;
      const headTree = decodeQueueWire(() => {
        const row = queueObject(commit.value);
        if (row.sha !== head) return invalidQueueWire("identity_mismatch");
        return queueSha(queueObject(row.tree).sha);
      });
      if (headTree.status !== "complete") return headTree;
      const before = await this.json(
        `/git/trees/${merge.value.tree}?recursive=1`,
        deadline,
      );
      if (before.status !== "complete") return before;
      const after = await this.json(
        `/git/trees/${headTree.value}?recursive=1`,
        deadline,
      );
      if (after.status !== "complete") return after;
      const beforeTree = parseRecursiveTree(before.value, merge.value.tree);
      const afterTree = parseRecursiveTree(after.value, headTree.value);
      if (beforeTree === null || afterTree === null) {
        return { status: "unavailable", reason: "incomplete" };
      }
      return {
        status: "complete",
        value: {
          base,
          head,
          mergeBase: merge.value.sha,
          changes: treeChanges(beforeTree, afterTree),
        },
      };
    });
  }
  /** Complete fixed workflow bytes at an exact Git revision; no rendered contents API. */
  readQueueWorkflowDigest(
    revision: GitSha,
    until: number,
  ): Promise<
    QueueRead<
      {
        revision: GitSha;
        path: ".github/workflows/deno-deploy.yml";
        sha256: string;
      }
    >
  > {
    if (!isGitSha(revision)) {
      return Promise.resolve({ status: "invalid", reason: "malformed" });
    }
    return this.bounded(until, async (deadline) => {
      const commit = await this.json(`/git/commits/${revision}`, deadline);
      if (commit.status !== "complete") return commit;
      const root = decodeQueueWire(() => {
        const row = queueObject(commit.value);
        if (row.sha !== revision) return invalidQueueWire("identity_mismatch");
        return queueSha(queueObject(row.tree).sha);
      });
      if (root.status !== "complete") return root;
      const tree = await this.json(
        `/git/trees/${root.value}?recursive=1`,
        deadline,
      );
      if (tree.status !== "complete") return tree;
      const entries = parseRecursiveTree(tree.value, root.value);
      if (entries === null) {
        return { status: "unavailable", reason: "incomplete" };
      }
      const path = ".github/workflows/deno-deploy.yml" as const;
      const file = entries.get(path);
      if (file === undefined || !["100644", "100755"].includes(file.mode)) {
        return { status: "unavailable", reason: "incomplete" };
      }
      const blob = await this.json(`/git/blobs/${file.sha}`, deadline);
      if (blob.status !== "complete") return blob;
      const bytes = decodeQueueWire(() => {
        const row = queueObject(blob.value);
        if (
          row.sha !== file.sha || row.encoding !== "base64" ||
          !Number.isSafeInteger(row.size) || (row.size as number) < 0 ||
          (row.size as number) > 256 * 1024 ||
          typeof row.content !== "string" ||
          row.content.length > 360 * 1024
        ) return invalidQueueWire("malformed");
        const encoded = row.content.replace(/\n/g, "");
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
            .test(encoded)
        ) {
          return invalidQueueWire("malformed");
        }
        const raw = atob(encoded);
        if (raw.length !== row.size || btoa(raw) !== encoded) {
          return invalidQueueWire("malformed");
        }
        return Uint8Array.from(raw, (char) => char.charCodeAt(0));
      });
      if (bytes.status !== "complete") return bytes;
      const header = new TextEncoder().encode(`blob ${bytes.value.length}\0`);
      const object = new Uint8Array(header.length + bytes.value.length);
      object.set(header);
      object.set(bytes.value, header.length);
      const hex = (buffer: ArrayBuffer) =>
        Array.from(
          new Uint8Array(buffer),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
      if (hex(await crypto.subtle.digest("SHA-1", object)) !== file.sha) {
        return { status: "invalid", reason: "identity_mismatch" };
      }
      const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes.value));
      if (deadline.fired() || this.options.clock.now() >= until) {
        return { status: "unavailable", reason: "deadline" };
      }
      return { status: "complete", value: { revision, path, sha256 } };
    });
  }
}
