/** Shared credential-free hosted test fixtures; this module registers no tests. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import {
  HOSTED_RUNTIME_CHILD_ENTRYPOINT,
  HOSTED_RUNTIME_CHILD_ENV_KEYS,
  HOSTED_RUNTIME_WORKFLOW_REF,
  runHostedRuntimeLauncher,
} from "../../src/host/hosted-runtime.ts";
import type {
  HostedModelDiagnosticV1,
  HostedRuntimeIdentityV1,
  HostedRuntimeLauncherInputV1,
  HostedRuntimeLauncherResultV1,
} from "../../src/host/hosted-runtime.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import type { ReleaseGitStateStore } from "../../src/state/mod.ts";
import { gitRun, makeRemoteCtx, T0, testGitEnv } from "../state/helpers.ts";

const HERE = new URL(import.meta.url);

if (HERE.protocol !== "file:") throw new Error("expected a file: test module");

export const ROOT = decodeURIComponent(
  new URL("../..", import.meta.url).pathname,
).replace(/\/$/, "");

export const RUN_ID = 7;

export const RUN_ATTEMPT = 2;

export const FIXED_LAUNCHER = "a".repeat(40) as GitSha;

export const OTHER_REVISION = "f".repeat(40) as GitSha;

export const OBSERVED_BASE = "b".repeat(40) as GitSha;

export const NATIVE_LOGIN = "github-actions[bot]";

export const APP_LOGIN = "ubiquity-sentinel[bot]";

export const APP_TOKEN = "test-app-token";

/**
 * Every allow-listed key that is OPTIONAL: it crosses only when the run
 * supplies non-empty text. The exact-key assertions subtract this set from
 * the allow-list for a run that supplies none of them.
 */
const OPTIONAL_CHILD_ENV_KEYS = [
  "SENTINEL_SUPERVISOR_TOKEN",
  "SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER",
  "SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT",
  "SENTINEL_MODEL_BASE_URL",
  "SENTINEL_MODEL_ID",
  "SENTINEL_MODEL_FALLBACK",
  "SENTINEL_REVIEW_MODEL_ID",
  "SENTINEL_DEEPSEEK_API_KEY",
  "SENTINEL_APP_INSTALLATION_ID",
  "SENTINEL_TARGET_INSTALLATION_ID",
  "SENTINEL_SELF_INSTALLATION_ID",
  "SENTINEL_COOLDOWN_MODE",
  "SENTINEL_MERGE_QUEUE",
  "SENTINEL_BACKUP_CI",
  // Set by the launcher itself, only for a revision it pinned a cutoff for.
  "SENTINEL_LEGACY_REVIEW_CUTOFF",
  "SENTINEL_SELF_TOKEN",
  "SENTINEL_SELF_TOKEN_MINT_GRANT",
] as const;

/** The exact child key set for a run that supplies no optional value. */
export function requiredChildEnvKeys(): string[] {
  const optional = new Set<string>(OPTIONAL_CHILD_ENV_KEYS);
  return HOSTED_RUNTIME_CHILD_ENV_KEYS.filter((key) => !optional.has(key))
    .sort();
}

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Returns a valid start instant, then a backward finish instant. */
export class BackwardClock implements Clock {
  private calls = 0;
  now(): number {
    this.calls += 1;
    return this.calls === 1 ? T0 : T0 - 1;
  }
}

/** One injected process border: real bounded Git plus the child invocation. */
export class BorderRuntime implements ReplayRuntimeV1 {
  readonly calls: ReplayCommandInputV1[] = [];
  child: ReplayCommandResultV1 | null = null;
  realChild = false;
  throwOnChild = false;
  private readonly real = new DenoReplayRuntime(Deno.execPath());

  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.calls.push(input);
    if (
      input.args.includes(HOSTED_RUNTIME_CHILD_ENTRYPOINT) ||
      input.args.includes("src/host/matrix-actions.ts")
    ) {
      if (this.throwOnChild) throw new Error("forced child border failure");
      if (this.realChild) return await this.real.run(input);
      if (this.child === null) throw new Error("no canned child result");
      return this.child;
    }
    return await this.real.run(input);
  }

  childCalls(): ReplayCommandInputV1[] {
    return this.calls.filter((call) =>
      call.args.includes(HOSTED_RUNTIME_CHILD_ENTRYPOINT)
    );
  }

  gitCalls(): ReplayCommandInputV1[] {
    return this.calls.filter((call) => call.executable === "/usr/bin/git");
  }
}

export function hostedEnv(launcherSha: GitSha): Record<string, string> {
  return {
    GITHUB_RUN_ID: String(RUN_ID),
    GITHUB_RUN_ATTEMPT: String(RUN_ATTEMPT),
    GITHUB_REPOSITORY: "ubiquity-sentinel/sentinel",
    GITHUB_REF: "refs/heads/sentinel-supervisor",
    GITHUB_SHA: launcherSha,
    GITHUB_WORKFLOW_SHA: launcherSha,
    GITHUB_WORKFLOW_REF: HOSTED_RUNTIME_WORKFLOW_REF,
    GITHUB_JOB: "repair",
    GITHUB_TOKEN: "test-native-token",
    UOS_AI_TOKEN: "test-model-token",
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: "/tmp",
  };
}

export function exited(
  stdout: string,
  exitCode = 0,
  overrides: Partial<ReplayCommandResultV1> = {},
): ReplayCommandResultV1 {
  return {
    outcome: "exited",
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    truncated: false,
    settled: true,
    detail: "",
    ...overrides,
  };
}

export function childLine(
  execution: HostedExecutionIntentV1,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    status: "ran",
    outcome: { status: "idle", detail: "no declared work" },
    controllerSha: execution.revision,
    baseSha: OBSERVED_BASE,
    login: NATIVE_LOGIN,
    startupReady: true,
    ciApproval: { approved: 0, pending: 0, unavailable: 0 },
    execution,
    ...overrides,
  });
}

const DIAGNOSTIC_TASK_KEY = "c".repeat(64);

/** One real serialized advisory summary exactly as the local host emits it. */
export function diagnosticLine(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: "v1",
    kind: "sentinel_model_diagnostic",
    taskKey: DIAGNOSTIC_TASK_KEY,
    base: OBSERVED_BASE,
    observedAt: T0,
    outcome: "failed",
    reason: "runtime_error",
    errorKind: null,
    terminalOrigin: "runtime",
    observedTerminalStatus: "completed",
    durationMs: 1_234,
    outputChars: 100,
    candidatePresent: true,
    reasonCode: null,
    ...overrides,
  });
}

/**
 * One advisory summary exactly as the independently pinned INSTALLED runtime
 * version emits it: a port error carries `reasonCode`, either one of that
 * version's own eight static seam codes or null. No raw detail is ever a code.
 */
export function runtimeDiagnosticLine(reasonCode: string | null): string {
  return JSON.stringify({
    version: "v1",
    kind: "sentinel_model_diagnostic",
    taskKey: DIAGNOSTIC_TASK_KEY,
    base: OBSERVED_BASE,
    observedAt: T0,
    outcome: "port_error",
    reason: "runtime_error",
    errorKind: "unavailable",
    terminalOrigin: null,
    observedTerminalStatus: null,
    durationMs: null,
    outputChars: null,
    candidatePresent: false,
    reasonCode,
  });
}

/** The exact safe diagnostic carried by {@link diagnosticLine}. */
export const SAFE_DIAGNOSTIC = {
  version: "v1",
  kind: "sentinel_model_diagnostic",
  taskKey: DIAGNOSTIC_TASK_KEY,
  base: OBSERVED_BASE,
  observedAt: T0,
  outcome: "failed",
  reason: "runtime_error",
  errorKind: null,
  terminalOrigin: "runtime",
  observedTerminalStatus: "completed",
  durationMs: 1_234,
  outputChars: 100,
  candidatePresent: true,
  reasonCode: null,
} as const;

export async function makeCheckout(
  dir: string,
  env: Record<string, string>,
  files: Record<string, string>,
): Promise<GitSha> {
  await Deno.mkdir(dir, { recursive: true });
  await gitRun(dir, ["init", "-q"], env);
  for (const [name, text] of Object.entries(files)) {
    const full = `${dir}/${name}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(full, text);
  }
  await gitRun(dir, ["add", "-A"], env);
  const committed = await gitRun(dir, ["commit", "-q", "-m", "fixture"], env);
  assert.ok(committed.ok, committed.stderr);
  const head = await gitRun(dir, ["rev-parse", "HEAD"], env);
  assert.ok(head.ok, head.stderr);
  return head.stdout.trim() as GitSha;
}

interface RigV1 {
  launcherDir: string;
  runtimeDir: string;
  identity: HostedRuntimeIdentityV1;
  execution: HostedExecutionIntentV1;
  env: Record<string, string>;
  release: ReleaseGitStateStore;
  clock: FakeClock;
  process: BorderRuntime;
  releaseHead(): Promise<GitSha | null>;
  cleanup(): Promise<void>;
}

export async function makeRig(
  options: {
    runtimeFiles?: Record<string, string>;
    executionRevision?: GitSha;
  } = {},
): Promise<RigV1> {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-hosted-runtime-",
    dir: ROOT,
  });
  const env = testGitEnv(`${root}/git-home`);
  await Deno.mkdir(`${root}/git-home`, { recursive: true });
  const launcherDir = `${root}/launcher`;
  const runtimeDir = `${root}/runtime`;
  const launcherSha = await makeCheckout(launcherDir, env, {
    "README.md": "launcher\n",
    ".gitignore": ".sentinel/\n",
  });
  const runtimeSha = await makeCheckout(
    runtimeDir,
    env,
    options.runtimeFiles ?? {
      "README.md": "runtime\n",
      ".gitignore": ".sentinel/\n",
    },
  );
  const remote = await makeRemoteCtx(root, env);
  const scratchDir = `${root}/state-scratch`;
  await Deno.mkdir(scratchDir, { recursive: true });
  const release = createReleaseStateStore({
    scratchDir,
    remoteUrl: remote.remoteUrl,
  });
  const identity: HostedRuntimeIdentityV1 = {
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    launcherSha,
    job: "repair",
  };
  const execution = parseHostedExecutionIntentV1({
    id: `${RUN_ID}:${RUN_ATTEMPT}:repair`,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    launcherSha,
    purpose: "ordinary",
    revision: options.executionRevision ?? runtimeSha,
    generation: 1,
    releaseId: null,
    createdAt: T0,
  });
  return {
    launcherDir,
    runtimeDir,
    identity,
    execution,
    env: hostedEnv(launcherSha),
    release,
    clock: new FakeClock(T0),
    process: new BorderRuntime(),
    releaseHead: async () => {
      const read = await release.readRelease();
      assert.ok(read.ok, JSON.stringify(read));
      if (!read.ok) throw new Error("release read failed");
      return read.value.status === "found" ? read.value.head : null;
    },
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

export async function seedRelease(rig: RigV1): Promise<void> {
  const snapshot = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [{
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: rig.execution.revision,
      generation: rig.execution.generation,
      lastHealthyProof: null,
      lastExecutionProof: null,
      nextOrdinaryAt: T0,
      execution: rig.execution,
      createdAt: T0,
      updatedAt: T0,
    }],
    hostedReleases: [],
    githubCooldowns: [],
  });
  const written = await rig.release.writeRelease(snapshot, null);
  assert.ok(
    written.ok && written.value.status === "applied",
    JSON.stringify(written),
  );
}

// Terminal/child fixtures explicitly model dormant proof floors. Activated-floor
// fixtures supply their own exact policies through the production launcher seam.
const DORMANT_QUEUE_CAPABILITY = { proofActivated: false, revisions: [] };
const DORMANT_CUSTODY_CAPABILITY = { custodyActivated: false, revisions: [] };

function launchInput(rig: RigV1): HostedRuntimeLauncherInputV1 {
  return {
    state: rig.release,
    clock: rig.clock,
    env: rig.env,
    launcherDir: rig.launcherDir,
    runtimeDir: rig.runtimeDir,
    denoExecutable: Deno.execPath(),
    process: rig.process,
  };
}

export function launch(
  rig: RigV1,
  overrides: Partial<HostedRuntimeLauncherInputV1> = {},
): Promise<HostedRuntimeLauncherResultV1> {
  return runHostedRuntimeLauncher(
    { ...launchInput(rig), ...overrides },
    DORMANT_QUEUE_CAPABILITY,
    DORMANT_CUSTODY_CAPABILITY,
  );
}

/**
 * The same launcher input with one optional advisory sink attached through
 * Object.assign, so this fixture keeps compiling against a runtime that does
 * not declare the optional streaming field yet.
 */
export function launchWithSink(
  rig: RigV1,
  sink: (diagnostic: HostedModelDiagnosticV1) => void,
): Promise<HostedRuntimeLauncherResultV1> {
  return runHostedRuntimeLauncher(
    Object.assign({}, launchInput(rig), { onDiagnostic: sink }),
    DORMANT_QUEUE_CAPABILITY,
    DORMANT_CUSTODY_CAPABILITY,
  );
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Synchronous marker check usable from inside a streaming sink callback. */
export function pathExistsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}
