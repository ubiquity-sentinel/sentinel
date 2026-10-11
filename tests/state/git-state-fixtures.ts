/** Shared fixtures only; this module registers no tests. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseGitHubCooldownV1 } from "../../src/contracts/github-cooldown.ts";
import { parseAttemptMemoryRecordV1 } from "../../src/contracts/attempt-memory.ts";
import { buildMemoryLessonsV1 } from "../../src/repair/memory-lessons.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { GitStateStore } from "../../src/state/mod.ts";
import type { GitRunnerV1 } from "../../src/state/mod.ts";
import {
  gitRun,
  incidentEvidence,
  makeRemoteCtx,
  REPO,
  SHA1,
  SHA2,
  T0,
  testGitEnv,
  workRecord,
} from "./helpers.ts";

export const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
export const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/state\/git-state-fixtures\.ts$/,
  "",
);

export interface Ctx {
  tmp: string;
  env: Record<string, string>;
  remoteUrl: string;
  bare: string;
  work: string;
  cleanup(): Promise<void>;
}

export function repairSnapshot(
  overrides: Partial<RepairStateSnapshotV1> = {},
): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 1000,
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
    ...overrides,
  };
}

export function releaseSnapshot(
  overrides: Partial<ReleaseStateSnapshotV1> = {},
): ReleaseStateSnapshotV1 {
  return {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 1000,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
    ...overrides,
  };
}

/** Minimal valid durable GitHub cooldown, parsed by the frozen parser. */
export function githubCooldown(
  installationId: number,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof parseGitHubCooldownV1> {
  return parseGitHubCooldownV1({
    installationId,
    retryNotBefore: null,
    observedAt: T0,
    observationId: "a".repeat(64),
    secondaryBackoff: 0,
    ...overrides,
  });
}

export async function makeCtx(prefix: string): Promise<Ctx> {
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-state-test-${prefix}-`,
    dir: ROOT,
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
  ctx: Ctx,
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

export async function remoteHead(ctx: Ctx, ref: string): Promise<GitSha> {
  const result = await gitRunAt(ctx, ["--git-dir", ctx.bare, "rev-parse", ref]);
  if (!result.ok) throw new Error(`remote head failed: ${result.stderr}`);
  return result.stdout.trim() as GitSha;
}

export function gitRunAt(
  ctx: Ctx,
  args: string[],
): Promise<Awaited<ReturnType<typeof gitRun>>> {
  return gitRun(ctx.tmp, args, ctx.env);
}

export function appliedHead(
  result: Awaited<ReturnType<GitStateStore["writeRepair"]>>,
): GitSha {
  assert.ok(result.ok, "expected a store result");
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "applied");
  if (result.value.status !== "applied") throw new Error("unreachable");
  return result.value.head;
}

export async function pushRawStateTree(
  ctx: Ctx,
  parent: GitSha | null,
  ref: string,
  files: {
    path: string;
    text: string;
    mode?: "100644" | "100755" | "120000";
  }[],
): Promise<void> {
  const env = ctx.env;
  const reset = await gitRun(ctx.work, ["read-tree", "--empty"], env);
  if (!reset.ok) throw new Error(`read-tree --empty failed: ${reset.stderr}`);
  // Stage every entry via index machinery (hash-object + cacheinfo): a
  // symlink entry is a blob whose text is the link target, so no filesystem
  // symlink is ever created and the recorded mode is exactly what we set.
  for (const file of files) {
    const blobFile = `${ctx.work}/__raw-blob`;
    await Deno.writeTextFile(blobFile, file.text);
    const blob = await gitRun(ctx.work, ["hash-object", "-w", blobFile], env);
    await Deno.remove(blobFile).catch(() => {});
    if (!blob.ok) throw new Error(`hash-object failed: ${blob.stderr}`);
    const mode = file.mode ?? "100644";
    const stage = await gitRun(
      ctx.work,
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `${mode},${blob.stdout.trim()},${file.path}`,
      ],
      env,
    );
    if (!stage.ok) {
      throw new Error(`update-index ${file.path} failed: ${stage.stderr}`);
    }
  }
  const tree = await gitRun(ctx.work, ["write-tree"], env);
  if (!tree.ok) throw new Error(`write-tree failed: ${tree.stderr}`);
  const parentArgs = parent === null ? [] : ["-p", parent];
  const commit = await gitRun(
    ctx.work,
    ["commit-tree", tree.stdout.trim(), ...parentArgs, "-m", "raw state tree"],
    env,
  );
  if (!commit.ok) throw new Error(`commit-tree failed: ${commit.stderr}`);
  const push = await gitRun(
    ctx.work,
    ["push", "-q", "origin", `${commit.stdout.trim()}:${ref}`],
    env,
  );
  if (!push.ok) throw new Error(`push failed: ${push.stderr}`);
}

export function rawManifestText(
  sequence: number,
  updatedAt: number,
  stateHead: GitSha | null,
): string {
  return `${
    canonicalStringify({
      version: "v1",
      kind: "repair_state_manifest",
      sequence,
      updatedAt,
      stateHead,
    })
  }\n`;
}

export function duplicateRefEvidenceText(id: string): string {
  const valid = incidentEvidence(id);
  return `${
    canonicalStringify({
      ...valid,
      artifacts: [
        valid.artifacts[0],
        {
          ...valid.artifacts[0],
          digest: "f".repeat(64),
          sizeBytes: valid.artifacts[0].sizeBytes + 1,
        },
      ],
    })
  }\n`;
}

export const CANDIDATE_REF = `refs/heads/sentinel-candidates/${
  "ab".repeat(32)
}`;
export const PRODUCING_RESERVATION = "cd".repeat(32);

/** New-format work record: a coherent preserved candidate on the target. */
export function parkedCandidateRecord(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return workRecord(id, {
    nextStep: "review",
    wait: { reason: "review_pending", since: T0, until: null },
    target: {
      base: SHA1,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: SHA2,
      pr: 7,
      candidateState: {
        preserved: {
          operationKey: `impl:${PRODUCING_RESERVATION}`,
          base: SHA1,
          head: SHA2,
          ref: CANDIDATE_REF,
        },
        publishedHead: SHA2,
      },
    },
    ...overrides,
  });
}

export async function memoryLessonsFixture(
  memory: ReturnType<typeof attemptMemory>,
) {
  const snapshot = repairSnapshot({ attemptMemory: [memory] });
  const built = await buildMemoryLessonsV1(snapshot, T0 + 5000);
  return built[0];
}

/** Minimal valid attempt-memory record for the state round-trip suite. */
export function attemptMemory(count = 2) {
  return parseAttemptMemoryRecordV1({
    version: "v1",
    kind: "attempt_memory",
    id: "a".repeat(64),
    repository: REPO,
    taskId: "issue-ubiquity-sentinel-48",
    base: SHA1,
    purpose: "implementation",
    entries: [
      {
        fingerprint: "b".repeat(64),
        stage: "model",
        failureClass: "semantic_no_progress",
        detail: "model run did not complete with a trusted candidate",
        controllerSha: SHA2,
        count,
        firstAtMs: T0,
        lastAtMs: T0 + 1000,
      },
    ],
  });
}
