/** Actual Actions composition with local Git state and a scripted external transport. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_RUNTIME_ID,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  parseHostedExecutionIntentV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { localCheckoutKey } from "../../src/host/local-checkout.ts";
import { LocalSessionTracker } from "../../src/host/local-client.ts";
import {
  type CodexSessionV1,
  CodexSubprocessSession,
  type CodexTransportOptionsV1,
} from "../../src/repair/codex-transport.ts";
import { ScriptedSession } from "../repair/model-port-helpers.ts";
import {
  FakeClock,
  hostedEnv,
  RUN_ATTEMPT,
  RUN_ID,
} from "./hosted-runtime-fixture.ts";
import { makeRemoteCtx, T0, testGitEnv } from "../state/helpers.ts";
import { hostedSeedRig } from "./hosted-self-dependencies-fixtures.ts";

export async function actionsSelfSeedRig() {
  const rig = await hostedSeedRig();
  await Deno.writeTextFile(
    `${rig.launcher}/.gitignore`,
    ".sentinel/\n.sentinel-artifacts/\n.sentinel-actions-state/\n",
  );
  await Deno.writeTextFile(
    `${rig.launcher}/sentinel.targets.json`,
    JSON.stringify(["Ubiquity-Sentinel/sentinel"]) + "\n",
  );
  await rig.git(["add", ".gitignore", "sentinel.targets.json"], rig.launcher);
  await rig.git(["commit", "-qm", "host fixture self target"], rig.launcher);
  const base = await rig.git(["rev-parse", "HEAD"], rig.launcher) as GitSha;
  await rig.git(["fetch", "--quiet", rig.launcher, base], rig.runtime);
  await rig.git(["checkout", "--quiet", "--detach", base], rig.runtime);
  const remote = await makeRemoteCtx(
    rig.root,
    testGitEnv(`${rig.root}/git-home`),
  );
  const release = createReleaseStateStore({
    scratchDir: `${rig.root}/release`,
    remoteUrl: remote.remoteUrl,
  });
  const execution = parseHostedExecutionIntentV1({
    id: `${RUN_ID}:${RUN_ATTEMPT}:repair`,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    launcherSha: base,
    purpose: "ordinary",
    revision: base,
    generation: 1,
    releaseId: null,
    createdAt: T0 + 10_000,
  });
  const prior = parseHostedExecutionIntentV1({
    ...execution,
    id: `${RUN_ID - 1}:${RUN_ATTEMPT}:repair`,
    runId: RUN_ID - 1,
    purpose: "bootstrap",
    createdAt: T0,
  });
  const initial = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedReleases: [],
    githubCooldowns: [],
    hostedRuntimes: [{
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: base,
      generation: 1,
      lastHealthyProof: null,
      lastExecutionProof: null,
      nextOrdinaryAt: T0,
      execution: prior,
      createdAt: T0,
      updatedAt: T0,
    }],
  });
  const written = await release.writeRelease(initial, null);
  assert(written.ok && written.value.status === "applied");
  const read = await release.readRelease();
  assert(read.ok && read.value.status === "found");
  const proof = {
    execution: prior,
    workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
    workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
    repository: "Ubiquity-Sentinel/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 101,
    startedAt: T0,
    finishedAt: T0 + 1000,
    observedAt: T0 + 1000,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: base,
    terminalAt: T0 + 1000,
    logDigest: "a".repeat(64),
  };
  const settled = await release.writeRelease(
    parseReleaseStateSnapshotV1({
      ...read.value.snapshot,
      stateHead: read.value.head,
      sequence: 2,
      updatedAt: T0 + 10_000,
      hostedRuntimes: [{
        ...read.value.snapshot.hostedRuntimes[0],
        execution: null,
        lastHealthyProof: proof,
        lastExecutionProof: proof,
        updatedAt: T0 + 10_000,
      }],
    }),
    read.value.head,
  );
  assert(settled.ok && settled.value.status === "applied");
  const ready = await release.readRelease();
  assert(ready.ok && ready.value.status === "found");
  const started = await release.writeRelease(
    parseReleaseStateSnapshotV1({
      ...ready.value.snapshot,
      stateHead: ready.value.head,
      sequence: 3,
      updatedAt: T0 + 10_000,
      hostedRuntimes: [{
        ...ready.value.snapshot.hostedRuntimes[0],
        execution,
        updatedAt: T0 + 10_000,
      }],
    }),
    ready.value.head,
  );
  assert(started.ok && started.value.status === "applied");
  const bin = `${rig.root}/bin`;
  await Deno.mkdir(bin);
  await Deno.writeTextFile(`${bin}/codex`, "#!/bin/sh\nexit 99\n");
  await Deno.chmod(`${bin}/codex`, 0o700);
  const env = {
    ...hostedEnv(base),
    PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
    HOME: `${rig.root}/host-home`,
    SENTINEL_MODEL_ID: "gpt-6.1-sol",
    GITHUB_TOKEN: "synthetic-native-credential-marker",
    UOS_AI_TOKEN: "synthetic-model-credential-marker",
  };
  const request = {
    ...rig.request,
    base,
    model: "gpt-6.1-sol",
    repository: { ...rig.request.repository, installationId: 0 },
  };
  const stateRoot = `${rig.runtime}/.sentinel-actions-state`;
  const key = await localCheckoutKey(request.taskId);
  return {
    ...rig,
    base,
    request,
    env,
    release,
    remote,
    clock: new FakeClock(T0 + 10_000),
    stateRoot,
    checkout: `${stateRoot}/checkouts/${key}`,
    client: `${stateRoot}/clients/${key}`,
  };
}

/** The host still constructs the actual port, tracker, and subprocess options. */
export function fakeActionsModelTransport(
  atTurn: (options: CodexTransportOptionsV1) => Promise<void>,
) {
  const original = LocalSessionTracker.prototype.open;
  const calls: CodexTransportOptionsV1[] = [];
  LocalSessionTracker.prototype.open = function <
    Session extends CodexSessionV1,
  >(factory: () => Session): Session {
    const actual = factory();
    assert(actual instanceof CodexSubprocessSession);
    // Inspect the actual immutable constructor input at the external transport
    // boundary. No LocalCheckoutModelPort/preparation method is replaced.
    const options =
      (actual as unknown as { options: CodexTransportOptionsV1 }).options;
    calls.push(structuredClone(options));
    const session = new class extends ScriptedSession {
      override async send(method: string, params: unknown): Promise<unknown> {
        if (method === "turn/start") await atTurn(options);
        return super.send(method, params);
      }
    }(
      {
        thread: { id: "thread-1" },
        model: "gpt-6.1-sol",
        reasoningEffort: "max",
        modelProvider: "uos",
        activePermissionProfile: { id: "sentinel-local" },
      },
      { turn: { id: "turn-1" } },
      [{
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "failed", durationMs: 1 },
        },
      }],
    );
    return original.call(this, (): CodexSessionV1 => session) as Session;
  };
  return {
    calls,
    restore: () => {
      LocalSessionTracker.prototype.open = original;
    },
  };
}

export function modelShellPolicy(config: string, checkout: string) {
  const environment: Record<string, string> = {};
  const writable: string[] = [];
  let section = "";
  for (const line of config.split("\n")) {
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    if (section === "[shell_environment_policy.set]" && line.includes(" = ")) {
      const [name, encoded] = line.split(" = ");
      environment[name] = JSON.parse(encoded);
    }
    const grant = /^("[^"]+") = "write"$/.exec(line);
    if (grant !== null) {
      const path = JSON.parse(grant[1]) as string;
      const workspace = section ===
        '[permissions.sentinel-local.filesystem.":workspace_roots"]';
      assert(
        workspace || section === "[permissions.sentinel-local.filesystem]",
      );
      writable.push(
        workspace ? path === "." ? checkout : `${checkout}/${path}` : path,
      );
    }
  }
  return { environment, writable };
}
