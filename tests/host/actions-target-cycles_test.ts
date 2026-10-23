/** Hosted actions-target-cycles_test responsibility. */
import assert from "node:assert/strict";
import {
  CONTROLLER,
  PUBLIC_CONTROLLER,
} from "./controller-identity-fixture.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseAppInstallationId,
  runActionsTargetCycles,
  scopeTargetConfigV1,
  targetsDiagnosticV1,
} from "../../src/host/actions.ts";
import type { ActionsTargetCyclesResultV1 } from "../../src/host/actions.ts";
import {
  composeLocalGitHub,
  createLocalRepositoryConfig,
  LocalSessionTracker,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";
import { createTargetConfigV1 } from "../../src/host/targets.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { gitRun, makeRemoteCtx, testGitEnv } from "../state/helpers.ts";
import {
  APP_INSTALLATION,
  FOREIGN_REPO,
  issueReadPaths,
  makeTargetHostRig,
  targetCycleInput,
  THIRD_REPO,
  unique,
} from "./actions-target-fixture.ts";
import { APP_PUBLISHER } from "./actions-ci-fixture.ts";
import { readHostedAppCredentials } from "../../src/host/hosted-app-credentials.ts";

Deno.test("actions host: issue-only repair scopes a gateway target to GitHub", () => {
  const self = createLocalRepositoryConfig();
  const gateway = createTargetConfigV1(
    self,
    { owner: "ubiquity", name: "ai.ubq.fi", slug: "ubiquity/ai.ubq.fi" },
    "development",
  );
  assert.equal(gateway.adapter.kind, "gateway");
  const scoped = scopeTargetConfigV1(
    gateway,
    self.repository,
    APP_INSTALLATION,
    { issueOnly: true },
  );
  assert.equal(scoped.adapter.kind, "github");
  assert.equal(scoped.repository.installationId, APP_INSTALLATION);
  const matrix = scopeTargetConfigV1(
    gateway,
    self.repository,
    APP_INSTALLATION,
    { issueOnly: false },
  );
  assert.equal(matrix.adapter.kind, "gateway");
});

Deno.test("actions host: live App installation ids are explicit while old runs retain the legacy scope", () => {
  const legacy = readHostedAppCredentials((name) =>
    ({
      SENTINEL_SUPERVISOR_TOKEN: "legacy-app",
      SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: "legacy-grant",
    })[name]
  );
  assert.equal(legacy.appToken, "legacy-app");
  // The `ubiquity` installation token never stands in for the self token:
  // an absent self token leaves the self repository on the native token.
  assert.equal(legacy.selfToken, undefined);
  assert.equal(legacy.selfGrant, undefined);
  assert.equal(legacy.targetInstallationId, 155687488);
  assert.equal(legacy.selfInstallationId, 155687488);

  const current = readHostedAppCredentials((name) =>
    ({
      SENTINEL_SUPERVISOR_TOKEN: "foreign-app",
      SENTINEL_SELF_TOKEN: "self-app",
      SENTINEL_SELF_TOKEN_MINT_GRANT: "self-grant",
      SENTINEL_TARGET_INSTALLATION_ID: "173913802",
      SENTINEL_SELF_INSTALLATION_ID: "173834540",
    })[name]
  );
  assert.equal(current.selfToken, "self-app");
  assert.equal(current.selfGrant, "self-grant");
  assert.equal(current.targetInstallationId, 173913802);
  assert.equal(current.selfInstallationId, 173834540);
});

Deno.test("actions host: prepared target capabilities reach the actual target cycle", async () => {
  const rig = makeTargetHostRig(["sentinel", FOREIGN_REPO, THIRD_REPO]);
  const trace: string[] = [];
  const pairs = new Map(rig.configs.map((config) => [config.repository.name, {
    incidents: { ...unavailableIncidents },
    replay: { ...unavailableReplay },
  }]));
  const input = {
    ...targetCycleInput(rig, {
      prepareTarget: (config) => {
        trace.push(`prepare:${config.repository.name}`);
        if (config.repository.name === THIRD_REPO) {
          throw new Error("owned setup refusal");
        }
        return Promise.resolve();
      },
      runCycle: (deps, options) => {
        const name = deps.configs[0].repository.name;
        const pair = pairs.get(name)!;
        trace.push(`cycle:${name}`);
        assert.equal(deps.incidents, pair.incidents);
        assert.equal(deps.replay, pair.replay);
        assert.equal(options.deadline, rig.clock.now() + 60 * 60_000);
        return runRepairEntrypoint(deps, options);
      },
    }),
    resolveTargetCapabilities: (config: typeof rig.configs[number]) => {
      trace.push(`resolve:${config.repository.name}`);
      return pairs.get(config.repository.name)!;
    },
  };
  const result = await runActionsTargetCycles(input);
  assert.deepEqual(trace, [
    "prepare:sentinel",
    "resolve:sentinel",
    "cycle:sentinel",
    `prepare:${FOREIGN_REPO}`,
    `resolve:${FOREIGN_REPO}`,
    `cycle:${FOREIGN_REPO}`,
    `prepare:${THIRD_REPO}`,
  ]);
  assert.deepEqual(result.addressed, [
    "ubiquity-sentinel/sentinel",
    `ubiquity/${FOREIGN_REPO}`,
  ]);
  assert.equal(result.failed.length, 1);
  assert.equal(rig.budget, input.budget);
});

Deno.test(
  "actions host: two committed targets produce two targeted cycles that read every target's issues",
  async () => {
    const rig = makeTargetHostRig(["sentinel", FOREIGN_REPO]);
    const configsPerCycle: string[][] = [];
    const admissionsPerCycle: number[][] = [];
    const outcomes: unknown[] = [];
    const reported: ActionsTargetCyclesResultV1[] = [];
    let boundary = 0;
    const result = await runActionsTargetCycles(targetCycleInput(rig, {
      report: (value) => {
        reported.push(value);
      },
      runCycle: async (deps, options) => {
        boundary = rig.gate.admissions.length;
        configsPerCycle.push(
          deps.configs.map((config) =>
            `${config.repository.owner}/${config.repository.name}`
          ),
        );
        const outcome = await runRepairEntrypoint(deps, options);
        admissionsPerCycle.push(rig.gate.admissions.slice(boundary));
        outcomes.push(outcome);
        return outcome;
      },
    }));

    // EVERY committed target is addressed exactly once, and each cycle is
    // injected the SOLE configuration its port was composed for.
    assert.deepEqual(result.addressed, [
      "ubiquity-sentinel/sentinel",
      `ubiquity/${FOREIGN_REPO}`,
    ]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(configsPerCycle, [
      ["ubiquity-sentinel/sentinel"],
      [`ubiquity/${FOREIGN_REPO}`],
    ]);
    // The REAL entrypoint read one issue list per target, in setting order,
    // through the port the host composed for that exact repository.
    assert.deepEqual(issueReadPaths(rig.http), [
      "/repos/ubiquity-sentinel/sentinel/issues",
      `/repos/ubiquity/${FOREIGN_REPO}/issues`,
    ]);
    // The sentinel self-target keeps the reserved no-App scope 0; the foreign
    // target is gated under the one App installation scope.
    assert.deepEqual(
      admissionsPerCycle.map(unique),
      [
        [PUBLIC_CONTROLLER ? 0 : APP_INSTALLATION],
        [APP_INSTALLATION],
      ],
      "each cycle is gated under its own target's installation scope",
    );
    // The aggregate uses the LAST addressed cycle's outcome.
    assert.equal(outcomes.length, 2);
    assert.equal(result.outcome, outcomes[1]);
    // One advisory report of the same pass, and the diagnostic line is never a
    // child status record.
    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.outcome, result.outcome);
    assert.deepEqual(reported[0]!.addressed, result.addressed);
    assert.deepEqual(reported[0]!.skipped, []);
    const line = targetsDiagnosticV1({
      addressed: result.addressed,
      skipped: result.skipped,
      failed: result.failed,
    });
    assert.equal(Object.hasOwn(line, "status"), false);
    assert.deepEqual(line, {
      version: "v1",
      kind: "sentinel_targets_diagnostic",
      addressed: ["ubiquity-sentinel/sentinel", `ubiquity/${FOREIGN_REPO}`],
      skipped: [],
      failed: [],
    });
  },
);

Deno.test(
  "actions host: a foreign target uses the App installation scope while the controller keeps 0",
  () => {
    assert.equal(APP_INSTALLATION, 155_687_488);
    assert.equal(parseAppInstallationId("4242"), 4242);
    assert.throws(() => parseAppInstallationId("0"));
    assert.throws(() => parseAppInstallationId("-1"));
    assert.throws(() => parseAppInstallationId("155687488x"));

    const self = createLocalRepositoryConfig();
    const sentinel = createTargetConfigV1(self, {
      slug: CONTROLLER.fullName,
      owner: self.repository.owner,
      name: self.repository.name,
    }, "development");
    const foreign = createTargetConfigV1(self, {
      slug: `ubiquity/${FOREIGN_REPO}`,
      owner: "ubiquity",
      name: FOREIGN_REPO,
    }, "main");
    const scopedSelf = scopeTargetConfigV1(sentinel, self.repository, 970_001);
    const scopedForeign = scopeTargetConfigV1(
      foreign,
      self.repository,
      970_001,
    );
    assert.equal(scopedSelf.repository.installationId, 0);
    assert.equal(scopedForeign.repository.installationId, 970_001);
    // Nothing except the identity changes: the trusted template still owns
    // every command, limit and protected path.
    assert.deepEqual(
      { ...scopedForeign, repository: null },
      { ...foreign, repository: null },
    );
  },
);

Deno.test(
  "actions host: an exhausted shared deadline stops before the next target cycle",
  async () => {
    const rig = makeTargetHostRig(["sentinel", FOREIGN_REPO, THIRD_REPO]);
    const composed: string[] = [];
    let cycles = 0;
    const result = await runActionsTargetCycles(targetCycleInput(rig, {
      deadline: rig.clock.now() + 10 * 60_000,
      composeGithub: (config) => {
        composed.push(`${config.repository.owner}/${config.repository.name}`);
        return rig.compose(config);
      },
      runCycle: async (deps, options) => {
        cycles++;
        const outcome = await runRepairEntrypoint(deps, options);
        // The one absolute deadline is now exhausted; the next check must stop
        // the run instead of restarting the clock for the next cycle.
        rig.clock.advance(11 * 60_000);
        return outcome;
      },
    }));

    assert.equal(cycles, 1, "only the first target was attempted");
    assert.deepEqual(result.addressed, ["ubiquity-sentinel/sentinel"]);
    assert.deepEqual(result.skipped, [
      `ubiquity/${FOREIGN_REPO}`,
      `ubiquity/${THIRD_REPO}`,
    ]);
    assert.deepEqual(composed, ["ubiquity-sentinel/sentinel"]);
    assert.deepEqual(issueReadPaths(rig.http), [
      "/repos/ubiquity-sentinel/sentinel/issues",
    ]);
    assert.ok(result.outcome !== null);
  },
);

Deno.test(
  "actions host: a composed port reads the supplied repository under the supplied installation scope",
  async () => {
    const rig = makeTargetHostRig([FOREIGN_REPO]);
    const port = composeLocalGitHub({
      clock: rig.clock,
      state: rig.state,
      gate: rig.gate,
      http: rig.http.transport,
      token: "dummy-token",
      login: APP_PUBLISHER,
      invocationId: "test-override",
      stateRoot: "/tmp/sentinel-multi-target-state",
      sourcePath: "/tmp/sentinel-multi-target-source",
      scratch: "/tmp/sentinel-multi-target-scratch",
      reviewCheckout: "/tmp/sentinel-multi-target-review",
      reviewClientHome: "/tmp/sentinel-multi-target-clients",
      reviewTmpDir: "/tmp/sentinel-multi-target-tmp",
      reviewDenoDir: "/tmp/sentinel-multi-target-deno",
      trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      codexExecutable: "/usr/bin/false",
      tracker: new LocalSessionTracker(),
      // The owner/name identity and the gate scope are supplied separately;
      // the explicit scope wins for every cooldown-gated request.
      repository: { owner: "ubiquity", name: FOREIGN_REPO, installationId: 0 },
      installationId: 970_001,
    });
    const listed = await port.listOpenIssues();
    assert.ok(listed.ok);
    assert.deepEqual(issueReadPaths(rig.http), [
      `/repos/ubiquity/${FOREIGN_REPO}/issues`,
    ]);
    assert.ok(rig.gate.admissions.length > 0);
    assert.deepEqual(unique(rig.gate.admissions), [970_001]);
  },
);

Deno.test(
  "actions host: the App installation scope is allowlisted in the workflow and both tasks",
  async () => {
    const workflow = await Deno.readTextFile(
      new URL("../../.github/workflows/supervisor.yml", import.meta.url),
    );
    const repairJob = workflow.split("Run selected Sentinel runtime")[1] ?? "";
    assert.ok(
      repairJob.includes('SENTINEL_APP_INSTALLATION_ID: "155687488"'),
      "the repair job passes the fixed App installation scope",
    );
    assert.ok(
      /--allow-env=\S*SENTINEL_APP_INSTALLATION_ID/.test(repairJob),
      "the repair launcher may read the App installation scope",
    );
    assert.ok(
      repairJob.includes(
        "SENTINEL_TARGET_INSTALLATION_ID: ${{ steps.app-token.outputs.installation-id }}",
      ),
      "the repair launcher binds the live foreign credential installation",
    );
    assert.ok(
      repairJob.includes(
        "SENTINEL_SELF_INSTALLATION_ID: ${{ steps.self-token.outputs.installation-id }}",
      ),
      "the repair launcher binds the live self credential installation",
    );
    assert.ok(
      /--allow-env=\S*SENTINEL_TARGET_INSTALLATION_ID/.test(repairJob),
      "the repair launcher may read the live foreign installation",
    );
    assert.ok(
      /--allow-env=\S*SENTINEL_SELF_INSTALLATION_ID/.test(repairJob),
      "the repair launcher may read the live self installation",
    );
    const manifest = JSON.parse(
      await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
    ) as { tasks: Record<string, string> };
    for (const task of ["repair:actions", "supervisor:run"]) {
      for (
        const key of [
          "SENTINEL_APP_INSTALLATION_ID",
          "SENTINEL_TARGET_INSTALLATION_ID",
          "SENTINEL_SELF_INSTALLATION_ID",
        ]
      ) {
        assert.ok(
          manifest.tasks[task].includes(key),
          `${task} may read ${key}`,
        );
      }
    }
  },
);

Deno.test(
  "actions host: the dedicated review-model override is allowlisted where the runtime reads it",
  async () => {
    const manifest = JSON.parse(
      await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
    ) as { tasks: Record<string, string> };
    for (const task of ["repair:run", "repair:actions"]) {
      assert.ok(
        manifest.tasks[task].includes("SENTINEL_REVIEW_MODEL_ID"),
        `${task} may read the dedicated review-model override`,
      );
    }
    const workflow = await Deno.readTextFile(
      new URL("../../.github/workflows/supervisor.yml", import.meta.url),
    );
    const repairJob = workflow.split("Run selected Sentinel runtime")[1] ?? "";
    assert.ok(
      /--allow-env=\S*SENTINEL_REVIEW_MODEL_ID/.test(repairJob),
      "the hosted repair launcher may read the dedicated review-model override",
    );
  },
);

Deno.test(
  "actions host: a target whose own preparation fails is recorded and never reported as addressed",
  async () => {
    const rig = makeTargetHostRig(["sentinel", FOREIGN_REPO]);
    const prepared: string[] = [];
    const addressed: string[][] = [];
    const result = await runActionsTargetCycles(targetCycleInput(rig, {
      prepareTarget: (config) => {
        const slug = `${config.repository.owner}/${config.repository.name}`;
        prepared.push(slug);
        // The foreign target's own remote is unreachable for this run: only
        // THAT target fails, and the self-target must still be repaired.
        if (slug.endsWith(FOREIGN_REPO)) {
          return Promise.reject(new Error("target mirror fetch failed"));
        }
        return Promise.resolve();
      },
      runCycle: async (deps, options) => {
        addressed.push(
          deps.configs.map((config) =>
            `${config.repository.owner}/${config.repository.name}`
          ),
        );
        return await runRepairEntrypoint(deps, options);
      },
    }));

    assert.deepEqual(prepared, [
      "ubiquity-sentinel/sentinel",
      `ubiquity/${FOREIGN_REPO}`,
    ]);
    assert.deepEqual(addressed, [["ubiquity-sentinel/sentinel"]]);
    assert.deepEqual(result.addressed, ["ubiquity-sentinel/sentinel"]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.failed, [
      `ubiquity/${FOREIGN_REPO}: target mirror fetch failed`,
    ]);
    // A failed target is neither addressed nor skipped: the two lists stay
    // disjoint so the diagnostic can never read as a success claim.
    for (const entry of result.failed) {
      assert.equal(
        result.addressed.some((slug) => entry.startsWith(slug)),
        false,
      );
      assert.equal(result.skipped.length, 0);
    }
  },
);

Deno.test(
  "actions host: a foreign target's own mirror resolves its base commit while the sentinel mirror cannot",
  async () => {
    // Real offline git: two independent repositories. The sentinel mirror is
    // seeded from the sentinel checkout only, exactly as the hosted host does,
    // so it provably cannot resolve a foreign repository's commit; that is the
    // defect this test pins.
    const root = await Deno.makeTempDir({
      dir: Deno.cwd(),
      prefix: "sentinel-target-mirror-",
    });
    // A private credential-free git home: no user/system config, no hooks and
    // no credential helper can leak in from this host.
    const home = `${root}/git-home`;
    await Deno.mkdir(home, { recursive: true });
    const env = testGitEnv(home);
    try {
      const sentinel = await makeRemoteCtx(`${root}/sentinel`, env);
      const foreign = await makeRemoteCtx(`${root}/foreign`, env);
      const commit = async (
        work: string,
        file: string,
        message: string,
      ): Promise<GitSha> => {
        await Deno.writeTextFile(`${work}/${file}`, `${message}\n`);
        assert.ok((await gitRun(work, ["add", "-A"], env)).ok);
        assert.ok(
          (await gitRun(work, ["commit", "-q", "-m", message], env)).ok,
        );
        const rev = await gitRun(work, ["rev-parse", "HEAD"], env);
        assert.ok(rev.ok);
        return rev.stdout.trim() as GitSha;
      };

      const sentinelBase = await commit(
        sentinel.work,
        "a.txt",
        "sentinel base",
      );
      assert.ok(
        (await gitRun(
          sentinel.work,
          ["push", "-q", "origin", "HEAD:refs/heads/development"],
          env,
        )).ok,
      );
      const foreignBase = await commit(foreign.work, "b.txt", "foreign base");
      assert.ok(
        (await gitRun(
          foreign.work,
          ["push", "-q", "origin", "HEAD:refs/heads/main"],
          env,
        )).ok,
      );

      // The sentinel mirror is seeded from the sentinel checkout. The foreign
      // commit object is NOT in it, which is exactly why a shared mirror
      // cannot serve a foreign target.
      const sentinelMirror = `${root}/mirror-sentinel`;
      assert.ok(
        (await gitRun(
          root,
          ["clone", "-q", "--no-hardlinks", sentinel.work, sentinelMirror],
          env,
        )).ok,
      );
      const absent = await gitRun(
        sentinelMirror,
        ["cat-file", "-e", `${foreignBase}^{commit}`],
        env,
      );
      assert.equal(
        absent.ok,
        false,
        "the sentinel mirror lacks foreign objects",
      );

      // The foreign target's OWN mirror, seeded from its own remote, resolves
      // that target's base commit and nothing of sentinel's.
      const foreignMirror = `${root}/mirror-foreign`;
      assert.ok(
        (await gitRun(
          root,
          [
            "clone",
            "-q",
            "--no-hardlinks",
            "--no-checkout",
            foreign.remoteUrl,
            foreignMirror,
          ],
          env,
        )).ok,
      );
      assert.ok(
        (await gitRun(
          foreignMirror,
          [
            "fetch",
            "-q",
            "--no-tags",
            foreign.remoteUrl,
            "+refs/heads/main:refs/remotes/origin/main",
          ],
          env,
        )).ok,
      );
      const resolved = await gitRun(
        foreignMirror,
        ["rev-parse", "refs/remotes/origin/main"],
        env,
      );
      assert.ok(resolved.ok);
      assert.equal(resolved.stdout.trim(), foreignBase);
      const detached = await gitRun(
        foreignMirror,
        ["checkout", "-q", "--detach", foreignBase],
        env,
      );
      assert.ok(detached.ok, "the foreign mirror can check out its own base");
      // Sentinel's object is genuinely absent from the foreign mirror, so the
      // two mirrors are disjoint and neither can silently serve the other.
      const sentinelAbsent = await gitRun(
        foreignMirror,
        ["cat-file", "-e", `${sentinelBase}^{commit}`],
        env,
      );
      assert.equal(sentinelAbsent.ok, false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);
