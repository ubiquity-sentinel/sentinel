import {
  CANARY_REPOSITORY,
  type CanaryGrant,
} from "../../ops/queue-canary-pins.ts";
import {
  canaryBindingDigest,
  type CanaryEvidence,
  type CanaryHost,
  type CanaryObservation,
  type CanaryPort,
} from "../../ops/queue-canary.ts";
import { SHA1, SHA2, SHA3, T0 } from "../github/helpers.ts";
export { SHA1, SHA2, SHA3, T0 };
export const ACTOR = {
  nodeId: "BOT_CANARY",
  login: "ubiquity-sentinel[bot]",
  type: "Bot" as const,
};
export const GRANT: CanaryGrant = {
  pull: {
    repository: CANARY_REPOSITORY,
    number: 7,
    nodeId: "PR_CANARY",
    baseRef: "queue-canary",
    headRef: "queue-canary-fixtures/docs-a",
    head: SHA2,
  },
  reviewedBase: SHA1,
  appActor: ACTOR,
  workflowId: 77,
  workflowSha256: "a".repeat(64),
  rulesSha256: "b".repeat(64),
  expectQueueRule: true,
  prior: null,
};
export function observation(): CanaryObservation {
  return {
    complete: true,
    queue: {
      status: "complete",
      value: {
        repository: CANARY_REPOSITORY,
        baseRef: "queue-canary",
        baseTip: SHA1,
        queueId: "MQ_CANARY",
        entries: [],
        observedAt: T0,
      },
    },
    membership: {
      status: "complete",
      value: { pull: GRANT.pull, entry: null, mergedRevision: null },
    },
    events: {
      status: "complete",
      value: { pull: GRANT.pull, added: [], removed: [] },
    },
    facts: { native: true },
    workflowAccepted: true,
    rulesAccepted: true,
    headCiGreen: true,
  };
}
export async function rig() {
  const host: CanaryHost = {
    repository: "Ubiquity-Sentinel/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    sha: SHA3,
    workflowSha: SHA3,
    expectedSha: SHA3,
    runId: 333,
    attempt: 1,
    event: "workflow_dispatch",
    action: "enqueue",
    bindingDigest: await canaryBindingDigest(GRANT),
    mintedAppSlug: "ubiquity-sentinel",
    mintedInstallationId: CANARY_REPOSITORY.installationId,
  };
  const observed = observation();
  const events: string[] = [], retained: CanaryEvidence[] = [];
  let now = T0;
  const port: CanaryPort = {
    identity: () =>
      Promise.resolve({
        appId: 4682172,
        appSlug: "ubiquity-sentinel",
        installationId: CANARY_REPOSITORY.installationId,
        repositoryId: 222,
        actor: ACTOR,
      }),
    observe: () => {
      events.push("observe");
      return Promise.resolve(structuredClone(observed));
    },
    firstDispatch: () => {
      events.push("history");
      return Promise.resolve(true);
    },
    priorAccepted: () => Promise.resolve(true),
    enqueueCanary: () => {
      events.push("enqueue");
      return Promise.resolve({ status: "ambiguous", requestId: null });
    },
    dequeueCanary: () => {
      events.push("dequeue");
      return Promise.resolve({ status: "ambiguous" });
    },
  };
  return {
    host,
    grants: [structuredClone(GRANT)],
    port,
    observed,
    events,
    retained,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    retain: (evidence: CanaryEvidence) => {
      events.push(`retain:${evidence.reason}`);
      retained.push(structuredClone(evidence));
      return Promise.resolve();
    },
  };
}

/** Real native readers consume these HTTP responses; no admission booleans are stubbed. */
export async function nativeObservationFixture(mode: string) {
  const { canonicalStringifySha256 } = await import(
    "../../src/contracts/canonical.ts"
  );
  const { response } = await import("../github/merge-queue-fixtures.ts");
  const workflow = "name: canary-fixture\non: [merge_group]\n";
  const hash = async (algorithm: string, value: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest(algorithm, new TextEncoder().encode(value)),
      ),
    ].map((n) => n.toString(16).padStart(2, "0")).join("");
  const blob = await hash("SHA-1", `blob ${workflow.length}\0${workflow}`);
  const grant = structuredClone(GRANT);
  grant.workflowSha256 = await hash("SHA-256", workflow);
  grant.rulesSha256 = await canonicalStringifySha256([{
    id: null,
    type: "merge_queue",
    name: null,
    rulesetSourceType: null,
    rulesetSource: null,
    rulesetId: 9,
    parameters: null,
  }]);
  const pull = {
    id: grant.pull.nodeId,
    number: grant.pull.number,
    baseRefName: grant.pull.baseRef,
    headRefName: grant.pull.headRef,
    headRefOid: grant.pull.head,
    repository: { name: "ai.ubq.fi", owner: { login: "ubiquity" } },
    merged: false,
    mergeCommit: null,
    isInMergeQueue: false,
    mergeQueueEntry: null,
    baseRefOid: SHA1,
    author: {
      __typename: "User",
      id: "USER_CANARY_OWNER",
      login: "canary-owner",
    },
    mergedBy: null,
  };
  const page = {
    nodes: [],
    totalCount: 0,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  const repository = (data: Record<string, unknown>) => ({
    data: {
      repository: { name: "ai.ubq.fi", owner: { login: "ubiquity" }, ...data },
    },
  });
  const handler = (
    request: import("../../src/github/http.ts").HttpRequestV1,
  ) => {
    const path = new URL(request.url).pathname;
    if (path === "/installation/repositories") {
      return response({
        total_count: 1,
        repositories: [{ id: 222, full_name: "ubiquity/ai.ubq.fi" }],
      });
    }
    if (path === "/apps/ubiquity-sentinel") {
      return response({ id: 4682172, slug: "ubiquity-sentinel" });
    }
    if (path === "/users/ubiquity-sentinel%5Bbot%5D") {
      return response({
        node_id: ACTOR.nodeId,
        login: ACTOR.login,
        type: ACTOR.type,
      });
    }
    if (path === "/graphql") {
      const query = JSON.parse(request.body!).query as string;
      if (query.includes("mergeQueue(branch:")) {
        return mode === "queue_unavailable" ? response({}, 403) : response(
          repository({
            ref: {
              name: "queue-canary",
              target: { __typename: "Commit", oid: SHA1 },
            },
            mergeQueue: { id: "MQ_CANARY", entries: page },
          }),
        );
      }
      if (query.includes("timelineItems")) {
        const result = repository({
          pullRequest: { ...pull, timelineItems: page },
        });
        return response(
          mode === "partial_timeline"
            ? { ...result, errors: [{ message: "synthetic partial timeline" }] }
            : result,
        );
      }
      return response(repository({ pullRequest: pull }));
    }
    if (path.endsWith("/rules/branches/queue-canary")) {
      return mode === "rules_unavailable"
        ? response({}, 503)
        : response([{ type: "merge_queue", ruleset_id: 9 }]);
    }
    if (path.endsWith("/rulesets/9")) {
      return response({
        id: 9,
        name: "canary fixture",
        enforcement: "active",
        current_user_can_bypass: mode === "bypass_unavailable"
          ? undefined
          : "never",
      });
    }
    if (path.endsWith("/actions/workflows/deno-deploy.yml")) {
      return mode === "metadata_unavailable" ? response({}, 404) : response({
        id: 77,
        path: ".github/workflows/deno-deploy.yml",
        state: "active",
      });
    }
    if (path.includes("/git/commits/")) {
      return response({ sha: path.split("/").at(-1), tree: { sha: SHA3 } });
    }
    if (path.includes("/git/trees/")) {
      return response({
        sha: SHA3,
        truncated: mode === "workflow_truncated",
        tree: [{
          path: ".github/workflows/deno-deploy.yml",
          mode: "100644",
          type: "blob",
          sha: blob,
        }],
      });
    }
    if (path.includes("/git/blobs/")) {
      return response({
        sha: blob,
        size: workflow.length,
        encoding: "base64",
        content: btoa(workflow),
      });
    }
    if (path.endsWith("/check-runs")) {
      return mode === "checks_unavailable" ? response({}, 503) : response({
        total_count: 4,
        check_runs: [
          "validate",
          "verify-artifact",
          "darwin-native",
          "mac-containment",
        ].map((name) => ({
          name,
          status: "completed",
          conclusion: mode === "red_ci" ? "failure" : "success",
          head_sha: SHA2,
          started_at: "2026-10-18T00:00:00Z",
          completed_at: "2026-10-18T00:01:00Z",
          app: { id: 15368, slug: "github-actions" },
        })),
      });
    }
    if (path.includes("/compare/")) {
      return mode === "patch_unavailable" ? response({}, 503) : response({
        base_commit: { sha: SHA1 },
        merge_base_commit: { sha: SHA1, commit: { tree: { sha: SHA3 } } },
      });
    }
    throw new Error("unexpected fixture HTTP request");
  };
  return { grant, handler };
}
