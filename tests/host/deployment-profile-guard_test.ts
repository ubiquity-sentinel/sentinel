/** Runtime policy belongs in the bound controller profile; tests can assert both roles. */
import assert from "node:assert/strict";

const authority = "src/contracts/hosted-controller-deployment.ts";
const publicLoader = "loadPublicTargetConfigsV1";
const publicOnlyConsumers = new Set([
  "src/host/targets.ts", // defines both entry points
  "src/host/local.ts", // local scope-zero repair
  "src/host/maintenance-existing-pr-publication.ts", // existing-PR custody for the public ai.ubq.fi target
]);

// Exact expressions, never whole-file exemptions. Each has an independent contract.
const exceptions: Record<string, string[]> = {
  // Immutable historical issue #48 evidence must remain pinned to the original public target.
  "ops/issue48-recovery.ts": [
    "input.repository !== ISSUE48_REPOSITORY",
    "headName !== ISSUE48_REPOSITORY",
    "baseName !== ISSUE48_REPOSITORY",
  ],
  "ops/issue48-review-quota-recovery.ts": [
    "input.repository !== ISSUE48_QUOTA_REPOSITORY",
  ],
  // App identity is shared by both installations.
  "src/host/hosted-app-grant.ts": ["value.appSlug !== SENTINEL_APP_SLUG"],
  // Wire decoder for any GitHub repository, including foreign targets.
  "src/repair/target-visibility.ts": [
    'visibility === "private"',
    'visibility === "internal"',
    'visibility === "public"',
  ],
  // Network surface in a VPS release receipt.
  "src/contracts/vps-release-wire.ts": ['object.surface !== "public"'],
  // Standalone, hash-pinned proof emitter; runtime imports would expand the CI trust boundary.
  "ops/native-ci-proof.ts": [
    'io.env("GITHUB_REPOSITORY") !== "ubiquity-sentinel/sentinel"',
  ],
};

const policyLiteral =
  /^(?:public|private|internal|ubiquity-sentinel(?:-private)?(?:\/sentinel)?)$/;
const rule: Deno.lint.Plugin = {
  name: "sentinel",
  rules: {
    "deployment-profile": {
      create(ctx) {
        const names = new Set<string>();
        const text = (node: Deno.lint.Node) => ctx.sourceCode.getText(node);
        const isPolicy = (node: Deno.lint.Node): boolean => {
          if (node.type === "Literal") {
            return typeof node.value === "string" &&
              policyLiteral.test(node.value);
          }
          if (node.type === "Identifier") return names.has(node.name);
          if (node.type === "TemplateLiteral") {
            return node.expressions.length === 0 &&
              policyLiteral.test(text(node).slice(1, -1));
          }
          if (
            node.type === "MemberExpression" &&
            /(?:profile|deployment|host|binding)(?:\?\.|\.)(?:role|targetVisibility|visibility|private)$/i
              .test(text(node))
          ) return true;
          if (node.type === "ArrayExpression") {
            return node.elements.some((element) =>
              element !== null && isPolicy(element)
            );
          }
          return false;
        };
        const report = (node: Deno.lint.Node) => {
          if (exceptions[ctx.filename]?.includes(text(node))) return;
          ctx.report({
            node,
            message: `Use the deployment profile for ${text(node)}`,
          });
        };
        return {
          VariableDeclarator(node) {
            if (
              node.id.type === "Identifier" && node.init && isPolicy(node.init)
            ) names.add(node.id.name);
          },
          ImportSpecifier(node) {
            const symbol = text(node.imported);
            if (
              symbol === "HOSTED_CONTROLLER_ROLE" ||
              symbol === "PRIVATE_CYCLE_CELLS" ||
              (symbol === publicLoader &&
                !publicOnlyConsumers.has(ctx.filename))
            ) report(node);
          },
          MemberExpression(node) {
            if (
              text(node.property) === publicLoader &&
              !publicOnlyConsumers.has(ctx.filename)
            ) report(node);
          },
          BinaryExpression(node) {
            if (
              ["==", "!=", "===", "!=="].includes(node.operator) &&
              (isPolicy(node.left) || isPolicy(node.right))
            ) report(node);
          },
          SwitchCase(node) {
            if (node.test && isPolicy(node.test)) report(node.test);
          },
          CallExpression(node) {
            if (node.callee.type !== "MemberExpression") return;
            const method = text(node.callee.property);
            if (
              ["includes", "has", "startsWith", "endsWith"].includes(method) &&
              (isPolicy(node.callee.object) || node.arguments.some(isPolicy))
            ) report(node);
          },
        };
      },
    },
  },
};

function violations(file: string, source: string) {
  return Deno.lint.runPlugin(rule, file, source).map((row) =>
    `${file}: ${row.message}`
  );
}

Deno.test("runtime source cannot select deployment policy outside the controller profile", async () => {
  const listing = await new Deno.Command("git", {
    args: ["ls-files", "--cached", "-z"],
    stdout: "piped",
  }).output();
  assert(listing.success);
  const failures: string[] = [];
  for (const file of new TextDecoder().decode(listing.stdout).split("\0")) {
    // Fixtures exercise both roles. Workflow YAML has a separate exhaustive job table.
    if (
      !/\.[cm]?[jt]sx?$/.test(file) || file.startsWith("tests/") ||
      file === authority
    ) continue;
    const source = await Deno.readTextFile(file);
    if (
      /public|private|internal|ubiquity-sentinel|profile|deployment|binding|host|HOSTED_CONTROLLER_ROLE|PRIVATE_CYCLE_CELLS|loadPublicTargetConfigsV1/i
        .test(source)
    ) {
      failures.push(...violations(file, source));
    }
  }
  assert.deepEqual(failures, []);
});

Deno.test("deployment guard rejects copied, reversed, aliased and switched policy", () => {
  for (
    const source of [
      'if (host.visibility === "private") run();',
      'if ("public" === profile.role) run();',
      "if (host.visibility === expected) run();",
      "targets.loadPublicTargetConfigsV1({});",
      'const own = "ubiquity-sentinel/sentinel"; if (repository === own) run();',
      'switch (repo) { case "ubiquity-sentinel-private/sentinel": run(); }',
      'if (["private"].includes(visibility)) run();',
      'import { loadPublicTargetConfigsV1 as load } from "./targets.ts";',
    ]
  ) assert(violations("ops/new-consumer.ts", source).length > 0, source);
});
