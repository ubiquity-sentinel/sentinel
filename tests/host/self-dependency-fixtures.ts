/** Real private Git checkout and fake model transport; no credentials or network. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { CodexSessionV1 } from "../../src/repair/codex-transport.ts";
import { LocalSessionTracker } from "../../src/host/local-client.ts";
import {
  LocalCheckoutModelPort,
  type LocalModelInputV1,
} from "../../src/host/local-model.ts";
import { localCheckoutKey } from "../../src/host/local-checkout.ts";
import { buildSelfDependencySeed } from "../../src/host/self-dependency-seed.ts";
import {
  copyDependencies,
  dependencyFiles,
  SELF_ACTION,
  SELF_ACTION_FILES,
} from "../../src/host/self-dependency-files.ts";
import { ScriptedSession } from "../repair/model-port-helpers.ts";
import { FakeClock } from "../repair/helpers.ts";
import { gitRun, T0, testGitEnv } from "../state/helpers.ts";
import { modelRequest } from "./local-test-helpers.ts";

export async function selfDependencyRig() {
  const parent = `${Deno.cwd()}/.sentinel-artifacts`;
  await Deno.mkdir(parent, { recursive: true });
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: parent, prefix: "self-dependency-" }),
  );
  const source = `${root}/source`;
  const env = testGitEnv(`${root}/git-home`);
  const git = async (args: string[], cwd = source) => {
    const result = await gitRun(cwd, args, env);
    assert.equal(result.ok, true, result.stderr);
    return result.stdout.trim();
  };
  await Deno.mkdir(source);
  await git(["init", "-q"]);
  await git(["config", "user.name", "Sentinel fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  for (
    const file of [
      ...SELF_ACTION_FILES.map((file) => `${SELF_ACTION}/${file}`),
      "tests/host/hosted-app-mint_test.ts",
      "tests/host/hosted-app-mint-fixtures.ts",
    ]
  ) {
    await Deno.mkdir(`${source}/${file.slice(0, file.lastIndexOf("/"))}`, {
      recursive: true,
    });
    await Deno.copyFile(file, `${source}/${file}`);
  }
  await Deno.writeTextFile(`${source}/.gitignore`, ".sentinel-artifacts/\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "exact action fixture"]);
  const base = await git(["rev-parse", "HEAD"]) as GitSha;
  const dependencies = await dependencyFiles(
    `${Deno.cwd()}/${SELF_ACTION}/node_modules`,
  );
  await copyDependencies({
    source: `${Deno.cwd()}/${SELF_ACTION}/node_modules`,
    action: `${source}/${SELF_ACTION}`,
    files: dependencies,
  });
  const seed = await buildSelfDependencySeed({
    sourceRoot: source,
    sourceCommit: base,
    trustedPath: Deno.env.get("PATH") ?? "",
    scratch: `${root}/scratch`,
  });
  const request = {
    ...modelRequest(),
    base,
    repository: {
      owner: "ubiquity-sentinel",
      name: "sentinel",
      installationId: 155687488,
    },
  };
  const stateRoot = `${root}/state`;
  const checkout = `${stateRoot}/checkouts/${await localCheckoutKey(
    request.taskId,
  )}`;
  const client = `${stateRoot}/clients/${await localCheckoutKey(
    request.taskId,
  )}`;
  const options: Omit<LocalModelInputV1, "tracker"> = {
    stateRoot,
    sourcePath: source,
    scratch: `${root}/scratch`,
    trustedPath: Deno.env.get("PATH") ?? "",
    codexExecutable: "/nonexistent/sentinel-test-codex",
    denoExecutable: Deno.execPath(),
    modelToken: "synthetic-test-token",
    clock: new FakeClock(T0),
  };
  return {
    root,
    source,
    base,
    seed,
    request,
    checkout,
    client,
    options,
    git,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}
export class DependencyTracker extends LocalSessionTracker {
  starts = 0;
  constructor(
    private readonly atStart: () => Promise<void> = () => Promise.resolve(),
  ) {
    super();
  }
  override open<Session extends CodexSessionV1>(
    _factory: () => Session,
  ): Session {
    this.starts++;
    const execute = this.atStart;
    const session = new class extends ScriptedSession {
      override async send(method: string, params: unknown): Promise<unknown> {
        if (method === "turn/start") await execute();
        return super.send(method, params);
      }
    }(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "uos",
        activePermissionProfile: { id: "sentinel-local" },
      },
      { turn: { id: "turn-1" } },
      [{
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "failed", durationMs: 1 },
        },
      }],
    );
    return super.open((): CodexSessionV1 => session) as Session;
  }
}
export async function mintConsumer(checkout: string) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--allow-read=.,/usr,/bin," + Deno.execPath(),
      "--allow-run",
      "--allow-write",
      "--allow-env=PATH,NODE_V8_COVERAGE",
      "tests/host/hosted-app-mint_test.ts",
    ],
    cwd: checkout,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: checkout,
      TMPDIR: `${checkout}/.sentinel-artifacts`,
      DENO_DIR: `${checkout}/.sentinel-artifacts/deno`,
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    text: new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
  };
}
export async function runSelfModel(
  rig: Awaited<ReturnType<typeof selfDependencyRig>>,
  tracker: DependencyTracker,
  extra: Partial<LocalModelInputV1> = {},
) {
  return await new LocalCheckoutModelPort({ ...rig.options, tracker, ...extra })
    .runModel(rig.request);
}

export async function fixtureSymlink(
  target: string,
  path: string,
): Promise<void> {
  const result = await new Deno.Command("/bin/ln", {
    args: ["-s", "--", target, path],
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
}
