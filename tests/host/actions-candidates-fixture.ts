/** Shared credential-free hosted test fixtures; this module registers no tests. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubRateLimitV1 } from "../../src/contracts/github-cooldown.ts";
import type {
  GitHubCooldownGateV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { createActionsCandidateRestorer } from "../../src/host/actions-candidates.ts";
import { FakeClock, type MemoryState } from "../repair/helpers.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";

const HERE = new URL(import.meta.url);

if (HERE.protocol !== "file:") throw new Error("expected a file: test module");

const ROOT = decodeURIComponent(new URL("../..", import.meta.url).pathname)
  .replace(/\/$/, "");

export const TRUSTED_PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";

export const SELF_REPO = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
} as const;

export const BRANCH = "sentinel/repair/issue-1";

export async function gitRun(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ok: result.success,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: TRUSTED_PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "sentinel-candidates-test",
    GIT_AUTHOR_EMAIL: "sentinel-candidates-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-candidates-test",
    GIT_COMMITTER_EMAIL: "sentinel-candidates-test@localhost",
  };
}

export interface CandidateCtxV1 {
  tmp: string;
  env: Record<string, string>;
  bare: string;
  base: GitSha;
  head: GitSha;
  clone(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function commitIn(
  work: string,
  env: Record<string, string>,
  name: string,
): Promise<GitSha> {
  await Deno.writeTextFile(`${work}/${name}.txt`, name);
  assert.ok((await gitRun(work, ["add", "-A"], env)).ok);
  assert.ok((await gitRun(work, ["commit", "-q", "-m", name], env)).ok);
  const rev = await gitRun(work, ["rev-parse", "HEAD"], env);
  return rev.stdout.trim() as GitSha;
}

export async function makeCandidateCtx(): Promise<CandidateCtxV1> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-candidates-",
    dir: ROOT,
  });
  try {
    const env = gitEnv(`${tmp}/home`);
    await Deno.mkdir(`${tmp}/home`, { recursive: true });
    const bare = `${tmp}/remote.git`;
    const work = `${tmp}/work`;
    await Deno.mkdir(work, { recursive: true });
    assert.ok((await gitRun(tmp, ["init", "-q", "--bare", bare], env)).ok);
    assert.ok((await gitRun(tmp, ["init", "-q", work], env)).ok);
    assert.ok(
      (await gitRun(work, ["remote", "add", "origin", bare], env)).ok,
    );
    const base = await commitIn(work, env, "base");
    assert.ok((await gitRun(work, ["branch", "-M", "development"], env)).ok);
    assert.ok(
      (await gitRun(work, ["push", "-q", "origin", "development"], env)).ok,
    );
    assert.ok((await gitRun(work, ["checkout", "-q", "-b", BRANCH], env)).ok);
    const head = await commitIn(work, env, "candidate");
    assert.ok(
      (await gitRun(
        work,
        ["push", "-q", "origin", `refs/heads/${BRANCH}`],
        env,
      )).ok,
    );
    const clone = async (): Promise<string> => {
      const dest = `${tmp}/clone-${crypto.randomUUID()}`;
      const cloned = await gitRun(tmp, [
        "clone",
        "-q",
        "--depth=1",
        "--single-branch",
        "--branch",
        "development",
        `file://${bare}`,
        dest,
      ], env);
      if (!cloned.ok) throw new Error(`clone failed: ${cloned.stderr}`);
      return dest;
    };
    return {
      tmp,
      env,
      bare,
      base,
      head,
      clone,
      cleanup: async () => {
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      },
    };
  } catch (error) {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    throw error;
  }
}

export class FakeGate implements GitHubCooldownGateV1 {
  deny = false;
  readonly admissions: number[] = [];
  beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    this.admissions.push(installationId);
    return Promise.resolve(
      this.deny
        ? portError("rate_limited", "installation is cooling down")
        : portOk(undefined),
    );
  }
  recordRateLimit(
    _installationId: number,
    _rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>> {
    return Promise.resolve(portOk(undefined));
  }
}

/** Fake authenticated ref API: exact self ref metadata, recorded requests. */
export class RefHttp {
  readonly requests: HttpRequestV1[] = [];
  sha: GitSha;
  fail = false;
  constructor(sha: GitSha) {
    this.sha = sha;
  }
  readonly transport: HttpTransportV1 = (request) => {
    this.requests.push(request);
    if (this.fail) return Promise.reject(new Error("transport down"));
    const pathname = new URL(request.url).pathname;
    const marker = "/git/ref/";
    const ref = "refs/" +
      pathname.slice(pathname.indexOf(marker) + marker.length);
    return Promise.resolve(
      {
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify({ ref, object: { sha: this.sha } }),
      } satisfies HttpResponseV1,
    );
  };
}

export function snapshot(
  work: RepairStateSnapshotV1["work"],
  reservations: RepairStateSnapshotV1["reservations"] = [],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work,
    reservations,
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

export function candidateRecord(
  ctx: CandidateCtxV1,
  overrides: Record<string, unknown> = {},
) {
  return workRecord("candidates-1", {
    repository: { ...SELF_REPO },
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: ctx.base,
      branch: BRANCH,
      checkpoint: null,
      head: ctx.head,
      pr: 12,
    },
    nextStep: "review",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    updatedAt: T0 + 1000,
    ...overrides,
  });
}

export function restorer(
  ctx: CandidateCtxV1,
  state: MemoryState,
  gate: FakeGate,
  http: RefHttp,
  sourcePath: string,
  remoteUrl: string = `file://${ctx.bare}`,
) {
  return createActionsCandidateRestorer({
    state,
    gate,
    token: "dummy-token",
    http: http.transport,
    clock: new FakeClock(T0),
    sourcePath,
    scratch: `${ctx.tmp}/home`,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    remoteUrl,
    apiBaseUrl: "https://api.github.com",
  });
}

export async function objectPresent(
  clone: string,
  env: Record<string, string>,
  sha: GitSha,
): Promise<boolean> {
  const read = await gitRun(clone, ["cat-file", "-e", `${sha}^{commit}`], env);
  return read.code === 0;
}
