/** Credential-free temporary Git, state and target composition fixtures; no test registrations. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_RUNTIME_ID,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  parseHostedExecutionIntentV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type { GitHubIssueV1 } from "../../src/contracts/ports.ts";
import {
  portError,
  portOk,
  type PortResultV1,
  type RepairStateWriter,
  type StateReadResultV1,
  type StateReadView,
  type StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
  type RepairGitStateStore,
} from "../../src/state/mod.ts";
import { FakeClock, FakeGithub, MemoryState } from "../repair/helpers.ts";
import { gitRun, makeRemoteCtx, T0, testGitEnv } from "../state/helpers.ts";
import { createHostedReviewOwnerCustody } from "../../src/host/review-owner-host.ts";
import type { ReviewOwnerCustodyBroker } from "../../src/host/review-owner-custody.ts";
import { response, snapshotWire } from "../github/merge-queue-fixtures.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";

export const ROOT = decodeURIComponent(
  new URL("../../", import.meta.url).pathname,
).replace(/\/$/, "");
export const PROVIDER = "uos";
export function issue(number: number): GitHubIssueV1 {
  return {
    number,
    title: "issue " + number,
    body: "repair target " + number,
    state: "open",
    author: null,
    labels: [],
    createdAt: T0,
    updatedAt: T0,
    closedAt: null,
    relations: { openBlockers: [], subIssueCount: 0 },
  };
}
export class TargetGithub extends FakeGithub {
  row = issue(1);
  override listOpenIssues() {
    this.calls.push("listOpenIssues");
    return Promise.resolve(portOk([this.row]));
  }
  override readIssue(number: number) {
    this.calls.push("readIssue:" + number);
    return Promise.resolve(
      portOk(number === this.row.number ? this.row : null),
    );
  }
}
export async function checked(
  dir: string,
  args: string[],
  env: Record<string, string>,
) {
  const result = await gitRun(dir, args, env);
  assert.ok(result.ok, result.stderr);
  return result.stdout.trim();
}
export async function checkout(
  path: string,
  env: Record<string, string>,
  files: Record<string, string>,
) {
  await Deno.mkdir(path, { recursive: true });
  await checked(path, ["init", "-q", "-b", "development"], env);
  for (const [name, bytes] of Object.entries(files)) {
    await Deno.writeTextFile(path + "/" + name, bytes);
  }
  await checked(path, ["add", "-A"], env);
  await checked(path, ["commit", "-q", "-m", "fixture"], env);
  return await checked(path, ["rev-parse", "HEAD"], env) as GitSha;
}
/**
 * Test-local repair-state adapter over the shared MemoryState. Only the clock
 * fixture's repair half is persisted here: the real store's expected-head CAS,
 * snapshot validation and sequence/time rules stay enabled, and every value
 * crossing the boundary is an independent copy so no consumer can mutate the
 * fixture's authoritative snapshot in place. It is deliberately repair-only
 * (MemoryState also lacks the real store's validateRepairTransition parity),
 * which the narrowed clock assertions and the explicit small real-Git recovery
 * plus sibling case cover together. Release reads never come from here; the
 * real Git release store stays authoritative.
 */
export class CopyingRepairState
  implements Pick<StateReadView, "readRepair">, RepairStateWriter {
  private readonly inner = new MemoryState();

  async readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    const read = await this.inner.readRepair();
    if (!read.ok || read.value.status !== "found") return read;
    return portOk({
      ...read.value,
      snapshot: structuredClone(read.value.snapshot),
    });
  }

  async writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    // The real store rejects a snapshot whose stateHead is not the expected
    // remote head before any transition check; MemoryState omits that check, so
    // this adapter applies it with the identical typed diagnostic.
    if (next.stateHead !== expectedHead) {
      return portError(
        "invalid",
        "snapshot stateHead must equal the expected remote head",
      );
    }
    return await this.inner.writeRepair(
      structuredClone(next),
      expectedHead,
    );
  }
}

export async function rig(
  healthy = true,
  purpose: "ordinary" | "bootstrap" | "prior" | "candidate" | "rollback" =
    "ordinary",
  fastRepair = false,
) {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-matrix-actions-",
    dir: ROOT,
  });
  await Deno.mkdir(root + "/home");
  const env = testGitEnv(root + "/home");
  const sha = await checkout(root + "/seed", env, {
    "sentinel.targets.json": JSON.stringify([
      "ubiquity/sentinel",
      "ubiquity/ai.ubq.fi",
    ]),
    ".gitignore": ".sentinel-actions-state/\n",
    "base.txt": "self\n",
  });
  const foreignSha = await checkout(root + "/foreign", env, {
    "base.txt": "foreign\n",
  });
  const remote = await makeRemoteCtx(root, env);
  const clock = new FakeClock(T0 + 10000);
  const execution = parseHostedExecutionIntentV1({
    id: "71:1:repair",
    runId: 71,
    runAttempt: 1,
    launcherSha: sha,
    purpose,
    revision: sha,
    generation: 1,
    releaseId: purpose === "ordinary" || purpose === "bootstrap"
      ? null
      : "release:test",
    createdAt: T0 + 10000,
  });
  const prior = parseHostedExecutionIntentV1({
    ...execution,
    id: "70:1:repair",
    runId: 70,
    purpose: "bootstrap",
    releaseId: null,
    createdAt: T0,
  });
  const proof = {
    execution: prior,
    workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
    workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 101,
    startedAt: T0,
    finishedAt: T0 + 1000,
    observedAt: T0 + 1000,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: sha,
    terminalAt: T0 + 1000,
    logDigest: "a".repeat(64),
  };
  const release = createReleaseStateStore({
    scratchDir: root + "/release",
    remoteUrl: remote.remoteUrl,
  });
  const seeded = await release.writeRelease(
    parseReleaseStateSnapshotV1({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: clock.now(),
      releases: [],
      hostedReleases: [],
      githubCooldowns: [],
      hostedRuntimes: [{
        version: "v1",
        kind: "hosted_runtime",
        id: HOSTED_RUNTIME_ID,
        activeRevision: sha,
        generation: 1,
        lastHealthyProof: null,
        lastExecutionProof: null,
        nextOrdinaryAt: T0,
        execution: healthy ? prior : execution,
        createdAt: T0,
        updatedAt: clock.now(),
      }],
    }),
    null,
  );
  assert.ok(
    seeded.ok && seeded.value.status === "applied",
    JSON.stringify(seeded),
  );
  if (healthy) {
    const read = await release.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    const previous = read.value.snapshot.hostedRuntimes[0]!;
    const settled = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: 2,
        updatedAt: clock.now(),
        hostedRuntimes: [{
          ...previous,
          execution: null,
          lastHealthyProof: proof,
          lastExecutionProof: proof,
          updatedAt: clock.now(),
        }],
      }),
      read.value.head,
    );
    assert.ok(
      settled.ok && settled.value.status === "applied",
      JSON.stringify(settled),
    );
    const ready = await release.readRelease();
    assert.ok(ready.ok && ready.value.status === "found");
    const started = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...ready.value.snapshot,
        stateHead: ready.value.head,
        sequence: 3,
        updatedAt: clock.now(),
        hostedRuntimes: [{
          ...ready.value.snapshot.hostedRuntimes[0]!,
          execution,
          updatedAt: clock.now(),
        }],
      }),
      ready.value.head,
    );
    assert.ok(
      started.ok && started.value.status === "applied",
      JSON.stringify(started),
    );
  }
  const realStore = createRepairStateStore({
    scratchDir: root + "/repair",
    remoteUrl: remote.remoteUrl,
  });
  // The clock fixture shares ONE repair transport across planner, cells, budget
  // and aggregate. Only that scenario narrows the repair half to memory (real
  // CAS/sequence/validation and copy boundaries); every release read and every
  // target Git object stays real.
  const fastState = fastRepair ? new CopyingRepairState() : null;
  const store: RepairGitStateStore = fastState === null
    ? realStore
    : Object.assign(
      Object.create(Object.getPrototypeOf(realStore)) as RepairGitStateStore,
      realStore,
      {
        readRepair: () => fastState!.readRepair(),
        writeRepair: (
          next: RepairStateSnapshotV1,
          expectedHead: GitSha | null,
        ) => fastState!.writeRepair(next, expectedHead),
      },
    );
  const github = new Map<string, TargetGithub>();
  for (
    const [slug, base] of [["ubiquity/sentinel", sha], [
      "ubiquity/ai.ubq.fi",
      foreignSha,
    ]] as const
  ) {
    github.set(
      slug,
      new TargetGithub({
        baseSha: base,
        candidateLifecycle: {
          preserveCandidate: () => Promise.resolve(portOk(undefined)),
        },
        reviewUnavailable: true,
      }),
    );
  }
  await Deno.mkdir(root + "/bin");
  await Deno.writeTextFile(root + "/bin/codex", "#!/bin/sh\nexit 1\n");
  await Deno.chmod(root + "/bin/codex", 0o700);
  const jobs = new Map<string, string>();
  let currentRun = 71;
  const brokers: ReviewOwnerCustodyBroker[] = [];
  async function advanceRun(runId: number) {
    const read = await release.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    const runtime = read.value.snapshot.hostedRuntimes[0]!;
    assert.ok(runtime.execution);
    const settlement = {
      ...proof,
      execution: runtime.execution,
      startedAt: runtime.execution.createdAt,
      finishedAt: clock.now(),
      observedAt: clock.now(),
      terminalAt: clock.now(),
      logDigest: "b".repeat(64),
    };
    const saved = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: read.value.snapshot.sequence + 1,
        updatedAt: clock.now(),
        hostedRuntimes: [{
          ...runtime,
          execution: null,
          lastHealthyProof: settlement,
          lastExecutionProof: settlement,
          updatedAt: clock.now(),
        }],
      }),
      read.value.head,
    );
    assert.ok(
      saved.ok && saved.value.status === "applied",
      JSON.stringify(saved),
    );
    clock.advance(1);
    const next = await release.readRelease();
    assert.ok(next.ok && next.value.status === "found");
    const nextExecution = parseHostedExecutionIntentV1({
      ...execution,
      id: runId + ":1:repair",
      runId,
      createdAt: clock.now(),
    });
    const started = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...next.value.snapshot,
        stateHead: next.value.head,
        sequence: next.value.snapshot.sequence + 1,
        updatedAt: clock.now(),
        hostedRuntimes: [{
          ...next.value.snapshot.hostedRuntimes[0]!,
          execution: nextExecution,
          updatedAt: clock.now(),
        }],
      }),
      next.value.head,
    );
    assert.ok(
      started.ok && started.value.status === "applied",
      JSON.stringify(started),
    );
    currentRun = runId;
  }
  async function job(name: string, role: string) {
    const dir = root + "/" + name + "/runtime";
    await Deno.mkdir(root + "/" + name, { recursive: true });
    await checked(root, ["clone", "-q", root + "/seed", dir], env);
    jobs.set(name, dir);
    const input = {
      clock,
      workDir: dir,
      stateRemoteUrl: remote.remoteUrl,
      refreshSelf: () => Promise.resolve(sha),
      resolveDefaultBranch: () => Promise.resolve("development"),
      preflight: () => Promise.resolve(),
      env: {
        GITHUB_RUN_ID: String(currentRun),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REPOSITORY: "ubiquity/sentinel",
        GITHUB_REF: "refs/heads/sentinel-supervisor",
        GITHUB_SHA: sha,
        GITHUB_WORKFLOW_SHA: sha,
        GITHUB_WORKFLOW_REF:
          "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
        GITHUB_JOB: role,
        GITHUB_TOKEN: "fake-read-token",
        SENTINEL_SUPERVISOR_TOKEN: "fake-app-token",
        UOS_AI_TOKEN: "fake-model-token",
        // The protected owner requires an absolute trusted tool search path.
        PATH: [
          root + "/bin",
          ...(Deno.env.get("PATH") ?? "/usr/bin:/bin").split(":").filter(
            (part) => part.startsWith("/"),
          ),
        ].join(":"),
        HOME: root + "/home",
        GITHUB_OUTPUT: root + "/" + name + "/output",
        SENTINEL_COOLDOWN_MODE: "off",
      },
      http: (request: HttpRequestV1) => {
        const path = new URL(request.url).pathname;
        if (
          request.method === "GET" &&
          path === "/repos/ubiquity/ai.ubq.fi/rules/branches/development"
        ) {
          return Promise.resolve(response([]));
        }
        if (
          request.method === "POST" && path === "/graphql" &&
          request.body?.includes("mergeQueue(branch:")
        ) {
          return Promise.resolve(response(snapshotWire(null)));
        }
        return Promise.reject(new Error("no external HTTP allowed"));
      },
      composeGithub: (
        config: { repository: { owner: string; name: string } },
      ) => github.get(config.repository.owner + "/" + config.repository.name)!,
      prepareTarget: async (
        config: { repository: { name: string } },
        source: string,
      ) => {
        if (config.repository.name === "sentinel") return;
        try {
          await Deno.stat(source);
        } catch {
          await Deno.mkdir(source.slice(0, source.lastIndexOf("/")), {
            recursive: true,
          });
          await checked(root, ["clone", "-q", root + "/foreign", source], env);
        }
      },
    };
    if (role === "repair") {
      const read = await release.readRelease();
      assert.ok(read.ok && read.value.status === "found");
      const owner = read.value.snapshot.hostedRuntimes[0]!.execution;
      if (owner?.purpose === "ordinary") {
        const broker = await createHostedReviewOwnerCustody({
          execution: owner,
          runtimeDir: dir,
          env: input.env,
        });
        brokers.push(broker);
        const descriptor = await broker.start(root);
        return {
          ...input,
          trustedStdin: JSON.stringify({ reviewCustody: descriptor }),
        };
      }
    }
    return input;
  }
  return {
    root,
    env,
    sha,
    foreignSha,
    clock,
    store,
    release,
    github,
    jobs,
    job,
    advanceRun,
    cleanup: async () => {
      for (const broker of brokers) await broker.dispose();
      await Deno.remove(root, { recursive: true });
    },
  };
}
