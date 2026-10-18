/** Concrete authenticated client over synthetic HTTP; no live network access. */
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import {
  createQueueDeliveryReader,
  type QueueDeliveryReaderOptions,
} from "../../src/github/queue-delivery-reader.ts";
import {
  APP,
  GROUP_BOT,
  POLICY,
  queueProofFacts,
  SHA4,
} from "../host/merge-queue-proof-fixtures.ts";
import {
  checkRunWire,
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  issueWire,
} from "./helpers.ts";
import {
  eventsWire,
  eventWire,
  membershipWire,
  QUEUE_REPO,
  response,
  SHA1,
  SHA2,
  SHA3,
  T0,
} from "./merge-queue-fixtures.ts";

export const BEFORE_TREE = "5".repeat(40) as GitSha;
export const AFTER_TREE = "6".repeat(40) as GitSha;
export const UNTIL = T0 + 60_000;
export const WORKFLOW_PATH = ".github/workflows/deno-deploy.yml";
export const WORKFLOW_BYTES = "name: accepted queue workflow\n";
export const WORKFLOW_BLOB =
  "6f80c26ad35f821fe4a111013fc9e57cbe659d28" as GitSha;
export const WORKFLOW_SHA256 =
  "0391b50c65e7a868dac81ca038f3c2265f1dab342aec011fc415822194bbe53f";
export function pullFactsWire(overrides: Record<string, unknown> = {}) {
  return membershipWire(null, {
    baseRefOid: SHA1,
    author: { login: APP.login },
    mergedBy: {
      __typename: GROUP_BOT.type,
      id: GROUP_BOT.nodeId,
      login: GROUP_BOT.login,
    },
    merged: true,
    mergeCommit: { oid: SHA4 },
    ...overrides,
  });
}
export function commitWire(overrides: Record<string, unknown> = {}) {
  return {
    sha: SHA4,
    parents: [{ sha: SHA3 }, { sha: SHA2 }],
    author: { type: APP.type, node_id: APP.nodeId, login: APP.login },
    ...overrides,
  };
}
export function compareWire(base = SHA1, mergeBase = base, status = "ahead") {
  return {
    base_commit: { sha: base },
    merge_base_commit: {
      sha: mergeBase,
      commit: { tree: { sha: BEFORE_TREE } },
    },
    status,
  };
}
export function treeWire(sha: GitSha, rows: unknown[], truncated = false) {
  return { sha, tree: rows, truncated };
}
export function blob(path: string, sha: GitSha, mode = "100644") {
  return { path, sha, mode, type: mode === "160000" ? "commit" : "blob" };
}
export function deliveryClient(
  replies: readonly HttpResponseV1[],
  workflowId: number | null = 84,
) {
  const requests: HttpRequestV1[] = [];
  const clock = new FakeClock();
  const auth = new FakeAuthProvider();
  const client = new GitHubQueueDeliveryClient({
    repository: QUEUE_REPO,
    apiBaseUrl: "https://api.github.com",
    clock,
    auth,
    cooldownGate: new FakeCooldownGate(),
    http: (request) => {
      const reply = replies[requests.length];
      requests.push(request);
      if (reply === undefined) {
        return Promise.reject(new Error("Unexpected synthetic request"));
      }
      return Promise.resolve(reply);
    },
  }, workflowId);
  return { client, requests, clock, auth };
}
export type Intercept = (
  request: HttpRequestV1,
  matchingCall: number,
) => HttpResponseV1 | undefined;
export async function readerFixture(input: {
  intercept?: Intercept;
  options?: Partial<
    Pick<QueueDeliveryReaderOptions, "policy" | "provenance" | "directWitness">
  >;
  workflowId?: number | null;
} = {}) {
  const facts = await queueProofFacts();
  if (facts.task === null || facts.task === "unavailable") {
    throw new Error("Fixture task missing");
  }
  const task = facts.task;
  const snapshot: RepairStateSnapshotV1 = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: SHA1,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [facts.record],
    reservations: [],
    reviews: [facts.receipt],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
  const requests: HttpRequestV1[] = [];
  const counts = new Map<string, number>();
  const clock = new FakeClock(T0 + 2000);
  const auth = new FakeAuthProvider();
  const client = new GitHubQueueDeliveryClient({
    repository: QUEUE_REPO,
    apiBaseUrl: "https://api.github.com",
    clock,
    auth,
    cooldownGate: new FakeCooldownGate(),
    http: (request) => {
      requests.push(request);
      const url = new URL(request.url);
      const path = url.pathname.replace("/repos/ubiquity/ai.ubq.fi", "");
      const query = request.body === null
        ? ""
        : String(JSON.parse(request.body).query ?? "");
      const key = path === "/graphql" ? query : path;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      const overridden = input.intercept?.(request, count);
      if (overridden !== undefined) return Promise.resolve(overridden);
      let body: unknown;
      if (path === "/issues/1") {
        body = issueWire({ ...task, number: task.issueNumber });
      } else if (path === "/graphql") {
        body = query.includes("timelineItems")
          ? eventsWire([eventWire()])
          : pullFactsWire();
      } else if (path.endsWith("/check-runs")) {
        body = {
          total_count: 4,
          check_runs: [
            "validate",
            "verify-artifact",
            "darwin-native",
            "mac-containment",
          ].map((name, index) =>
            checkRunWire({
              id: 90 + index,
              name,
              head_sha: path.includes("check-suites") ? SHA4 : SHA2,
              check_suite: { id: 85 },
              app: { id: 15368, slug: "github-actions" },
            })
          ),
        };
      } else if (path.endsWith("/statuses")) body = [];
      else if (path === `/commits/${SHA4}`) body = commitWire();
      else if (path === "/git/ref/heads/development") {
        body = {
          ref: "refs/heads/development",
          object: { type: "commit", sha: SHA4 },
        };
      } else if (path.startsWith("/compare/")) {
        const [base, head] = path.slice("/compare/".length).split("...") as [
          GitSha,
          GitSha,
        ];
        body = compareWire(base, base, base === head ? "identical" : "ahead");
      } else if (path.startsWith("/git/commits/")) {
        body = {
          sha: path.slice("/git/commits/".length),
          tree: { sha: AFTER_TREE },
        };
      } else if (path === `/git/trees/${BEFORE_TREE}`) {
        body = treeWire(BEFORE_TREE, [
          blob("src/fix.ts", SHA1),
          blob(WORKFLOW_PATH, WORKFLOW_BLOB),
        ]);
      } else if (path === `/git/trees/${AFTER_TREE}`) {
        body = treeWire(AFTER_TREE, [
          blob("src/fix.ts", SHA2),
          blob(WORKFLOW_PATH, WORKFLOW_BLOB),
        ]);
      } else if (path === `/git/blobs/${WORKFLOW_BLOB}`) {
        body = {
          sha: WORKFLOW_BLOB,
          encoding: "base64",
          size: WORKFLOW_BYTES.length,
          content: btoa(WORKFLOW_BYTES),
        };
      } else if (path === "/actions/workflows/84/runs") {
        body = {
          total_count: 1,
          workflow_runs: [{
            id: 83,
            run_attempt: 1,
            head_sha: SHA4,
            event: "merge_group",
            workflow_id: 84,
            path: ".github/workflows/deno-deploy.yml",
            check_suite_id: 85,
            status: "completed",
            conclusion: "success",
            repository: {
              name: QUEUE_REPO.name,
              owner: { login: QUEUE_REPO.owner },
            },
          }],
        };
      } else {return Promise.reject(
          new Error(`Unexpected synthetic path ${path}`),
        );}
      return Promise.resolve(response(body));
    },
  }, input.workflowId === undefined ? 84 : input.workflowId);
  const reader = createQueueDeliveryReader({
    repository: QUEUE_REPO,
    client,
    clock,
    policy: POLICY,
    ...input.options,
  });
  return {
    facts,
    snapshot,
    client,
    clock,
    requests,
    auth,
    reader,
    request: {
      record: facts.record,
      snapshot,
      receipt: facts.receipt,
      currentTask: task,
      revision: SHA4,
      now: clock.now(),
      deadline: UNTIL,
    },
  };
}
