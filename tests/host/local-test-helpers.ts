import assert from "node:assert/strict";
import {
  ensureTaskCheckout,
  localCheckoutKey,
  type LocalRepairHostOptionsV1,
} from "../../src/host/local.ts";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import type {
  GitHubCooldownGateV1,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { MemoryState } from "../repair/helpers.ts";
import { gitRun, REPO, SHA1, SHA3, T0, testGitEnv } from "../state/helpers.ts";

// ---------------------------------------------------------------------------
// Startup gate ordering: durable cooldown admission precedes EVERY remote
// refresh/login request, and a confirmed rate-limit response is persisted
// through the same durable gate before the static startup failure.
// ---------------------------------------------------------------------------

/** Valid empty repair snapshot (same shape as tests/repair/local-owner_test.ts). */
function emptySnapshot(): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

export async function seededState(): Promise<MemoryState> {
  const state = new MemoryState();
  const seeded = await state.writeRepair(emptySnapshot(), null);
  assert.equal(seeded.ok, true);
  return state;
}

/** One ordered event log for gate admission, HTTP and persistence. */
export function countingGate(
  inner: GitHubCooldownGateV1,
  events: string[],
): GitHubCooldownGateV1 {
  return {
    beforeRequest: (installationId) => {
      events.push(`beforeRequest:${installationId}`);
      return inner.beforeRequest(installationId);
    },
    recordRateLimit: (installationId, rateLimit) => {
      events.push(`recordRateLimit:${installationId}`);
      return inner.recordRateLimit(installationId, rateLimit);
    },
  };
}

/** Poison paths: any real Git execution here would fail, never succeed. */
export const POISON_OPTIONS: LocalRepairHostOptionsV1 = {
  stateRoot: "/nonexistent/sentinel-poison-state",
  sourceDir: "/nonexistent/sentinel-poison-source",
  controllerSha: SHA1,
  githubToken: "dummy-token",
  modelToken: "dummy-token",
  codexExecutable: "/nonexistent/sentinel-poison-codex",
  denoExecutable: "/nonexistent/sentinel-poison-deno",
  trustedPath: "/nonexistent/sentinel-poison-bin",
};

export const POISON_SOURCE = "/nonexistent/sentinel-poison-source";

export const POISON_SCRATCH = "/nonexistent/sentinel-poison-scratch";

export const GIT_FAILED_TEXT = "git command failed";

// ---------------------------------------------------------------------------
// Private local model-result receipts: minimal explicit projection, unique
// 0600 files in 0700 directories and fixed reason classification. Real
// temporary directory only; no model, network or external call.
// ---------------------------------------------------------------------------

export const DUMMY_ISSUE_BODY = "dummy-issue-body-secret-marker";

export const DUMMY_EVIDENCE_REF = "dummy-evidence-ref-marker";

export const DUMMY_CHANGED_PATH = "src/dummy-changed-path-marker.ts";

export const DUMMY_RAW_ERROR = "dummy-raw-error-marker";

export const DUMMY_INVOCATION = "dummy-invocation-marker";

export const DUMMY_PROVIDER = "dummy-provider-marker";

export const DUMMY_THREAD = "dummy-thread-marker";

export const DUMMY_TURN = "dummy-turn-marker";

export const DUMMY_MODEL = "dummy-observed-model-marker";

export const DUMMY_REASONING = "dummy-observed-reasoning-marker";

/** Capture console.log so advisory emission can be asserted and restored. */
export function captureConsoleLog(): { lines: string[]; restore: () => void } {
  const original = console.log;
  const lines: string[] = [];
  console.log = ((...args: unknown[]) => {
    lines.push(
      args.map((arg) => typeof arg === "string" ? arg : String(arg)).join(" "),
    );
  }) as typeof console.log;
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

export function modelRequest(): ModelRunRequestV1 {
  return {
    taskId: asWorkItemId("issue-42"),
    repository: { ...REPO },
    base: SHA1,
    issue: { number: 42, title: "receipt", body: DUMMY_ISSUE_BODY },
    evidence: [{ kind: "replay_result", ref: DUMMY_EVIDENCE_REF }],
    model: "gpt-reserve",
    reasoning: "max",
    maxDurationMs: 1_200_000,
    maxOutputChars: 400_000,
  };
}

/** Receipt fixture with explicit overrides; candidate defaults to present. */
export function receipt(
  overrides: {
    outcome?: ModelRunReceiptV1["outcome"];
    error?: string | null;
    terminalOrigin?: "runtime" | "host-timeout";
    observedTerminalStatus?: "completed" | "interrupted" | "failed" | null;
    outputChars?: number;
    candidate?: boolean;
    provider?: string;
    threadId?: string;
    turnId?: string;
    observedModel?: string;
    observedReasoning?: string;
    durationMs?: number;
  } = {},
): PortResultV1<ModelRunReceiptV1> {
  return {
    ok: true,
    value: {
      invocationId: DUMMY_INVOCATION,
      outcome: overrides.outcome ?? "completed",
      actual: {
        evidenceKind: "request-runtime",
        provider: overrides.provider ?? "sentinel-host",
        threadId: overrides.threadId ?? "thread-1",
        turnId: overrides.turnId ?? "turn-1",
        terminalOrigin: overrides.terminalOrigin ?? "runtime",
        observedTerminalStatus: overrides.observedTerminalStatus !== undefined
          ? overrides.observedTerminalStatus
          : "completed",
        observedModel: overrides.observedModel ?? "gpt-reserve",
        observedReasoning: overrides.observedReasoning ?? "max",
        durationMs: overrides.durationMs ?? 1_234,
        outputChars: overrides.outputChars ?? 100,
      },
      candidate: overrides.candidate === false ? null : {
        head: SHA3,
        checkpointSha: null,
        changedPaths: [DUMMY_CHANGED_PATH],
      },
      error: overrides.error ?? null,
    },
  };
}

export const SAFE_DIAGNOSTIC_KEYS = [
  "base",
  "candidatePresent",
  "durationMs",
  "errorKind",
  "kind",
  "observedAt",
  "observedTerminalStatus",
  "outcome",
  "outputChars",
  "reason",
  "reasonCode",
  "taskKey",
  "terminalOrigin",
  "version",
];

/**
 * Real temporary Git fixture for the checkout base tests: a source repository
 * with two linear development commits plus an unrelated (divergent) root commit
 * and a candidate commit, and a clean private state root. Credential-free local
 * commands only; testGitEnv pins Git configuration and identity.
 */
export async function checkoutFixture() {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-checkout-",
  });
  try {
    const env = testGitEnv(`${root}/git-home`);
    await Deno.mkdir(`${root}/git-home`, { recursive: true });
    await Deno.mkdir(`${root}/scratch`, { recursive: true });
    const source = `${root}/source`;
    await Deno.mkdir(source, { recursive: true });
    const git = (cwd: string, args: string[]) => gitRun(cwd, args, env);
    const must = async (cwd: string, args: string[]) => {
      const result = await git(cwd, args);
      assert.ok(result.ok, `${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    await must(source, ["init", "-q"]);
    await Deno.writeTextFile(`${source}/file.txt`, "one\n");
    await must(source, ["add", "file.txt"]);
    await must(source, ["commit", "-qm", "one"]);
    const oldBase = await must(source, ["rev-parse", "HEAD"]);
    const branch = await must(source, ["rev-parse", "--abbrev-ref", "HEAD"]);
    await Deno.writeTextFile(`${source}/file.txt`, "one\ntwo\n");
    await must(source, ["commit", "-qam", "two"]);
    const newBase = await must(source, ["rev-parse", "HEAD"]);
    await must(source, ["checkout", "-q", "-b", "candidate", oldBase]);
    await Deno.writeTextFile(`${source}/file.txt`, "candidate\n");
    await must(source, ["commit", "-qam", "candidate"]);
    const candidate = await must(source, ["rev-parse", "HEAD"]);
    await must(source, ["checkout", "-q", "--orphan", "divergent"]);
    await must(source, ["rm", "-q", "-rf", "."]);
    await Deno.writeTextFile(`${source}/other.txt`, "divergent\n");
    await must(source, ["add", "other.txt"]);
    await must(source, ["commit", "-qm", "divergent"]);
    const divergent = await must(source, ["rev-parse", "HEAD"]);
    await must(source, ["checkout", "-q", branch]);
    return {
      root,
      env,
      git,
      must,
      source,
      oldBase,
      newBase,
      candidate,
      divergent,
      key: await localCheckoutKey("issue-1"),
      stateRoot: `${root}/state`,
      scratch: `${root}/scratch`,
      trustedPath: env.PATH ?? "/usr/bin:/bin",
    };
  } catch (error) {
    await Deno.remove(root, { recursive: true }).catch(() => {});
    throw error;
  }
}

type CheckoutFixture = Awaited<ReturnType<typeof checkoutFixture>>;

/** Request the checkout for the fixture key at the given exact base. */
export function requestCheckout(fixture: CheckoutFixture, base: string) {
  return ensureTaskCheckout({
    taskId: "issue-1",
    base: base as GitSha,
    key: fixture.key,
    stateRoot: fixture.stateRoot,
    sourcePath: fixture.source,
    scratch: fixture.scratch,
    trustedPath: fixture.trustedPath,
  });
}

/** Exact revision of `rev` inside the fixture checkout. */
export async function checkoutRev(
  fixture: CheckoutFixture,
  rev: string,
): Promise<string> {
  return await fixture.must(
    `${fixture.stateRoot}/checkouts/${fixture.key}`,
    ["rev-parse", rev],
  );
}

export async function localTestPathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function localTestDirEntries(path: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  return names;
}

/**
 * Create one fixture link through absolute `/bin/ln` with an empty environment:
 * no scoped Deno permission beyond ordinary reads is required, and the child
 * never observes the test process environment. The command must succeed.
 */
export async function localTestLink(args: string[]): Promise<void> {
  const linked = await new Deno.Command("/bin/ln", {
    args,
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  }).output();
  assert.equal(linked.code, 0, `ln ${args.join(" ")} must create the fixture`);
}
