import type { GitSha } from "../../src/contracts/brands.ts";
import assert from "node:assert/strict";
import {
  acceptedEvent,
  asTransport,
  DEP_0,
  promoteRoute,
  ScriptedTransport,
  stabilityPolicy,
  storeAt,
  targetConfig,
  terminalEvent,
  TestClock,
} from "../release/helpers.ts";
import { type makeIntegrationCtx, REPO, T0 } from "./helpers.ts";
import type { ReleaseEntrypointDepsV1 } from "../../src/release-main.ts";
import type { ReleaseHostOptionsV1 } from "../../src/host/release.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import type { ReleaseCycleResultV1 } from "../../src/release/controller.ts";
import type { ReleaseRecordV1 } from "../../src/contracts/release.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { composeReleaseHost } from "../../src/host/release.ts";
import { runReleaseEntrypoint } from "../../src/release-main.ts";

/** Immutable fixture truth (see tests/fixtures/release/build-receipt-upload-v1.json). */
const RECEIPT_FIXTURE = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../fixtures/release/build-receipt-upload-v1.json",
      import.meta.url,
    ),
  ),
) as {
  producerCommit: string;
  workflowBlobSha: string;
  archiveSize: number;
  archiveDigest: string;
  archiveBase64: string;
};

export const PRODUCER_COMMIT = RECEIPT_FIXTURE.producerCommit as GitSha;
const WORKFLOW_SHA = RECEIPT_FIXTURE.workflowBlobSha as GitSha;
const ARCHIVE_BYTES = Uint8Array.from(
  atob(RECEIPT_FIXTURE.archiveBase64),
  (character) => character.charCodeAt(0),
);
const ARCHIVE_SIZE = RECEIPT_FIXTURE.archiveSize;
const ARCHIVE_DIGEST = RECEIPT_FIXTURE.archiveDigest;

const REPO_FULL = "ubiquity/ai.ubq.fi";
const REPO_ID = 111;
const WORKFLOW_ID = 9999;
const RUN_ID = 12345;
const ATTEMPT = 2;
const BASE_BRANCH = "development";
const STORAGE_URL =
  "https://objects.githubusercontent.com/github-production-release-asset/123/zip?X-Amz-Signature=deadbeef";
const ARTIFACT_ID = 9001;
const TARGET_NAME = `sentinel-build-receipt-${RUN_ID}-${ATTEMPT}`;
export const ISSUE1_REVISION_ID = "synthetic-r123";

// ---------------------------------------------------------------------------
// Composed release host fixture (fixture-bound receipt wire + scripted Deno).
// ---------------------------------------------------------------------------

function jsonBody(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface ScriptedFetchV1 {
  fetchImpl: typeof globalThis.fetch;
  calls: { url: URL }[];
}

function scriptedFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): ScriptedFetchV1 {
  const calls: { url: URL }[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url });
    return Promise.resolve(handler(url, init ?? {}));
  };
  return { fetchImpl: fetchImpl as typeof globalThis.fetch, calls };
}

function prPayload(number: number, revision: GitSha, head: GitSha) {
  return {
    number,
    state: "closed",
    merged: true,
    merge_commit_sha: revision,
    head: { sha: head },
    base: {
      ref: BASE_BRANCH,
      sha: "3".repeat(40),
      repo: { id: REPO_ID, full_name: REPO_FULL },
    },
  };
}

function runItem(revision: GitSha) {
  return {
    id: RUN_ID,
    run_attempt: ATTEMPT,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: revision,
    head_branch: BASE_BRANCH,
    workflow_id: WORKFLOW_ID,
    repository: { id: REPO_ID, full_name: REPO_FULL },
    head_repository: { id: REPO_ID, full_name: REPO_FULL },
  };
}

function receiptArtifact() {
  return {
    id: ARTIFACT_ID,
    name: TARGET_NAME,
    size_in_bytes: ARCHIVE_SIZE,
    digest: ARCHIVE_DIGEST,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: {
      id: RUN_ID,
      repository_id: REPO_ID,
      head_repository_id: REPO_ID,
      head_sha: PRODUCER_COMMIT,
      head_branch: BASE_BRANCH,
    },
  };
}

/**
 * Fixture-bound GitHub build-receipt wire. PR 7 (issue one, the fixture
 * producer commit) resolves the immutable receipt; PR 8 (issue two, the toy
 * candidate commit) has no matching push run for its revision, which is the
 * typed "absent" result (never a fabricated receipt).
 */
function receiptFetchHandler(
  toyCandidateSha: GitSha,
): (url: URL) => Response {
  return (url) => {
    const path = url.pathname;
    const revision = url.searchParams.get("head_sha") ??
      url.searchParams.get("ref") ?? "";
    if (path.endsWith("/pulls/7")) {
      return jsonBody(prPayload(7, PRODUCER_COMMIT, PRODUCER_COMMIT));
    }
    if (path.endsWith("/pulls/8")) {
      return jsonBody(prPayload(8, toyCandidateSha, toyCandidateSha));
    }
    if (path.endsWith("/contents/.github/workflows/deno-deploy.yml")) {
      return jsonBody({
        type: "file",
        path: ".github/workflows/deno-deploy.yml",
        sha: WORKFLOW_SHA,
      });
    }
    if (path.endsWith("/actions/workflows/deno-deploy.yml")) {
      return jsonBody({
        id: WORKFLOW_ID,
        path: ".github/workflows/deno-deploy.yml",
        name: "deno-deploy",
      });
    }
    if (/\/workflows\/[0-9]+\/runs$/.test(path)) {
      if (revision === PRODUCER_COMMIT) {
        return jsonBody({
          total_count: 1,
          workflow_runs: [runItem(PRODUCER_COMMIT)],
        });
      }
      return jsonBody({ total_count: 0, workflow_runs: [] });
    }
    if (path.endsWith(`/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`)) {
      return jsonBody(runItem(PRODUCER_COMMIT));
    }
    if (path.endsWith(`/actions/runs/${RUN_ID}/artifacts`)) {
      return jsonBody({ total_count: 1, artifacts: [receiptArtifact()] });
    }
    if (path.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
      return new Response(null, {
        status: 302,
        headers: { location: STORAGE_URL },
      });
    }
    if (path.endsWith("/github-production-release-asset/123/zip")) {
      return new Response(ARCHIVE_BYTES as BodyInit, { status: 200 });
    }
    if (path.endsWith(`/actions/runs/${RUN_ID}`)) {
      return jsonBody(runItem(PRODUCER_COMMIT));
    }
    assert.fail(`unexpected GitHub wire call: ${url.href}`);
  };
}

/** Stable deployment identities for the scripted Deno platform. */
function deployIdentity(
  revisionId: string,
  gitSha: GitSha,
): { gitSha: GitSha; revisionId: string } {
  return { gitSha, revisionId };
}

const PRIOR_IDENTITY = deployIdentity(DEP_0.revisionId, DEP_0.gitSha);
const ISSUE1_IDENTITY = deployIdentity(
  ISSUE1_REVISION_ID,
  PRODUCER_COMMIT,
);

/**
 * Real release host options over the shared ctx: release-role real Git state,
 * real DenoReleaseRESTClient over the scripted platform, and — when
 * `withResolver` — the authenticated fixture-bound resolver (the ONLY
 * authentic receipt available in this harness).
 */
export function makeReleaseRig(
  ctx: Awaited<ReturnType<typeof makeIntegrationCtx>>,
  toyCandidateSha: GitSha,
  withResolver: boolean,
): {
  clock: TestClock;
  transport: ScriptedTransport;
  wire: ScriptedFetchV1;
  deps: ReleaseEntrypointDepsV1;
  options: ReleaseHostOptionsV1;
  run(): Promise<PortResultV1<ReleaseCycleResultV1>>;
  records(): Promise<ReleaseRecordV1[]>;
  promoteCalls(): number;
} {
  const config = targetConfig({ projectId: "ai-ubq-fi" });
  const transport = new ScriptedTransport(config);
  registerREST(transport, [PRIOR_IDENTITY, ISSUE1_IDENTITY]);
  transport.health();
  integrationLogRoute(transport, { accept: 100, fiveXx: 1 });
  promoteRoute(transport, ISSUE1_IDENTITY, {});
  const clock = new TestClock(T0);
  const store = storeAt(ctx, "composed-release", "release");
  const wire = scriptedFetch(receiptFetchHandler(toyCandidateSha));
  const resolver = withResolver
    ? {
      repository: REPO,
      environment: "production" as const,
      project: "ai-ubq-fi",
      baseBranch: BASE_BRANCH,
      workflowBlobSha: WORKFLOW_SHA,
      auth: {
        authorizationHeader: () => Promise.resolve(portOk("Bearer test-token")),
      },
      fetch: wire.fetchImpl,
      timeoutMs: 10_000,
    }
    : undefined;
  const options: ReleaseHostOptionsV1 = {
    clock,
    stateRead: store,
    stateWrite: store,
    repository: REPO,
    environment: "production",
    target: config,
    policy: stabilityPolicy(),
    deno: {
      transport: asTransport(transport),
      auth: {
        bearerToken: () => Promise.resolve(portOk("synthetic-token")),
      },
    },
    resolver,
  };
  const deps = composeReleaseHost(options);
  return {
    clock,
    transport,
    wire,
    deps,
    options,
    // The production release entrypoint waits on real 30-second timers.
    // Inject the trusted host's clock-advancing waiter (the exact existing
    // integration-helper pattern) so the complete 60×30s monitoring window
    // is exercised deterministically through the real entrypoint without a
    // 30-minute wall-clock run.
    run: () =>
      runReleaseEntrypoint({
        ...deps,
        wait: (durationMs) => {
          clock.advance(durationMs);
          return Promise.resolve();
        },
      }),
    records: async () => {
      const read = await store.readRelease();
      if (!read.ok || read.value.status !== "found") return [];
      return read.value.snapshot.releases;
    },
    promoteCalls: () =>
      transport.callCount("POST", /^\/v2\/revisions\/[^/]+\/promote$/),
  };
}

/** Exact self-consistent Deno REST contract for the composed project id. */
function registerREST(
  transport: ScriptedTransport,
  deployments: readonly { gitSha: GitSha; revisionId: string }[],
): void {
  transport.revisions = [...deployments];
  transport.route({
    method: "GET",
    pathname: "/v2/apps/ai-ubq-fi/revisions",
    respond: (url) => {
      if (url.searchParams.get("status") !== "succeeded") {
        return { kind: "reject" };
      }
      return {
        kind: "response",
        status: 200,
        body: JSON.stringify(
          deployments.map((identity) => ({
            id: identity.revisionId,
            status: "succeeded",
            labels: { "custom.branch": "main" },
            created_at: "2026-09-07T00:00:00.000Z",
          })),
        ),
      };
    },
  });
  for (const identity of deployments) {
    transport.route({
      method: "GET",
      pathname: `/v2/revisions/${identity.revisionId}`,
      respond: () => ({
        kind: "response",
        status: 200,
        body: JSON.stringify({
          id: identity.revisionId,
          status: "succeeded",
          labels: { "custom.branch": "main" },
        }),
      }),
    });
  }
}

/**
 * Exact revision-id → identity log cohort (the m05 module route only knows
 * the DEP_0/DEP_1 pair; this integration must serve the exact fixture-bound
 * revision ids or every window sample would be incomplete).
 */
function integrationLogRoute(
  transport: ScriptedTransport,
  options: { accept: number; fiveXx: number },
): void {
  const byRevisionId = new Map([
    [PRIOR_IDENTITY.revisionId, PRIOR_IDENTITY],
    [ISSUE1_IDENTITY.revisionId, ISSUE1_IDENTITY],
  ]);
  transport.any("GET", new RegExp("^/v2/apps/[^/]+/logs$"), (url) => {
    const revisionId = url.searchParams.get("revision_id") ?? "dep-0000";
    const start = Date.parse(url.searchParams.get("start") ?? "0");
    const identity = byRevisionId.get(revisionId) ?? PRIOR_IDENTITY;
    const logs: string[] = [];
    for (let i = 0; i < options.accept; i++) {
      logs.push(
        acceptedEvent({
          requestId: `${revisionId}-acc-${i}`,
          timestamp: start + i,
          identity,
        }),
      );
    }
    const failures = identity === PRIOR_IDENTITY ? 0 : options.fiveXx;
    for (let i = 0; i < failures; i++) {
      logs.push(
        terminalEvent({
          requestId: `${revisionId}-acc-${i}`,
          timestamp: start + i,
          identity,
          status: 502,
        }),
      );
    }
    for (let i = failures; i < options.accept; i++) {
      logs.push(
        terminalEvent({
          requestId: `${revisionId}-acc-${i}`,
          timestamp: start + i,
          identity,
          status: 200,
        }),
      );
    }
    return {
      kind: "response",
      status: 200,
      body: JSON.stringify({
        logs: logs.map((message, index) => ({
          timestamp: new Date(start + index).toISOString(),
          level: "info",
          message,
          revision_id: revisionId,
        })),
        next_cursor: null,
      }),
    };
  });
}
