// m05 test-only helpers: a scripted stateful transport over the documented
// Deno REST/health endpoints, a controllable receipt resolver, a test clock,
// and real temporary Git state fixtures. No production state branch is
// created anywhere; every write targets disposable local bare repositories.
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { DeploymentIdentityV1 } from "../../src/contracts/shared.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import { GitStateStore } from "../../src/state/mod.ts";
import type { GitRunnerV1 } from "../../src/state/mod.ts";
import type {
  BuildReceiptLookupV1,
  BuildReceiptResolverV1,
} from "../../src/release/resolver.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { DenoHttpTransportV1 } from "../../src/release/http.ts";
import {
  gitRun,
  makeRemoteCtx,
  releaseRequest,
  REPO,
  SHA1,
  SHA2,
  T0,
  testGitEnv,
} from "../state/helpers.ts";
import { DEP_0, DEP_1, PROJECT_ID } from "./helpers-config.ts";
import type { ScriptedTransport } from "./helpers-transport.ts";
export {
  API_URL,
  BODY_MARKER,
  CUSTOM_URL,
  DEP_0,
  DEP_1,
  DEP_X,
  GIT_SHA_HEADER,
  HEALTH_HEADERS,
  immutableUrl,
  MANAGED_URL,
  PROJECT_ID,
  REVISION_HEADER,
  stabilityPolicy,
  targetConfig,
  TestClock,
} from "./helpers-config.ts";
export {
  type RouteCallV1,
  type RouteResponseV1,
  type RouteV1,
  ScriptedTransport,
} from "./helpers-transport.ts";

export { releaseRequest, REPO, SHA1, SHA2, T0 };

export const REVISIONS_PATH = `/v2/apps/${PROJECT_ID}/revisions`;
export const PROMOTE_RE = /^\/v2\/revisions\/([^/]+)\/promote$/;
export const REVISION_RE = /^\/v2\/revisions\/([^/]+)$/;
export const LOGS_RE = /^\/v2\/apps\/[^/]+\/logs$/;

/**
 * Registers a self-consistent Deno REST contract for `deployments`:
 * revisions list (one page, exact ids, no git/transaction labels — the
 * receipt revision id is the membership selector), and per-revision exact
 * resource routes. The promote route is registered separately through
 * `promoteRoute` so tests can swap its behavior. Callers that exercise the
 * immutable health probe register `transport.health()` too.
 */
export function installREST(
  transport: ScriptedTransport,
  deployments: DeploymentIdentityV1[],
): void {
  transport.revisions = deployments;
  transport.route({
    method: "GET",
    pathname: REVISIONS_PATH,
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

export interface PromoteRouteOptionsV1 {
  /** Reject BEFORE the effect (a transport failure; outcome ambiguous). */
  reject?: boolean;
  /** Apply the effect, then lose the response (promotion ambiguous). */
  lost?: boolean;
}

/**
 * Promote route: applies the effect (flips the deployed identity) and returns
 * 204; `lost` applies the effect then rejects the response; `reject` never
 * applies the effect.
 */
export function promoteRoute(
  transport: ScriptedTransport,
  target: DeploymentIdentityV1,
  options: PromoteRouteOptionsV1 = {},
): void {
  transport.any(
    "POST",
    new RegExp("^/v2/revisions/([^/]+)/promote$"),
    (url) => {
      if (options.reject) return { kind: "reject" };
      const id = /^\/v2\/revisions\/([^/]+)\/promote$/.exec(url.pathname)?.[1];
      const revision = transport.revisions.find((entry) =>
        entry.revisionId === id
      );
      if (revision === undefined) return { kind: "reject" };
      if (options.lost && revision.revisionId !== target.revisionId) {
        return { kind: "reject" };
      }
      transport.deployed = revision;
      if (options.lost) return { kind: "reject" };
      return { kind: "response", status: 204 };
    },
  );
}

/**
 * Routes for a full self-consistent Deno REST contract: revisions list for a
 * fixed set, exact revision resources, timelines, and a promote that applies
 * the effect (flips the deployed identity) and returns 204. Additional routes
 * (health, logs) are registered by the caller.
 */
export interface LogEventV1 {
  requestId: string;
  status?: number;
  deliveryOutcome?: string;
  stream?: boolean | null;
  streamTerminalType?: string | null;
  failureKind?: string | null;
  gitSha: string;
  revisionId: string;
  timestamp: number;
}

function acceptedMessage(event: LogEventV1): string {
  return JSON.stringify({
    request_id: event.requestId,
    route: "route1",
    git_sha: event.gitSha,
    deno_revision: event.revisionId,
  });
}

function terminalMessage(event: LogEventV1): string {
  return JSON.stringify({
    request_id: event.requestId,
    route: "route1",
    status: event.status ?? 200,
    delivery_outcome: event.deliveryOutcome ?? "delivered",
    stream: event.stream ?? null,
    stream_terminal_type: event.streamTerminalType ?? null,
    failure_kind: event.failureKind ?? null,
    git_sha: event.gitSha,
    deno_revision: event.revisionId,
  });
}

export function acceptedEvent(
  event: Partial<LogEventV1> & { requestId: string; timestamp: number } & {
    identity: DeploymentIdentityV1;
  },
): string {
  return `[ai.ubq.fi] request_accepted ${
    acceptedMessage({
      requestId: event.requestId,
      gitSha: event.identity.gitSha,
      revisionId: event.identity.revisionId,
      timestamp: event.timestamp,
    })
  }`;
}

export function terminalEvent(
  event: Partial<LogEventV1> & { requestId: string; timestamp: number } & {
    identity: DeploymentIdentityV1;
  },
): string {
  return `[ai.ubq.fi] request_terminal ${
    terminalMessage({
      requestId: event.requestId,
      gitSha: event.identity.gitSha,
      revisionId: event.identity.revisionId,
      status: event.status ?? 200,
      deliveryOutcome: event.deliveryOutcome ?? "delivered",
      stream: event.stream ?? null,
      streamTerminalType: event.streamTerminalType ?? null,
      failureKind: event.failureKind ?? null,
      timestamp: event.timestamp,
    })
  }`;
}

/**
 * A logs route serving a deterministic cohort for the exact revision +
 * window: `accept` accepted events and `fails` failing terminals (with the
 * given 5xx/timeout/stream/upstream split), plus optional unreadable entries
 * to force incomplete coverage. Failure terminals reference ACCEPTED request
 * ids of the same cohort (the gateway emits one accepted + one terminal per
 * request); `orphanTerminals` adds terminals whose accepted event is outside
 * the window, which must never contribute to the cohort's failure counts.
 */
export function logRoute(
  transport: ScriptedTransport,
  options: {
    accept: number;
    fails?: {
      fiveXx?: number;
      timeout?: number;
      stream?: number;
      upstream?: number;
    };
    /** Failures observed for the PRIOR identity (baseline window). */
    baselineFails?: {
      fiveXx?: number;
      timeout?: number;
      stream?: number;
      upstream?: number;
    };
    /** Terminal events with no accepted event in this window. */
    orphanTerminals?: number;
    /** Revision ids whose log queries must fail (transport rejection). */
    rejectRevisionIds?: string[];
    unreadable?: number;
  },
): void {
  transport.any(
    "GET",
    new RegExp("^/v2/apps/[^/]+/logs$"),
    (url) => {
      if (transport.logsReject) return { kind: "reject" };
      const revisionId = url.searchParams.get("revision_id") ?? "dep-0000";
      if (options.rejectRevisionIds?.includes(revisionId)) {
        return { kind: "reject" };
      }
      const start = Date.parse(url.searchParams.get("start") ?? "0");
      const gitSha = revisionId === DEP_1.revisionId
        ? DEP_1.gitSha
        : DEP_0.gitSha;
      const identity: DeploymentIdentityV1 = { gitSha, revisionId };
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
      const revFailures = revisionId === "dep-0000"
        ? options.baselineFails ?? {}
        : options.fails ?? {};
      const fails = revFailures;
      let failIndex = 0;
      const pushFail = (
        status: number,
        failureKind: string | null,
        stream: boolean | null,
        streamTerminalType: string | null,
      ) => {
        // A failing request is still part of the accepted cohort: its
        // terminal references the accepted request id (the gateway emits one
        // accepted + one terminal per request).
        const requestId = failIndex < options.accept
          ? `${revisionId}-acc-${failIndex}`
          : `${revisionId}-orphan-${failIndex}`;
        logs.push(
          terminalEvent({
            requestId,
            timestamp: start + failIndex,
            identity,
            status,
            failureKind,
            stream,
            streamTerminalType,
          }),
        );
        failIndex++;
      };
      for (let i = 0; i < (fails.fiveXx ?? 0); i++) {
        pushFail(502, null, null, null);
      }
      for (let i = 0; i < (fails.timeout ?? 0); i++) {
        pushFail(200, "upstream_timeout", null, null);
      }
      for (let i = 0; i < (fails.stream ?? 0); i++) {
        pushFail(200, null, true, "error");
      }
      for (let i = 0; i < (fails.upstream ?? 0); i++) {
        pushFail(502, "upstream_error", null, null);
      }
      // Every accepted request has a terminal outcome in the gateway log. The
      // release acceptance contract treats an accepted-only row as incomplete
      // evidence, so emit successful terminals for the remaining requests.
      for (let i = failIndex; i < options.accept; i++) {
        logs.push(
          terminalEvent({
            requestId: `${revisionId}-acc-${i}`,
            timestamp: start + i,
            identity,
            status: 200,
          }),
        );
      }
      for (let i = 0; i < (options.orphanTerminals ?? 0); i++) {
        const requestId = `${revisionId}-outside-${i}`;
        logs.push(
          terminalEvent({
            requestId,
            timestamp: start + i,
            identity,
            status: 502,
          }),
        );
      }
      for (let i = 0; i < (options.unreadable ?? 0); i++) {
        logs.push("[ai.ubq.fi] request_accepted {broken");
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
    },
  );
}

// ---------------------------------------------------------------------------
// Receipt resolver.
// ---------------------------------------------------------------------------

export class ScriptedResolver implements BuildReceiptResolverV1 {
  outcome: PortResultV1<BuildReceiptLookupV1> = portOk({
    status: "found",
    receipt: {
      buildTransactionId: `txn-${DEP_1.revisionId}`,
      identity: DEP_1,
    },
  });

  resolve(): Promise<PortResultV1<BuildReceiptLookupV1>> {
    return Promise.resolve(this.outcome);
  }
}

// ---------------------------------------------------------------------------
// Real temporary Git state fixtures.
// ---------------------------------------------------------------------------

export interface GitCtxV1 {
  tmp: string;
  env: Record<string, string>;
  remoteUrl: string;
  bare: string;
  work: string;
  cleanup(): Promise<void>;
}

export async function makeGitCtx(prefix: string): Promise<GitCtxV1> {
  const here = new URL(import.meta.url);
  if (here.protocol !== "file:") {
    throw new Error("expected a file: test module");
  }
  const root = decodeURIComponent(here.pathname).replace(
    /\/tests\/release\/helpers\.ts$/,
    "",
  );
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-release-test-${prefix}-`,
    dir: root,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  return {
    tmp,
    env,
    remoteUrl: remote.remoteUrl,
    bare: remote.bare,
    work: remote.work,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

export function storeAt(
  ctx: GitCtxV1,
  name: string,
  role: "repair" | "release",
  runner?: GitRunnerV1,
): GitStateStore {
  return new GitStateStore({
    scratchDir: `${ctx.tmp}/scratch-${name}`,
    remoteUrl: ctx.remoteUrl,
    role,
    runner,
  });
}

/**
 * Publishes one open release request onto the repair state branch using the
 * real repair-role store (branch creation + CAS write), and returns the
 * applied head.
 */
export async function publishRepairRequest(
  ctx: GitCtxV1,
  request: ReleaseRequestV1,
): Promise<GitSha> {
  const repair = storeAt(ctx, "repair", "repair");
  const next = {
    version: "v1" as const,
    kind: "repair_state_snapshot" as const,
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [request],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
  const write = await repair.writeRepair(next, null);
  assert.ok(write.ok, "repair request write should succeed");
  if (write.ok) {
    assert.equal(write.value.status, "applied");
    if (write.value.status === "applied") return write.value.head;
  }
  throw new Error("unreachable");
}

export function requestFor(
  id = "release-request-0001",
  overrides: Record<string, unknown> = {},
): ReleaseRequestV1 {
  return parseReleaseRequestV1(
    releaseRequest(id, {
      revision: SHA1,
      source: {
        pullRequest: 1,
        reviewRequestId: "review-req-1",
        reviewReceiptId: null,
        head: SHA1,
        base: SHA2,
      },
      createdAt: T0,
      ...overrides,
    }),
  );
}

export async function remoteHeadJson(
  ctx: GitCtxV1,
  ref: string,
): Promise<string | null> {
  const found = await gitRun(
    ctx.tmp,
    ["--git-dir", ctx.bare, "rev-parse", ref],
    ctx.env,
  );
  if (!found.ok) return null;
  return found.stdout.trim();
}

/** Reads and parses one release record from the release state branch. */
export async function readReleaseRecordsFromStore(
  ctx: GitCtxV1,
): Promise<import("../../src/contracts/release.ts").ReleaseRecordV1[]> {
  const store = storeAt(ctx, "read", "release");
  const read = await store.readRelease();
  if (!read.ok || read.value.status !== "found") return [];
  return read.value.snapshot.releases;
}

export function canonicalRecordText(record: unknown): string {
  return `${canonicalStringify(record)}\n`;
}

/** Wraps a scripted transport into the injected fetch-like function type. */
export function asTransport(t: ScriptedTransport): DenoHttpTransportV1 {
  return (input, init) => t.fetch(input, init);
}
