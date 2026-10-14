// Bounded receipt fixture and scripted GitHub transports; registers no tests.
import assert from "node:assert/strict";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import {
  GithubBuildReceiptResolver,
  type GithubBuildReceiptResolverAuthV1,
} from "../../src/release/build-receipt-resolver.ts";
import type { BuildReceiptLookupV1 } from "../../src/release/resolver.ts";

export const fixture = JSON.parse(
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
  receipt: {
    repository: string;
    run_id: string;
    run_attempt: string;
    workflow_ref: string;
    git_sha: string;
    project: string;
    revision_id: string;
    build_transaction_id: string;
  };
};

export function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const REVISION = fixture.producerCommit as GitSha; // 79ca71...
export const WORKFLOW_SHA = fixture.workflowBlobSha as GitSha; // 24d741...
export const ARCHIVE_BYTES = decodeBase64(fixture.archiveBase64);
export const ARCHIVE_SIZE = fixture.archiveSize; // 404
export const ARCHIVE_DIGEST = fixture.archiveDigest; // sha256:a598...

export const REPO_FULL = "ubiquity/ai.ubq.fi";
export const REPO_ID = 111;
export const WORKFLOW_ID = 9999;
export const RUN_ID = 12345;
export const ATTEMPT = 2;
export const PR_NUMBER = 321;
export const HEAD_SHA = "1111111111111111111111111111111111111111" as GitSha;
export const BASE_BRANCH = "development";
export const NOW_MS = 1_700_000_000_000;
export const EXPIRES_AT = "2099-01-01T00:00:00Z";
export const STORAGE_URL =
  "https://objects.githubusercontent.com/github-production-release-asset/123/zip?X-Amz-Signature=deadbeef";
export const ARTIFACT_ID = 9001;
export const TARGET_NAME = `sentinel-build-receipt-${RUN_ID}-${ATTEMPT}`;
export const AUTH_HEADER = "Bearer test-token";

export const EXPECTED_RECEIPT = {
  status: "found",
  receipt: {
    buildTransactionId: "github-actions:ubiquity/ai.ubq.fi:12345:2",
    identity: { gitSha: REVISION, revisionId: "synthetic-r123" },
  },
};

// ---------------------------------------------------------------------------
// Static resolver error texts (asserted exactly, never echoed).
// ---------------------------------------------------------------------------

export const ERR_CONFIG = "resolver configuration is invalid";
export const ERR_TIMEOUT = "build receipt resolution timed out";
export const ERR_TRANSPORT = "GitHub API request failed";
export const ERR_AUTH = "GitHub API authentication failed";
export const ERR_RATE = "GitHub API rate limit exceeded";
export const ERR_NOT_FOUND = "GitHub API resource not found";
export const ERR_PR = "GitHub pull request response is invalid";
export const ERR_WORKFLOW = "GitHub workflow response is invalid";
export const ERR_RUNS = "GitHub workflow runs response is invalid";
export const ERR_RUNS_PAGINATION = "GitHub workflow runs pagination is invalid";
export const ERR_ATTEMPT = "GitHub workflow run attempt response is invalid";
export const ERR_ARTIFACTS =
  "GitHub workflow run artifacts response is invalid";
export const ERR_ARTIFACTS_PAGINATION =
  "GitHub workflow run artifacts pagination is invalid";
export const ERR_ARTIFACT = "build receipt artifact is invalid";
export const ERR_ARTIFACT_EXPIRED = "build receipt artifact is expired";
export const ERR_ARTIFACT_SIZE = "build receipt artifact size mismatch";
export const ERR_ARTIFACT_DIGEST = "build receipt artifact digest mismatch";
export const ERR_SIGNED_URL = "build receipt artifact download URL is invalid";
export const ERR_STORAGE = "build receipt artifact download failed";
export const ERR_RERUN = "build workflow run attempt changed during resolution";

// ---------------------------------------------------------------------------
// Scripted transport.
// ---------------------------------------------------------------------------

export interface RecordedCall {
  url: URL;
  init: RequestInit;
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface FetchOverrides {
  prPayload?: unknown;
  prStatus?: number;
  contentsPayload?: unknown;
  workflowPayload?: unknown;
  runsPayload?: (url: URL) => unknown;
  attemptPayload?: unknown;
  artifactsPayload?: (url: URL) => unknown;
  zipStatus?: number;
  zipLocation?: string | null;
  storageBody?: BodyInit;
  storageStatus?: number;
  recheckPayload?: unknown;
  /** Pathname suffix that resolves only after delayMs (deadline scenarios). */
  slow?: { pathSuffix: string; delayMs: number; response: Response };
}

/** Actual GitHub-shaped success responses, with per-route overrides. */
export function successFetch(overrides: FetchOverrides = {}) {
  return (url: URL, _init: RequestInit): Response | Promise<Response> => {
    const p = url.pathname;
    if (overrides.slow && p.endsWith(overrides.slow.pathSuffix)) {
      return new Promise<Response>((resolve) => {
        setTimeout(
          () => resolve(overrides.slow!.response),
          overrides.slow!.delayMs,
        );
      });
    }
    if (p.endsWith(`/pulls/${PR_NUMBER}`)) {
      if (overrides.prStatus !== undefined) {
        return new Response(null, { status: overrides.prStatus });
      }
      return jsonResponse(overrides.prPayload ?? prPayload());
    }
    if (p.endsWith("/contents/.github/workflows/deno-deploy.yml")) {
      return jsonResponse(
        overrides.contentsPayload ?? {
          type: "file",
          path: ".github/workflows/deno-deploy.yml",
          sha: WORKFLOW_SHA,
        },
      );
    }
    if (p.endsWith("/actions/workflows/deno-deploy.yml")) {
      return jsonResponse(
        overrides.workflowPayload ?? {
          id: WORKFLOW_ID,
          path: ".github/workflows/deno-deploy.yml",
          name: "deno-deploy",
        },
      );
    }
    if (/\/workflows\/[0-9]+\/runs$/.test(p)) {
      return jsonResponse(
        overrides.runsPayload
          ? overrides.runsPayload(url)
          : { total_count: 1, workflow_runs: [runItem()] },
      );
    }
    if (p.endsWith(`/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`)) {
      return jsonResponse(overrides.attemptPayload ?? runItem());
    }
    if (p.endsWith(`/actions/runs/${RUN_ID}/artifacts`)) {
      return jsonResponse(
        overrides.artifactsPayload
          ? overrides.artifactsPayload(url)
          : { total_count: 1, artifacts: [receiptArtifact()] },
      );
    }
    if (p.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
      const status = overrides.zipStatus ?? 302;
      const headers: Record<string, string> =
        overrides.zipLocation === undefined
          ? { location: STORAGE_URL }
          : overrides.zipLocation === null
          ? {}
          : { location: overrides.zipLocation };
      return new Response(null, { status, headers });
    }
    if (p.endsWith("/github-production-release-asset/123/zip")) {
      if (overrides.storageStatus !== undefined) {
        return new Response(null, { status: overrides.storageStatus });
      }
      return new Response(
        (overrides.storageBody ?? ARCHIVE_BYTES) as BodyInit,
        { status: 200 },
      );
    }
    if (p.endsWith(`/actions/runs/${RUN_ID}`)) {
      return jsonResponse(overrides.recheckPayload ?? runItem());
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  };
}

export function scriptedFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  };
  return { fetchImpl: fetchImpl as typeof globalThis.fetch, calls };
}

// ---------------------------------------------------------------------------
// Actual GitHub REST response shapes; `base.sha` is allowed to move.
// ---------------------------------------------------------------------------

export function prPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: PR_NUMBER,
    state: "closed",
    merged: true,
    merge_commit_sha: REVISION,
    head: { sha: HEAD_SHA },
    base: {
      ref: BASE_BRANCH,
      sha: "3333333333333333333333333333333333333333",
      repo: { id: REPO_ID, full_name: REPO_FULL },
    },
    ...overrides,
  };
}

export function runItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: RUN_ID,
    run_attempt: ATTEMPT,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: REVISION,
    head_branch: BASE_BRANCH,
    workflow_id: WORKFLOW_ID,
    repository: { id: REPO_ID, full_name: REPO_FULL },
    head_repository: { id: REPO_ID, full_name: REPO_FULL },
    ...overrides,
  };
}

export function receiptArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ARTIFACT_ID,
    name: TARGET_NAME,
    size_in_bytes: ARCHIVE_SIZE,
    digest: ARCHIVE_DIGEST,
    expired: false,
    expires_at: EXPIRES_AT,
    workflow_run: {
      id: RUN_ID,
      repository_id: REPO_ID,
      head_repository_id: REPO_ID,
      head_sha: REVISION,
      head_branch: BASE_BRANCH,
    },
    ...overrides,
  };
}

/** Unrelated artifact types: legitimately larger, expired, without digest. */
export function unrelatedArtifact(
  id: number,
  name: string,
): Record<string, unknown> {
  return {
    id,
    name,
    size_in_bytes: 5_000_000,
    digest: null,
    expired: true,
    expires_at: "2000-01-01T00:00:00Z",
    workflow_run: {
      id: RUN_ID,
      repository_id: REPO_ID,
      head_repository_id: REPO_ID,
      head_sha: REVISION,
      head_branch: BASE_BRANCH,
    },
  };
}

// ---------------------------------------------------------------------------
// World.
// ---------------------------------------------------------------------------

export interface World {
  resolver: GithubBuildReceiptResolver;
  calls: RecordedCall[];
  authCalls: { count: number };
  request: ReleaseRequestV1;
}

export function baseRequest(): ReleaseRequestV1 {
  return {
    version: "v1",
    kind: "release_request",
    id: "req-1",
    target: {
      repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
      environment: "production",
    },
    revision: REVISION,
    source: {
      pullRequest: PR_NUMBER,
      reviewRequestId: "rev-1",
      reviewReceiptId: null,
      head: HEAD_SHA,
      // The request base is historical; the PR base.sha above has moved.
      base: "2222222222222222222222222222222222222222" as GitSha,
    },
    status: "open",
    failureReason: null,
    createdAt: NOW_MS,
  };
}

export const GOOD_AUTH: GithubBuildReceiptResolverAuthV1 = {
  authorizationHeader: (): Promise<PortResultV1<string>> =>
    Promise.resolve(portOk(AUTH_HEADER)),
};

export function buildWorld(opts: {
  fetch?: (url: URL, init: RequestInit) => Response | Promise<Response>;
  auth?: GithubBuildReceiptResolverAuthV1;
  request?: ReleaseRequestV1;
  timeoutMs?: number;
  baseBranch?: string;
  clockNow?: number;
} = {}): World {
  const { fetchImpl, calls } = scriptedFetch(opts.fetch ?? successFetch());
  const auth = opts.auth ?? GOOD_AUTH;
  const authCalls = { count: 0 };
  if (opts.auth === undefined) {
    const original = auth.authorizationHeader;
    auth.authorizationHeader = () => {
      authCalls.count += 1;
      return original();
    };
  }
  const resolver = new GithubBuildReceiptResolver({
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
    environment: "production",
    project: "ai-ubq-fi",
    baseBranch: opts.baseBranch ?? BASE_BRANCH,
    workflowBlobSha: WORKFLOW_SHA,
    clock: { now: () => opts.clockNow ?? NOW_MS },
    auth,
    fetch: fetchImpl,
    timeoutMs: opts.timeoutMs ?? 2000,
  });
  return { resolver, calls, authCalls, request: opts.request ?? baseRequest() };
}

export function resolve(
  world: World,
): Promise<PortResultV1<BuildReceiptLookupV1>> {
  return world.resolver.resolve(world.request);
}

export function expectError(
  result: PortResultV1<unknown>,
  kind: string,
  detail: string,
): void {
  if (result.ok) assert.fail("expected a typed error, got a success");
  assert.equal(result.error.kind, kind);
  assert.equal(result.error.detail, detail);
}

export function expectFound(result: PortResultV1<BuildReceiptLookupV1>): void {
  if (!result.ok || result.value.status !== "found") {
    assert.fail("expected a found receipt");
  }
  assert.deepStrictEqual(result.value, EXPECTED_RECEIPT);
}

export function assertAbsent(result: PortResultV1<BuildReceiptLookupV1>): void {
  if (!result.ok || result.value.status !== "absent") {
    assert.fail("expected absent");
  }
}

export function assertAmbiguous(
  result: PortResultV1<BuildReceiptLookupV1>,
  detail: string,
): void {
  if (
    !result.ok || result.value.status !== "ambiguous" ||
    result.value.detail !== detail
  ) {
    assert.fail("expected ambiguous: " + detail);
  }
}

export function headersOf(init: RequestInit): Headers {
  return new Headers(init.headers as HeadersInit | undefined);
}

export const API_CALL_PATHS = [
  `/repos/ubiquity/ai.ubq.fi/pulls/${PR_NUMBER}`,
  "/repos/ubiquity/ai.ubq.fi/contents/.github/workflows/deno-deploy.yml",
  "/repos/ubiquity/ai.ubq.fi/actions/workflows/deno-deploy.yml",
  `/repos/ubiquity/ai.ubq.fi/actions/workflows/${WORKFLOW_ID}/runs`,
  `/repos/ubiquity/ai.ubq.fi/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`,
  `/repos/ubiquity/ai.ubq.fi/actions/runs/${RUN_ID}/artifacts`,
  `/repos/ubiquity/ai.ubq.fi/actions/artifacts/${ARTIFACT_ID}/zip`,
  "/github-production-release-asset/123/zip",
  `/repos/ubiquity/ai.ubq.fi/actions/runs/${RUN_ID}`,
];
