import {
  exactCandidateLifecycle,
  FakeClock,
  makeIntegrationCtx,
  REPO,
  SHA1,
  T0,
} from "./helpers.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import {
  composedConfig,
  ExactHeadFakeGithub,
  gatewayAuth,
  RecordingReplayRuntime,
} from "./causal-capture-ports.ts";
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
import {
  FakeCodexSession,
  makeConcreteVerifier,
  mutateVerifier,
  sessionVerifier,
} from "./causal-capture-verifier.ts";
import type { RepairHostOptionsV1 } from "../../src/host/repair.ts";
import type { FixtureDigest, GitSha } from "../../src/contracts/brands.ts";
import { runComposedRepairHost } from "../../src/host/run.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ToyRepoV1 } from "./causal-capture-toy.ts";
import type { GatewayCausalProofV1 } from "../../src/replay/causal-proof.ts";
import assert from "node:assert/strict";
import {
  craftCapture,
  EXPECTED_FAILURE,
  GATEWAY_COMMAND,
  GATEWAY_LIMITS,
  hexToBytes,
  INDEX_PATH,
  REPLAY_PATH,
  TEST_COMMAND,
  TEST_ID,
} from "./causal-capture-fixture.ts";
import { artifactRef } from "../../src/adapters/gateway/incident-adapter.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { markerProofParser } from "../../src/replay/fixture.ts";
import { toyIsolation } from "../replay/helpers.ts";
import { composeRepairHost } from "../../src/host/repair.ts";
import type { GatewayReplayComposition } from "../../src/adapters/gateway/replay-composition.ts";

interface CausalRigV1 {
  ctx: Awaited<ReturnType<typeof makeIntegrationCtx>>;
  clock: FakeClock;
  store: ReturnType<typeof createRepairStateStore>;
  github: ExactHeadFakeGithub;
  transport: ReturnType<typeof recordingTransport>;
  gatewayStore: LocalArtifactStore;
  sessions: FakeCodexSession[];
  replayRuntime: RecordingReplayRuntime;
  options: RepairHostOptionsV1;
  /** Deterministic candidate head the fake implementation delivers. */
  setCandidateHead(head: GitSha): void;
  run(
    deadlineMs?: number,
  ): Promise<Awaited<ReturnType<typeof runComposedRepairHost>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
  cleanup(): Promise<void>;
}

export async function makeCausalRig(
  toy: ToyRepoV1,
  prefix: string,
  options: {
    /**
     * When true the rig builds the CONCRETE trusted local consumer verifier
     * over the toy source (real executions of the committed consumer). A
     * mutateProof wrapper is used ONLY for negative bound-mismatch cases.
     */
    concrete?: boolean;
    mutateProof?: (proof: GatewayCausalProofV1) => GatewayCausalProofV1 | null;
    capture?: { bodyInput?: string; completed?: boolean };
  } = {},
): Promise<CausalRigV1> {
  const ctx = await makeIntegrationCtx(`causal-${prefix}`);
  const clock = new FakeClock(T0);
  const store = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const configs = [composedConfig(REPO)];
  let candidateHead: GitSha | null = null;
  // The positive candidate head depends on the composed fixture bytes and is
  // resolved after this rig is built, so the exact preservation assertion
  // reads it at call time (always set before the positive run).
  const github = new ExactHeadFakeGithub({
    baseSha: toy.originalSha,
    candidateLifecycle: exactCandidateLifecycle({
      base: toy.originalSha,
      head: () => {
        const head = candidateHead;
        assert.ok(
          head !== null,
          "candidate head must be set before preservation",
        );
        return head;
      },
    }),
  });
  const keyBytes = hexToBytes(
    JSON.parse(
      await Deno.readTextFile(
        new URL("../fixtures/gateway/producer-golden-v2.json", import.meta.url),
      ),
    ).syntheticKeyHex,
  );
  const capture = await craftCapture(
    keyBytes,
    toy.originalSha,
    T0,
    options.capture,
  );
  const row = makeIndexRow({
    incident_id: INCIDENT_A,
    fingerprint: capture.fingerprint,
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
    evidence_expires_at_ms: capture.manifest.expires_at_ms as number,
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
  const replayRuntime = new RecordingReplayRuntime(
    new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin"),
  );
  // The concrete verifier shares the same recording runtime so the test can
  // observe the actual consumer executions (boundary evidence).
  const concrete = options.concrete === true ||
    options.mutateProof !== undefined;
  const inner = concrete
    ? await makeConcreteVerifier(toy, ctx.tmp, replayRuntime)
    : null;
  const verifier = inner === null
    ? undefined
    : options.mutateProof === undefined
    ? inner
    : mutateVerifier(inner, options.mutateProof);
  const optionsBag: RepairHostOptionsV1 = {
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
      testCommandId: TEST_COMMAND,
      testIds: [TEST_ID],
      expectedFailure: EXPECTED_FAILURE,
      verifier,
    },
    replay: {
      source: { kind: "local", path: toy.root },
      scratchDir: `${ctx.tmp}/replay-scratch`,
      policy: {
        bundleScopes: ["tests/", "scripts/"],
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
          assert.ok(
            candidateHead !== null,
            "candidate head must be set before the loop runs",
          );
          return Promise.resolve({
            head: candidateHead!,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          });
        },
      },
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
    github,
    transport,
    gatewayStore,
    sessions,
    replayRuntime,
    options: optionsBag,
    setCandidateHead: (head: GitSha) => {
      candidateHead = head;
    },
    // Default logical allowance (30 logical minutes) covers implementation,
    // full review and entrypoint finalization bounds, still under the
    // production 120-minute ceiling; the fake clock means no wall-clock wait.
    run: (deadlineMs = 1_800_000) =>
      runComposedRepairHost(optionsBag, {
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

/** Resolve the composed fixture + proof through the exact host composition. */
export async function resolveComposedFixture(
  rig: CausalRigV1,
): Promise<{
  fixtureRef: string;
  fixtureDigest: FixtureDigest;
  entries: { path: string; bytes: Uint8Array }[];
  proof: GatewayCausalProofV1 | undefined;
}> {
  const deps = composeRepairHost(rig.options);
  const composition = deps.incidents as GatewayReplayComposition;
  const read = await composition.readIncident(INCIDENT_A);
  assert.ok(read.ok && read.value !== null, JSON.stringify(read));
  const resolved = await composition.resolveFixture(
    read.value!.replay!.fixtureRef,
  );
  assert.ok(resolved.ok, JSON.stringify(resolved));
  if (!resolved.ok) throw new Error("fixture resolution failed");
  return {
    fixtureRef: read.value!.replay!.fixtureRef,
    fixtureDigest: read.value!.replay!.fixtureDigest!,
    entries: resolved.value.entries,
    proof: resolved.value.causalProof,
  };
}

export async function walkFiles(
  dir: string,
  out: string[] = [],
): Promise<string[]> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walkFiles(path, out);
      else out.push(path);
    }
  } catch {
    // directory may not exist (the fake model writes no checkout files)
  }
  return out;
}
