/**
 * Focused suite for the committed target setting (`sentinel.targets.json`).
 *
 * The setting is authority-bearing: it decides which repositories this
 * deployment may repair, so every rejection path is covered here without
 * network or state, and the shipped file itself is parsed.
 */
import assert from "node:assert/strict";

import { createLocalRepositoryConfig } from "../../src/host/local.ts";
import {
  createDefaultBranchResolver,
  createGatedTargetReadTransport,
  createTargetConfigV1,
  createTargetTreeFactsResolver,
  loadTargetConfigsV1,
  parseTargetSlugsV1,
  readTargetSlugsV1,
  STATIC_TARGETS_INVALID,
  TARGETS_FILE_NAME,
  TARGETS_MAX,
} from "../../src/host/targets.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  isNoTestEvidenceTargetV1,
  NO_TEST_EVIDENCE_COMMAND_ID,
} from "../../src/host/target-policy-generic.ts";
import type { TargetSlugV1 } from "../../src/host/targets.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";

const TEMPLATE = createLocalRepositoryConfig();

function response(status: number, body: string): HttpResponseV1 {
  return { status, headers: new Headers(), bodyText: body };
}

/** A changed fixture tree gets a new commit, just like the GitHub read API. */
function treeFactsHttp(root: string, routes: ReadonlyMap<string, string>) {
  let previousTree: string | undefined;
  let revision = 0;
  return (request: HttpRequestV1): Promise<HttpResponseV1> => {
    if (request.url === `${root.replace(/\/contents$/, "")}/commits/main`) {
      const tree = JSON.stringify([...routes]);
      if (tree !== previousTree) {
        revision += 1;
        previousTree = tree;
      }
      return Promise.resolve(response(
        200,
        JSON.stringify({
          sha: revision.toString(16).padStart(40, "0"),
        }),
      ));
    }
    if (!request.url.startsWith(root)) {
      return Promise.resolve(response(404, "{}"));
    }
    const url = new URL(request.url);
    assert.equal(
      url.searchParams.get("ref"),
      revision.toString(16).padStart(40, "0"),
    );
    url.searchParams.set("ref", "main");
    const body = routes.get(url.href);
    return Promise.resolve(
      body === undefined ? response(404, "{}") : response(200, body),
    );
  };
}

function slug(owner: string, name: string): TargetSlugV1 {
  return { slug: `${owner}/${name}`, owner, name };
}

Deno.test("targets: the shipped setting is a plain array", async () => {
  const text = await Deno.readTextFile(`./${TARGETS_FILE_NAME}`);
  const parsed = JSON.parse(text) as unknown;
  assert.ok(Array.isArray(parsed), "the setting is a plain array");
});

/** The 2026-11-01 owner directive: every active ubiquity code repository. */
const SHIPPED_TARGETS = [
  "ubiquity-sentinel/sentinel",
  "ubiquity/ai.ubq.fi",
  "ubiquity/passport.ubq.fi",
  "ubiquity/prospector",
  "ubiquity/prospector-chrome-extension",
  "ubiquity/ubiquity-dollar",
  "ubiquity/ubiquibar",
  "ubiquity/stake.ubq.fi",
  "ubiquity/prospector-monorepo",
  "ubiquity/uusd.ubq.fi",
  "ubiquity/work.ubq.fi",
  "ubiquity/ubq.fi-router",
  "ubiquity/pay.ubq.fi",
  "ubiquity/arbitrage-bot",
  "ubiquity/xp.ubq.fi",
  "ubiquity/permit2-rpc-manager",
  "ubiquity/deno-deploy-workflow",
  "ubiquity/webauthn-evm-signing-key",
  "ubiquity/ts-template",
  "ubiquity/keygen.ubq.fi",
  "ubiquity/demo.ubq.fi",
  "ubiquity/checkout.ubq.fi",
  "ubiquity/uad-contracts",
  "ubiquity/supabase-payments-audit",
  "ubiquity/permit3",
  "ubiquity/permit2-allowance.ubq.fi",
  "ubiquity/partner.ubq.fi",
  "ubiquity/notifications.ubq.fi",
  "ubiquity/github-labels-processor",
  "ubiquity/card-issuance",
];

Deno.test("targets: the shipped setting names every active ubiquity repository", async () => {
  const text = await Deno.readTextFile(`./${TARGETS_FILE_NAME}`);
  assert.deepEqual(
    parseTargetSlugsV1(JSON.parse(text)).map((entry) => entry.slug),
    SHIPPED_TARGETS,
  );
  assert.ok(SHIPPED_TARGETS.length <= TARGETS_MAX, "within the fan-out bound");
});

Deno.test("targets: the setting file is ordinary work under the 2026-10-30 reduced set", () => {
  assert.equal(
    TEMPLATE.protectedPaths.includes(TARGETS_FILE_NAME),
    false,
    "only credential, dispatch, merge-gate and promotion files stay protected",
  );
});

Deno.test("targets: only a bounded, duplicate-free slug array is accepted", () => {
  assert.deepEqual(
    parseTargetSlugsV1(["ubiquity-sentinel/sentinel"]).map((entry) =>
      entry.slug
    ),
    ["ubiquity-sentinel/sentinel"],
  );
  const rejected: unknown[] = [
    [],
    {},
    "ubiquity-sentinel/sentinel",
    [""],
    ["sentinel"],
    ["/sentinel"],
    ["ubiquity/"],
    ["ubiquity-sentinel/sentinel/extra"],
    ["ubiquity-sentinel/sentinel", "ubiquity-sentinel/Sentinel"],
    ["ubiquity-sentinel/sentinel", "ubiquity-sentinel/sentinel"],
    [1],
    [null],
    Array.from(
      { length: TARGETS_MAX + 1 },
      (_unused, index) => `ubiquity/repo-${index}`,
    ),
  ];
  for (const input of rejected) {
    assert.throws(
      () => parseTargetSlugsV1(input),
      (error: unknown) =>
        error instanceof TypeError && error.message === STATIC_TARGETS_INVALID,
      `expected rejection for ${JSON.stringify(input).slice(0, 60)}`,
    );
  }
});

Deno.test("targets: expanded settings through 64 entries preserve their order", () => {
  for (const length of [33, 64]) {
    const targets = Array.from(
      { length },
      (_unused, index) => `ubiquity/repo-${index}`,
    );
    assert.deepEqual(
      parseTargetSlugsV1(targets).map((target) => target.slug),
      targets,
    );
  }
});

Deno.test("targets: the 64-target setting resolves in order without resolver fan-out", async () => {
  const targets = Array.from(
    { length: 64 },
    (_unused, index) => `ubiquity/repo-${index}`,
  );
  const reads: string[] = [];
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () => Promise.resolve(JSON.stringify(targets)),
    resolveDefaultBranch: async (target) => {
      reads.push(`branch:${target.slug}`);
      await Promise.resolve();
      return "main";
    },
    resolveTreeFacts: async (target, branch) => {
      assert.equal(branch, "main");
      reads.push(`facts:${target.slug}`);
      await Promise.resolve();
      return { files: [], hasCiWorkflow: true };
    },
  });
  assert.deepEqual(
    reads,
    targets.flatMap((target) => [
      `branch:${target}`,
      `facts:${target}`,
    ]),
  );
  assert.deepEqual(
    loaded.configs.map((config) =>
      `${config.repository.owner}/${config.repository.name}@${config.baseBranch}`
    ),
    targets.map((target) => `${target}@main`),
  );
  assert.deepEqual(loaded.skipped, []);
  assert.deepEqual(loaded.factsUnavailable, []);
});

Deno.test("targets: 65 entries fail closed before resolving any repository", async () => {
  const targets = Array.from(
    { length: 65 },
    (_unused, index) => `ubiquity/repo-${index}`,
  );
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () => Promise.resolve(JSON.stringify(targets)),
    resolveDefaultBranch: () => {
      assert.fail("over-limit settings must not resolve default branches");
    },
    resolveTreeFacts: () => {
      assert.fail("over-limit settings must not resolve tree facts");
    },
  });
  assert.deepEqual(loaded, {
    targets: [],
    configs: [],
    skipped: [],
    factsUnavailable: [],
  });
});

Deno.test("targets: an unreadable or malformed setting yields no targets", async () => {
  assert.deepEqual(
    await readTargetSlugsV1({
      readFile: () => Promise.reject(new Error("missing")),
    }),
    [],
  );
  assert.deepEqual(
    await readTargetSlugsV1({ readFile: () => Promise.resolve("{") }),
    [],
  );
  assert.deepEqual(
    await readTargetSlugsV1({ readFile: () => Promise.resolve("[]") }),
    [],
  );
  assert.deepEqual(
    await readTargetSlugsV1({
      readFile: () => Promise.resolve('["ubiquity-sentinel/sentinel"]'),
    }),
    [slug("ubiquity-sentinel", "sentinel")],
  );
  assert.deepEqual(
    await readTargetSlugsV1({
      root: ".",
      readFile: (path) =>
        Promise.resolve(
          path === `./${TARGETS_FILE_NAME}`
            ? '["ubiquity-sentinel/sentinel"]'
            : "[]",
        ),
    }),
    [slug("ubiquity-sentinel", "sentinel")],
  );
});

Deno.test("targets: a slug can only change identity and base branch", () => {
  const config = createTargetConfigV1(
    TEMPLATE,
    slug("ubiquity", "another-repo"),
    "main",
  );
  assert.deepEqual(config.repository, {
    owner: "ubiquity",
    name: "another-repo",
    installationId: TEMPLATE.repository.installationId,
  });
  assert.equal(config.baseBranch, "main");
  // A generic slug still cannot choose policy: without facts it gets the
  // facts-less generic policy (no local verify, generic credential boundary).
  assert.equal(config.commands.test, "no_local_verify");
  assert.equal(
    config.commandRegistry.commands[config.commands.test].executable,
    "false",
    "never claim a local verify without a checkout",
  );
  for (
    const path of [".env", ".git/", ".npmrc", ".secrets", ".actrc", ".vars"]
  ) assert.ok(config.protectedPaths.includes(path), path);
  assert.equal(
    config.protectedPaths.includes("src/host/local-config.ts"),
    false,
    "the Sentinel custody list is not a generic target's boundary",
  );
  assert.deepEqual(config.sessionBound, TEMPLATE.sessionBound);
  assert.deepEqual(config.liveStartLimits, TEMPLATE.liveStartLimits);
  assert.equal(config.secretRef, TEMPLATE.secretRef);

  // Only the Sentinel repository itself keeps the named template.
  const self = createTargetConfigV1(
    TEMPLATE,
    slug("ubiquity-sentinel", "sentinel"),
    "main",
  );
  assert.deepEqual(self.commands, TEMPLATE.commands);
  assert.deepEqual(self.commandRegistry, TEMPLATE.commandRegistry);
  assert.deepEqual(self.protectedPaths, TEMPLATE.protectedPaths);
});

Deno.test("targets: a target whose default branch is unavailable is skipped", async () => {
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () =>
      Promise.resolve('["ubiquity-sentinel/sentinel", "ubiquity/other"]'),
    resolveDefaultBranch: (target) =>
      Promise.resolve(target.name === "sentinel" ? "development" : null),
    resolveTreeFacts: () => Promise.resolve({ files: [], hasCiWorkflow: true }),
  });
  assert.deepEqual(
    loaded.configs.map((config) =>
      `${config.repository.name}@${config.baseBranch}`
    ),
    ["sentinel@development"],
  );
  assert.deepEqual([...loaded.skipped], ["ubiquity/other"]);
});

Deno.test("targets: a bun target with CI gets the bun verify policy", async () => {
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () => Promise.resolve('["ubiquity/prospector"]'),
    resolveDefaultBranch: () => Promise.resolve("development"),
    resolveTreeFacts: () =>
      Promise.resolve({
        files: ["bun.lock", "package.json"],
        manifestScripts: { package: ["test"] },
        hasCiWorkflow: true,
      }),
  });
  assert.equal(loaded.configs.length, 1);
  const config = loaded.configs[0]!;
  assert.equal(config.adapter.kind, "github");
  const spec = config.commandRegistry.commands[config.commands.test];
  assert.equal(spec.executable, "bun");
  assert.deepEqual(spec.args, ["--no-env-file", "run", "test"]);
  assert.equal(isNoTestEvidenceTargetV1(config), false);
});

Deno.test("targets: prospector mixed manifests select the declared package manager", async () => {
  for (const [index, toolchain] of ["bun", "npm", "yarn", "pnpm"].entries()) {
    // Each manifest graph has its own commit, including across cached reads.
    const revision = (index + 1).toString(16).padStart(40, "0");
    const packageManager = `${toolchain}@1.3.3`;
    const manifests: Record<string, string> = {
      "/package.json": JSON.stringify({
        packageManager,
        scripts: { check: "tsc --noEmit" },
      }),
      "/deno.json": JSON.stringify({ tasks: { test: "deno test" } }),
      "/.github/workflows/ci.yml":
        `on: [pull_request]\njobs:\n  check:\n    steps:\n      - run: ${toolchain} ${
          toolchain === "npm" ? "ci" : "install --frozen-lockfile"
        } && ${toolchain} run check\n`,
    };
    const resolveTreeFacts = createTargetTreeFactsResolver({
      token: "token-value",
      http: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/repos/ubiquity/prospector/commits/main") {
          return Promise.resolve(
            response(200, JSON.stringify({ sha: revision })),
          );
        }
        assert.equal(url.searchParams.get("ref"), revision);
        const path = url.pathname.split("/contents")[1];
        let body: unknown;
        if (path === "") {
          body = ["package.json", "deno.json", "bun.lock"].map((name) => ({
            type: "file",
            name,
            path: name,
          }));
        } else if (path === "/.github/workflows") {
          body = [{
            type: "file",
            name: "ci.yml",
            path: ".github/workflows/ci.yml",
          }];
        } else {
          const text = manifests[path];
          assert.notEqual(text, undefined, `unexpected contents read: ${path}`);
          body = { type: "file", encoding: "base64", content: btoa(text) };
        }
        return Promise.resolve(response(200, JSON.stringify(body)));
      },
    });
    const tree = await resolveTreeFacts(slug("ubiquity", "prospector"), "main");
    assert.ok(tree);
    assert.equal(tree.packageManager, packageManager);
    const loaded = await loadTargetConfigsV1({
      template: TEMPLATE,
      readFile: () => Promise.resolve('["ubiquity/prospector"]'),
      resolveDefaultBranch: () => Promise.resolve("main"),
      resolveTreeFacts,
    });
    assert.deepEqual(loaded.skipped, []);
    assert.equal(loaded.configs.length, 1);
    const config = loaded.configs[0]!;
    const spec = config.commandRegistry.commands[config.commands.test];
    assert.equal(config.adapter.kind, "github");
    assert.equal(spec.executable, toolchain);
    assert.deepEqual(
      spec.args,
      toolchain === "bun"
        ? ["--no-env-file", "run", "check"]
        : ["run", "check"],
    );
    assert.equal(isNoTestEvidenceTargetV1(config), false);
  }
});

Deno.test("targets: Deno without package-manager markers keeps its task names separate", async () => {
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () => Promise.resolve('["ubiquity/prospector"]'),
    resolveDefaultBranch: () => Promise.resolve("main"),
    resolveTreeFacts: () =>
      Promise.resolve({
        // With no package-manager declaration or lockfile, only a Deno task may run.
        files: ["deno.json", "package.json"],
        manifestScripts: { deno: ["check"], package: ["test"] },
        hasCiWorkflow: true,
      }),
  });
  const config = loaded.configs[0]!;
  const spec = config.commandRegistry.commands[config.commands.test];
  assert.equal(spec.executable, "deno");
  assert.deepEqual(spec.args, ["task", "check"]);
});

Deno.test("targets: no CI and no local verify carries the no-evidence park", async () => {
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () => Promise.resolve('["ubiquity/empty-repo"]'),
    resolveDefaultBranch: () => Promise.resolve("main"),
    resolveTreeFacts: () =>
      Promise.resolve({ files: ["README.md"], hasCiWorkflow: false }),
  });
  assert.equal(loaded.configs.length, 1);
  const config = loaded.configs[0]!;
  assert.equal(config.commands.test, NO_TEST_EVIDENCE_COMMAND_ID);
  assert.equal(isNoTestEvidenceTargetV1(config), true);
  assert.equal(
    config.commandRegistry.commands[config.commands.test].executable,
    "false",
  );
});

Deno.test("targets: unreadable tree facts skip the target like a bad branch", async () => {
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () =>
      Promise.resolve('["ubiquity-sentinel/sentinel", "ubiquity/offline"]'),
    resolveDefaultBranch: () => Promise.resolve("development"),
    resolveTreeFacts: (target) =>
      Promise.resolve(
        target.name === "offline" ? null : {
          files: ["deno.json"],
          manifestScripts: { deno: ["test"] },
          hasCiWorkflow: true,
        },
      ),
  });
  // A facts read is authoritative: an unprovable answer skips the generic
  // target instead of rebuilding it from an assumed toolchain.
  assert.deepEqual(
    loaded.configs.map((config) => config.repository.name),
    ["sentinel"],
  );
  assert.deepEqual([...loaded.skipped], ["ubiquity/offline"]);
  assert.deepEqual([...loaded.factsUnavailable], ["ubiquity/offline"]);
  assert.deepEqual(
    loaded.configs[0]!.commandRegistry,
    TEMPLATE.commandRegistry,
  );
});

Deno.test("targets: a malformed sentinel.protected skips the target", async () => {
  const root = "https://api.github.com/repos/ubiquity/protected/contents";
  const file = (name: string, text: string) =>
    JSON.stringify({
      type: "file",
      name,
      path: name,
      encoding: "base64",
      content: btoa(text),
    });
  const routes = new Map<string, string>([
    [
      `${root}?ref=main`,
      JSON.stringify([
        { type: "file", name: "package.json", path: "package.json" },
        {
          type: "file",
          name: "sentinel.protected",
          path: "sentinel.protected",
        },
      ]),
    ],
    [
      `${root}/package.json?ref=main`,
      file("package.json", JSON.stringify({ scripts: { test: "bun test" } })),
    ],
    [
      `${root}/sentinel.protected?ref=main`,
      file("sentinel.protected", "deploy/../escape\n"),
    ],
  ]);
  const resolver = createTargetTreeFactsResolver({
    http: treeFactsHttp(root, routes),
    token: "token-value",
  });
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () => Promise.resolve('["ubiquity/protected"]'),
    resolveDefaultBranch: () => Promise.resolve("main"),
    resolveTreeFacts: resolver,
  });
  assert.deepEqual(loaded.configs, []);
  assert.deepEqual([...loaded.skipped], ["ubiquity/protected"]);
  assert.deepEqual([...loaded.factsUnavailable], ["ubiquity/protected"]);
});

Deno.test("targets: named policies never spend a tree-facts read", async () => {
  const asked: string[] = [];
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () =>
      Promise.resolve(
        '["ubiquity-sentinel/sentinel", "ubiquity/passport.ubq.fi", "ubiquity/ai.ubq.fi", "ubiquity/prospector"]',
      ),
    resolveDefaultBranch: () => Promise.resolve("development"),
    resolveTreeFacts: (target) => {
      asked.push(target.slug);
      return Promise.resolve({
        files: ["bun.lock", "package.json"],
        manifestScripts: { package: ["test"] },
        hasCiWorkflow: true,
      });
    },
  });
  assert.deepEqual(asked, ["ubiquity/prospector"]);
  assert.deepEqual(
    loaded.configs.map((config) => config.commands.test),
    ["test_ci", "passport_verify", "gateway_verify", "generic_verify"],
  );
});

Deno.test("targets: an omitted facts resolver keeps the generic boundary", async () => {
  const loaded = await loadTargetConfigsV1({
    template: TEMPLATE,
    readFile: () =>
      Promise.resolve('["ubiquity-sentinel/sentinel", "ubiquity/prospector"]'),
    resolveDefaultBranch: () => Promise.resolve("development"),
  });
  assert.deepEqual([...loaded.skipped], []);
  assert.deepEqual(
    loaded.configs[0]!.commandRegistry,
    TEMPLATE.commandRegistry,
  );
  const generic = loaded.configs[1]!;
  assert.equal(generic.commands.test, "no_local_verify");
  assert.ok(generic.protectedPaths.includes(".git/"));
  assert.ok(generic.protectedPaths.includes(".npmrc"));
});

Deno.test("targets: tree facts read the exact branch's markers and CI trigger", async () => {
  const rootUrl = "https://api.github.com/repos/ubiquity/prospector/contents";
  const routes = new Map<string, string>();
  const file = (name: string, text: string) =>
    JSON.stringify({
      type: "file",
      name,
      path: name,
      encoding: "base64",
      content: btoa(text),
    });
  routes.set(
    `${rootUrl}?ref=main`,
    JSON.stringify([
      { type: "file", name: "package.json", path: "package.json" },
      { type: "file", name: "bun.lock", path: "bun.lock" },
      { type: "file", name: "deno.jsonc", path: "deno.jsonc" },
      { type: "file", name: "sentinel.protected", path: "sentinel.protected" },
      { type: "dir", name: ".github", path: ".github" },
    ]),
  );
  routes.set(
    `${rootUrl}/package.json?ref=main`,
    file("package.json", JSON.stringify({ scripts: { test: "bun test" } })),
  );
  routes.set(
    `${rootUrl}/deno.jsonc?ref=main`,
    file(
      "deno.jsonc",
      // Deno's own dialect: comments and trailing commas in both extensions.
      '{\n  // owner lanes\n  "tasks": { "check": "deno check src/mod.ts", },\n}\n',
    ),
  );
  routes.set(
    `${rootUrl}/sentinel.protected?ref=main`,
    file("sentinel.protected", "# owner boundary\ndeploy/\n"),
  );
  routes.set(
    `${rootUrl}/.github/workflows?ref=main`,
    JSON.stringify([
      {
        type: "file",
        name: "ci.yml",
        path: ".github/workflows/ci.yml",
      },
    ]),
  );
  routes.set(
    `${rootUrl}/.github/workflows/ci.yml?ref=main`,
    file("ci.yml", "on:\n  pull_request:\n"),
  );
  const http = treeFactsHttp(rootUrl, routes);
  const facts = createTargetTreeFactsResolver({ http, token: "token-value" });
  const read = await facts(slug("ubiquity", "prospector"), "main");
  assert.deepEqual(read, {
    files: [
      "package.json",
      "bun.lock",
      "deno.jsonc",
      "sentinel.protected",
    ],
    hasCiWorkflow: true,
    manifestScripts: { package: ["test"], deno: ["check"] },
    sentinelProtected: ["deploy"],
  });

  // A workflow that only runs on push is not pull-request CI.
  routes.set(
    `${rootUrl}/.github/workflows/ci.yml?ref=main`,
    file("ci.yml", "on:\n  push:\n"),
  );
  const pushOnly = await facts(slug("ubiquity", "prospector"), "main");
  assert.equal(pushOnly?.hasCiWorkflow, false);

  // Flow-style triggers are pull-request CI too.
  for (
    const flow of [
      "on: [push, pull_request]\n",
      "on: {pull_request: {}}\n",
      "on: pull_request\n",
    ]
  ) {
    routes.set(
      `${rootUrl}/.github/workflows/ci.yml?ref=main`,
      file("ci.yml", flow),
    );
    const flowFacts = await facts(slug("ubiquity", "prospector"), "main");
    assert.equal(flowFacts?.hasCiWorkflow, true, flow);
  }
  // Block lists, comments and multi-line flows are scanned without a YAML
  // dependency: a commented trigger is not a trigger, a block list item is.
  for (
    const workflow of [
      "on:\n  - push\n  - pull_request\n",
      "on: [push, # pull_request is not active here\n  pull_request]\n",
      "on: { push: {}, pull_request: {} }  # owner CI\n",
    ]
  ) {
    routes.set(
      `${rootUrl}/.github/workflows/ci.yml?ref=main`,
      file("ci.yml", workflow),
    );
    assert.equal(
      (await facts(slug("ubiquity", "prospector"), "main"))?.hasCiWorkflow,
      true,
      workflow,
    );
  }
  routes.set(
    `${rootUrl}/.github/workflows/ci.yml?ref=main`,
    file("ci.yml", "on:\n  # pull_request:\n  push:\n"),
  );
  assert.equal(
    (await facts(slug("ubiquity", "prospector"), "main"))?.hasCiWorkflow,
    false,
    "a commented trigger is not CI",
  );
  routes.set(
    `${rootUrl}/.github/workflows/ci.yml?ref=main`,
    file(
      "ci.yml",
      "on:\n  workflow_call:\n    inputs:\n      pull_request:\n",
    ),
  );
  assert.equal(
    (await facts(slug("ubiquity", "prospector"), "main"))?.hasCiWorkflow,
    false,
    "a nested input named pull_request is not an event",
  );
  // A push-only flow list is not pull-request CI.
  routes.set(
    `${rootUrl}/.github/workflows/ci.yml?ref=main`,
    file("ci.yml", "on: [push]\n"),
  );
  assert.equal(
    (await facts(slug("ubiquity", "prospector"), "main"))?.hasCiWorkflow,
    false,
  );

  // Trailing commas are not a parse failure: the check task is still found.
  assert.deepEqual(
    (await facts(slug("ubiquity", "prospector"), "main"))?.manifestScripts,
    { package: ["test"], deno: ["check"] },
  );

  // An unreadable root listing never becomes an empty (defaulted) tree.
  assert.equal(await facts(slug("ubiquity", "gone"), "main"), null);
});

Deno.test("targets: gated target reads consult the durable gate first", async () => {
  let requests = 0;
  const request = {
    method: "GET" as const,
    url: "https://api.github.com/repos/ubiquity/prospector",
    headers: new Map<string, string>(),
    body: null,
  };
  const refused = createGatedTargetReadTransport({
    http: () => {
      requests += 1;
      return Promise.resolve(response(200, "{}"));
    },
    gate: {
      beforeRequest: () => Promise.resolve(portError("unavailable", "held")),
    },
    installationId: 173913802,
  });
  await assert.rejects(() => refused(request), /durable cooldown/);
  assert.equal(requests, 0, "a held gate performs no request");

  const scopes: number[] = [];
  const allowed = createGatedTargetReadTransport({
    http: () => Promise.resolve(response(200, "{}")),
    gate: {
      beforeRequest: (installationId) => {
        scopes.push(installationId);
        return Promise.resolve(portOk(undefined));
      },
    },
    installationId: 173913802,
  });
  const answered = await allowed(request);
  assert.equal(answered.status, 200);
  assert.deepEqual(scopes, [173913802]);
});

Deno.test("targets: the default branch comes from GitHub, never from the file", async () => {
  const seen: string[] = [];
  const resolve = createDefaultBranchResolver({
    http: (request: HttpRequestV1) => {
      seen.push(request.url);
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "Bearer token-value");
      return Promise.resolve(
        response(200, JSON.stringify({ default_branch: "trunk" })),
      );
    },
    token: "token-value",
  });
  assert.equal(await resolve(slug("ubiquity-sentinel", "sentinel")), "trunk");
  assert.deepEqual(seen, [
    "https://api.github.com/repos/ubiquity-sentinel/sentinel",
  ]);

  const notFound = createDefaultBranchResolver({
    http: () => Promise.resolve(response(404, "{}")),
    token: "token-value",
  });
  assert.equal(await notFound(slug("ubiquity", "gone")), null);

  const garbage = createDefaultBranchResolver({
    http: () => Promise.resolve(response(200, "not json")),
    token: "token-value",
  });
  assert.equal(await garbage(slug("ubiquity-sentinel", "sentinel")), null);

  const blank = createDefaultBranchResolver({
    http: () =>
      Promise.resolve(response(200, JSON.stringify({ default_branch: " " }))),
    token: "token-value",
  });
  assert.equal(await blank(slug("ubiquity-sentinel", "sentinel")), null);

  const unavailable = createDefaultBranchResolver({
    http: () => Promise.reject(new Error("offline")),
    token: "token-value",
  });
  assert.equal(await unavailable(slug("ubiquity-sentinel", "sentinel")), null);
});
