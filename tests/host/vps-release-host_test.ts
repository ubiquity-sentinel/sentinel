import assert from "node:assert/strict";
import { completeMetricsWork } from "../release/vps-metrics-fixtures.ts";
import type { VpsReleasePortV1 } from "../../src/contracts/ports-vps-release.ts";
import { asGitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  composeTrustedVpsReleaseHost,
  type TrustedVpsReleaseHostOptionsV1,
} from "../../src/host/vps-release.ts";
import { runVpsReleaseEntrypoint } from "../../src/release-main.ts";
import { stabilityPolicy } from "../release/helpers.ts";

const options: TrustedVpsReleaseHostOptionsV1 = {
  clock: { now: () => 10 },
  stateRead: {
    readRepair: () =>
      Promise.resolve(
        portOk({ status: "absent", currentHead: null, ref: null }),
      ),
    readRelease: () =>
      Promise.resolve(
        portOk({ status: "absent", currentHead: null, ref: null }),
      ),
  },
  stateWrite: {
    writeRelease: () => {
      throw new Error("must not write");
    },
  },
  repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
  environment: "isolated",
  controllerSha: asGitSha("a".repeat(40)),
  targetRoot: "/tmp/m08-vps-unavailable",
  pinnedDriver: {
    releaseRoot: "/tmp/m08-vps-unavailable/releases/" + "a".repeat(40),
    identity: {
      runtime: "vps",
      gitSha: "a".repeat(40),
      deploymentId: "vps-" + "a".repeat(40),
      sourceArchiveSha256: "b".repeat(64),
      immutableTreeSha256: "c".repeat(64),
    },
    moduleSha256: "d".repeat(64),
  },
  policy: stabilityPolicy(),
  retention: { evidenceMaxAgeMs: 1_800_000, evidenceMaxBytes: 1_048_576 },
  joinStorage: {
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(false),
  },
  cipher: {
    seal: () => Promise.reject(new Error("absent test cipher")),
    open: () => Promise.reject(new Error("absent test cipher")),
  },
  journalCommand: () => Promise.reject(new Error("absent test journal")),
  logsLagMs: 0,
  timeoutKinds: [],
  upstreamWideKinds: [],
  verifySource: () => Promise.resolve(false),
  journalCoverage: () => Promise.resolve(null),
  readInferenceProof: () => Promise.resolve(null),
  wait: () => Promise.resolve(),
  deadline: 100,
};

Deno.test("VPS host: absent native writer, driver or policy does not acquire promotion authority", async (t) => {
  for (
    const [name, input] of [
      ["foreign repository", {
        ...options,
        repository: { ...options.repository, name: "sentinel" },
      }],
      ["expired deadline", { ...options, deadline: 10 }],
      ["unproved installed driver", options],
      ["wrong production root", {
        ...options,
        environment: "production" as const,
      }],
    ] as const
  ) {
    await t.step(name, async () => {
      const result = await composeTrustedVpsReleaseHost(input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, "unavailable");
    });
  }
});

Deno.test("VPS entrypoint: expired absolute deadline calls no driver, telemetry or state writer", async () => {
  let calls = 0;
  const port = new Proxy({} as VpsReleasePortV1, {
    get: () => () => {
      calls++;
      throw new Error("unexpected effect");
    },
  });
  const result = await runVpsReleaseEntrypoint({
    metricsWork: completeMetricsWork(),
    ...options,
    driverSha256: options.pinnedDriver.moduleSha256,
    port,
    deadline: 10,
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});
