/** Minimal public live-state records, disposable Git stores and fake read-only GitHub. */
import assert from "node:assert/strict";
import {
  CONTROLLER,
  PUBLIC_CONTROLLER,
} from "./controller-identity-fixture.ts";
import seed from "../fixtures/hosted-runtime-live-seed.json" with {
  type: "json",
};
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import { HostedSupervisorGitHubClient } from "../../src/host/actions-supervisor-install-api.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import { recordFiles } from "../../src/state/state-codec.ts";
import { makeRemoteCtx, pushRawTree, testGitEnv } from "../state/helpers.ts";
import {
  DORMANT_HOSTED_POLICIES,
  FakeEvidence,
  ROOT,
  runProof,
} from "./actions-supervisor-fixture.ts";
import { FakeClock } from "./hosted-runtime-fixture.ts";

// The public case retains its captured prior. Private installation uses a new
// synthetic prior, never a relabelled public runtime, release or reservation.
export const LEGACY_RUNTIME =
  (PUBLIC_CONTROLLER
    ? "1838df313105bab219d71602695a7f758a65125e"
    : "e".repeat(40)) as GitSha;
export const SUCCESSOR = "f".repeat(40) as GitSha;
export const INSTALL_NOW = PUBLIC_CONTROLLER
  ? seed.runtime.updatedAt + 100_000
  : 1_790_000_000_000;

export async function liveInstallRig() {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-live-install-",
    dir: ROOT,
  });
  const env = testGitEnv(`${root}/home`);
  await Deno.mkdir(`${root}/home`, { recursive: true });
  const remote = await makeRemoteCtx(root, env);
  const release = createReleaseStateStore({
    scratchDir: `${root}/release`,
    remoteUrl: remote.remoteUrl,
  });
  const repair = createRepairStateStore({
    scratchDir: `${root}/repair`,
    remoteUrl: remote.remoteUrl,
  });
  const clock = new FakeClock(INSTALL_NOW);
  const historical = parseHostedExecutionIntentV1({
    ...(PUBLIC_CONTROLLER ? seed.runtime.lastHealthyProof.execution : {
      launcherSha: LEGACY_RUNTIME,
      runAttempt: 1,
    }),
    id: "4000:1:repair",
    runId: 4000,
    purpose: "bootstrap",
    releaseId: null,
    revision: LEGACY_RUNTIME,
    generation: 82,
    createdAt: INSTALL_NOW - 10_000,
  });
  const healthy = runProof(historical, "healthy");
  const snapshot = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: INSTALL_NOW,
    releases: [],
    hostedReleases: PUBLIC_CONTROLLER ? [seed.release] : [],
    githubCooldowns: [],
    hostedRuntimes: [{
      ...(PUBLIC_CONTROLLER ? seed.runtime : {
        version: "v1",
        kind: "hosted_runtime",
        id: CONTROLLER.runtimeId,
        createdAt: INSTALL_NOW - 20_000,
        nextOrdinaryAt: INSTALL_NOW,
      }),
      activeRevision: LEGACY_RUNTIME,
      generation: 82,
      execution: null,
      lastHealthyProof: healthy,
      lastExecutionProof: healthy,
      updatedAt: INSTALL_NOW,
    }],
  });
  const emptyRelease = { ...snapshot, hostedRuntimes: [], hostedReleases: [] };
  const released = await release.writeRelease(emptyRelease, null);
  assert.ok(released.ok && released.value.status === "applied");
  const releaseFiles = Object.fromEntries(
    (await recordFiles(snapshot, "release")).map((r) => [r.path, r.text]),
  );
  releaseFiles["manifest.json"] = canonicalStringify({
    version: "v1",
    kind: "release_state_manifest",
    stateHead: released.value.head,
    sequence: 2,
    updatedAt: INSTALL_NOW,
  }) + "\n";
  assert.ok(
    (await pushRawTree(
      remote,
      released.value.head,
      "refs/heads/sentinel-state/release",
      releaseFiles,
      env,
    )).ok,
  );
  const repairSnapshot = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: INSTALL_NOW,
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
  const repaired = await repair.writeRepair(repairSnapshot, null);
  assert.ok(repaired.ok && repaired.value.status === "applied");
  const repairFiles = Object.fromEntries(
    (await recordFiles(
      parseRepairStateSnapshotV1({
        ...repairSnapshot,
        reservations: PUBLIC_CONTROLLER ? [seed.reservation] : [],
      }),
      "repair",
    )).map((r) => [r.path, r.text]),
  );
  repairFiles["manifest.json"] = canonicalStringify({
    version: "v1",
    kind: "repair_state_manifest",
    stateHead: repaired.value.head,
    sequence: 2,
    updatedAt: INSTALL_NOW,
  }) + "\n";
  assert.ok(
    (await pushRawTree(
      remote,
      repaired.value.head,
      "refs/heads/sentinel-state/repair",
      repairFiles,
      env,
    )).ok,
  );

  const calls: string[] = [];
  const client = new HostedSupervisorGitHubClient({
    repository: CONTROLLER.repository,
    apiBaseUrl: "https://api.github.com",
    clock,
    auth: {
      authorizationHeader: () => Promise.resolve(portOk("Bearer synthetic")),
    },
    cooldownGate: {
      beforeRequest: () => Promise.resolve(portOk(undefined)),
      recordRateLimit: () => Promise.resolve(portOk(undefined)),
    },
    http: (request) => {
      assert.equal(request.method, "GET");
      const url = new URL(request.url);
      calls.push(url.pathname);
      let body: unknown;
      if (
        url.pathname ===
          `${CONTROLLER.apiPath}/commits/${SUCCESSOR}/check-runs`
      ) {
        body = {
          total_count: 1,
          check_runs: [{
            id: 91,
            name: "test-local",
            head_sha: SUCCESSOR,
            status: "completed",
            conclusion: "success",
            app: { slug: "github-actions" },
          }],
        };
      } else if (
        url.pathname === `${CONTROLLER.apiPath}/commits/${SUCCESSOR}`
      ) {
        body = { sha: SUCCESSOR };
      } else if (
        url.pathname ===
          `${CONTROLLER.apiPath}/compare/${LEGACY_RUNTIME}...${SUCCESSOR}`
      ) {
        body = {
          status: "ahead",
          base_commit: { sha: LEGACY_RUNTIME },
          merge_base_commit: { sha: LEGACY_RUNTIME },
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
        };
      } else throw new Error(`unexpected fake GitHub request: ${url.pathname}`);
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify(body),
      });
    },
  });
  const evidence = Object.assign(new FakeEvidence(), {
    verifyAncestor: client.verifyAncestor.bind(client),
    verifyLauncherCi: client.verifyLauncherCi.bind(client),
  });
  evidence.revisions.add(LEGACY_RUNTIME);
  evidence.revisions.add(SUCCESSOR);
  const identity = (runId: number) => ({
    runId,
    runAttempt: 1,
    launcherSha: SUCCESSOR,
  });
  const input = (runId: number) => ({
    ...DORMANT_HOSTED_POLICIES,
    clock,
    state: release,
    evidence,
    run: identity(runId),
  });
  return {
    root,
    release,
    repair,
    evidence,
    clock,
    calls,
    identity,
    prepare: (runId: number) => runHostedSupervisorPrepare(input(runId)),
    finalize: (runId: number) => runHostedSupervisorFinalize(input(runId)),
    snapshot: async (): Promise<ReleaseStateSnapshotV1> => {
      const read = await release.readRelease();
      assert.ok(read.ok && read.value.status === "found");
      return read.value.snapshot;
    },
    close: () => Deno.remove(root, { recursive: true }),
  };
}
