import assert from "node:assert/strict";
import { createSelfDependencyPreparer } from "../../src/host/self-dependency-preparation.ts";
import {
  buildSelfDependencySeed,
  parseSelfDependencySeed,
  type SelfDependencySeedV1,
} from "../../src/host/self-dependency-seed.ts";
import {
  dependencyFiles,
  SELF_ACTION,
  textDigest,
} from "../../src/host/self-dependency-files.ts";
import {
  ensureTaskCheckout,
  localCheckoutKey,
} from "../../src/host/local-checkout.ts";
import { LocalCheckoutModelPort } from "../../src/host/local-model.ts";
import { captureConsoleLog } from "./local-test-helpers.ts";
import {
  DependencyTracker,
  fixtureSymlink,
  mintConsumer,
  runSelfModel,
  selfDependencyRig,
} from "./self-dependency-fixtures.ts";

Deno.test("self dependencies: real checkout then prepared client runs all actual offline mint and post consumers", async () => {
  const rig = await selfDependencyRig();
  const captured = captureConsoleLog();
  let consumer: Awaited<ReturnType<typeof mintConsumer>> | undefined;
  const tracker = new DependencyTracker(async () => {
    const config = await Deno.readTextFile(`${rig.client}/config.toml`);
    assert(config.includes('"/usr/local/bin/node" = "read"'));
    assert(config.includes("enabled = false"));
    assert(config.includes('inherit = "none"'));
    assert(!config.includes("synthetic-test-token"));
    consumer = await mintConsumer(rig.checkout);
  });
  try {
    const tracked = await rig.git(["status", "--porcelain"]);
    const prepare = createSelfDependencyPreparer({
      seedRoot: rig.source,
      manifestText: rig.seed.text,
      expectedSealSha256: rig.seed.sha256,
      sourceCommit: rig.base,
    });
    const result = await runSelfModel(rig, tracker, {
      prepareCheckoutDependencies: prepare,
    });
    assert.equal(tracker.starts, 1);
    assert(result.ok);
    assert(consumer !== undefined);
    assert.equal(consumer.code, 0, consumer.text);
    assert.match(consumer.text, /19 passed.*0 failed/s);
    assert.equal(
      await rig.git(["status", "--porcelain"], rig.checkout),
      tracked,
    );
    assert.deepEqual(
      await dependencyFiles(`${rig.checkout}/${SELF_ACTION}/node_modules`),
      parseSelfDependencySeed(rig.seed.text).dependencies,
    );
    assert.equal(
      (await prepare({
        repository: rig.request.repository,
        checkout: rig.checkout,
      })).ok,
      true,
      "unchanged reused tree verifies",
    );
  } finally {
    captured.restore();
    await tracker.settleAll();
    await rig.cleanup();
  }
});

Deno.test("self dependencies: missing prep reproduces mandatory consumer failure after Git-only checkout", async () => {
  const rig = await selfDependencyRig();
  const captured = captureConsoleLog();
  let consumer: Awaited<ReturnType<typeof mintConsumer>> | undefined;
  const tracker = new DependencyTracker(async () => {
    consumer = await mintConsumer(rig.checkout);
  });
  try {
    await runSelfModel(rig, tracker);
    assert.equal(tracker.starts, 1);
    assert(consumer !== undefined);
    assert.notEqual(consumer.code, 0);
    assert.match(consumer.text, /failed/);
    const load = await new Deno.Command("/usr/local/bin/node", {
      args: [
        "--input-type=module",
        "--eval",
        `import('./${SELF_ACTION}/main.js')`,
      ],
      cwd: rig.checkout,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.match(new TextDecoder().decode(load.stderr), /ERR_MODULE_NOT_FOUND/);
  } finally {
    captured.restore();
    await tracker.settleAll();
    await rig.cleanup();
  }
});

Deno.test("self dependencies: altered seed source or tree refuses before client, session, or tracked writes", async (t) => {
  for (
    const mode of [
      "source",
      "lock",
      "dependency",
      "symlink",
      "extra",
      "hardlink",
    ]
  ) {
    await t.step(mode, async () => {
      const rig = await selfDependencyRig();
      const captured = captureConsoleLog();
      const tracker = new DependencyTracker();
      try {
        const prepare = createSelfDependencyPreparer({
          seedRoot: rig.source,
          manifestText: rig.seed.text,
          expectedSealSha256: rig.seed.sha256,
          sourceCommit: rig.base,
        });
        const action = `${rig.source}/${SELF_ACTION}`;
        const dependency = `${action}/node_modules/@actions/core/package.json`;
        if (mode === "source") {
          await Deno.writeTextFile(`${action}/main.js`, "untrusted");
        }
        if (mode === "lock") {
          await Deno.writeTextFile(`${action}/package-lock.json`, "{}");
        }
        if (mode === "dependency") await Deno.writeTextFile(dependency, "{}");
        if (mode === "symlink") {
          await Deno.remove(dependency);
          await fixtureSymlink(`${action}/package.json`, dependency);
        }
        if (mode === "extra") {
          await Deno.writeTextFile(
            `${action}/node_modules/unexpected`,
            "unexpected",
          );
        }
        if (mode === "hardlink") {
          await Deno.link(dependency, `${rig.root}/outside-link`);
        }
        const result = await runSelfModel(rig, tracker, {
          prepareCheckoutDependencies: prepare,
        });
        assert.equal(result.ok, false);
        assert.equal(tracker.starts, 0);
        await assert.rejects(
          () => Deno.lstat(rig.client),
          Deno.errors.NotFound,
        );
        await assert.rejects(
          () => Deno.lstat(`${rig.checkout}/${SELF_ACTION}/node_modules`),
          Deno.errors.NotFound,
        );
        assert.equal(
          await rig.git(["status", "--porcelain"], rig.checkout),
          "",
        );
        assert(!JSON.stringify(result).includes(rig.root));
      } finally {
        captured.restore();
        await tracker.settleAll();
        await rig.cleanup();
      }
    });
  }
});

Deno.test("self dependencies: changed candidate lock, source, ancestor link, and reused tree fail closed", async (t) => {
  const rig = await selfDependencyRig();
  try {
    const prepare = createSelfDependencyPreparer({
      seedRoot: rig.source,
      manifestText: rig.seed.text,
      expectedSealSha256: rig.seed.sha256,
      sourceCommit: rig.base,
    });
    const prepared = await ensureTaskCheckout({
      taskId: rig.request.taskId,
      key: await localCheckoutKey(rig.request.taskId),
      base: rig.base,
      stateRoot: rig.options.stateRoot,
      sourcePath: rig.source,
      scratch: rig.options.scratch,
      trustedPath: rig.options.trustedPath,
    });
    assert(prepared.ok);
    for (const file of ["package-lock.json", "main.js"]) {
      await t.step(file, async () => {
        const path = `${rig.checkout}/${SELF_ACTION}/${file}`;
        const original = await Deno.readFile(path);
        await Deno.writeTextFile(path, "changed");
        assert.equal(
          (await prepare({
            repository: rig.request.repository,
            checkout: rig.checkout,
          })).ok,
          false,
        );
        assert.equal(await Deno.readTextFile(path), "changed");
        await Deno.writeFile(path, original);
      });
    }
    await t.step("escaping ancestor", async () => {
      await Deno.rename(
        `${rig.checkout}/.github`,
        `${rig.checkout}/saved-github`,
      );
      await fixtureSymlink(
        `${rig.checkout}/saved-github`,
        `${rig.checkout}/.github`,
      );
      assert.equal(
        (await prepare({
          repository: rig.request.repository,
          checkout: rig.checkout,
        })).ok,
        false,
      );
      await Deno.remove(`${rig.checkout}/.github`);
      await Deno.rename(
        `${rig.checkout}/saved-github`,
        `${rig.checkout}/.github`,
      );
    });
    await t.step("existing symlink is never followed", async () => {
      await fixtureSymlink(
        `${rig.source}/${SELF_ACTION}/node_modules`,
        `${rig.checkout}/${SELF_ACTION}/node_modules`,
      );
      assert.equal(
        (await prepare({
          repository: rig.request.repository,
          checkout: rig.checkout,
        })).ok,
        false,
      );
      await Deno.remove(`${rig.checkout}/${SELF_ACTION}/node_modules`);
    });
    assert.equal(
      (await prepare({
        repository: rig.request.repository,
        checkout: rig.checkout,
      })).ok,
      true,
    );
    await t.step(
      "modified reusable tree is preserved and refused",
      async () => {
        const changed =
          `${rig.checkout}/${SELF_ACTION}/node_modules/@actions/core/package.json`;
        await Deno.writeTextFile(changed, "changed");
        assert.equal(
          (await prepare({
            repository: rig.request.repository,
            checkout: rig.checkout,
          })).ok,
          false,
        );
        assert.equal(await Deno.readTextFile(changed), "changed");
      },
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("self dependencies: seal parser and producer reject unknown Node, identity and unsafe manifests", async (t) => {
  const rig = await selfDependencyRig();
  try {
    const prepared = await ensureTaskCheckout({
      taskId: rig.request.taskId,
      key: await localCheckoutKey(rig.request.taskId),
      base: rig.base,
      stateRoot: rig.options.stateRoot,
      sourcePath: rig.source,
      scratch: rig.options.scratch,
      trustedPath: rig.options.trustedPath,
    });
    assert(prepared.ok);
    for (
      const mutate of [
        (
          v: Omit<SelfDependencySeedV1, "node"> & {
            node: {
              path: string;
              version: string;
              sha256: string;
              size: number;
            };
            authority?: string;
          },
        ) => {
          v.node.version = "v22.18.0";
        },
        (
          v: Omit<SelfDependencySeedV1, "node"> & {
            node: {
              path: string;
              version: string;
              sha256: string;
              size: number;
            };
            authority?: string;
          },
        ) => {
          v.node.path = "/untrusted/node";
        },
        (
          v: Omit<SelfDependencySeedV1, "node"> & {
            node: {
              path: string;
              version: string;
              sha256: string;
              size: number;
            };
            authority?: string;
          },
        ) => {
          v.authority = "model";
        },
        (
          v: Omit<SelfDependencySeedV1, "node"> & {
            node: {
              path: string;
              version: string;
              sha256: string;
              size: number;
            };
            authority?: string;
          },
        ) => {
          v.dependencies[0].path = "../escape";
        },
        (
          v: Omit<SelfDependencySeedV1, "node"> & {
            node: {
              path: string;
              version: string;
              sha256: string;
              size: number;
            };
            authority?: string;
          },
        ) => {
          v.dependencies.push(v.dependencies[0]);
        },
        (
          v: Omit<SelfDependencySeedV1, "node"> & {
            node: {
              path: string;
              version: string;
              sha256: string;
              size: number;
            };
            authority?: string;
          },
        ) => {
          v.dependencies[0].size = 40 * 1024 * 1024;
        },
        (
          v: Omit<SelfDependencySeedV1, "node"> & {
            node: {
              path: string;
              version: string;
              sha256: string;
              size: number;
            };
            authority?: string;
          },
        ) => {
          v.source = [];
        },
      ]
    ) {
      const value = JSON.parse(rig.seed.text);
      mutate(value);
      assert.throws(() => parseSelfDependencySeed(JSON.stringify(value)));
    }
    assert.throws(() =>
      createSelfDependencyPreparer({
        seedRoot: rig.source,
        manifestText: rig.seed.text + " ",
        expectedSealSha256: rig.seed.sha256,
        sourceCommit: rig.base,
      })
    );
    await t.step("mismatched Node digest", async () => {
      const value = JSON.parse(rig.seed.text);
      value.node.sha256 = "f".repeat(64);
      const text = JSON.stringify(value);
      const prepare = createSelfDependencyPreparer({
        seedRoot: rig.source,
        manifestText: text,
        expectedSealSha256: textDigest(text),
        sourceCommit: rig.base,
      });
      assert.equal(
        (await prepare({
          repository: rig.request.repository,
          checkout: rig.checkout,
        })).ok,
        false,
      );
    });
    await Deno.writeTextFile(`${rig.source}/${SELF_ACTION}/main.js`, "changed");
    await assert.rejects(() =>
      buildSelfDependencySeed({
        sourceRoot: rig.source,
        sourceCommit: rig.base,
        trustedPath: rig.options.trustedPath,
        scratch: rig.options.scratch,
      })
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("self dependencies: nonself target bypasses preparation and self exceptions refuse before session", async () => {
  const rig = await selfDependencyRig();
  const captured = captureConsoleLog();
  const tracker = new DependencyTracker();
  let calls = 0;
  try {
    const port = new LocalCheckoutModelPort({
      ...rig.options,
      tracker,
      prepareCheckoutDependencies: () => {
        calls++;
        throw new Error("private error");
      },
    });
    const foreign = {
      ...rig.request,
      repository: {
        owner: "ubiquity",
        name: "ai.ubq.fi",
        installationId: 155687488,
      },
    };
    assert.equal((await port.runModel(foreign)).ok, true);
    assert.equal(calls, 0);
    assert.equal(tracker.starts, 1);
    assert.equal((await port.runModel(rig.request)).ok, false);
    assert.equal(calls, 1);
    assert.equal(tracker.starts, 1);
    assert(!captured.lines.join("\n").includes("private error"));
  } finally {
    captured.restore();
    await tracker.settleAll();
    await rig.cleanup();
  }
});
