import assert from "node:assert/strict";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { createTargetConfigV1 } from "../../src/host/targets.ts";

const template = createLocalRepositoryConfig();
const gateway = () =>
  createTargetConfigV1(template, {
    slug: "ubiquity/ai.ubq.fi",
    owner: "ubiquity",
    name: "ai.ubq.fi",
  }, "trunk");

Deno.test("target policy: gateway validation is the target's full verification gate", () => {
  const config = gateway();
  const spec = config.commandRegistry.commands[config.commands.test];
  assert.equal(spec.executable, "sh");
  assert.deepEqual(spec.args, ["scripts/verify.sh"]);
  assert.equal(config.baseBranch, "trunk");
  assert.deepEqual(config.sessionBound, template.sessionBound);
  assert.deepEqual(config.liveStartLimits, template.liveStartLimits);
});

Deno.test("target policy: gateway replay is the documented credential-free consumer", () => {
  const config = gateway();
  const spec = config.commandRegistry.commands[config.commands.replay];
  assert.equal(spec.executable, "deno");
  assert.deepEqual(spec.args, [
    "run",
    "--no-prompt",
    "--no-config",
    "--no-remote",
    "--allow-read=.",
    "scripts/replay.ts",
  ]);
});

Deno.test("target policy: gateway authority is protected without removing inherited protection", () => {
  const config = gateway();
  for (const path of template.protectedPaths) {
    assert.ok(config.protectedPaths.includes(path), path);
  }
  for (
    const path of [
      ".env",
      ".data/",
      ".release/",
      "docs/DECISIONS.md",
      "scripts/replay.ts",
      "scripts/replay-chat-stream.ts",
      "tests/helpers/sentinel-recorded-upstream.ts",
      "src/sentinel/",
    ]
  ) assert.ok(config.protectedPaths.includes(path), path);
});

Deno.test("target policy: the gateway's source, auth, ops and tooling are ordinary work", () => {
  // Owner directive 2026-11-05: these merge autonomously after native review
  // and green current-head CI; they are no longer owner-landing paths.
  const config = gateway();
  for (
    const path of [
      "ops/",
      "src/auth/",
      "src/api-keys.ts",
      "src/config.ts",
      "deno.json",
      "deno.lock",
      "package.json",
      "bun.lock",
      "tsconfig.json",
      ".prettierrc.json",
      "scripts/verify.sh",
      "tools/lint/",
    ]
  ) assert.equal(config.protectedPaths.includes(path), false, path);
});

Deno.test("target policy: only Sentinel keeps the named template", () => {
  const self = createTargetConfigV1(template, {
    slug: "ubiquity-sentinel/sentinel",
    owner: "ubiquity-sentinel",
    name: "sentinel",
  }, "main");
  assert.deepEqual(self.commands, template.commands);
  assert.deepEqual(self.commandRegistry, template.commandRegistry);
  assert.deepEqual(self.protectedPaths, template.protectedPaths);

  // Every other identity, including a foreign ai.ubq.fi spoof, is generic:
  // facts-less here, so no local verify and the generic credential boundary.
  for (
    const [owner, name] of [
      ["ubiquity", "another-repo"],
      ["foreign", "ai.ubq.fi"],
    ] as const
  ) {
    const config = createTargetConfigV1(template, {
      slug: `${owner}/${name}`,
      owner,
      name,
    }, "main");
    assert.equal(config.commands.test, "no_local_verify", name);
    assert.equal(
      config.commandRegistry.commands[config.commands.test].executable,
      "false",
      name,
    );
    assert.notDeepEqual(config.commandRegistry, template.commandRegistry);
    assert.ok(config.protectedPaths.includes(".git/"), name);
    assert.ok(config.protectedPaths.includes(".npmrc"), name);
    assert.equal(
      config.protectedPaths.includes("src/host/local-config.ts"),
      false,
      "a generic identity never inherits Sentinel custody",
    );
  }
});
