import assert from "node:assert/strict";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import { LocalCheckoutModelPort } from "../../src/host/local-model.ts";
import type {
  ModelRunReceiptV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import {
  dependencyFiles,
  SELF_ACTION,
} from "../../src/host/self-dependency-files.ts";
import { parseSelfDependencySeed } from "../../src/host/self-dependency-seed.ts";
import { captureConsoleLog } from "./local-test-helpers.ts";
import {
  actionsSelfSeedRig,
  fakeActionsModelTransport,
  modelShellPolicy,
} from "./actions-self-dependencies-fixtures.ts";

Deno.test("Actions self dependencies: real host refuses absent producer then runs its actual prepared model with confined credential-free shell", async () => {
  const rig = await actionsSelfSeedRig();
  const captured = captureConsoleLog();
  let consumer: { code: number; text: string } | null = null;
  let childEnvironment: Record<string, string> | null = null;
  let clientPolicyChecked = false;
  const boundary = fakeActionsModelTransport(async (options) => {
    assert.equal(options.cwd, rig.checkout);
    assert.deepEqual(Object.keys(options.env ?? {}).sort(), [
      "CODEX_HOME",
      "DENO_DIR",
      "HOME",
      "PATH",
      "TMPDIR",
    ]);
    assert(!JSON.stringify(options.env).includes("credential-marker"));
    const config = await Deno.readTextFile(`${rig.client}/config.toml`);
    assert(config.includes('inherit = "none"'));
    assert(config.includes("enabled = false"));
    assert(config.includes('"/usr/local/bin/node" = "read"'));
    assert(!config.includes("credential-marker"));
    const { environment, writable } = modelShellPolicy(config, rig.checkout);
    assert.deepEqual(Object.keys(environment).sort(), [
      "BUN_INSTALL_CACHE_DIR",
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
      "DENO_DIR",
      "HOME",
      "PATH",
      "TMPDIR",
    ]);
    assert.equal(environment.HOME, rig.checkout);
    assert.equal(writable.length, 3);
    for (const grant of writable) {
      const canonical = await Deno.realPath(grant);
      assert.equal(canonical, grant);
      assert(
        !rig.launcher.startsWith(`${canonical}/`) && rig.launcher !== canonical,
        `launcher is writable through ${grant}`,
      );
      assert(
        !rig.seedDirectory.startsWith(`${canonical}/`) &&
          rig.seedDirectory !== canonical,
        `seed is writable through ${grant}`,
      );
      assert(
        !canonical.startsWith(`${rig.launcher}/`),
        `write grant enters launcher: ${grant}`,
      );
    }
    clientPolicyChecked = true;
    const probe = await new Deno.Command("/usr/local/bin/node", {
      args: [
        "--input-type=module",
        "--eval",
        "console.log(JSON.stringify(process.env))",
      ],
      cwd: options.cwd,
      clearEnv: true,
      env: environment,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(probe.code, 0, new TextDecoder().decode(probe.stderr));
    childEnvironment = JSON.parse(new TextDecoder().decode(probe.stdout));
    assert.deepEqual(
      childEnvironment,
      environment,
      "actual child inherits only the generated model shell environment",
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--allow-read=.,/usr,/bin," + Deno.execPath(),
        "--allow-run",
        "--allow-write",
        "--allow-env=PATH,NODE_V8_COVERAGE",
        "tests/host/hosted-app-mint_test.ts",
      ],
      cwd: options.cwd,
      clearEnv: true,
      env: environment,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    consumer = {
      code: result.code,
      text: new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr),
    };
  });
  let httpCalls = 0;
  let queueReads = 0;
  const modelResults: PortResultV1<ModelRunReceiptV1>[] = [];
  const actualModels: LocalCheckoutModelPort[] = [];
  const runHost = () =>
    runActionsRepairHost({
      clock: rig.clock,
      env: rig.env,
      workDir: rig.runtime,
      stateRemoteUrl: rig.remote.remoteUrl,
      refreshSelf: () => Promise.resolve(rig.base),
      resolveDefaultBranch: () => Promise.resolve("development"),
      preflight: () => Promise.resolve(),
      http: (request) => {
        const url = new URL(request.url);
        if (
          request.method === "GET" && url.origin === "https://api.github.com" &&
          url.pathname ===
            "/repos/ubiquity/ai.ubq.fi/rules/branches/development"
        ) {
          queueReads++;
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: "[]",
          });
        }
        httpCalls++;
        throw new Error("fixture forbids HTTP");
      },
      runTargetCycles: async (input) => {
        assert(input.model instanceof LocalCheckoutModelPort);
        assert.equal(input.model.modelId, "gpt-6.1-sol");
        assert.equal(
          input.modelStartsEnabled,
          true,
          "actual saved healthy execution enables the model boundary",
        );
        actualModels.push(input.model);
        modelResults.push(await input.model.runModel(rig.request));
        return {
          outcome: { status: "idle", detail: "fixture boundary observed" },
          addressed: ["ubiquity-sentinel/sentinel"],
          skipped: [],
          failed: [],
        };
      },
    });
  try {
    const missing = await runHost();
    assert.equal(missing.status, "ran");
    assert.equal(modelResults[0]?.ok, false);
    assert.equal(boundary.calls.length, 0);
    await assert.rejects(() => Deno.lstat(rig.client), Deno.errors.NotFound);
    await assert.rejects(
      () => Deno.lstat(`${rig.checkout}/${SELF_ACTION}/node_modules`),
      Deno.errors.NotFound,
    );
    const produced = await rig.producer();
    assert.deepEqual(produced, {
      code: 0,
      stdout: "sentinel self dependencies: prepared\n",
      stderr: "",
    });
    const manifestText = await Deno.readTextFile(
      `${rig.seedDirectory}/manifest.json`,
    );
    const sealText = await Deno.readTextFile(
      `${rig.seedDirectory}/seal.sha256`,
    );
    const ready = await runHost();
    assert.equal(ready.status, "ran");
    assert.equal(actualModels.length, 2);
    assert.notEqual(actualModels[0], actualModels[1]);
    assert.equal(modelResults[1]?.ok, true);
    assert.equal(boundary.calls.length, 1);
    assert(clientPolicyChecked);
    assert(childEnvironment !== null);
    assert(consumer !== null);
    const observed = consumer as { code: number; text: string };
    assert.equal(observed.code, 0, observed.text);
    assert.match(observed.text, /19 passed.*0 failed/s);
    assert.deepEqual(
      await dependencyFiles(`${rig.checkout}/${SELF_ACTION}/node_modules`),
      parseSelfDependencySeed(manifestText).dependencies,
    );
    assert.equal(
      await Deno.readTextFile(`${rig.seedDirectory}/manifest.json`),
      manifestText,
    );
    assert.equal(
      await Deno.readTextFile(`${rig.seedDirectory}/seal.sha256`),
      sealText,
    );
    await assert.rejects(
      () => Deno.lstat(`${rig.checkout}/.sentinel/self-dependencies`),
      Deno.errors.NotFound,
    );
    assert.equal(await rig.git(["status", "--porcelain"], rig.checkout), "");
    await rig.assertClean();
    assert.equal(httpCalls, 0);
    assert.equal(queueReads, 2);
    const read = await rig.release.readRelease();
    assert(read.ok && read.value.status === "found");
    assert.equal(
      read.value.snapshot.hostedRuntimes[0].execution?.launcherSha,
      rig.base,
    );
    for (const secret of [rig.env.GITHUB_TOKEN, rig.env.UOS_AI_TOKEN]) {
      assert(!captured.lines.join("\n").includes(secret));
    }
  } finally {
    boundary.restore();
    captured.restore();
    await rig.cleanup();
  }
});
