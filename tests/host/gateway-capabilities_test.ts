import assert from "node:assert/strict";
import { asGitSha } from "../../src/contracts/brands.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { scopeTargetConfigV1 } from "../../src/host/actions-target-cycles.ts";
import { createTargetConfigV1 } from "../../src/host/targets.ts";
import {
  createTrustedGatewayCapabilities,
  type PreparedGatewayTargetV1,
  type TrustedGatewayRuntimeV1,
  unavailableTargetCapabilities,
} from "../../src/host/gateway-capabilities.ts";
import { markerProofParser } from "../../src/replay/fixture.ts";

const template = createLocalRepositoryConfig();
const config = scopeTargetConfigV1(
  createTargetConfigV1(template, {
    slug: "ubiquity/ai.ubq.fi",
    owner: "ubiquity",
    name: "ai.ubq.fi",
  }, "development"),
  template.repository,
  17,
);
const prepared: PreparedGatewayTargetV1 = {
  config,
  sourcePath: "/tmp/m08-gateway-source-not-created",
  sourceSha: asGitSha("a".repeat(40)),
  controllerSha: asGitSha("b".repeat(40)),
  denoExecutable: "/usr/local/bin/deno",
  gitExecutable: "/usr/bin/git",
};
const authority: TrustedGatewayRuntimeV1 = {
  retained: {
    root: "/tmp/m08-gateway-store-not-created",
    limits: {
      totalMaxBytes: 1024,
      artifactMaxBytes: 1024,
      retentionMaxAgeMs: 1000,
    },
  },
  dependencyCache: {
    root: "/tmp/m08-gateway-cache-not-created",
    sourceSha: prepared.sourceSha,
    manifestDigest: "c".repeat(64),
  },
  sanitizer: { publicModels: ["fixture-model"], publicHeaders: {} },
  replayPolicy: {
    bundleScopes: ["tests/"],
    maxFixtureBytes: 1024,
    maxEntryBytes: 1024,
    proof: markerProofParser(),
  },
  testIds: ["gateway-regression"],
  failure: "stream_terminated",
  scratchDir: "/tmp/m08-gateway-scratch-not-created",
};

Deno.test("gateway host: target/source/commands/protections refuse before auth, intake or model admission", async (t) => {
  const wrong = [
    { ...config, repository: { ...config.repository, name: "sentinel" } },
    { ...config, repository: { ...config.repository, installationId: 0 } },
    { ...config, baseBranch: "other" },
    { ...config, adapter: { kind: "github" as const } },
    {
      ...config,
      adapter: { kind: "gateway" as const, baseUrl: "https://other.invalid" },
    },
    { ...config, protectedPaths: [] },
    {
      ...config,
      commandRegistry: {
        ...config.commandRegistry,
        commands: {
          ...config.commandRegistry.commands,
          [config.commands.test]: {
            ...config.commandRegistry.commands[config.commands.test],
            args: ["sentinel:test-local"],
          },
        },
      },
    },
  ];
  for (const [index, candidate] of wrong.entries()) {
    await t.step(`binding-${index}`, async () => {
      let authReads = 0, requests = 0;
      const input = {
        config: candidate,
        prepared,
        clock: {
          now: () => 0,
        },
        authority: {
          ...authority,
          transport: () => {
            requests++;
            return Promise.reject(new Error("private-test-canary"));
          },
        },
        authJson: "",
        replayKeyB64: "",
      };
      Object.defineProperty(input, "authJson", {
        get: () => {
          authReads++;
          throw new Error("private-test-canary");
        },
      });
      const result = await createTrustedGatewayCapabilities(input);
      assert.equal(result.ok, false);
      assert.equal(authReads, 0);
      assert.equal(requests, 0);
      assert.equal(
        JSON.stringify(result).includes("private-test-canary"),
        false,
      );
    });
  }
});

Deno.test("gateway host: missing capability remains unavailable rather than an authoritative empty page", async () => {
  const pair = unavailableTargetCapabilities();
  const listed = await pair.incidents.listUnresolvedIncidents(null, 1);
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.equal(listed.error.kind, "unavailable");
  assert.equal(config.adapter.kind, "gateway");
  assert.equal(config.commands.test, "gateway_verify");
  assert.equal(config.commands.replay, "gateway_replay");
  assert.equal(template.adapter.kind, "github");
});
