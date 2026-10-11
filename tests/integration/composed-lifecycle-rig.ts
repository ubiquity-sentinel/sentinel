import {
  exactCandidateLifecycle,
  FakeClock,
  makeIntegrationCtx,
  REPO,
  SHA1,
  T0,
} from "./helpers.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import {
  composedConfig,
  ExactHeadFakeGithub,
  FakeCodexSession,
  gatewayAuth,
  RecordingReplayRuntime,
  ScriptedCandidateRegistry,
  sessionVerifier,
} from "./composed-lifecycle-ports.ts";
import {
  CAPTURE_ID_A,
  INCIDENT_A,
  jsonResponse,
  makeIndexPage,
  makeIndexRow,
  makeReplayPage,
  recordingTransport,
} from "../adapters/gateway/helpers.ts";
import { LocalArtifactStore } from "../../src/adapters/gateway/store.ts";
import type { RepairHostOptionsV1 } from "../../src/host/repair.ts";
import { runComposedRepairHost } from "../../src/host/run.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ToyRepoV1 } from "./composed-lifecycle-toy.ts";
import { PRODUCER_COMMIT } from "./composed-lifecycle-release.ts";
import {
  craftCapture,
  EXPECTED_FAILURE,
  GATEWAY_COMMAND,
  GATEWAY_LIMITS,
  hexToBytes,
  INDEX_PATH,
  REPLAY_PATH,
  TEST_ID,
} from "./composed-lifecycle-capture.ts";
import { artifactRef } from "../../src/adapters/gateway/incident-adapter.ts";
import assert from "node:assert/strict";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { markerProofParser } from "../../src/replay/fixture.ts";
import { toyIsolation } from "../replay/helpers.ts";

interface RepairRigV1 {
  ctx: Awaited<ReturnType<typeof makeIntegrationCtx>>;
  clock: FakeClock;
  store: ReturnType<typeof createRepairStateStore>;
  configs: RepositoryConfigV1[];
  github: ExactHeadFakeGithub;
  transport: ReturnType<typeof recordingTransport>;
  gatewayStore: LocalArtifactStore;
  fingerprint: string;
  candidateRegistry: ScriptedCandidateRegistry;
  sessions: FakeCodexSession[];
  replayRuntime: RecordingReplayRuntime;
  options: RepairHostOptionsV1;
  run(
    deadlineMs?: number,
  ): Promise<Awaited<ReturnType<typeof runComposedRepairHost>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
  cleanup(): Promise<void>;
}

export async function makeRepairRig(
  toy: ToyRepoV1,
  prefix: string,
): Promise<RepairRigV1> {
  const ctx = await makeIntegrationCtx(`composed-${prefix}`);
  const clock = new FakeClock(T0);
  const store = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const configs = [composedConfig(REPO)];
  const github = new ExactHeadFakeGithub({
    baseSha: toy.originalSha,
    issues: [
      {
        number: 1,
        title: "composed issue one",
        body: "issue one body",
        createdAt: T0,
      },
      {
        number: 2,
        title: "composed issue two",
        body: "issue two body",
        createdAt: T0,
      },
    ],
    openIssues: [
      {
        number: 1,
        title: "composed issue one",
        body: "issue one body",
        createdAt: T0,
      },
      {
        number: 2,
        title: "composed issue two",
        body: "issue two body",
        createdAt: T0,
      },
    ],
    // Both produced candidates must be preserved before publication: the
    // explicit lifecycle asserts each exact base/head and the deterministic
    // preservation ref. No intentionally-missing-PR override in the positive
    // setup, so every read observes the same exact created PRs.
    candidateLifecycle: exactCandidateLifecycle(
      { base: toy.originalSha, head: PRODUCER_COMMIT },
      { base: toy.originalSha, head: toy.candidateSha },
    ),
  });
  const keyBytes = hexToBytes(
    JSON.parse(
      await Deno.readTextFile(
        new URL("../fixtures/gateway/producer-golden-v2.json", import.meta.url),
      ),
    ).syntheticKeyHex,
  );
  const capture = await craftCapture(keyBytes, toy.originalSha, T0);
  const row = makeIndexRow({
    incident_id: INCIDENT_A,
    fingerprint: capture.manifest.fingerprint,
    failing_revision: toy.originalSha,
    severity: "P1",
    first_seen_at_ms: T0,
    last_seen_at_ms: T0 + 3_000,
    count: 7,
    provenance: {
      endpoint: "https://ai.ubq.fi",
      captured_at_ms: T0,
      captured_by: "gateway",
    },
    evidence_ref: {
      ref: artifactRef(INCIDENT_A, CAPTURE_ID_A),
      digest: capture.digest,
    },
    evidence_expires_at_ms: capture.manifest.expires_at_ms,
  });
  const transport = recordingTransport((url) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([row]));
    }
    if (url.pathname === REPLAY_PATH) {
      return jsonResponse(makeReplayPage({
        manifest: capture.manifest,
        chunks: capture.chunks,
      }));
    }
    throw new Error(`unexpected gateway transport call: ${url.pathname}`);
  });
  const gatewayStore = new LocalArtifactStore({
    root: `${ctx.tmp}/store`,
    limits: GATEWAY_LIMITS,
  });
  const opened = await gatewayStore.open();
  assert.ok(opened.ok, `store open failed: ${JSON.stringify(opened)}`);

  const sessions: FakeCodexSession[] = [];
  const candidateRegistry = new ScriptedCandidateRegistry(
    [PRODUCER_COMMIT, toy.candidateSha],
    ["src/app.ts"],
  );
  const replayRuntime = new RecordingReplayRuntime(
    new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin"),
  );
  const options: RepairHostOptionsV1 = {
    configs,
    controllerSha: SHA1,
    clock,
    state: store,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state: store, clock }),
    gateway: {
      repository: REPO,
      transport,
      auth: gatewayAuth(),
      store: gatewayStore,
      keyBytes,
      policy: {
        publicModels: ["synthetic-model"],
        publicHeaders: { accept: ["text/event-stream"] },
      },
      commandId: GATEWAY_COMMAND,
      testIds: [TEST_ID],
      expectedFailure: EXPECTED_FAILURE,
    },
    replay: {
      source: { kind: "local", path: toy.root },
      scratchDir: `${ctx.tmp}/replay-scratch`,
      policy: {
        bundleScopes: ["tests/"],
        maxFixtureBytes: 512 * 1024,
        maxEntryBytes: 256 * 1024,
        proof: markerProofParser(),
      },
      isolation: toyIsolation(replayRuntime),
      runtime: replayRuntime,
    },
    model: {
      openSession: () => {
        const session = new FakeCodexSession();
        sessions.push(session);
        return Promise.resolve(session);
      },
      checkoutDir: `${ctx.tmp}/model-checkout`,
      checkout: {
        resolve: () => {
          const candidate = candidateRegistry.next();
          return Promise.resolve({
            head: candidate.head,
            checkpointSha: null,
            changedPaths: candidate.changedPaths,
          });
        },
      },
      // Trusted-host commit seam: the in-process fake session produces no
      // real worktree, so the deterministic candidate identity comes from
      // the checkout resolver and the commit step is acknowledged.
      commitCandidate: { commit: () => Promise.resolve(true) },
      // Explicit selected provider: required before any session opens, and it
      // always binds the concrete request/runtime receipt producer; the
      // verifier below is only an additional restriction after those checks.
      modelProvider: "sentinel-host",
      receiptVerifier: sessionVerifier,
    },
  };
  return {
    ctx,
    clock,
    store,
    configs,
    github,
    transport,
    gatewayStore,
    fingerprint: capture.manifest.fingerprint as string,
    candidateRegistry,
    sessions,
    replayRuntime,
    options,
    // The positive rig must admit a full declared review bound (10 minutes)
    // plus the five-minute operation margin inside the loop deadline; 60
    // minutes stays under the fixed 120-minute ceiling and the 90-minute model
    // cutoff, and the clock is fake so it costs no real time.
    run: (deadlineMs = 60 * 60_000) =>
      runComposedRepairHost(options, {
        deadline: clock.now() + deadlineMs,
        stepLimit: 32,
      }),
    snapshot: async () => {
      const read = await store.readRepair();
      assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
      if (!read.ok || read.value.status !== "found") {
        throw new Error("no repair state");
      }
      return read.value.snapshot;
    },
    cleanup: async () => {
      await ctx.cleanup();
    },
  };
}
