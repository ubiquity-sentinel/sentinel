/** Shared credential-free hosted test fixtures; this module registers no tests. */
import assert from "node:assert/strict";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { GitHubPort, PortResultV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { CandidatePreservationV1 } from "../../src/contracts/work-record.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import type { DenoGitExecutorOptions } from "../../src/github/git-executor.ts";
import type { HttpResponseV1, HttpTransportV1 } from "../../src/github/http.ts";
import { createCandidatePreserver } from "../../src/host/actions-candidates.ts";
import type { CandidateProofPassV1 } from "../../src/host/actions-candidates-proof.ts";
import { composeGitHubHost } from "../../src/host/github.ts";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import { FakeAuthProvider, FakeReviewService } from "../github/helpers.ts";
import { FakeClock, type MemoryState } from "../repair/helpers.ts";
import { reservation, T0 } from "../state/helpers.ts";
import {
  type candidateRecord,
  FakeGate,
  gitRun,
  SELF_REPO,
  TRUSTED_PATH,
} from "./actions-candidates-fixture.ts";
import type { CandidateCtxV1 } from "./actions-candidates-fixture.ts";

// ---------------------------------------------------------------------------
// Trusted candidate preservation: REAL bare remote, REAL DenoGitExecutor
// push/CAS path and REAL GitReviewSnapshot validation; only the external HTTP
// transport is fake (it reads the same real remote refs).
// ---------------------------------------------------------------------------

export const PRESERVATION_ID = "a".repeat(64);

export const CANDIDATE_TASK_ID = "candidates-1" as WorkItemId;

export const CANDIDATE_OPERATION_KEY = `impl:${PRESERVATION_ID}`;

/** The exact submitted implementation reservation for one candidate attempt. */
export function submittedReservation(
  record: ReturnType<typeof candidateRecord>,
  overrides: Record<string, unknown> = {},
) {
  return reservation(PRESERVATION_ID, {
    repository: { ...SELF_REPO },
    taskId: record.id,
    attempt: record.counters.attempts,
    head: record.target.base,
    purpose: "implementation",
    outcome: "submitted",
    settledAt: T0 + 5,
    proofRef: null,
    ...overrides,
  });
}

/** A private trusted source mirror: a clone of the exact producer checkout. */
export async function mirror(ctx: CandidateCtxV1): Promise<string> {
  const dest = `${ctx.tmp}/mirror-${crypto.randomUUID()}`;
  const cloned = await gitRun(
    ctx.tmp,
    ["clone", "-q", "--no-hardlinks", `${ctx.tmp}/work`, dest],
    ctx.env,
  );
  if (!cloned.ok) throw new Error(`mirror clone failed: ${cloned.stderr}`);
  return dest;
}

/** Exact operation descriptor for one task/base/head/operation key. */
export async function candidateFor(
  taskId: WorkItemId,
  base: GitSha,
  head: GitSha,
  operationKey: string,
): Promise<CandidatePreservationV1> {
  return {
    operationKey,
    base,
    head,
    ref: await candidatePreservationRef({ ...SELF_REPO }, taskId, operationKey),
  };
}

/** Authoritative remote ref read from the real fixture bare repository. */
export async function remoteSha(
  ctx: CandidateCtxV1,
  ref: string,
): Promise<GitSha | null> {
  const read = await gitRun(
    ctx.tmp,
    ["ls-remote", `file://${ctx.bare}`, ref],
    ctx.env,
  );
  assert.ok(read.ok, read.stderr);
  const line = read.stdout.trim();
  return line === "" ? null : line.split("\t")[0]!.trim() as GitSha;
}

/** No queue rule; every remote ref read still observes the REAL fixture remote. */
export class RealRefHttp {
  readonly paths: string[] = [];
  constructor(private readonly reader: DenoGitExecutor) {}
  readonly transport: HttpTransportV1 = (request) => {
    const pathname = new URL(request.url).pathname;
    this.paths.push(pathname);
    assert.equal(request.method, "GET");
    if (pathname === "/repos/ubiquity/ai.ubq.fi/rules/branches/development") {
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: "[]",
      });
    }
    const marker = "/git/ref/";
    const index = pathname.indexOf(marker);
    if (index === -1) {
      // Any PR/issue/review read is a failure: preservation must never touch
      // those surfaces.
      return Promise.reject(new Error(`unexpected non-ref read: ${pathname}`));
    }
    const ref = "refs/" + pathname.slice(index + marker.length);
    return this.reader.readRemoteRef(ref).then((read): HttpResponseV1 => {
      if (!read.ok) {
        return { status: 500, headers: new Headers(), bodyText: "" };
      }
      if (read.value === null) {
        return { status: 404, headers: new Headers(), bodyText: "" };
      }
      return {
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify({ ref, object: { sha: read.value } }),
      };
    });
  };
}

/** The real composed port + executor over one real fixture remote. */
function candidatePort(input: {
  ctx: CandidateCtxV1;
  sourcePath: string;
  gate: FakeGate;
  gitExtra?: Partial<DenoGitExecutorOptions>;
}) {
  const reader = new DenoGitExecutor({
    localDir: input.sourcePath,
    remoteUrl: `file://${input.ctx.bare}`,
    gitHome: `${input.ctx.tmp}/home`,
    gitPath: "git",
  });
  const http = new RealRefHttp(reader);
  const host = composeGitHubHost({
    repository: { ...SELF_REPO },
    http: http.transport,
    auth: new FakeAuthProvider(),
    cooldownGate: input.gate,
    clock: new FakeClock(T0),
    reviewService: new FakeReviewService(),
    trustedPrAuthor: "sentinel[bot]",
    trustedReviewer: "chatgpt-codex-connector[bot]",
    trustedResolutionAuthors: ["sentinel[bot]"],
    git: {
      localDir: input.sourcePath,
      remoteUrl: `file://${input.ctx.bare}`,
      gitHome: `${input.ctx.tmp}/home`,
      gitPath: "git",
      ...input.gitExtra,
    },
  });
  return { host, http };
}

function preserverRun(input: {
  ctx: CandidateCtxV1;
  state: MemoryState;
  port: Pick<GitHubPort, "readRef" | "pushHead">;
  sourcePath: string;
  http: HttpTransportV1;
  gate: FakeGate;
  protectedPaths?: readonly string[];
  runtime?: ReplayRuntimeV1;
  ensure?: (taskId: WorkItemId, head: GitSha) => Promise<PortResultV1<void>>;
  proofPass?: CandidateProofPassV1;
}) {
  return createCandidatePreserver({
    ...(input.proofPass === undefined ? {} : { proofPass: input.proofPass }),
    state: input.state,
    gate: input.gate,
    token: "dummy-token",
    http: input.http,
    clock: new FakeClock(T0),
    sourcePath: input.sourcePath,
    scratch: `${input.ctx.tmp}/home`,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    runtime: input.runtime,
    remoteUrl: `file://${input.ctx.bare}`,
    apiBaseUrl: "https://api.github.com",
    port: input.port,
    protectedPaths: input.protectedPaths ?? [],
    ensureLocalCandidate: input.ensure ??
      (() => Promise.resolve(portOk(undefined))),
  });
}

/** Drive the real preserver over the real port/remote and record every push. */
export async function preserveAttempt(input: {
  ctx: CandidateCtxV1;
  state: MemoryState;
  taskId: WorkItemId;
  sourcePath: string;
  candidate: CandidatePreservationV1;
  publishedHead?: GitSha | null;
  protectedPaths?: readonly string[];
  runtime?: ReplayRuntimeV1;
  ensure?: (taskId: WorkItemId, head: GitSha) => Promise<PortResultV1<void>>;
  gitExtra?: Partial<DenoGitExecutorOptions>;
  /** The owning pass's one proof store per remote, as maintenance passes it. */
  proofPass?: CandidateProofPassV1;
  pushOverride?: (
    realPush: (
      ref: string,
      sha: GitSha,
      expected: GitSha | null,
    ) => Promise<PortResultV1<"applied" | "ambiguous">>,
    ref: string,
    sha: GitSha,
    expected: GitSha | null,
  ) => Promise<PortResultV1<"applied" | "ambiguous">>;
}) {
  const gate = new FakeGate();
  const { host, http } = candidatePort({
    ctx: input.ctx,
    sourcePath: input.sourcePath,
    gate,
    gitExtra: input.gitExtra,
  });
  const pushes: { ref: string; sha: GitSha; expected: GitSha | null }[] = [];
  const port: Pick<GitHubPort, "readRef" | "pushHead"> = {
    readRef: (ref) => host.port.readRef(ref),
    pushHead: async (ref, sha, expected) => {
      pushes.push({ ref, sha, expected });
      if (input.pushOverride !== undefined) {
        return await input.pushOverride(
          host.port.pushHead.bind(host.port),
          ref,
          sha,
          expected,
        );
      }
      return await host.port.pushHead(ref, sha, expected);
    },
  };
  const preserve = preserverRun({
    ctx: input.ctx,
    state: input.state,
    port,
    sourcePath: input.sourcePath,
    http: http.transport,
    gate,
    protectedPaths: input.protectedPaths,
    runtime: input.runtime,
    ensure: input.ensure,
    proofPass: input.proofPass,
  });
  const result = await preserve({
    taskId: input.taskId,
    candidate: input.candidate,
    publishedHead: input.publishedHead ?? null,
  });
  return { result, http, gate, pushes };
}

/** Force a truncated fetch in the fresh-store proof only. */
export class TruncatingFetchRuntime implements ReplayRuntimeV1 {
  constructor(private readonly delegate: ReplayRuntimeV1) {}
  run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    if (input.args.includes("fetch")) {
      return Promise.resolve({
        outcome: "exited",
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        truncated: true,
        settled: true,
        detail: "truncated",
      });
    }
    return this.delegate.run(input);
  }
}

/**
 * Force one unsettled child in the fresh-store proof only. No real child is
 * spawned or intentionally left running: the runtime returns the uncertainty
 * directly, so the store-preservation behavior is asserted deterministically.
 */
export class UnsettledInitRuntime implements ReplayRuntimeV1 {
  constructor(private readonly delegate: ReplayRuntimeV1) {}
  run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    if (input.args.includes("init")) {
      return Promise.resolve({
        outcome: "timed_out",
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        truncated: false,
        settled: false,
        detail: "owned descendants could not be proved settled",
      });
    }
    return this.delegate.run(input);
  }
}
