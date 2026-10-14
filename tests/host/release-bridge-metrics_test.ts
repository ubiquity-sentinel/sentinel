import assert from "node:assert/strict";
import { asGitSha } from "../../src/contracts/brands.ts";
import {
  portOk,
  type ReleaseStateWriter,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import {
  createReleaseBridgeHostOptions,
  type ReleaseBridgeCapabilities,
  type ReleaseBridgeInstallation,
} from "../../src/host/release-bridge.ts";
import { composeTrustedVpsReleaseHost } from "../../src/host/vps-release.ts";
const sha = "a".repeat(40), hash = "b".repeat(64);
const pin: ReleaseBridgeInstallation = {
  version: "v1",
  kind: "vps_release_bridge_installation",
  activation: "owner_activated",
  controller: {
    revision: asGitSha(sha),
    root: "/tmp/uninstalled-controller",
    treeSha256: hash,
    entrypointSha256: hash,
  },
  driver: {
    root: "/tmp/uninstalled-driver",
    identity: {
      runtime: "vps",
      gitSha: sha,
      deploymentId: `vps-${sha}`,
      sourceArchiveSha256: hash,
      immutableTreeSha256: hash,
    },
    moduleSha256: hash,
  },
  source: {
    revision: asGitSha(sha),
    workflowId: 1,
    workflowSha256: hash,
    repositoryId: 1,
    ownerId: 1,
    subject: "repo:ubiquity/sentinel:environment:sentinel-release-bridge",
    environment: "sentinel-release-bridge",
  },
  targetInstallationId: 7,
  capabilitiesSha256: hash,
};
Deno.test("release bridge: actual host composition preserves private telemetry capabilities and native history without admitting absent installation", async () => {
  let calls = 0;
  const state: StateReadView & ReleaseStateWriter = {
    readRepair: () =>
      Promise.resolve(
        portOk({ status: "absent", currentHead: null, ref: null }),
      ),
    readRelease: () =>
      Promise.resolve(
        portOk({ status: "absent", currentHead: null, ref: null }),
      ),
    readReleaseAt: () => {
      calls++;
      return Promise.resolve(
        portOk({ status: "absent", currentHead: null, ref: null }),
      );
    },
    writeRelease: () => {
      throw new Error("no state write authorized");
    },
  };
  const host: ReleaseBridgeCapabilities["host"] = {
    clock: { now: () => 10 },
    logsLagMs: 0,
    timeoutKinds: [],
    upstreamWideKinds: [],
    policy: {
      windowMs: 1_800_000,
      sampleIntervalMs: 30_000,
      minSamples: 60,
      minRequests: 50,
      baselineWindowMs: 1_800_000,
      baselineMinSamples: 60,
      thresholds: [{
        metric: "five_xx_rate",
        maxRate: 0.02,
        maxIncrease: 0.01,
      }],
    },
    retention: { evidenceMaxAgeMs: 1_800_000, evidenceMaxBytes: 1_048_576 },
    joinStorage: {
      load: () => Promise.resolve(null),
      save: () => Promise.resolve(false),
    },
    cipher: {
      seal: () => Promise.reject(new Error("test key unavailable")),
      open: () => Promise.reject(new Error("test key unavailable")),
    },
    journalCommand: () =>
      Promise.reject(new Error("no external command authorized")),
    verifySource: () => Promise.resolve(false),
    journalCoverage: () => Promise.resolve(null),
    readInferenceProof: () => Promise.resolve(null),
    wait: () => Promise.resolve(),
    deadline: 100,
  };
  const options = createReleaseBridgeHostOptions(host, state, pin);
  assert.equal(options.joinStorage, host.joinStorage);
  assert.equal(options.cipher, host.cipher);
  assert.equal(options.journalCommand, host.journalCommand);
  assert.deepEqual(options.retention, host.retention);
  await options.stateRead.readReleaseAt!({
    commit: asGitSha(sha),
    expectedHead: asGitSha(sha),
  });
  assert.equal(calls, 1);
  const result = await composeTrustedVpsReleaseHost(options);
  assert.equal(
    result.ok,
    false,
    "real composer refuses the unproved installation even with all metadata capabilities",
  );
  assert.equal(
    (await composeTrustedVpsReleaseHost({
      ...options,
      retention: { evidenceMaxAgeMs: 0, evidenceMaxBytes: 1 },
    })).ok,
    false,
  );
});
