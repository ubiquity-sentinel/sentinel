/** Shared credential-free hosted test fixtures; this module registers no tests. */
import assert from "node:assert/strict";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { runHostedSupervisorPrepare } from "../../src/host/actions-supervisor.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import {
  gitRun,
  makeRemoteCtx,
  sha256Hex,
  T0,
  testGitEnv,
} from "../state/helpers.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import {
  execution,
  FakeClock,
  FakeEvidence,
  RECOVERY_HEALTH_DIGEST,
  RECOVERY_HEALTH_LAUNCHER,
  RECOVERY_OLD_LAUNCHER,
  RECOVERY_REVISION,
  ROOT,
  run,
  runProof,
  skippedProof,
} from "./actions-supervisor-fixture.ts";

export async function recoveryRig(overrides: Record<string, unknown> = {}) {
  const root = await Deno.makeTempDir({
    prefix: "same-pointer-recovery-",
    dir: ROOT,
  });
  const env = testGitEnv(`${root}/git-home`);
  await Deno.mkdir(`${root}/git-home`);
  const remote = await makeRemoteCtx(root, env);
  const prior = runProof(
    execution({
      id: "37134515396:1:repair",
      runId: 37134515396,
      launcherSha: RECOVERY_HEALTH_LAUNCHER,
      revision: RECOVERY_REVISION,
      generation: 59,
    }),
    "healthy",
    { logDigest: RECOVERY_HEALTH_DIGEST, jobId: 111236538381 },
  );
  const skipped = skippedProof(
    execution({
      id: "37148984941:1:repair",
      runId: 37148984941,
      launcherSha: RECOVERY_OLD_LAUNCHER,
      revision: RECOVERY_REVISION,
      generation: 59,
      purpose: "ordinary",
      createdAt: T0 + 4000,
    }),
  );
  const snapshot = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 6000,
    releases: [],
    hostedReleases: [],
    githubCooldowns: [],
    hostedRuntimes: [{
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: RECOVERY_REVISION,
      generation: 59,
      execution: null,
      lastHealthyProof: prior,
      lastExecutionProof: skipped,
      nextOrdinaryAt: T0,
      createdAt: T0,
      updatedAt: T0 + 6000,
      ...overrides,
    }],
  });
  const files = {
    "manifest.json": canonicalStringify({
      version: "v1",
      kind: "release_state_manifest",
      stateHead: null,
      sequence: 1,
      updatedAt: snapshot.updatedAt,
    }) + "\n",
    [`hostedRuntimes/${await sha256Hex(HOSTED_RUNTIME_ID)}.json`]:
      canonicalStringify(snapshot.hostedRuntimes[0]) + "\n",
  };
  for (const [path, text] of Object.entries(files)) {
    await Deno.mkdir(
      `${remote.work}/${path}`.slice(
        0,
        `${remote.work}/${path}`.lastIndexOf("/"),
      ),
      { recursive: true },
    );
    await Deno.writeTextFile(`${remote.work}/${path}`, text);
  }
  for (
    const args of [["add", "-A"], [
      "commit",
      "-qm",
      "parsed historical quarantine fixture",
    ], ["push", "-q", "origin", "HEAD:refs/heads/sentinel-state/release"]]
  ) {
    const result = await gitRun(remote.work, args, env);
    assert.equal(result.code, 0, result.stderr);
  }
  const state = createReleaseStateStore({
    scratchDir: `${root}/scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const repair = createRepairStateStore({
    scratchDir: `${root}/repair-scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const seededRepair = await repair.writeRepair(
    parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0 + 6000,
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
    }),
    null,
  );
  assert.ok(
    seededRepair.ok && seededRepair.value.status === "applied",
    JSON.stringify(seededRepair),
  );
  const evidence = new FakeEvidence();
  const clock = new FakeClock(T0 + 10000);
  const latest = snapshot.hostedRuntimes[0].lastExecutionProof;
  if (latest !== null) {
    evidence.settlements.set(latest.execution.id, {
      ...latest,
      observedAt: latest.observedAt + 1,
    });
  }
  const read = async () => {
    const result = await state.readRelease();
    if (!result.ok || result.value.status !== "found") {
      throw new Error("missing recovery state");
    }
    return result.value;
  };
  return {
    root,
    state,
    evidence,
    clock,
    prior,
    skipped,
    read,
    prepare: (identity = run(72)) =>
      runHostedSupervisorPrepare({ state, evidence, clock, run: identity }),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}
