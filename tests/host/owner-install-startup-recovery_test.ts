import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  runHostedSupervisorWithPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import startupCompareResponse from "../fixtures/startup-recovery-compare.json" with {
  type: "json",
};
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseHostedRunProofV1,
  parseHostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type { HostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  buildOwnerDevelopmentInstallSnapshot
    as productionBuildOwnerDevelopmentInstallSnapshot,
  planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall,
} from "../../src/host/owner-development-install.ts";
import {
  LAUNCHER,
  STATE_HEAD,
  UNRELATED,
} from "./owner-install-fixture-constants.ts";
import {
  cooldown,
  notStartedProof,
  releaseSnapshot,
  requestedRelease,
} from "./owner-install-fixture-proofs.ts";
import {
  STARTUP_CANDIDATE,
  STARTUP_FAILED,
  STARTUP_NOW,
  STARTUP_PRIOR,
  STARTUP_RUNTIME,
  startupAuthority,
} from "./owner-install-fixture-startup.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";

Deno.test("owner startup recovery: fixed identity proof refuses retired pointers and unsafe custody", () => {
  const base = releaseSnapshot({ runtime: STARTUP_RUNTIME });
  const authority = startupAuthority();
  const plan = (state: ReleaseStateSnapshotV1, auth: unknown = authority) =>
    Reflect.apply(planOwnerDevelopmentInstall, undefined, [
      state,
      STARTUP_NOW,
      undefined,
      auth,
    ]) as ReturnType<typeof planOwnerDevelopmentInstall>;
  const unsafe: ReleaseStateSnapshotV1[] = [
    {
      ...base,
      hostedRuntimes: [{ ...STARTUP_RUNTIME, activeRevision: UNRELATED }],
    },
    { ...base, hostedRuntimes: [{ ...STARTUP_RUNTIME, generation: 62 }] },
    {
      ...base,
      hostedRuntimes: [{ ...STARTUP_RUNTIME, lastHealthyProof: null }],
    },
    {
      ...base,
      hostedRuntimes: [{
        ...STARTUP_RUNTIME,
        lastHealthyProof: {
          ...STARTUP_RUNTIME.lastHealthyProof!,
          execution: {
            ...STARTUP_RUNTIME.lastHealthyProof!.execution,
            generation: 65,
          },
        },
      }],
    },
    {
      ...base,
      hostedRuntimes: [{
        ...STARTUP_RUNTIME,
        lastHealthyProof: {
          ...STARTUP_RUNTIME.lastHealthyProof!,
          logDigest: "0".repeat(64),
        },
      }],
    },
    {
      ...base,
      hostedRuntimes: [{ ...STARTUP_RUNTIME, lastExecutionProof: null }],
    },
    {
      ...base,
      hostedRuntimes: [{
        ...STARTUP_RUNTIME,
        lastExecutionProof: notStartedProof(STARTUP_FAILED, 66),
      }],
    },
    {
      ...base,
      hostedRuntimes: [{
        ...STARTUP_RUNTIME,
        execution: {
          ...STARTUP_RUNTIME.lastExecutionProof!.execution,
          runId: 777,
          id: "777:1:repair",
        },
      }],
    },
    { ...base, hostedReleases: [requestedRelease()] },
    { ...base, githubCooldowns: [cooldown(STARTUP_NOW + 60_000)] },
  ];
  for (const state of unsafe) {
    const result = plan(state);
    assert.ok(
      result.status === "waiting" || result.status === "no_change",
      JSON.stringify(result),
    );
  }
  for (
    const auth of [
      { ...authority, nativeQuiescent: false },
      { ...authority, nativeProofsVerified: false },
      { ...authority, healthyProof: { ...authority.healthyProof, jobId: 1 } },
      { ...authority, run: { ...authority.run, runId: 0 } },
    ]
  ) assert.equal(plan(base, auth).status, "waiting");

  const healthy = parseHostedRunProofV1({
    ...STARTUP_RUNTIME.lastHealthyProof!,
    execution: {
      ...STARTUP_RUNTIME.lastHealthyProof!.execution,
      id: "999:1:repair",
      runId: 999,
      revision: STARTUP_CANDIDATE,
      generation: 67,
      purpose: "bootstrap",
    },
  });
  const accepted = {
    ...base,
    hostedRuntimes: [{
      ...STARTUP_RUNTIME,
      activeRevision: STARTUP_CANDIDATE,
      generation: 67,
      lastHealthyProof: healthy,
    }],
  };
  assert.equal(
    plan(accepted).status,
    "no_change",
    "accepted startup does not reopen on later unrelated failure",
  );
  for (
    const [revision, generation] of [
      ["2266a52ae1db749548d9f30031c6425894307849", 63],
      ["ebd779621ab3849cd206e2f3c74c63cf2f832880", 64],
      [STARTUP_PRIOR, 63],
    ] as const
  ) {
    assert.equal(
      plan({
        ...base,
        hostedRuntimes: [{
          ...STARTUP_RUNTIME,
          activeRevision: revision as GitSha,
          generation,
        }],
      }).status,
      "no_change",
      "retired startup pointers never reinstall",
    );
  }
  assert.equal(
    planOwnerDevelopmentInstall(base, STARTUP_NOW).status,
    "no_change",
    "legacy invocation gains no authority",
  );
  const chosen = plan(base);
  assert.equal(chosen.status, "install");
  if (chosen.status !== "install") throw new Error("missing valid control");
  assert.throws(() =>
    Reflect.apply(buildOwnerDevelopmentInstallSnapshot, undefined, [
      base,
      STATE_HEAD,
      { ...chosen.move, nextRevision: UNRELATED },
      STARTUP_NOW,
      undefined,
      authority,
    ])
  );
});

Deno.test("owner startup recovery: real installer and supervisor refuse retired63 and64 without writes", async () => {
  for (
    const [activeRevision, generation] of [
      ["2266a52ae1db749548d9f30031c6425894307849", 63],
      ["ebd779621ab3849cd206e2f3c74c63cf2f832880", 64],
      [STARTUP_PRIOR, 63],
    ] as const
  ) {
    const fixture = await concurrencyInstallerFixture(
      releaseSnapshot({
        runtime: parseHostedRuntimeRecordV1({
          ...STARTUP_RUNTIME,
          activeRevision,
          generation,
        }),
      }),
      undefined,
      STARTUP_CANDIDATE,
      undefined,
      {},
    );
    try {
      const before = await fixture.read();
      const beforeRepair = await fixture.readRepair();
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "no_change");
      const supervisor = await runHostedSupervisorPrepare({
        queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
        existingPrRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
        runtimeRollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,

        clock: { now: () => STARTUP_NOW },
        state: fixture.releaseStore,
        run: fixture.runIdentity(),
        ownerStartupRecoveryOnly: true,
        evidence: {
          readExecution: () => {
            throw new Error("retired pointer cannot settle");
          },
          verifyRevision: () => {
            throw new Error("retired pointer cannot verify");
          },
          verifyRequest: () => {
            throw new Error("retired pointer cannot release");
          },
        },
      });
      assert.equal(supervisor.status, "pending");
      assert.equal(fixture.patches(), 0);
      assert.deepEqual(await fixture.read(), before);
      assert.deepEqual(await fixture.readRepair(), beforeRepair);
    } finally {
      await fixture.close();
    }
  }
});

Deno.test("owner startup recovery: real consumer refuses source CI native custody and CAS faults", async (test) => {
  for (
    const fault of [
      "ancestry",
      "ci",
      "parent",
      "readback",
      "source",
      "controller_ci",
      "native",
      "proof",
    ] as const
  ) {
    await test.step(fault, async () => {
      const standard =
        fault === "ancestry" || fault === "ci" || fault === "parent" ||
          fault === "readback"
          ? fault
          : undefined;
      const special = standard === undefined
        ? fault as "source" | "controller_ci" | "native" | "proof"
        : undefined;
      const fixture = await concurrencyInstallerFixture(
        releaseSnapshot({ runtime: STARTUP_RUNTIME }),
        standard,
        STARTUP_CANDIDATE,
        undefined,
        { refusal: special },
      );
      try {
        await fixture.run();
        assert.notEqual(fixture.reports.at(-1)?.status, "installed", fault);
        assert.equal(fixture.patches(), fault === "readback" ? 1 : 0, fault);
        if (fault === "source") {
          assert.equal(
            fixture.requests.length,
            0,
            "dirty source reads no token-backed API",
          );
        }
      } finally {
        await fixture.close();
      }
    });
  }
});

Deno.test("owner startup recovery: actual GitHub compare shape binds exact candidate and refuses malformed ancestry", async () => {
  assert.equal(Object.hasOwn(startupCompareResponse, "head_commit"), false);
  for (
    const compareFault of [
      undefined,
      "base",
      "merge_base",
      "counter",
      "missing",
    ] as const
  ) {
    const fixture = await concurrencyInstallerFixture(
      releaseSnapshot({ runtime: STARTUP_RUNTIME }),
      undefined,
      STARTUP_CANDIDATE,
      undefined,
      { compareFault },
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(
        fixture.reports.at(-1)?.status,
        compareFault === undefined ? "installed" : "waiting",
        JSON.stringify(fixture.reports),
      );
      assert.equal(fixture.patches(), compareFault === undefined ? 1 : 0);
      assert.deepEqual(
        fixture.requests.filter((request) => request.path.includes("/compare/"))
          .map((request) => request.path),
        [`/repos/ubiquity/sentinel/compare/${STARTUP_CANDIDATE}...${fixture.runIdentity().launcherSha}`],
      );
    } finally {
      await fixture.close();
    }
  }
});

Deno.test("supervisor workflow: ordinary maintenance precedes the existing verification path", async () => {
  const text = await Deno.readTextFile(
    new URL("../../.github/workflows/supervisor.yml", import.meta.url),
  );
  const maintenance = text.slice(
    text.indexOf("  maintenance:"),
    text.indexOf("  prepare:"),
  );
  assert.match(
    maintenance,
    /if: github\.ref == 'refs\/heads\/sentinel-supervisor'/,
  );
  assert.match(text, /needs\.maintenance\.result == 'success'/);
  // The retired recovery flags no longer appear; the prepare and finalize
  // verification runs stay on the plain supervisor entrypoint.
  assert.doesNotMatch(text, /--startup-recovery|--owner-startup-recovery-only/);
  assert.equal(
    (text.match(/run: deno task supervisor:run$/gm) ?? []).length,
    2,
  );
  assert.match(text, /--allow-run=git/);
  assert.doesNotMatch(text, /--allow-env=[^\n]*OWNER_STARTUP_RECOVERY/);
  const ownerInstall = text.slice(
    text.indexOf(
      "      - name: Install owner-authorized development runtime\n",
    ),
    text.indexOf("      - name: Prepare hosted supervisor run\n"),
  );
  assert.deepEqual(
    ownerInstall.match(/^ {10}--allow-net(?:[= ].*)?$/gm),
    ['          --allow-net="api.github.com,*.blob.core.windows.net"'],
  );
});

Deno.test("owner startup recovery: real installer and supervisor verify generation67 then hold terminal without rollback", async (test) => {
  for (const outcome of ["healthy", "failed"] as const) {
    await test.step(outcome, async () => {
      const fixture = await concurrencyInstallerFixture(
        releaseSnapshot({ runtime: STARTUP_RUNTIME }),
        undefined,
        STARTUP_CANDIDATE,
        undefined,
        {},
      );
      try {
        const beforeRepair = await fixture.readRepair();
        assert.equal(await fixture.run(), 0, JSON.stringify(fixture.reports));
        assert.equal(
          fixture.reports.at(-1)?.status,
          "installed",
          JSON.stringify(fixture.reports),
        );
        assert.equal(fixture.patches(), 1);
        const read = await fixture.read();
        assert.ok(read.ok && read.value.status === "found");
        const runtime = read.value.snapshot.hostedRuntimes[0];
        assert.equal(runtime.activeRevision, STARTUP_CANDIDATE);
        assert.equal(runtime.generation, 67);
        assert.deepEqual(
          runtime.lastHealthyProof,
          STARTUP_RUNTIME.lastHealthyProof,
        );
        assert.equal(await fixture.run(), 0);
        assert.equal(
          fixture.patches(),
          1,
          "duplicate invocation cannot move an in-flight pointer",
        );
        let time = STARTUP_NOW;
        let observed: HostedRunProofV1 | null = null;
        const core = () => ({
          queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
          existingPrRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
          runtimeRollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,

          clock: { now: () => time },
          state: fixture.releaseStore,
          run: fixture.runIdentity(),
          ownerStartupRecoveryOnly: true,
          evidence: {
            readExecution: () => Promise.resolve(portOk(observed)),
            verifyRevision: () => Promise.resolve(portOk(true)),
            verifyRequest: () => {
              throw new Error("recovery must not select a release");
            },
            verifyMatrixOrdinaryRevision: () => {
              throw new Error("recovery must not admit a matrix");
            },
          },
        });
        const outputs = new Map<string, string>();
        const host = () => {
          const identity = fixture.runIdentity();
          return runHostedSupervisorWithPolicy(
            DORMANT_HOSTED_SUPERVISOR_POLICY,
            {
              sourceDir: Deno.cwd(),
              clock: { now: () => time },
              state: fixture.releaseStore,
              ownerStartupRecoveryOnly: true,
              http: () => {
                throw new Error(
                  "recovery composition must not query task/release or ordinary capability",
                );
              },
              process: {
                run: (input) =>
                  Promise.resolve({
                    outcome: "exited",
                    exitCode: 0,
                    signal: null,
                    stdout: new TextEncoder().encode(
                      input.args.includes("rev-parse")
                        ? `${identity.launcherSha}\n`
                        : "",
                    ),
                    stderr: new Uint8Array(),
                    truncated: false,
                    settled: true,
                    durationMs: 0,
                    detail: "offline source identity",
                  }),
              },
              env: {
                GITHUB_REPOSITORY: "ubiquity/sentinel",
                GITHUB_REF: "refs/heads/sentinel-supervisor",
                GITHUB_JOB: "prepare",
                GITHUB_RUN_ID: String(identity.runId),
                GITHUB_RUN_ATTEMPT: "1",
                GITHUB_SHA: identity.launcherSha,
                GITHUB_WORKFLOW_SHA: identity.launcherSha,
                GITHUB_WORKFLOW_REF:
                  "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
                GITHUB_TOKEN: "offline-native-token-value",
              },
              writeOutput: (name, value) => {
                outputs.set(name, value);
                return Promise.resolve();
              },
            },
          );
        };
        assert.equal((await host()).execution?.purpose, "bootstrap");
        assert.equal(outputs.get("modelStartsEnabled"), "false");
        const prepared = await runHostedSupervisorPrepare(core());
        assert.equal(prepared.status, "run");
        if (prepared.status !== "run") {
          throw new Error("expected saved bootstrap");
        }
        assert.equal(prepared.execution.purpose, "bootstrap");
        assert.equal(prepared.execution.releaseId, null);
        observed = parseHostedRunProofV1({
          execution: prepared.execution,
          workflowId: 357012162,
          workflowPath: ".github/workflows/supervisor.yml",
          repository: "ubiquity/sentinel",
          ref: "refs/heads/sentinel-supervisor",
          jobId: 999001,
          startedAt: time + 100,
          finishedAt: time + 200,
          observedAt: time + 300,
          outcome,
          startupReady: outcome === "healthy",
          settled: true,
          baseSha: outcome === "healthy"
            ? STARTUP_RUNTIME.lastHealthyProof!.baseSha
            : null,
          terminalAt: time + 150,
          logDigest: "1".repeat(64),
        });
        time += 400;
        fixture.setNow(time);
        assert.equal(
          (await runHostedSupervisorFinalize(core())).status,
          "idle",
        );
        const settled = await fixture.read();
        assert.ok(settled.ok && settled.value.status === "found");
        const terminal = settled.value.snapshot.hostedRuntimes[0];
        assert.equal(terminal.activeRevision, STARTUP_CANDIDATE);
        assert.equal(terminal.generation, 67);
        assert.equal(terminal.execution, null);
        assert.deepEqual(terminal.lastExecutionProof, observed);
        assert.deepEqual(
          terminal.lastHealthyProof,
          outcome === "healthy" ? observed : STARTUP_RUNTIME.lastHealthyProof,
          "only fresh generation67 health replaces the historical generation63 proof",
        );
        fixture.setRun(1000000);
        for (let replay = 0; replay < 2; replay++) {
          assert.equal(await fixture.run(), 0);
          assert.equal(fixture.reports.at(-1)?.status, "no_change");
          assert.equal(
            fixture.patches(),
            1,
            "terminal generation67 never reinstalls or rolls back",
          );
          assert.deepEqual(
            await fixture.read(),
            settled,
            "terminal hold writes no release state",
          );
        }
        assert.equal((await runHostedSupervisorPrepare(core())).status, "idle");
        outputs.clear();
        assert.equal((await host()).status, "idle");
        assert.equal(outputs.get("run"), "false");
        assert.deepEqual(
          await fixture.readRepair(),
          beforeRepair,
          "foreign work and all charges stay byte-identical",
        );
      } finally {
        await fixture.close();
      }
    });
  }
});

Deno.test("owner startup recovery: exact failed66 installs only pinned67 and records bootstrap intent", () => {
  const state = releaseSnapshot({ runtime: STARTUP_RUNTIME });
  const authority = startupAuthority();
  const plan = Reflect.apply(planOwnerDevelopmentInstall, undefined, [
    state,
    STARTUP_NOW,
    undefined,
    authority,
  ]) as ReturnType<typeof planOwnerDevelopmentInstall>;
  assert.equal(plan.status, "install");
  if (plan.status !== "install") {
    throw new Error("expected pinned startup installation");
  }
  assert.equal(plan.move.priorRevision, STARTUP_FAILED);
  assert.equal(plan.move.nextRevision, STARTUP_CANDIDATE);
  assert.equal(plan.move.nextGeneration, 67);
  assert.deepEqual(
    plan.move.priorHealthyProof,
    STARTUP_RUNTIME.lastHealthyProof,
  );
  const next = Reflect.apply(buildOwnerDevelopmentInstallSnapshot, undefined, [
    state,
    STATE_HEAD,
    plan.move,
    STARTUP_NOW,
    undefined,
    authority,
  ]) as ReleaseStateSnapshotV1;
  assert.deepEqual(next.hostedRuntimes[0].execution, {
    id: "999999:1:repair",
    runId: 999999,
    runAttempt: 1,
    launcherSha: LAUNCHER,
    purpose: "bootstrap",
    revision: STARTUP_CANDIDATE,
    generation: 67,
    releaseId: null,
    createdAt: STARTUP_NOW,
  });
  assert.deepEqual(
    next.hostedRuntimes[0].lastHealthyProof,
    STARTUP_RUNTIME.lastHealthyProof,
  );
});

Deno.test("owner startup recovery: changed repair custody refuses while an ambiguous applied CAS reconciles once", async () => {
  for (const fault of ["repair", "ambiguous"] as const) {
    const fixture = await concurrencyInstallerFixture(
      releaseSnapshot({ runtime: STARTUP_RUNTIME }),
      undefined,
      STARTUP_CANDIDATE,
      undefined,
      { refusal: fault },
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(
        fixture.reports.at(-1)?.status,
        fault === "repair" ? "failed" : "installed",
        JSON.stringify(fixture.reports),
      );
      assert.equal(fixture.patches(), fault === "repair" ? 0 : 1);
      if (fault === "ambiguous") {
        assert.equal(await fixture.run(), 0);
        assert.equal(
          fixture.patches(),
          1,
          "an ambiguous but confirmed write is never repeated",
        );
      }
    } finally {
      await fixture.close();
    }
  }
});

/** Keep explicit policy/refusal inputs; only historical omissions use fixture policy. */
function planOwnerDevelopmentInstall(
  ...args: Parameters<typeof productionPlanOwnerDevelopmentInstall>
): ReturnType<typeof productionPlanOwnerDevelopmentInstall> {
  return productionPlanOwnerDevelopmentInstall(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.queue : args[4],
    args[5] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.custody : args[5],
    args[6] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.rollout : args[6],
    args[7],
    args[8],
  );
}

/** Snapshot validation uses the same historical policy as its real planner. */
function buildOwnerDevelopmentInstallSnapshot(
  ...args: Parameters<typeof productionBuildOwnerDevelopmentInstallSnapshot>
): ReturnType<typeof productionBuildOwnerDevelopmentInstallSnapshot> {
  return productionBuildOwnerDevelopmentInstallSnapshot(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[6] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.queue : args[6],
    args[7] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.custody : args[7],
    args[8],
    args[9] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.rollout : args[9],
    args[10],
  );
}
