/** Shared credential-free hosted test fixtures; this module registers no tests. */
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  GitHubCooldownGateV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import type { GitHubRateLimitV1 } from "../../src/contracts/github-cooldown.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { runActionsCiApproval } from "../../src/host/actions-ci.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";

const SELF_REPO = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
} as const;

const HEAD = SHA3;

const HEAD_REF = "sentinel/repair/issue-1";

export const PR_NUMBER = 30;

export const RUN_ID = 34_722_408_066;

export const PUBLISHER = "github-actions[bot]";

/** Login of the surviving `ubiquity-sentinel` App's bot identity. */
export const APP_PUBLISHER = "ubiquity-sentinel[bot]";

const WORKFLOW_PATH = ".github/workflows/ci.yml";

export const API_BASE = "https://api.github.com";

/** Real raw PR repository id and minimal API URL for ubiquity-sentinel/sentinel. */
export const REPO_ID = 1_362_069_392;

const REPO_API_URL = "https://api.github.com/repos/ubiquity-sentinel/sentinel";

export const PULL_PATH = `/repos/ubiquity-sentinel/sentinel/pulls/${PR_NUMBER}`;

export const LIST_PATH =
  "/repos/ubiquity-sentinel/sentinel/actions/workflows/ci.yml/runs";

export const RUN_PATH =
  `/repos/ubiquity-sentinel/sentinel/actions/runs/${RUN_ID}`;

export const APPROVE_PATH = `${RUN_PATH}/approve`;

export function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseV1 {
  return {
    status,
    headers: new Headers(headers),
    bodyText: typeof body === "string" ? body : JSON.stringify(body),
  };
}

type Handler = (
  request: HttpRequestV1,
) => HttpResponseV1 | Promise<HttpResponseV1>;

/** One scripted transport: exact method+path routes, recorded call order. */
export class ScriptedHttp {
  readonly calls: HttpRequestV1[] = [];
  private readonly routes = new Map<string, Handler>();
  on(method: string, path: string, handler: Handler): void {
    this.routes.set(`${method} ${path}`, handler);
  }
  readonly transport: HttpTransportV1 = (request) => {
    this.calls.push(request);
    const pathname = new URL(request.url).pathname;
    const handler = this.routes.get(`${request.method} ${pathname}`);
    if (handler === undefined) {
      return Promise.reject(new Error("unscripted request"));
    }
    return Promise.resolve(handler(request));
  };
  posts(): HttpRequestV1[] {
    return this.calls.filter((call) => call.method === "POST");
  }
}

export class FakeGate implements GitHubCooldownGateV1 {
  readonly admissions: number[] = [];
  readonly recorded: GitHubRateLimitV1[] = [];
  deny = false;
  beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    this.admissions.push(installationId);
    if (this.deny) {
      return Promise.resolve(
        portError("rate_limited", "installation is cooling down"),
      );
    }
    return Promise.resolve(portOk(undefined));
  }
  recordRateLimit(
    _installationId: number,
    rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>> {
    this.recorded.push(rateLimit);
    return Promise.resolve(portOk(undefined));
  }
}

/** Actual raw PR shape: head/base.repo are full repository objects. */
export function pullBody(
  overrides: {
    number?: number;
    state?: string;
    author?: string;
    headSha?: string;
    headRef?: string;
    headRepo?: string;
    headRepoId?: number;
    baseRepoId?: number;
    baseRef?: string;
  } = {},
): unknown {
  return {
    number: overrides.number ?? PR_NUMBER,
    state: overrides.state ?? "open",
    user: { login: overrides.author ?? PUBLISHER },
    head: {
      sha: overrides.headSha ?? HEAD,
      ref: overrides.headRef ?? HEAD_REF,
      repo: {
        id: overrides.headRepoId ?? REPO_ID,
        name: "sentinel",
        full_name: overrides.headRepo ?? "ubiquity-sentinel/sentinel",
        url: REPO_API_URL,
      },
    },
    base: {
      ref: overrides.baseRef ?? "development",
      repo: {
        id: overrides.baseRepoId ?? REPO_ID,
        name: "sentinel",
        full_name: "ubiquity-sentinel/sentinel",
        url: REPO_API_URL,
      },
    },
  };
}

/**
 * Actual workflow-run shape: `pull_requests[].head/base.repo` are the minimal
 * `{ id, name, url }` API objects, while `head_repository` is a full object.
 */
export function runBody(
  overrides: {
    id?: number;
    attempt?: number;
    actor?: string;
    triggeringActor?: string;
    path?: string;
    headSha?: string;
    headRef?: string;
    headRepo?: string;
    status?: string;
    conclusion?: string | null;
    prNumber?: number;
    assocRepoId?: number;
    assocRepoName?: string;
    assocRepoUrl?: string;
  } = {},
): Record<string, unknown> {
  const conclusion = overrides.conclusion === undefined
    ? "action_required"
    : overrides.conclusion;
  const associationRepo = () => ({
    id: overrides.assocRepoId ?? REPO_ID,
    name: overrides.assocRepoName ?? "sentinel",
    url: overrides.assocRepoUrl ?? REPO_API_URL,
  });
  return {
    id: overrides.id ?? RUN_ID,
    run_attempt: overrides.attempt ?? 1,
    event: "pull_request",
    path: overrides.path ?? WORKFLOW_PATH,
    head_sha: overrides.headSha ?? HEAD,
    head_branch: overrides.headRef ?? HEAD_REF,
    head_repository: {
      full_name: overrides.headRepo ?? "ubiquity-sentinel/sentinel",
    },
    actor: { login: overrides.actor ?? PUBLISHER },
    triggering_actor: { login: overrides.triggeringActor ?? PUBLISHER },
    status: overrides.status ?? "completed",
    conclusion,
    pull_requests: [{
      number: overrides.prNumber ?? PR_NUMBER,
      head: {
        sha: overrides.headSha ?? HEAD,
        ref: overrides.headRef ?? HEAD_REF,
        repo: associationRepo(),
      },
      base: {
        ref: "development",
        repo: associationRepo(),
      },
    }],
  };
}

export function runsBody(runs: unknown[], total = runs.length): unknown {
  return { total_count: total, workflow_runs: runs };
}

/** M15 V1 self-candidate preservation identity for the CI fixtures. */
const CANDIDATE_REF = `refs/heads/sentinel-candidates/${"ab".repeat(32)}`;

const PRODUCING_RESERVATION = "cd".repeat(32);

export function candidateRecord(
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord("issue-1", {
    repository: { ...SELF_REPO },
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: HEAD_REF,
      checkpoint: null,
      head: HEAD,
      pr: PR_NUMBER,
      // Valid Stage2 candidate state: the preserved descriptor and the
      // published head both bind to the exact target base/head, so the
      // ordinary CI tests exercise the real candidate eligibility path.
      candidateState: {
        preserved: {
          operationKey: `impl:${PRODUCING_RESERVATION}`,
          base: SHA1,
          head: HEAD,
          ref: CANDIDATE_REF,
        },
        publishedHead: HEAD,
      },
    },
    nextStep: "review",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

function snapshot(work: WorkRecordV1[]): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

export function makeRig(work: WorkRecordV1[] = [candidateRecord()]) {
  const state = new MemoryState();
  state.repair = snapshot(work);
  const gate = new FakeGate();
  const http = new ScriptedHttp();
  const clock = new FakeClock(T0);
  http.on("GET", PULL_PATH, () => response(200, pullBody()));
  http.on("GET", LIST_PATH, () => response(200, runsBody([runBody()])));
  http.on("GET", RUN_PATH, () => response(200, runBody()));
  http.on("POST", APPROVE_PATH, () => response(201, {}));
  return {
    state,
    gate,
    http,
    clock,
    run: (deadline = clock.now() + 60 * 60_000) => {
      const input = {
        state,
        gate,
        http: http.transport,
        token: "dummy-token",
        clock,
        deadline,
        apiBaseUrl: API_BASE,
      };
      return runActionsCiApproval(input);
    },
  };
}

export type RigV1 = ReturnType<typeof makeRig>;

// ---------------------------------------------------------------------------
// M15 V1 candidate state: incomplete (unpreserved/unpublished) new-format
// records are filtered before approval, so they are never
// auto-approved and never starve a later eligible candidate.
// ---------------------------------------------------------------------------

/** Incomplete self candidate: valid PR/head/branch but nothing preserved. */
export function incompleteCandidateRecord(index: number): WorkRecordV1 {
  const pr = 40 + index;
  const head = SHA2;
  return workRecord(`incomplete-${index}`, {
    repository: { ...SELF_REPO },
    source: { kind: "issue", id: `${100 + index}`, revision: SHA1 },
    related: { incidentId: null, issueNumber: 100 + index },
    target: {
      base: SHA1,
      branch: `sentinel/repair/incomplete-${index}`,
      checkpoint: null,
      head,
      pr,
      candidateState: { preserved: null, publishedHead: null },
    },
    nextStep: "review",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
  });
}
