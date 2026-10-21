/** Actual Actions host composition, real local state/Git and synthetic native APIs. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubPort } from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import type {
  ActionsRepairHostDepsV1,
  ActionsTargetCyclesInputV1,
} from "../../src/host/actions-target-cycles.ts";
import { HOSTED_RUNTIME_WORKFLOW_REF } from "../../src/host/hosted-runtime-identity.ts";
import { type HttpTransportV1, requestHeader } from "../../src/github/http.ts";
import { principalHostFixture } from "./hosted-app-principal-fixtures.ts";
import { nativeFixture } from "./existing-pr-native-fixtures.ts";
import { runProof } from "./actions-supervisor-fixture.ts";
import { captureConsoleLog } from "./local-test-helpers.ts";
import { makeRemoteCtx, testGitEnv, workRecord } from "../state/helpers.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { issueWire } from "../github/helpers.ts";

export async function actionsExistingPrincipalFixture(
  takeoverActivated = true,
  unmarked = false,
) {
  const principal = await principalHostFixture();
  const native = await nativeFixture();
  const root = principal.root;
  await principal.write(
    principal.runtime,
    ".gitignore",
    ".sentinel-actions-state/\n",
  );
  await principal.git(principal.runtime, ["add", "."]);
  await principal.git(principal.runtime, [
    "commit",
    "-qm",
    "fixture host scratch",
  ]);
  const revision = await principal.git(principal.runtime, [
    "rev-parse",
    "HEAD",
  ]) as GitSha;
  principal.execution.revision = revision;
  principal.execution.generation = 1;
  principal.capability.takeover.activated = takeoverActivated;
  principal.capability.existingPr.revisions = [revision];
  await principal.write(
    principal.launcher,
    "src/host/hosted-custody-capability.json",
    JSON.stringify(principal.capability),
  );
  const ready = parseReleaseStateSnapshotV1(principal.state.release!.snapshot);
  const saved = ready.hostedRuntimes[0];
  saved.activeRevision = revision;
  saved.generation = 1;
  saved.execution = structuredClone(principal.execution);
  assert(saved.lastHealthyProof !== null);
  saved.lastHealthyProof = runProof({
    ...saved.lastHealthyProof.execution,
    revision,
    generation: 1,
  }, "healthy");
  principal.state.setRelease(ready);
  await principal.commitLauncher();
  principal.identity.job = "matrix_plan";
  principal.model.jobs[0].name = "matrix_plan";
  (principal.model.jobs[0].steps as Array<{ name: string }>)[2].name =
    principal.profiles[0].jobs.matrix_plan.runtimeStep;
  principal.model.repositories[0].node_id =
    native.request.binding.headRepositoryId;

  const remoteRoot = root + "/state";
  await Deno.mkdir(remoteRoot);
  const remote = await makeRemoteCtx(remoteRoot, testGitEnv(root));
  const release = createReleaseStateStore({
    scratchDir: root + "/release",
    remoteUrl: remote.remoteUrl,
  });
  const state = createRepairStateStore({
    scratchDir: root + "/repair",
    remoteUrl: remote.remoteUrl,
  });
  const finalRelease = parseReleaseStateSnapshotV1(
    principal.state.release!.snapshot,
  );
  const runtime = finalRelease.hostedRuntimes[0];
  const healthy = runtime.lastHealthyProof!;
  let releaseHead: GitSha | null = null;
  for (
    const [index, item] of [
      {
        ...runtime,
        execution: healthy.execution,
        lastHealthyProof: null,
        lastExecutionProof: null,
      },
      {
        ...runtime,
        execution: null,
        lastHealthyProof: healthy,
        lastExecutionProof: healthy,
      },
      { ...runtime, lastHealthyProof: healthy, lastExecutionProof: healthy },
    ].entries()
  ) {
    const written = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...finalRelease,
        stateHead: releaseHead,
        sequence: index + 1,
        hostedRuntimes: [item],
      }),
      releaseHead,
    );
    assert(
      written.ok && written.value.status === "applied",
      "fixture release transition " + index + ": " + JSON.stringify(written),
    );
    releaseHead = written.value.head;
  }
  const seed = unmarked
    ? parseRepairStateSnapshotV1({
      ...native.state.repair!,
      work: [workRecord("issue-1", {
        repository: native.request.binding.repository,
        source: { kind: "issue", id: "1", revision: native.ctx.base },
        controller: { sha: revision },
        target: {
          base: native.ctx.base,
          head: null,
          branch: "sentinel/issue-1",
          pr: null,
          checkpoint: null,
        },
      })],
    })
    : native.state.repair!;
  const repair = await state.writeRepair(seed, null);
  assert(repair.ok && repair.value.status === "applied");
  const request = { ...native.request, expectedStateHead: repair.value.head };
  const bin = root + "/bin";
  await Deno.mkdir(bin);
  await Deno.writeTextFile(bin + "/codex", "#!/bin/sh\nexit 99\n");
  await Deno.chmod(bin + "/codex", 0o700);
  const env: Record<string, string | undefined> = {
    GITHUB_RUN_ID: String(principal.identity.runId),
    GITHUB_RUN_ATTEMPT: String(principal.identity.runAttempt),
    GITHUB_REPOSITORY: "ubiquity-sentinel/sentinel",
    GITHUB_REF: "refs/heads/sentinel-supervisor",
    GITHUB_SHA: principal.identity.launcherSha,
    GITHUB_WORKFLOW_SHA: principal.identity.launcherSha,
    GITHUB_WORKFLOW_REF: HOSTED_RUNTIME_WORKFLOW_REF,
    GITHUB_JOB: "matrix_plan",
    GITHUB_TOKEN: principal.jobInput.token,
    SENTINEL_SUPERVISOR_TOKEN: principal.scopeInput.token,
    SENTINEL_SELF_TOKEN: principal.scopeInput.token,
    SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: principal.hostInput.mintGrant,
    SENTINEL_SELF_TOKEN_MINT_GRANT: principal.hostInput.mintGrant,
    SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER: principal.hostInput.appTokenNotAfter,
    SENTINEL_APP_INSTALLATION_ID: "155687488",
    SENTINEL_MODEL_ID: "gpt-6.1-sol",
    UOS_AI_TOKEN: "fixture-model-token",
    PATH: bin + ":" + (Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin"),
    HOME: root + "/home",
  };
  const controls = {
    revoked: false,
    scopeReads: 0,
    afterScopeRead: undefined as
      | ((read: number) => Promise<void> | void)
      | undefined,
  };
  const targetCalls: Array<{ method: string; path: string }> = [];
  const http: HttpTransportV1 = async (input) => {
    const path = new URL(input.url).pathname;
    if (path.includes("/actions/")) return principal.jobInput.http(input);
    assert.equal(
      requestHeader(input.headers, "authorization"),
      "Bearer " + (env.SENTINEL_SUPERVISOR_TOKEN ?? env.GITHUB_TOKEN),
      "actual host REST port uses its captured target credential",
    );
    targetCalls.push({ method: input.method, path });
    if (path === "/repos/ubiquity-sentinel/sentinel/issues/1") {
      return {
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify(issueWire({
          number: 1,
          title: "Repair source",
          body: native.controls.body,
        })),
      };
    }
    if (
      path === "/graphql" &&
      JSON.parse(input.body!).query.includes("SentinelIssueRelations")
    ) {
      return {
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify({
          data: {
            repository: {
              issue: {
                number: 1,
                blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
                subIssues: { totalCount: 0 },
              },
            },
          },
        }),
      };
    }
    if (controls.revoked && path === "/installation/repositories") {
      return Promise.resolve({
        status: 401,
        headers: new Headers(),
        bodyText: "{}",
      });
    }
    if (
      path === "/installation/repositories" ||
      path === "/repos/ubiquity-sentinel/sentinel"
    ) {
      const reply = await principal.scopeInput.http(input);
      if (path === "/repos/ubiquity-sentinel/sentinel") {
        await controls.afterScopeRead?.(++controls.scopeReads);
      }
      return reply;
    }
    if (path === "/repos/ubiquity/ai.ubq.fi/rules/branches/development") {
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: "[]",
      });
    }
    return native.http(input);
  };
  const originalCommand = Deno.Command;
  const originalRun = DenoReplayRuntime.prototype.run;
  const gitCalls: Array<{ args: string[]; credential: string }> = [];
  DenoReplayRuntime.prototype.run = function (input) {
    const remoteUrl = "https://github.com/ubiquity-sentinel/sentinel.git";
    if (input.executable === "/usr/bin/git" && input.args.includes(remoteUrl)) {
      const expected = "Authorization: Basic " +
        btoa(
          "x-access-token:" +
            (env.SENTINEL_SELF_TOKEN ?? env.SENTINEL_SUPERVISOR_TOKEN ??
              env.GITHUB_TOKEN),
        );
      assert.equal(
        input.env.GIT_CONFIG_KEY_0,
        "http." + remoteUrl + ".extraheader",
      );
      assert.equal(input.env.GIT_CONFIG_VALUE_0, expected);
      gitCalls.push({
        args: [...input.args],
        credential: input.env.GIT_CONFIG_VALUE_0,
      });
      return originalRun.call(this, {
        ...input,
        args: [
          "-c",
          "url.file://" + native.ctx.bare + ".insteadOf=" + remoteUrl,
          ...input.args,
        ],
      });
    }
    return originalRun.call(this, input);
  };
  Deno.Command = class extends originalCommand {
    constructor(command: string | URL, options: Deno.CommandOptions = {}) {
      const remoteUrl = "https://github.com/ubiquity-sentinel/sentinel.git";
      let actual = options;
      if (command === "/usr/bin/git" && options.args?.includes(remoteUrl)) {
        const expected = "Authorization: Basic " +
          btoa(
            "x-access-token:" +
              (env.SENTINEL_SELF_TOKEN ?? env.SENTINEL_SUPERVISOR_TOKEN ??
                env.GITHUB_TOKEN),
          );
        assert.equal(
          options.env?.GIT_CONFIG_KEY_0,
          "http." + remoteUrl + ".extraheader",
        );
        assert.equal(options.env?.GIT_CONFIG_VALUE_0, expected);
        gitCalls.push({
          args: [...options.args],
          credential: options.env.GIT_CONFIG_VALUE_0,
        });
        actual = {
          ...options,
          args: [
            "-c",
            "url.file://" + native.ctx.bare + ".insteadOf=" + remoteUrl,
            ...options.args,
          ],
        };
      }
      super(command, actual);
    }
  };
  const captured = captureConsoleLog();
  let composed: GitHubPort | undefined;
  const deps: ActionsRepairHostDepsV1 = {
    job: "matrix_plan",
    env,
    clock: principal.clock,
    workDir: principal.runtime,
    state,
    http,
    hostedAppSourceProfiles: principal.profiles,
    refreshSelf: async (sourcePath) => {
      await principal.git(sourcePath, [
        "fetch",
        "-q",
        native.ctx.bare,
        native.ctx.base,
      ]);
      return native.ctx.base;
    },
    prepareTarget: async (config, sourcePath) => {
      if (config.repository.name === "sentinel") return;
      await principal.git(root, [
        "clone",
        "-q",
        "--no-checkout",
        native.ctx.bare,
        sourcePath,
      ]);
    },
    resolveDefaultBranch: () => Promise.resolve("development"),
    preflight: () => Promise.resolve(),
    composeGithub: (_config, production) => {
      composed = production;
      return production;
    },
  };
  return {
    principal,
    native,
    state,
    release,
    env,
    controls,
    request,
    targetCalls,
    gitCalls,
    async run(
      effect: (
        port: GitHubPort,
        input: ActionsTargetCyclesInputV1,
      ) => Promise<void>,
    ) {
      const result = await runActionsRepairHost({
        ...deps,
        runTargetCycles: async (input) => {
          const config = input.configs.find((row) =>
            row.repository.name === "sentinel"
          );
          assert(config !== undefined);
          const port = input.composeGithub(config);
          assert(composed !== undefined);
          assert.equal(port.existingPrTakeover, composed.existingPrTakeover);
          assert.equal(input.modelStartsEnabled, true);
          await effect(port, input);
          return {
            outcome: { status: "idle", detail: "fixture native boundary" },
            addressed: ["ubiquity-sentinel/sentinel"],
            skipped: [],
            failed: [],
          };
        },
      });
      assert.equal(result.status, "ran");
      return result;
    },
    async close() {
      Deno.Command = originalCommand;
      DenoReplayRuntime.prototype.run = originalRun;
      captured.restore();
      await native.ctx.cleanup();
      await principal.close();
    },
  };
}
