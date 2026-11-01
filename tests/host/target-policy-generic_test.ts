/**
 * Generic target policy (owner directive 2026-11-01: repair every ubiquity
 * repository). Detection, verify commands, protected paths, the optional
 * `sentinel.protected` list and the no-test-evidence park are pure here.
 */
import assert from "node:assert/strict";

import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import {
  createGenericTargetPolicyV1,
  detectTargetToolchainV1,
  GENERIC_TARGET_PROTECTED_PATHS,
  genericTargetProtectedPathsV1,
  isGenericTargetProtectedPathV1,
  isNoTestEvidenceTargetV1,
  NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER,
  NO_CI_AND_NO_LOCAL_VERIFY_DETAIL,
  NO_TEST_EVIDENCE_COMMAND_ID,
  parseSentinelProtectedListV1,
  SENTINEL_PROTECTED_LIST_FILE,
  targetTouchesProtectedV1,
} from "../../src/host/target-policy-generic.ts";
import type { TargetTreeFactsV1 } from "../../src/host/target-policy-generic.ts";
import { selectTrustedTargetPolicyV1 } from "../../src/host/target-policy.ts";

const TEMPLATE = createLocalRepositoryConfig();

function facts(overrides: Partial<TargetTreeFactsV1> = {}): TargetTreeFactsV1 {
  return {
    files: [],
    hasCiWorkflow: true,
    scripts: [],
    ...overrides,
  };
}

Deno.test("generic policy: detection reads top-level toolchain markers", () => {
  const cases: [string[], string][] = [
    [["deno.json"], "deno"],
    [["deno.jsonc"], "deno"],
    [["bun.lockb"], "bun"],
    [["bun.lock"], "bun"],
    [["package-lock.json"], "npm"],
    [["yarn.lock"], "yarn"],
    [["pnpm-lock.yaml"], "pnpm"],
    [["foundry.toml"], "forge"],
    [["README.md", "src/main.ts"], "none"],
    [[], "none"],
  ];
  for (const [files, expected] of cases) {
    assert.equal(
      detectTargetToolchainV1(files),
      expected,
      JSON.stringify(files),
    );
  }
  // A nested marker is not the target root's toolchain declaration.
  assert.equal(detectTargetToolchainV1(["packages/a/deno.json"]), "none");
});

Deno.test("generic policy: toolchain precedence favors lockfiles over Deno", () => {
  const locks = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["pnpm-lock.yaml", "pnpm"],
  ] as const;
  for (const deno of ["deno.json", "deno.jsonc"]) {
    for (const [lock, toolchain] of locks) {
      const policy = createGenericTargetPolicyV1(facts({
        files: [deno, "package.json", lock],
        manifestScripts: { deno: ["test"], package: ["check"] },
      }));
      assert.equal(policy.toolchain, toolchain, `${deno} + ${lock}`);
      const spec = policy.commandRegistry.commands[policy.commands.test];
      assert.equal(spec.executable, toolchain);
      assert.deepEqual(
        spec.args,
        toolchain === "bun"
          ? ["--no-env-file", "run", "check"]
          : ["run", "check"],
      );
      assert.equal(policy.mergeEvidence, "target_ci");
    }
  }
});

Deno.test("generic policy: toolchain precedence favors packageManager over locks", () => {
  for (const toolchain of ["bun", "npm", "yarn", "pnpm"]) {
    for (
      const locks of [[], [
        "bun.lock",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
      ]]
    ) {
      const tree = {
        files: ["package.json", "deno.json", ...locks],
        packageManager: `${toolchain}@1.3.3`,
        manifestScripts: { deno: ["test"], package: ["check"] },
        hasCiWorkflow: true,
      };
      const policy = createGenericTargetPolicyV1(tree);
      assert.equal(policy.toolchain, toolchain, tree.packageManager);
      const spec = policy.commandRegistry.commands[policy.commands.test];
      assert.equal(spec.executable, toolchain);
      assert.deepEqual(
        spec.args,
        toolchain === "bun"
          ? ["--no-env-file", "run", "check"]
          : ["run", "check"],
      );
    }
  }
  assert.equal(
    detectTargetToolchainV1(["deno.json", "nested/package.json"], "bun@1.3.3"),
    "deno",
    "a package manager must come from the root package manifest",
  );
  for (
    const packageManager of [
      "unknown@1.0.0",
      "bun",
      "bun@",
      "bun@1.0.0 run test",
    ]
  ) {
    const tree = {
      files: ["package.json", "deno.json", "pnpm-lock.yaml"],
      packageManager,
      hasCiWorkflow: true,
    };
    assert.equal(createGenericTargetPolicyV1(tree).toolchain, "pnpm");
  }
});

Deno.test("generic policy: each toolchain builds a bounded verify command", () => {
  const cases: [
    string[],
    string[],
    string,
    string[],
  ][] = [
    [["deno.json"], ["test"], "deno", ["task", "test"]],
    [["bun.lock"], ["test"], "bun", ["--no-env-file", "run", "test"]],
    [["package-lock.json"], ["test"], "npm", ["run", "test"]],
    [["yarn.lock"], ["test"], "yarn", ["run", "test"]],
    [["pnpm-lock.yaml"], ["test"], "pnpm", ["run", "test"]],
    [["foundry.toml"], [], "forge", ["test"]],
  ];
  for (const [files, scripts, executable, args] of cases) {
    const policy = createGenericTargetPolicyV1(facts({ files, scripts }));
    assert.equal(policy.adapter.kind, "github");
    assert.equal(policy.localVerify, true, JSON.stringify(files));
    assert.equal(policy.mergeEvidence, "target_ci");
    assert.equal(policy.blocker, null);
    const spec = policy.commandRegistry.commands[policy.commands.test];
    assert.equal(spec.executable, executable, JSON.stringify(files));
    assert.deepEqual(spec.args, args, JSON.stringify(files));
    assert.equal(spec.maxDurationMs, 1_800_000);
    assert.equal(spec.maxOutputBytes, 4_194_304);
  }
});

Deno.test("generic policy: script preference and missing scripts", () => {
  const verify = createGenericTargetPolicyV1(
    facts({ files: ["deno.json"], scripts: ["lint", "verify", "test"] }),
  );
  assert.deepEqual(
    verify.commandRegistry.commands[verify.commands.test].args,
    ["task", "verify"],
  );
  const typecheck = createGenericTargetPolicyV1(
    facts({ files: ["bun.lock"], scripts: ["typecheck", "lint"] }),
  );
  assert.deepEqual(
    typecheck.commandRegistry.commands[typecheck.commands.test].args,
    ["--no-env-file", "run", "typecheck"],
  );
  const check = createGenericTargetPolicyV1(
    facts({ files: ["package-lock.json"], scripts: ["check"] }),
  );
  assert.deepEqual(
    check.commandRegistry.commands[check.commands.test].args,
    ["run", "check"],
  );
  // A declared toolchain with no usable script has no local verify.
  const none = createGenericTargetPolicyV1(
    facts({ files: ["deno.json"], scripts: ["build"] }),
  );
  assert.equal(none.toolchain, "deno");
  assert.equal(none.localVerify, false);
  const spec = none.commandRegistry.commands[none.commands.test];
  assert.equal(spec.executable, "false", "fail closed, never a silent pass");
});

Deno.test("generic policy: verify reads only the detected toolchain's manifest", () => {
  // A deno target with only a package.json `test` script has no Deno task to
  // run: the union must never become `deno task test`.
  const denoOnly = createGenericTargetPolicyV1(
    facts({
      files: ["deno.json", "package.json"],
      manifestScripts: { deno: [], package: ["test"] },
    }),
  );
  assert.equal(denoOnly.toolchain, "deno");
  assert.equal(denoOnly.localVerify, false);
  assert.equal(
    denoOnly.commandRegistry.commands[denoOnly.commands.test].executable,
    "false",
  );

  // The same repo with a real Deno task runs that task, not the union.
  const deno = createGenericTargetPolicyV1(
    facts({
      files: ["deno.json", "package.json"],
      manifestScripts: { deno: ["check"], package: ["test"] },
    }),
  );
  assert.equal(deno.localVerify, true);
  assert.deepEqual(
    deno.commandRegistry.commands[deno.commands.test].args,
    ["task", "check"],
  );

  // A bun target reads only package.json scripts, never Deno tasks.
  const bun = createGenericTargetPolicyV1(
    facts({
      files: ["bun.lock", "package.json"],
      manifestScripts: { deno: ["check"], package: ["test"] },
    }),
  );
  assert.equal(bun.toolchain, "bun");
  const bunSpec = bun.commandRegistry.commands[bun.commands.test];
  assert.equal(bunSpec.executable, "bun");
  assert.deepEqual(bunSpec.args, ["--no-env-file", "run", "test"]);

  // A bun target whose only name is a Deno task has no local verify.
  const bunTaskOnly = createGenericTargetPolicyV1(
    facts({
      files: ["bun.lock", "package.json"],
      manifestScripts: { deno: ["check"], package: [] },
    }),
  );
  assert.equal(bunTaskOnly.localVerify, false);
});

Deno.test("generic policy: protected paths cover credentials, history and dispatch", () => {
  for (
    const path of [
      ".env",
      ".env.local",
      ".env.production",
      "nested/.env.test",
      ".git/config",
      ".github/workflows/ci.yml",
      ".npmrc",
      ".secrets",
      ".actrc",
      ".vars",
      ".input",
    ]
  ) assert.equal(isGenericTargetProtectedPathV1(path), true, path);
  for (
    const path of [
      "src/index.ts",
      "README.md",
      "tests/main_test.ts",
      "bun.lock",
    ]
  ) assert.equal(isGenericTargetProtectedPathV1(path), false, path);
  assert.ok(GENERIC_TARGET_PROTECTED_PATHS.includes(".git/"));
  assert.ok(
    GENERIC_TARGET_PROTECTED_PATHS.includes(SENTINEL_PROTECTED_LIST_FILE),
  );
  // Env files the checkout actually shows also land in the array form.
  const policy = createGenericTargetPolicyV1(
    facts({ files: ["package-lock.json", ".env.staging"], scripts: ["test"] }),
  );
  assert.ok(policy.protectedPaths.includes(".env.staging"));
});

Deno.test("generic policy: the production boundary protects nested env files", () => {
  const generic = createGenericTargetPolicyV1(
    facts({ files: ["bun.lock", "package.json"], scripts: ["test"] }),
  );
  const config = {
    commands: generic.commands,
    protectedPaths: generic.protectedPaths,
  };
  for (
    const path of [
      ".env",
      ".env.local",
      "apps/web/.env.local",
      "packages/api/.env.production",
      "nested/dir/.envrc",
      ".github/workflows/ci.yml",
      ".secrets",
    ]
  ) assert.equal(targetTouchesProtectedV1(config, path), true, path);
  for (
    const path of ["src/main.ts", "apps/web/env.example", "docs/env.md"]
  ) assert.equal(targetTouchesProtectedV1(config, path), false, path);

  // Non-generic targets keep the unchanged literal predicate.
  const legacy = {
    commands: TEMPLATE.commands,
    protectedPaths: [".env", ".github/workflows/"],
  };
  assert.equal(targetTouchesProtectedV1(legacy, ".env"), true);
  assert.equal(targetTouchesProtectedV1(legacy, "apps/web/.env.local"), false);
});

Deno.test("generic policy: a target's sentinel.protected list adds boundaries", () => {
  const policy = createGenericTargetPolicyV1(facts({
    files: ["package-lock.json"],
    scripts: ["test"],
    sentinelProtected: ["deploy/", "config/prod.toml"],
  }));
  assert.ok(policy.protectedPaths.includes("deploy"));
  assert.ok(policy.protectedPaths.includes("config/prod.toml"));
  assert.equal(
    isGenericTargetProtectedPathV1("deploy/main.ts", policy.protectedPaths),
    true,
  );
  // An unsafe entry is data, never authority: it cannot widen to `/`.
  const widened = genericTargetProtectedPathsV1(["/", "..", "a/../b", ""]);
  assert.deepEqual(widened, [...GENERIC_TARGET_PROTECTED_PATHS]);
});

Deno.test("generic policy: sentinel.protected parses JSON and line lists", () => {
  assert.deepEqual(parseSentinelProtectedListV1(""), []);
  assert.deepEqual(
    parseSentinelProtectedListV1('["deploy/", "config/prod.toml"]'),
    ["deploy", "config/prod.toml"],
  );
  assert.deepEqual(
    parseSentinelProtectedListV1("# owners only\ndeploy/\n\n.patches\n"),
    ["deploy", ".patches"],
  );
  for (
    const invalid of ['["../escape"]', '["/root"]', "deploy/../../etc", "[1]"]
  ) {
    assert.throws(
      () => parseSentinelProtectedListV1(invalid),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message ===
          `${SENTINEL_PROTECTED_LIST_FILE} contains an invalid path`,
      invalid,
    );
  }
});

Deno.test("generic policy: no CI and no local verify parks the record", () => {
  const parked = createGenericTargetPolicyV1(
    facts({ files: [], hasCiWorkflow: false }),
  );
  assert.equal(parked.mergeEvidence, "none");
  assert.equal(parked.blocker, NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER);
  assert.equal(parked.blocker, "no_ci_and_no_local_verify");
  assert.equal(parked.commands.test, NO_TEST_EVIDENCE_COMMAND_ID);
  assert.equal(isNoTestEvidenceTargetV1(parked), true);
  assert.equal(
    parked.commandRegistry.commands[parked.commands.test].executable,
    "false",
    "a fail-closed command, never a silent pass",
  );
  assert.ok(NO_CI_AND_NO_LOCAL_VERIFY_DETAIL.startsWith(parked.blocker!));

  // No CI but a runnable local verify: the command exists, but nothing runs it
  // as merge evidence, so the target still parks. Merge evidence must be CI.
  const local = createGenericTargetPolicyV1(
    facts({ files: ["deno.json"], scripts: ["test"], hasCiWorkflow: false }),
  );
  assert.equal(local.localVerify, true);
  assert.equal(local.mergeEvidence, "none");
  assert.equal(local.blocker, NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER);
  assert.equal(local.commands.test, NO_TEST_EVIDENCE_COMMAND_ID);
  assert.equal(
    local.commandRegistry.commands[local.commands.test].executable,
    "deno",
    "the detected verify stays registered and bounded",
  );

  // A target with CI never parks even without a local verify; its own CI is
  // the merge gate.
  const ci = createGenericTargetPolicyV1(facts({ files: [] }));
  assert.equal(ci.mergeEvidence, "target_ci");
  assert.equal(ci.blocker, null);
});

Deno.test("generic policy: select uses target facts and keeps special policies", () => {
  const generic = selectTrustedTargetPolicyV1(
    TEMPLATE,
    { owner: "ubiquity", name: "prospector" },
    facts({ files: ["bun.lock"], scripts: ["test"] }),
  );
  assert.equal(generic.adapter.kind, "github");
  const spec = generic.commandRegistry.commands[generic.commands.test];
  assert.equal(spec.executable, "bun");
  assert.ok(generic.protectedPaths.includes(".git/"));

  // Without facts a generic target still gets the generic credential boundary
  // and family predicate, never the Sentinel template's commands or custody.
  const noFacts = selectTrustedTargetPolicyV1(
    TEMPLATE,
    { owner: "ubiquity", name: "prospector" },
  );
  assert.equal(noFacts.adapter.kind, "github");
  assert.equal(noFacts.commands.test, "no_local_verify");
  assert.equal(
    noFacts.commandRegistry.commands[noFacts.commands.test].executable,
    "false",
    "no checkout facts can never claim a local verify",
  );
  assert.notDeepEqual(noFacts.commandRegistry, TEMPLATE.commandRegistry);
  for (const path of [".git/", ".npmrc", ".secrets", ".actrc", ".vars"]) {
    assert.ok(noFacts.protectedPaths.includes(path), path);
  }
  for (
    const path of [
      ".env",
      "apps/web/.env.local",
      "nested/.env.production",
      ".git/config",
      ".github/workflows/ci.yml",
    ]
  ) assert.equal(targetTouchesProtectedV1(noFacts, path), true, path);
  assert.equal(
    targetTouchesProtectedV1(noFacts, "apps/web/env.example"),
    false,
  );

  // The self target keeps its template commands and custody protections.
  const self = selectTrustedTargetPolicyV1(
    TEMPLATE,
    { owner: "ubiquity-sentinel", name: "sentinel" },
    facts({ files: ["deno.json"], scripts: ["test"] }),
  );
  assert.deepEqual(self.commands, TEMPLATE.commands);
  assert.deepEqual(self.protectedPaths, TEMPLATE.protectedPaths);

  // Passport and the Gateway keep their named policies even with facts.
  const passport = selectTrustedTargetPolicyV1(
    TEMPLATE,
    { owner: "ubiquity", name: "passport.ubq.fi" },
    facts({ files: ["deno.json"], scripts: ["test"] }),
  );
  assert.equal(passport.commands.test, "passport_verify");
  const gateway = selectTrustedTargetPolicyV1(
    TEMPLATE,
    { owner: "ubiquity", name: "ai.ubq.fi" },
    facts({ files: ["deno.json"], scripts: ["test"] }),
  );
  assert.equal(gateway.commands.test, "gateway_verify");
});
