import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  readHostedSelfDependencyPreparer,
  writeHostedSelfDependencySeed,
} from "../../src/host/hosted-self-dependencies.ts";
import {
  SELF_ACTION,
  textDigest,
} from "../../src/host/self-dependency-files.ts";
import { LocalCheckoutModelPort } from "../../src/host/local-model.ts";
import { captureConsoleLog } from "./local-test-helpers.ts";
import {
  DependencyTracker,
  fixtureSymlink,
  mintConsumer,
} from "./self-dependency-fixtures.ts";
import { hostedSeedRig } from "./hosted-self-dependencies-fixtures.ts";

Deno.test("hosted self dependencies: independent producer files unlock actual model checkout and 19 offline mint consumers", async () => {
  const rig = await hostedSeedRig();
  const captured = captureConsoleLog();
  let consumer: Awaited<ReturnType<typeof mintConsumer>> | null = null;
  const tracker = new DependencyTracker(async () => {
    consumer = await mintConsumer(rig.checkout);
  });
  try {
    const missing = await readHostedSelfDependencyPreparer(rig.input);
    const port = (prepare: typeof missing) =>
      new LocalCheckoutModelPort({
        ...rig.options,
        tracker,
        prepareCheckoutDependencies: prepare,
      });
    assert.equal((await port(missing).runModel(rig.request)).ok, false);
    assert.equal(tracker.starts, 0);
    await assert.rejects(() => Deno.lstat(rig.client), Deno.errors.NotFound);
    const produced = await rig.producer();
    assert.deepEqual(produced, {
      code: 0,
      stdout: "sentinel self dependencies: prepared\n",
      stderr: "",
    });
    const before = await Deno.readTextFile(
      `${rig.seedDirectory}/manifest.json`,
    );
    assert.equal(
      await Deno.readTextFile(`${rig.seedDirectory}/seal.sha256`),
      `${textDigest(before)}\n`,
    );
    assert.equal(
      (await port(missing).runModel(rig.request)).ok,
      false,
      "unavailable initial custody is not silently replaced during the pass",
    );
    const prepared = await readHostedSelfDependencyPreparer(rig.input);
    assert.equal((await port(prepared).runModel(rig.request)).ok, true);
    assert.equal(tracker.starts, 1);
    assert(consumer !== null);
    const observed = consumer as Awaited<ReturnType<typeof mintConsumer>>;
    assert.equal(observed.code, 0, observed.text);
    assert.match(observed.text, /19 passed.*0 failed/s);
    await assert.rejects(
      () => Deno.lstat(`${rig.checkout}/.sentinel/self-dependencies`),
      Deno.errors.NotFound,
    );
    await rig.assertClean();
    assert.equal(await rig.git(["status", "--porcelain"], rig.checkout), "");
    assert.equal(
      (await rig.producer()).code,
      0,
      "same immutable producer publication is idempotent",
    );
    assert.equal(
      await Deno.readTextFile(`${rig.seedDirectory}/manifest.json`),
      before,
    );
  } finally {
    captured.restore();
    await tracker.settleAll();
    await rig.cleanup();
  }
});

Deno.test("hosted self dependencies: fixed producer refuses dirty source and arguments with static output", async () => {
  const rig = await hostedSeedRig();
  try {
    const args = await rig.producer(["/private-input-marker"]);
    assert.deepEqual(args, {
      code: 1,
      stdout: "",
      stderr: "sentinel self dependencies: unavailable\n",
    });
    await Deno.writeTextFile(
      `${rig.launcher}/private-input-marker`,
      "untracked",
    );
    const dirty = await rig.producer();
    assert.deepEqual(dirty, args);
    await assert.rejects(
      () => Deno.lstat(rig.seedDirectory),
      Deno.errors.NotFound,
    );
    await Deno.remove(`${rig.launcher}/private-input-marker`);
    await Deno.writeTextFile(
      `${rig.launcher}/${SELF_ACTION}/main.js`,
      "changed tracked source",
    );
    assert.deepEqual(await rig.producer(), args);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted self dependencies: stale native execution, wrong layout, and missing files refuse self only", async (t) => {
  const rig = await hostedSeedRig();
  const captured = captureConsoleLog();
  const tracker = new DependencyTracker();
  try {
    assert.equal((await rig.producer()).code, 0);
    const other = "f".repeat(40) as GitSha;
    for (
      const [name, input] of [
        ["stale saved execution", {
          ...rig.input,
          executionLauncherSha: other,
        }],
        ["stale native launcher", {
          ...rig.input,
          launcherSha: other,
          executionLauncherSha: other,
        }],
        ["caller directory", { ...rig.input, runtimeDir: rig.launcher }],
        ["noncanonical runtime", {
          ...rig.input,
          runtimeDir: `${rig.runtime}/../runtime`,
        }],
      ] as const
    ) {
      await t.step(name, async () => {
        const prepare = await readHostedSelfDependencyPreparer(input);
        const port = new LocalCheckoutModelPort({
          ...rig.options,
          tracker,
          prepareCheckoutDependencies: prepare,
        });
        assert.equal((await port.runModel(rig.request)).ok, false);
        assert.equal(tracker.starts, 0);
        assert.equal(
          (await prepare({
            repository: { ...rig.request.repository, name: "ai.ubq.fi" },
            checkout: "/never-read-private-marker",
          })).ok,
          true,
        );
      });
    }
    const valid = await readHostedSelfDependencyPreparer(rig.input);
    await Deno.remove(`${rig.seedDirectory}/seal.sha256`);
    assert.equal(
      (await valid({
        repository: rig.request.repository,
        checkout: rig.checkout,
      })).ok,
      false,
    );
    const unavailable = await readHostedSelfDependencyPreparer(rig.input);
    assert.equal(
      (await unavailable({
        repository: rig.request.repository,
        checkout: rig.checkout,
      })).ok,
      false,
    );
    await assert.rejects(() => Deno.lstat(rig.client), Deno.errors.NotFound);
  } finally {
    captured.restore();
    await tracker.settleAll();
    await rig.cleanup();
  }
});

Deno.test("hosted self dependencies: mutated pair, linked files, altered source and stale publication refuse before model", async (t) => {
  const rig = await hostedSeedRig();
  const captured = captureConsoleLog();
  const tracker = new DependencyTracker();
  try {
    assert.equal((await rig.producer()).code, 0);
    const manifestPath = `${rig.seedDirectory}/manifest.json`;
    const sealPath = `${rig.seedDirectory}/seal.sha256`;
    const original = await Deno.readTextFile(manifestPath);
    const seal = await Deno.readTextFile(sealPath);
    const bound = await readHostedSelfDependencyPreparer(rig.input);
    const run = async (prepare = bound) => {
      const result = await new LocalCheckoutModelPort({
        ...rig.options,
        tracker,
        prepareCheckoutDependencies: prepare,
      }).runModel(rig.request);
      assert.equal(result.ok, false);
      assert.equal(tracker.starts, 0);
      await assert.rejects(() => Deno.lstat(rig.client), Deno.errors.NotFound);
      assert(!JSON.stringify(result).includes(rig.root));
    };
    await t.step("manifest mutation", async () => {
      await Deno.writeTextFile(manifestPath, original + " ");
      await run();
      await Deno.writeTextFile(manifestPath, original);
    });
    await t.step("digest mutation", async () => {
      await Deno.writeTextFile(sealPath, "f".repeat(64) + "\n");
      await run();
      await Deno.writeTextFile(sealPath, seal);
    });
    await t.step("both files changed after custody", async () => {
      await Deno.writeTextFile(manifestPath, original + " ");
      await Deno.writeTextFile(sealPath, textDigest(original + " ") + "\n");
      await run();
      await Deno.writeTextFile(manifestPath, original);
      await Deno.writeTextFile(sealPath, seal);
    });
    await t.step("manifest symlink", async () => {
      const saved = `${rig.root}/saved-manifest`;
      await Deno.rename(manifestPath, saved);
      await fixtureSymlink(saved, manifestPath);
      await run();
      await run(await readHostedSelfDependencyPreparer(rig.input));
      await Deno.remove(manifestPath);
      await Deno.rename(saved, manifestPath);
    });
    await t.step("seal hardlink", async () => {
      const link = `${rig.root}/seal-hardlink`;
      await Deno.link(sealPath, link);
      await run();
      await Deno.remove(link);
    });
    await t.step("seed directory ancestor link", async () => {
      const saved = `${rig.root}/saved-seed`;
      await Deno.rename(rig.seedDirectory, saved);
      await fixtureSymlink(saved, rig.seedDirectory);
      await run();
      await Deno.remove(rig.seedDirectory);
      await Deno.rename(saved, rig.seedDirectory);
    });
    await t.step("untracked extra seed file", async () => {
      const extra = `${rig.seedDirectory}/private-input-marker`;
      await Deno.writeTextFile(extra, "unexpected");
      await run();
      await Deno.remove(extra);
    });
    await t.step("oversized manifest", async () => {
      await Deno.writeTextFile(manifestPath, "x".repeat(512 * 1024 + 1));
      await run();
      await Deno.writeTextFile(manifestPath, original);
    });
    await t.step("changed locked dependency bytes", async () => {
      const file =
        `${rig.launcher}/${SELF_ACTION}/node_modules/@actions/core/package.json`;
      const data = await Deno.readFile(file);
      await Deno.writeTextFile(file, "changed");
      await run();
      await assert.rejects(() =>
        writeHostedSelfDependencySeed({
          launcherDir: rig.launcher,
          trustedPath: rig.options.trustedPath,
        })
      );
      await Deno.writeFile(file, data);
      assert.equal(await Deno.readTextFile(manifestPath), original);
    });
    await t.step("dirty tracked launcher", async () => {
      const file = `${rig.launcher}/${SELF_ACTION}/main.js`;
      const data = await Deno.readFile(file);
      await Deno.writeTextFile(file, "changed");
      await run();
      await Deno.writeFile(file, data);
    });
    await t.step("clean new launcher cannot reuse old seed", async () => {
      await Deno.writeTextFile(`${rig.launcher}/new-file`, "new commit");
      await rig.git(["add", "new-file"], rig.launcher);
      await rig.git(["commit", "-qm", "new source"], rig.launcher);
      const head = await rig.git(["rev-parse", "HEAD"], rig.launcher) as GitSha;
      await run();
      await run(
        await readHostedSelfDependencyPreparer({
          ...rig.input,
          launcherSha: head,
          executionLauncherSha: head,
        }),
      );
      assert.equal((await rig.producer()).code, 1);
      assert.equal(await Deno.readTextFile(manifestPath), original);
    });
  } finally {
    captured.restore();
    await tracker.settleAll();
    await rig.cleanup();
  }
});
