import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { hostedOrdinaryAdmitted } from "../../src/contracts/hosted-supervisor-verification.ts";
import {
  parseHostedInstallationRecordV1,
  validateHostedInstallationTransition,
} from "../../src/contracts/hosted-supervisor-installation.ts";
import {
  portOk,
  type ReleaseStateWriter,
  type StateReadView,
  type StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import {
  type HostedSupervisorEvidencePortV1,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import { HostedSupervisorGitHubClient } from "../../src/host/actions-supervisor-install-api.ts";
import { revalidateHostedRuntimeCompatibility } from "../../src/host/hosted-runtime-compatibility-authority.ts";
import { runHostedSupervisorHost } from "../../src/host/actions-supervisor-host.ts";
import { parseHostedEnvironment } from "../../src/host/hosted-runtime.ts";
import {
  CANDIDATE,
  LAUNCHER,
  makeRig,
  releaseRequest,
  requireRun,
  reviewReceipt,
  type RigV1,
  ROOT,
  run,
  runProof,
  skippedProof,
  startedFailureProof,
} from "./actions-supervisor-fixture.ts";
import { exited, hostedEnv } from "./hosted-runtime-fixture.ts";

async function settle(
  rig: RigV1,
  execution: HostedExecutionIntentV1,
  outcome: "healthy" | "failed" | "not_started" | "started_failure",
) {
  rig.clock.advance(5_000);
  rig.evidence.settlements.set(
    execution.id,
    outcome === "not_started"
      ? skippedProof(execution)
      : outcome === "started_failure"
      ? startedFailureProof(execution)
      : runProof(execution, outcome),
  );
  assert.equal(
    (await rig.finalize({
      runId: execution.runId,
      runAttempt: execution.runAttempt,
      launcherSha: execution.launcherSha,
    })).status,
    "idle",
  );
}
async function ready(rig: RigV1) {
  rig.evidence.revisions.add(LAUNCHER);
  await settle(rig, requireRun(await rig.prepare(run(1))), "healthy");
  const ordinary = requireRun(await rig.prepare(run(2)));
  assert.equal(ordinary.purpose, "ordinary");
  await settle(rig, ordinary, "healthy");
}
async function request(rig: RigV1) {
  const req = releaseRequest();
  await rig.seedRepair([req], [reviewReceipt(req)]);
  rig.evidence.requests.add(req.id);
}
function installEvidence(rig: RigV1, ancestor = true, ci = true) {
  Object.assign(
    rig.evidence,
    {
      verifyAncestor: (_a: GitSha, _d: GitSha) =>
        Promise.resolve(portOk(ancestor)),
      verifyLauncherCi: (revision: GitSha) =>
        Promise.resolve(portOk(ci ? { revision, checkRunId: 91 } : null)),
    } satisfies Pick<
      HostedSupervisorEvidencePortV1,
      "verifyAncestor" | "verifyLauncherCi"
    >,
  );
}
const launcherRun = (id: number) => ({ ...run(id), launcherSha: CANDIDATE });

async function hostReplay(
  rig: RigV1,
  execution: HostedExecutionIntentV1,
): Promise<Map<string, string>> {
  const outputs = new Map<string, string>();
  const result = await runHostedSupervisorHost({
    env: {
      ...hostedEnv(execution.launcherSha),
      GITHUB_RUN_ID: String(execution.runId),
      GITHUB_RUN_ATTEMPT: String(execution.runAttempt),
      GITHUB_JOB: "prepare",
      GITHUB_TOKEN: "synthetic-native-token-for-test",
    },
    sourceDir: ROOT,
    clock: rig.clock,
    state: rig.release,
    http: () =>
      Promise.reject(new Error("exact saved execution replay needs no API")),
    process: {
      run: (command) =>
        Promise.resolve(
          exited(command.args.includes("status") ? "" : execution.launcherSha),
        ),
    },
    writeOutput: (key, value) => {
      outputs.set(key, value);
      return Promise.resolve();
    },
  });
  assert.equal(result.status, "run");
  return outputs;
}

Deno.test("starvation: healthy PRIOR settlement survives release-local source unavailability", async () => {
  const rig = await makeRig();
  try {
    await ready(rig);
    await request(rig);
    const prior = requireRun(await rig.prepare(run(3)));
    rig.evidence.taskFail = true;
    await settle(rig, prior, "healthy");
    assert.equal(
      (await rig.snapshot()).hostedReleases[0].priorProof?.execution.id,
      prior.id,
    );
    const ordinary = requireRun(await rig.prepare(run(4)));
    assert.equal(ordinary.purpose, "ordinary");
    await settle(rig, ordinary, "healthy");
    const next = requireRun(await rig.prepare(run(5)));
    assert.equal(next.purpose, "ordinary");
    assert.equal(
      (await rig.snapshot()).hostedRuntimes[0].activeRevision,
      LAUNCHER,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("starvation: candidate failed or twice not_started restores recorded prior before abandonment", async (t) => {
  for (const outcome of ["failed", "not_started"] as const) {
    await t.step(outcome, async () => {
      const rig = await makeRig();
      try {
        await ready(rig);
        await request(rig);
        const prior = requireRun(await rig.prepare(run(3)));
        await settle(rig, prior, "healthy");
        await settle(rig, requireRun(await rig.prepare(run(4))), "healthy");
        const candidate = requireRun(await rig.prepare(run(5)));
        assert.equal(candidate.purpose, "candidate");
        await settle(rig, candidate, outcome);
        let id = 6;
        if (outcome === "not_started") {
          const retry = requireRun(await rig.prepare(run(id++)));
          assert.equal(retry.purpose, "candidate");
          await settle(rig, retry, "not_started");
        }
        const rollback = requireRun(await rig.prepare(run(id++)));
        assert.equal(rollback.purpose, "rollback");
        assert.equal(rollback.revision, LAUNCHER);
        assert.equal(rollback.generation, 3);
        const before = await rig.snapshot();
        assert.equal(before.hostedReleases[0].phase, "rollback_verifying");
        assert.equal(
          before.hostedReleases[0].candidateProof?.outcome ?? null,
          outcome === "failed" ? "failed" : null,
        );
        await settle(rig, rollback, "healthy");
        const state = await rig.snapshot();
        assert.equal(state.hostedReleases[0].phase, "abandoned");
        assert.equal(
          state.hostedReleases[0].abandonment?.reason,
          outcome === "failed"
            ? "candidate_verification_failed"
            : "candidate_verification_exhausted",
        );
        assert.deepEqual(
          state.hostedReleases[0].candidateProof,
          before.hostedReleases[0].candidateProof,
        );
        assert.equal(
          requireRun(await rig.prepare(run(id))).purpose,
          "ordinary",
        );
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("starvation: a divergent release candidate stays pending through self-install and cannot veto ordinary", async () => {
  const rig = await makeRig(), successor = "3".repeat(40) as GitSha;
  try {
    await ready(rig);
    await request(rig);
    await settle(rig, requireRun(await rig.prepare(run(3))), "failed");
    Object.assign(rig.evidence, {
      verifyAncestor: (a: GitSha, _d: GitSha) =>
        Promise.resolve(portOk(a !== CANDIDATE)),
      verifyLauncherCi: (revision: GitSha) =>
        Promise.resolve(portOk({ revision, checkRunId: 91 })),
    });
    const identity = { ...run(4), launcherSha: successor };
    const boot = requireRun(await rig.prepare(identity));
    assert.equal(boot.revision, successor);
    await settle(rig, boot, "healthy");
    assert.equal((await rig.snapshot()).hostedReleases[0].phase, "requested");
    const ordinary = requireRun(
      await rig.prepare({ ...run(5), launcherSha: successor }),
    );
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, successor);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("starvation: two PRIOR failures abandon; ordinary interleaves and duplicate settlement is inert", async () => {
  const rig = await makeRig();
  try {
    await ready(rig);
    await request(rig);
    const healthy = (await rig.snapshot()).hostedRuntimes[0].lastHealthyProof;
    const repairBefore = await rig.repair.readRepair();
    const first = requireRun(await rig.prepare(run(3)));
    assert.equal(first.purpose, "prior");
    assert.equal(
      (await rig.snapshot()).hostedReleases[0].verification?.prior.attempts,
      1,
    );
    await settle(rig, first, "failed");
    const ordinary = requireRun(await rig.prepare(run(4)));
    assert.equal(ordinary.purpose, "ordinary");
    assert.ok(hostedOrdinaryAdmitted((await rig.snapshot()).hostedRuntimes[0]));
    await settle(rig, ordinary, "failed");
    const second = requireRun(await rig.prepare(run(5)));
    assert.equal(second.purpose, "prior");
    await settle(rig, second, "failed");
    const before = await rig.snapshot(), record = before.hostedReleases[0];
    assert.equal(record.phase, "abandoned");
    assert.equal(record.abandonment?.reason, "prior_verification_exhausted");
    assert.deepEqual(record.abandonment?.executionIds, [first.id, second.id]);
    assert.equal(record.verification?.prior.attempts, 2);
    assert.equal(record.verification?.prior.failures, 2);
    assert.equal(
      record.verification?.prior.lastFailure?.proof.execution.id,
      second.id,
    );
    assert.deepEqual(before.hostedRuntimes[0].lastHealthyProof, healthy);
    assert.equal(before.hostedRuntimes[0].generation, 1);
    assert.equal((await rig.finalize(run(5))).status, "idle");
    assert.deepEqual(await rig.snapshot(), before);
    assert.equal(requireRun(await rig.prepare(run(6))).purpose, "ordinary");
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("starvation: not_started consumes bounded attempts without claiming failed health", async () => {
  const rig = await makeRig();
  try {
    await ready(rig);
    await request(rig);
    for (const id of [3, 5]) {
      const prior = requireRun(await rig.prepare(run(id)));
      assert.equal(prior.purpose, "prior");
      await settle(rig, prior, "not_started");
      if (id === 3) {
        await settle(rig, requireRun(await rig.prepare(run(4))), "healthy");
      }
    }
    const state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "abandoned");
    assert.equal(state.hostedReleases[0].verification?.prior.failures, 2);
    assert.equal(state.hostedRuntimes[0].verificationFailures, 0);
    assert.equal(state.hostedReleases[0].priorProof, null);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("starvation: two failed installed-generation verifications admit durable degraded ordinary work", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    for (const id of [1, 2]) {
      const boot = requireRun(await rig.prepare(run(id)));
      assert.equal(boot.purpose, "bootstrap");
      await settle(rig, boot, "failed");
    }
    const execution = requireRun(await rig.prepare(run(3)));
    const runtime = (await rig.snapshot()).hostedRuntimes[0];
    assert.equal(execution.purpose, "ordinary");
    assert.equal(runtime.lastHealthyProof, null);
    assert.equal(runtime.ordinaryAdmission?.mode, "degraded");
    assert.deepEqual(runtime.ordinaryAdmission?.failedVerificationIds, [
      "1:1:repair",
      "2:1:repair",
    ]);
    assert.ok(hostedOrdinaryAdmitted(runtime));
    assert.equal(
      (await hostReplay(rig, execution)).get("modelStartsEnabled"),
      "true",
    );
    const identity = parseHostedEnvironment({
      ...hostedEnv(LAUNCHER),
      GITHUB_RUN_ID: "3",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "repair",
    }, "repair");
    const validated = await revalidateHostedRuntimeCompatibility({
      state: rig.release,
      identity,
      execution,
      controllerSha: LAUNCHER,
      clock: rig.clock,
      deadline: rig.clock.now() + 10_000,
    });
    assert.ok(validated.ok);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("starvation: launcher self-install bootstraps before release and abandons included candidate atomically", async () => {
  const rig = await makeRig();
  try {
    await ready(rig);
    await request(rig);
    await settle(rig, requireRun(await rig.prepare(run(3))), "failed");
    installEvidence(rig);
    const boot = requireRun(await rig.prepare(launcherRun(4)));
    assert.equal(boot.purpose, "bootstrap");
    assert.equal(boot.revision, CANDIDATE);
    assert.equal(boot.generation, 2);
    const state = await rig.snapshot();
    assert.equal(state.hostedInstallations?.[0].phase, "bootstrapping");
    assert.equal(state.hostedInstallations?.[0].bootstrapExecutionId, boot.id);
    assert.equal(
      state.hostedReleases[0].abandonment?.reason,
      "included_in_successor",
    );
    assert.equal(
      state.hostedReleases[0].abandonment?.successorRevision,
      CANDIDATE,
    );
    assert.equal(state.hostedReleases[0].priorProof, null);
    assert.equal(state.hostedReleases[0].verification?.prior.failures, 1);
    assert.equal(hostedOrdinaryAdmitted(state.hostedRuntimes[0]), false);
    assert.equal(
      (await hostReplay(rig, boot)).get("modelStartsEnabled"),
      "false",
    );
    await settle(rig, boot, "healthy");
    const ordinary = requireRun(await rig.prepare(launcherRun(5)));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, CANDIDATE);
    assert.equal(
      (await rig.snapshot()).hostedInstallations?.[0].phase,
      "accepted",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("starvation: divergent or missing-CI launcher is refused while installed ordinary work continues", async (t) => {
  for (
    const [name, ancestor, ci] of [["divergent", false, true], [
      "missing CI",
      true,
      false,
    ]] as const
  ) {
    await t.step(name, async () => {
      const rig = await makeRig();
      try {
        await ready(rig);
        installEvidence(rig, ancestor, ci);
        const execution = requireRun(await rig.prepare(launcherRun(3)));
        assert.equal(execution.purpose, "ordinary");
        assert.equal(execution.revision, LAUNCHER);
        assert.equal((await rig.snapshot()).hostedInstallations, undefined);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("starvation: an unsettled execution prevents self-install and every additional admission", async () => {
  const rig = await makeRig();
  try {
    await ready(rig);
    const saved = requireRun(await rig.prepare(run(3)));
    installEvidence(rig);
    const before = await rig.snapshot();
    assert.equal((await rig.prepare(launcherRun(4))).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
    assert.equal(before.hostedRuntimes[0].execution?.id, saved.id);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("starvation: self-install CAS conflict and lost acknowledgement are reconciled by exact state", async (t) => {
  for (const mode of ["conflict", "lost acknowledgement"] as const) {
    await t.step(mode, async () => {
      const rig = await makeRig();
      try {
        await ready(rig);
        installEvidence(rig);
        const before = await rig.snapshot();
        let writes = 0;
        const state: StateReadView & ReleaseStateWriter = {
          readRelease: () => rig.release.readRelease(),
          readRepair: () => rig.release.readRepair(),
          writeRelease: async (next, head) => {
            writes++;
            if (mode === "conflict") {
              return portOk<StateWriteResultV1>({
                status: "conflict",
                currentHead: head,
              });
            }
            const result = await rig.release.writeRelease(next, head);
            assert.ok(
              result.ok && result.value.status === "applied",
              JSON.stringify(result),
            );
            return portOk<StateWriteResultV1>({
              status: "ambiguous",
              currentHead: null,
            });
          },
        };
        const outcome = await runHostedSupervisorPrepare({
          clock: rig.clock,
          state,
          run: launcherRun(3),
          evidence: rig.evidence,
        });
        if (mode === "conflict") {
          assert.equal(outcome.status, "pending");
          assert.equal(writes, 1);
          assert.deepEqual(await rig.snapshot(), before);
        } else {
          assert.equal(requireRun(outcome).revision, CANDIDATE);
          assert.equal(writes, 2);
          const after = await rig.snapshot();
          assert.equal(after.hostedInstallations?.length, 1);
          assert.equal(
            requireRun(await rig.prepare(launcherRun(3))).id,
            "3:1:repair",
          );
        }
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("starvation: failed installation restores exact prior; same failed SHA cannot reinstall; failed rollback stops models", async (t) => {
  for (const restoration of ["healthy", "failed"] as const) {
    await t.step(restoration, async () => {
      const rig = await makeRig();
      try {
        await ready(rig);
        installEvidence(rig);
        const boot = requireRun(await rig.prepare(launcherRun(3)));
        // A runtime that reached startup-ready and failed gets no retry (#191).
        await settle(rig, boot, "started_failure");
        const pending = (await rig.snapshot()).hostedInstallations?.[0];
        assert.equal(pending?.phase, "rollback_pending");
        assert.equal(pending?.retriedBootstrapProof, undefined);
        const rollback = requireRun(await rig.prepare(launcherRun(4)));
        assert.equal(rollback.purpose, "bootstrap");
        assert.equal(rollback.revision, LAUNCHER);
        assert.equal(rollback.generation, 3);
        await settle(rig, rollback, restoration);
        const outcome = await rig.prepare(launcherRun(5)),
          state = await rig.snapshot();
        assert.equal(
          state.hostedInstallations?.[0].bootstrapProof?.outcome,
          "failed",
        );
        assert.equal(
          state.hostedInstallations?.[0].phase,
          restoration === "healthy" ? "rolled_back" : "rollback_failed",
        );
        assert.equal(state.hostedRuntimes[0].activeRevision, LAUNCHER);
        assert.equal(state.hostedRuntimes[0].generation, 3);
        if (restoration === "healthy") {
          assert.equal(requireRun(outcome).purpose, "ordinary");
          assert.equal(state.hostedInstallations?.length, 1);
        } else {
          assert.equal(outcome.status, "pending");
          assert.equal(state.hostedRuntimes[0].execution, null);
          assert.equal(hostedOrdinaryAdmitted(state.hostedRuntimes[0]), false);
        }
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("starvation: a bootstrap that never reached startup-ready retries once at its exact pointer without a rollback journal", async (t) => {
  for (const first of ["not_started", "failed"] as const) {
    await t.step(first, async () => {
      const rig = await makeRig();
      try {
        await ready(rig);
        installEvidence(rig);
        const boot = requireRun(await rig.prepare(launcherRun(3)));
        await settle(rig, boot, first);
        const waiting = await rig.snapshot();
        const journal = waiting.hostedInstallations?.[0];
        assert.equal(journal?.phase, "bootstrapping");
        assert.equal(journal?.pointerIntent, null);
        assert.equal(journal?.bootstrapProof, null);
        assert.equal(journal?.bootstrapExecutionId, boot.id);
        assert.equal(journal?.retriedBootstrapProof?.execution.id, boot.id);
        assert.equal(waiting.hostedRuntimes[0].execution, null);
        assert.equal(waiting.hostedRuntimes[0].verificationBlocked, true);
        const retry = requireRun(await rig.prepare(launcherRun(4)));
        assert.equal(retry.purpose, "bootstrap");
        assert.equal(retry.revision, CANDIDATE);
        assert.equal(retry.launcherSha, CANDIDATE);
        assert.equal(retry.generation, boot.generation);
        assert.notEqual(retry.id, boot.id);
        const retrying = await rig.snapshot();
        assert.equal(
          retrying.hostedInstallations?.[0].bootstrapExecutionId,
          retry.id,
        );
        assert.equal(retrying.hostedRuntimes[0].activeRevision, CANDIDATE);
        assert.equal(retrying.hostedRuntimes[0].generation, 2);
        assert.equal(
          (await hostReplay(rig, retry)).get("modelStartsEnabled"),
          "false",
        );
        await settle(rig, retry, "healthy");
        const accepted = (await rig.snapshot()).hostedInstallations?.[0];
        assert.equal(accepted?.phase, "accepted");
        assert.equal(accepted?.bootstrapProof?.execution.id, retry.id);
        assert.deepEqual(
          accepted?.retriedBootstrapProof,
          journal?.retriedBootstrapProof,
        );
        const ordinary = requireRun(await rig.prepare(launcherRun(5)));
        assert.equal(ordinary.purpose, "ordinary");
        assert.equal(ordinary.revision, CANDIDATE);
        assert.equal(ordinary.generation, 2);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("starvation: a retry that again never starts journals the exact rollback and the SHA cannot reinstall", async (t) => {
  for (const second of ["not_started", "failed", "started_failure"] as const) {
    await t.step(second, async () => {
      const rig = await makeRig();
      try {
        await ready(rig);
        installEvidence(rig);
        const boot = requireRun(await rig.prepare(launcherRun(3)));
        await settle(rig, boot, "not_started");
        const retry = requireRun(await rig.prepare(launcherRun(4)));
        const retrying = await rig.snapshot();
        await settle(rig, retry, second);
        const journal = (await rig.snapshot()).hostedInstallations?.[0];
        assert.equal(journal?.phase, "rollback_pending");
        assert.equal(journal?.bootstrapProof?.execution.id, retry.id);
        assert.equal(journal?.retriedBootstrapProof?.execution.id, boot.id);
        assert.equal(journal?.pointerIntent?.action, "rollback");
        assert.equal(journal?.pointerIntent?.expectedRevision, CANDIDATE);
        assert.equal(journal?.pointerIntent?.nextRevision, LAUNCHER);
        assert.equal(journal?.pointerIntent?.expectedGeneration, 2);
        // The single retry is consumed: no third attempt can bind, and only a
        // never-started first settlement can admit one.
        const idle = { ...retrying.hostedRuntimes[0], execution: null };
        const third = { ...retry, id: "99:1:repair", runId: 99 };
        assert.equal(
          validateHostedInstallationTransition(
            retrying.hostedInstallations!,
            [{
              ...retrying.hostedInstallations![0],
              bootstrapExecutionId: third.id,
            }],
            idle,
            { ...idle, execution: third },
          ),
          "installation execution identity is immutable",
        );
        assert.throws(
          () =>
            parseHostedInstallationRecordV1({
              ...retrying.hostedInstallations![0],
              retriedBootstrapProof: startedFailureProof(boot),
            }),
          /never reached startup-ready/,
        );
        const rollback = requireRun(await rig.prepare(launcherRun(5)));
        assert.equal(rollback.purpose, "bootstrap");
        assert.equal(rollback.revision, LAUNCHER);
        assert.equal(rollback.generation, 3);
        await settle(rig, rollback, "healthy");
        const ordinary = requireRun(await rig.prepare(launcherRun(6)));
        const state = await rig.snapshot();
        assert.equal(state.hostedInstallations?.length, 1);
        assert.equal(state.hostedInstallations?.[0].phase, "rolled_back");
        assert.equal(ordinary.purpose, "ordinary");
        assert.equal(ordinary.revision, LAUNCHER);
        assert.equal(ordinary.generation, 3);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("starvation: authenticated compare and exact latest test-local matcher reject divergent, foreign, incomplete CI", async (t) => {
  for (
    const scenario of [
      "success",
      "divergent",
      "wrong SHA",
      "foreign app",
      "failed check",
      "incomplete listing",
    ] as const
  ) {
    await t.step(scenario, async () => {
      const paths: string[] = [];
      const client = new HostedSupervisorGitHubClient({
        repository: {
          owner: "ubiquity-sentinel",
          name: "sentinel",
          installationId: 0,
        },
        apiBaseUrl: "https://api.github.com",
        auth: {
          authorizationHeader: () =>
            Promise.resolve(portOk("Bearer synthetic")),
        },
        clock: { now: () => 1_790_000_000_000 },
        cooldownGate: {
          beforeRequest: () => Promise.resolve(portOk(undefined)),
          recordRateLimit: () => Promise.resolve(portOk(undefined)),
        },
        http: (request) => {
          assert.equal(request.method, "GET");
          const url = new URL(request.url);
          paths.push(url.pathname);
          const value = url.pathname.includes("check-runs")
            ? {
              total_count: scenario === "incomplete listing" ? 2 : 1,
              check_runs: [{
                id: 91,
                name: "test-local",
                head_sha: scenario === "wrong SHA" ? LAUNCHER : CANDIDATE,
                status: "completed",
                conclusion: scenario === "failed check" ? "failure" : "success",
                app: {
                  slug: scenario === "foreign app" ? "other" : "github-actions",
                },
              }],
            }
            : url.pathname.includes("compare")
            ? {
              status: scenario === "divergent" ? "diverged" : "ahead",
              base_commit: { sha: LAUNCHER },
              merge_base_commit: {
                sha: scenario === "divergent" ? "f".repeat(40) : LAUNCHER,
              },
              ahead_by: 1,
              behind_by: scenario === "divergent" ? 1 : 0,
              total_commits: scenario === "divergent" ? 2 : 1,
            }
            : { sha: CANDIDATE };
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify(value),
          });
        },
      });
      const ancestry = await client.verifyAncestor(LAUNCHER, CANDIDATE);
      assert.ok(ancestry.ok);
      if (ancestry.ok) assert.equal(ancestry.value, scenario !== "divergent");
      const ci = await client.verifyLauncherCi(CANDIDATE);
      assert.ok(ci.ok);
      if (ci.ok) {
        assert.equal(
          ci.value !== null,
          scenario === "success" || scenario === "divergent",
        );
      }
      assert.ok(
        paths.includes(
          `/repos/ubiquity-sentinel/sentinel/commits/${CANDIDATE}`,
        ),
      );
    });
  }
});
