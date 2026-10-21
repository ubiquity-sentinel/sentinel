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
      "ops/",
      ".env",
      ".data/",
      "deno.lock",
      "docs/DECISIONS.md",
      "scripts/verify.sh",
      "scripts/_bootstrap.sh",
      "tools/lint/",
      "scripts/replay.ts",
      "scripts/replay-chat-stream.ts",
      "tests/helpers/sentinel-recorded-upstream.ts",
      "src/sentinel/",
    ]
  ) assert.ok(config.protectedPaths.includes(path), path);
});

Deno.test("target policy: the gateway's Bun configuration keeps the Deno-era protection", () => {
  // The gateway moved to Bun: the files that took over deno.json, deno.lock and
  // .prettierrc.json are protected exactly like the files they replaced, which
  // also stay protected.
  const config = gateway();
  for (
    const path of [
      "deno.json",
      "deno.lock",
      ".prettierrc.json",
      "package.json",
      "bun.lock",
      "bunfig.toml",
      "tsconfig.json",
      "tsconfig.lint.json",
      "knip.json",
      ".prettierrc",
      "scripts/knip.sh",
    ]
  ) assert.ok(config.protectedPaths.includes(path), path);
});

Deno.test("target policy: Sentinel policy and non-gateway trusted templates stay unchanged", () => {
  for (const name of ["sentinel", "another-repo"]) {
    const owner = name === "sentinel" ? "ubiquity-sentinel" : "ubiquity";
    const config = createTargetConfigV1(template, {
      slug: `${owner}/${name}`,
      owner,
      name,
    }, "main");
    assert.deepEqual(config.commands, template.commands);
    assert.deepEqual(config.commandRegistry, template.commandRegistry);
    assert.deepEqual(config.protectedPaths, template.protectedPaths);
  }
  const spoof = createTargetConfigV1(template, {
    slug: "ubiquity/ai.ubq.fi",
    owner: "foreign",
    name: "ai.ubq.fi",
  }, "main");
  assert.deepEqual(spoof.commandRegistry, template.commandRegistry);
});
