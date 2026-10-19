import assert from "node:assert/strict";
import { DORMANT_HOSTED_POLICIES } from "./actions-supervisor-fixture.ts";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  type HostedPolicyGraph,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import { createGitBundleImporter } from "../../src/host/matrix-git.ts";
import { runHostedSupervisorFinalize } from "../../src/host/actions-supervisor.ts";
import {
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
} from "../repair/helpers.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type GitHubPort,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import {
  isDeferredCurrentMatrixHistoryBudget,
} from "../../ops/hosted-autonomy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyResultV1,
} from "../../ops/hosted-autonomy.ts";
import { gitRun, makeRemoteCtx, T0 } from "../state/helpers.ts";
import { BASE, ENV, SELF_REPO } from "./hosted-autonomy-fixtures.ts";
import { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";
import { prepareModernHistory } from "./hosted-autonomy-modern-history-fixtures.ts";
import { expectProtectedRefusal } from "./hosted-autonomy-modern-results.ts";
import { captureHostedAutonomyMain } from "./hosted-autonomy-rig.ts";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import { createHostedCandidateRecoveryPort } from "../../ops/hosted-autonomy-candidate-port.ts";
import { isInflightPreservation } from "../../ops/hosted-autonomy-blocked-candidate.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import {
  type BlockedCandidateCase,
  type InflightCaseV1,
  type InflightStateV1,
  parkModernCandidate,
  publishModernCellResults,
  serveTargetRefs,
} from "./hosted-autonomy-modern-scenario-fixtures.ts";

export type {
  BlockedCandidateCase,
  InflightCaseV1,
  InflightStateV1,
} from "./hosted-autonomy-modern-scenario-fixtures.ts";

export async function modernRecoveryScenario(
  history = false,
  throughMain = false,
  blockedCandidate?: BlockedCandidateCase,
  inflight?: InflightCaseV1,
) {
  return await withHostedProductionPolicy(
    DORMANT_HOSTED_SUPERVISOR_POLICY,
    (graph) =>
      modernRecoveryScenarioInGraph(
        graph,
        history,
        throughMain,
        blockedCandidate,
        inflight,
      ),
  );
}

async function modernRecoveryScenarioInGraph(
  graph: HostedPolicyGraph,
  history: boolean,
  throughMain: boolean,
  blockedCandidate?: BlockedCandidateCase,
  inflight?: InflightCaseV1,
) {
  const runner = await graph.runner();
  const graphmain = await graph.maintenanceMain();
  const { createActionsMatrixArtifactTransport } = await graph
    .matrixArtifacts();
  const { createHostedClosedMatrixRecovery } = await graph.matrixAdapters();
  const targetRoot = await Deno.makeTempDir({
    prefix: "sentinel-modern-target-",
    dir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
  });
  const target = await makeRemoteCtx(targetRoot, ENV);
  const checked = async (dir: string, args: string[]) => {
    const result = await gitRun(dir, args, ENV);
    assert(result.ok, result.stderr);
    return result.stdout.trim();
  };
  await Deno.writeTextFile(target.work + "/repair.txt", "original\n");
  await checked(target.work, ["add", "repair.txt"]);
  await checked(target.work, ["commit", "-q", "-m", "base"]);
  const base = await checked(target.work, ["rev-parse", "HEAD"]) as GitSha;
  const consumerRevision = "3".repeat(40) as GitSha;
  if (history) {
    await checked(target.work, ["update-ref", "refs/heads/development", base]);
    await checked(target.work, ["checkout", "-q", "-b", "offline-candidate"]);
  }
  const scratch = targetRoot + "/factory";
  const mirror = history
    ? scratch + "/sources/ubiquity-sentinel"
    : targetRoot + "/target-mirror";
  if (history) await Deno.mkdir(scratch + "/sources", { recursive: true });
  await checked(targetRoot, ["clone", "-q", target.work, mirror]);
  if (history) {
    await checked(mirror, [
      "config",
      `url.file://${target.work}.insteadOf`,
      "https://github.com/ubiquity/sentinel.git",
    ]);
    await checked(mirror, ["config", "protocol.https.allow", "never"]);
  }
  if (inflight?.published) {
    await Deno.writeTextFile(target.work + "/repair.txt", "published\n");
    await checked(target.work, ["commit", "-q", "-am", "published"]);
  }
  await Deno.writeTextFile(target.work + "/repair.txt", "candidate\n");
  await checked(target.work, ["add", "repair.txt"]);
  await checked(target.work, ["commit", "-q", "-m", "candidate"]);
  const candidate = await checked(target.work, ["rev-parse", "HEAD"]) as GitSha;
  // The PR head the candidate was built on, or a sibling (in the trusted
  // mirror) it never descends from.
  const publishedHead = !inflight?.published
    ? null
    : inflight.published === "ancestor"
    ? await checked(target.work, ["rev-parse", "HEAD^"]) as GitSha
    : await checked(mirror, [
      "commit-tree",
      base + "^{tree}",
      "-p",
      base,
      "-m",
      "unrelated",
    ]) as GitSha;
  const f = await historicalMalformedRig(
    true,
    2,
    true,
    true,
    false,
    true,
    base,
  );
  try {
    f.plan.plannedAt = T0 + 1000;
    await f.refreshPlan();
    const results = await publishModernCellResults({
      f,
      base,
      candidate,
      target,
      targetRoot,
    });
    const release = createReleaseStateStore({
      scratchDir: f.rig.tmp + "/modern-finalize",
      remoteUrl: f.rig.tmp + "/remote.git",
    });
    assert.equal(
      (await runHostedSupervisorFinalize({
        ...DORMANT_HOSTED_POLICIES,
        state: release,
        clock: f.clock,
        run: f.nativeRun,
        evidence: {
          readExecution: f.historicalMatrix.readExecution,
          verifyRevision: () => Promise.resolve(portOk(true)),
          verifyRequest: () => Promise.resolve(portOk(false)),
        },
      })).status,
      "idle",
    );
    const config = repositoryConfig(undefined, undefined, {
      repository: SELF_REPO,
      protectedPaths: [],
      adapter: { kind: "github" },
      liveStartLimits: { perHour: null, perSevenDays: null },
    });
    // Keep maintenance and the executing model port on this real Git base.
    f.github.readBaseTip = () => Promise.resolve(base);
    const model = new FakeModel();
    const github = new FakeGithub({ baseSha: base, openIssues: [] });
    const cycle = {
      state: f.rig.state,
      clock: f.clock,
      configs: [config],
      controllerSha: f.execution.revision,
      githubCooldown: new HostedRepairCooldownGate({
        state: f.rig.state,
        clock: f.clock,
      }),
      github,
      incidents: new FakeIncidents(),
      replay: new FakeReplay(),
      model,
      budget: new RollingStartBudget({
        state: f.rig.state,
        clock: f.clock,
        configs: [config],
      }),
      externalImplementations: true,
    };
    if (blockedCandidate) {
      await parkModernCandidate({
        f,
        results,
        blockedCandidate,
        inflight,
        base,
        candidate,
        publishedHead,
        target,
      });
    }
    const inflightState: InflightStateV1 = {
      state: f.rig.state,
      clock: f.clock,
      config,
      taskId: f.cells[1].taskId,
      candidate,
      base,
    };
    await inflight?.beforeRestore?.(inflightState);
    const before = await f.rig.state.readRepair();
    let releaseBefore = await f.rig.state.readRelease();
    assert(before.ok && before.value.status === "found");
    assert(releaseBefore.ok && releaseBefore.value.status === "found");
    const native = releaseBefore.value.snapshot.hostedRuntimes[0];
    assert.equal(native.execution, null);
    assert.equal(native.lastExecutionProof?.execution.id, f.execution.id);
    let recoveryHttp = f.http;
    if (history) {
      const prepared = await prepareModernHistory({
        f,
        native,
        base,
        releaseBefore,
        target,
        runtimeSha: blockedCandidate ? consumerRevision : undefined,
      });
      releaseBefore = prepared.releaseBefore;
      recoveryHttp = prepared.recoveryHttp;
    }
    // The target repository answers every exact git ref read.
    if (blockedCandidate) {
      recoveryHttp = serveTargetRefs(recoveryHttp, target.work);
    }
    let expireCustody = false;
    const custodyEntered = Promise.withResolvers<void>();
    const continueCustody = Promise.withResolvers<void>();
    let nativeWriterProbe = false;
    let nativeWriterAttempted = false;
    let mainExit: number | null = null;
    let recoveryPort: GitHubPort | undefined;
    const run = async (main = false): Promise<HostedAutonomyResultV1> => {
      const previous = Deno.cwd();
      Deno.chdir(f.checkout);
      try {
        const deps: HostedAutonomyDepsV1 = {
          state: f.rig.state,
          clock: f.clock,
          githubFor: f.rig.githubFor,
          historicalMatrix: f.historicalMatrix,
          closedMatrix: async (state = f.rig.state) => {
            if (history) {
              const actual = await createHostedClosedMatrixRecovery({
                state,
                clock: f.clock,
                token: "offline-native-token",
                apiToken: "offline-native-token",
                sourceDir: target.work,
                scratch,
                artifactRoot: f.rig.tmp + "/history-artifacts",
                http: recoveryHttp,
                artifactHttp: recoveryHttp,
              });
              const readExecution = actual.readExecution;
              return {
                ...actual,
                ...(blockedCandidate
                  ? {
                    cycleFor: (config: typeof actual.configs[number]) => ({
                      ...actual.cycleFor(config),
                      github: recoveryPort = (() => {
                        const port = createHostedCandidateRecoveryPort({
                          state,
                          clock: f.clock,
                          gate: new HostedRepairCooldownGate({
                            state,
                            clock: f.clock,
                          }),
                          // The candidate edits a path the target protects.
                          config: blockedCandidate === "protected-refusal"
                            ? { ...config, protectedPaths: ["repair.txt"] }
                            : config,
                          token: "offline-native-token",
                          http: recoveryHttp,
                          sourcePath: mirror,
                          scratch,
                          remoteUrl: `file://${target.work}`,
                        });
                        return blockedCandidate ===
                            "wrong-preservation-readback"
                          ? new Proxy(port, {
                            get: (_, key) =>
                              key === "readRef"
                                ? async (ref: string) => {
                                  const observed = await port.readRef(ref);
                                  return observed.ok && observed.value
                                    ? portOk({ ...observed.value, sha: base })
                                    : observed;
                                }
                                : Reflect.get(port, key),
                          })
                          : port;
                      })(),
                    }),
                  }
                  : {}),
                prepareTarget: async (config) => {
                  await actual.prepareTarget(config);
                  if (expireCustody) {
                    f.rig.state.readRelease = async () => {
                      const value = await originalReleaseRead();
                      custodyEntered.resolve();
                      await continueCustody.promise;
                      // Past the five-minute walk bound (started at T0 + 60 s).
                      f.clock.now = () => T0 + 360_001;
                      return value;
                    };
                  }
                },
                readExecution: async (execution) => {
                  const result = await readExecution(execution);
                  if (nativeWriterProbe && execution.id === f.execution.id) {
                    nativeWriterAttempted = true;
                    f.rig.state.readRelease = () =>
                      Promise.resolve(
                        portError("conflict", "offline native custody drift"),
                      );
                    await actual.cycleFor(actual.configs[0]).budget
                      .settleModelStart({
                        id: f.cells[0].reservationId,
                        outcome: "ambiguous",
                        proofRef: null,
                      });
                  }
                  return result;
                },
              };
            }
            const gate = new HostedRepairCooldownGate({
              state,
              clock: f.clock,
            });
            const budget = new RollingStartBudget({
              state,
              clock: f.clock,
              configs: [config],
            });
            const client = new GitHubApiClient({
              repository: SELF_REPO,
              apiBaseUrl: "https://api.github.com",
              clock: f.clock,
              http: f.http,
              auth: {
                authorizationHeader: () =>
                  Promise.resolve(portOk("Bearer offline-native-token")),
              },
              cooldownGate: gate,
            });
            return Promise.resolve({
              state,
              clock: f.clock,
              configs: [config],
              cycleFor: () => ({
                ...cycle,
                state,
                budget,
                githubCooldown: gate,
              }),
              prepareTarget: () => Promise.resolve(),
              importerFor: (_, bundlesDir) =>
                createGitBundleImporter({ repositoryDir: mirror, bundlesDir }),
              transportFor: (readState) =>
                createActionsMatrixArtifactTransport({
                  state: readState,
                  clock: f.clock,
                  token: "offline-native-token",
                  artifactRoot: f.rig.tmp + "/modern-artifacts",
                  http: f.http,
                }),
              readExecution: async (execution) => {
                const result = await client.readHostedExecution(execution);
                if (nativeWriterProbe) {
                  nativeWriterAttempted = true;
                  f.rig.state.readRelease = () =>
                    Promise.resolve(
                      portError("conflict", "offline native custody drift"),
                    );
                  await budget.settleModelStart({
                    id: f.cells[0].reservationId,
                    outcome: "ambiguous",
                    proofRef: null,
                  });
                }
                return result;
              },
            });
          },
        };
        const authorized = await withDarkQueueAuthority(deps);
        if (!main) return await runner.runHostedAutonomy(authorized);
        const head = await checked(f.checkout, ["rev-parse", "HEAD"]);
        const captured = await captureHostedAutonomyMain(
          authorized,
          head,
          graphmain.runHostedAutonomyMain,
        );
        mainExit = captured.exit;
        return captured.result;
      } finally {
        Deno.chdir(previous);
      }
    };
    if (blockedCandidate) {
      if (blockedCandidate === "wrong-task") {
        assert(before.ok && before.value.status === "found");
        const record = before.value.snapshot.work.find((row) =>
          row.id === f.cells[1].taskId
        )!;
        const portFor = (repository = config.repository) =>
          createHostedCandidateRecoveryPort({
            state: f.rig.state,
            clock: f.clock,
            gate: new HostedRepairCooldownGate({
              state: f.rig.state,
              clock: f.clock,
            }),
            config: { ...config, repository },
            token: "offline-native-token",
            http: recoveryHttp,
            sourcePath: mirror,
            scratch,
            remoteUrl: `file://${target.work}`,
          });
        const port = portFor();
        const own = record.intent!.branch!;
        // The gate opens only the exact bound ref in its own repository.
        assert.equal((await port.readRef(own)).ok, true);
        for (
          const [gate, ref] of [
            [port, own.slice(0, -64) + "0".repeat(64)],
            [portFor({ ...config.repository, name: "other" }), own],
          ] as const
        ) {
          assert.deepEqual(
            await gate.readRef(ref),
            portError(
              "unavailable",
              "historical preservation binding unavailable",
            ),
          );
        }
        const refused = await port.preserveCandidate({
          taskId: f.cells[0].taskId,
          candidate: {
            operationKey: record.intent!.key,
            base: record.target.base,
            head: record.target.head!,
            ref: record.intent!.branch!,
          },
          publishedHead: null,
        });
        assert.equal(refused.ok, false);
        assert.deepEqual(await f.rig.state.readRepair(), before);
        assert.deepEqual(model.requests, []);
        return;
      }
      let competing: Awaited<ReturnType<typeof f.rig.state.readRepair>> | null =
        null;
      let casRefused = 0;
      const originalWrite = f.rig.state.writeRepair;
      if (blockedCandidate === "post-write-readback-drift") {
        f.rig.state.writeRepair = async (next, head) => {
          const written = await originalWrite(next, head);
          if (
            written.ok && written.value.status === "applied" &&
            next.work.some((row) =>
              row.id === f.cells[1].taskId && row.nextStep === "work" &&
              row.intent === null
            )
          ) {
            const read = f.rig.state.readRepair;
            f.rig.state.readRepair = () => {
              f.rig.state.readRepair = read;
              return Promise.resolve(before);
            };
          }
          return written;
        };
      }
      if (
        blockedCandidate === "cas-conflict" ||
        blockedCandidate === "changed-record"
      ) {
        f.rig.state.writeRepair = async (next, head) => {
          if (
            next.work.some((row) =>
              row.id === f.cells[1].taskId && row.nextStep === "work" &&
              row.intent === null
            )
          ) {
            if (blockedCandidate === "changed-record") {
              const read = await f.rig.state.readRepair();
              assert(read.ok && read.value.status === "found");
              await originalWrite({
                ...read.value.snapshot,
                stateHead: read.value.head,
                sequence: read.value.snapshot.sequence + 1,
                work: read.value.snapshot.work.map((row) =>
                  row.id === f.cells[1].taskId
                    ? {
                      ...row,
                      counters: {
                        ...row.counters,
                        stalled: (row.counters.stalled ?? 0) + 1,
                      },
                    }
                    : row
                ),
              }, read.value.head);
              competing = await f.rig.state.readRepair();
            }
            casRefused++;
            return portOk({ status: "conflict" as const, currentHead: head });
          }
          return originalWrite(next, head);
        };
      }
      const result = await run(
        blockedCandidate === "post-write-readback-drift",
      ).catch((error: unknown) => error);
      const after = await f.rig.state.readRepair();
      assert(before.ok && before.value.status === "found");
      assert(after.ok && after.value.status === "found");
      if (blockedCandidate === "post-write-readback-drift") {
        assert(!(result instanceof Error), String(result));
        const reported = result as HostedAutonomyResultV1;
        assert.equal(mainExit, 1, "post-write integrity drift must fail main");
        assert.equal(reported.status, "failed");
        assert.equal(reported.beforeHead, before.value.head);
        assert.equal(reported.appliedHead, after.value.head);
        assert.notEqual(reported.appliedHead, before.value.head);
        assert.deepEqual(
          after.value.snapshot.reservations,
          before.value.snapshot.reservations,
        );
      } else if (
        (blockedCandidate === "valid" && inflight?.wait !== "review_pending" &&
          inflight?.published !== "unrelated") ||
        blockedCandidate === "existing-ref" ||
        blockedCandidate === "existing-ref-parked"
      ) {
        assert(!(result instanceof Error), String(result));
        const recovered = after.value.snapshot.work.find((row) =>
          row.id === f.cells[1].taskId
        )!;
        const original = before.value.snapshot.work.find((row) =>
          row.id === recovered.id
        )!;
        const consumedCharge = inflight?.consumed
          ? f.cells[1].reservationId
          : null;
        if (inflight?.consumed) {
          // This pass consumed the cell and finished its preservation from
          // the objects its own ingest imported: nothing is left in flight.
          assert.equal(original.intent?.kind, "implementation");
          assert.deepEqual(recovered.target.candidateState, {
            preserved: {
              operationKey: original.intent!.key,
              base: original.target.base,
              head: candidate,
              ref: await candidatePreservationRef(
                original.repository,
                original.id,
                original.intent!.key,
              ),
            },
            publishedHead: null,
          });
          assert.equal(recovered.wait, null);
          assert.deepEqual(recovered.counters, original.counters);
          // Its own consumption settled the charge it already held; nothing
          // is refunded, started or added.
          const settled = after.value.snapshot.reservations.find((row) =>
            row.id === consumedCharge
          )!;
          assert.equal(settled.outcome, "submitted");
          assert.notEqual(settled.settledAt, null);
        } else {
          // Artifact and native-ref recovery leave the exact same record.
          assert.deepEqual(recovered, {
            ...original,
            nextStep: "work",
            blocker: null,
            wait: null,
            intent: null,
            target: {
              ...original.target,
              candidateState: {
                preserved: {
                  operationKey: original.intent!.key,
                  base: original.target.base,
                  head: original.target.head!,
                  ref: original.intent!.branch!,
                },
                publishedHead: original.target.candidateState!.publishedHead,
              },
            },
            updatedAt: recovered.updatedAt,
          });
        }
        if (
          blockedCandidate === "existing-ref" ||
          blockedCandidate === "existing-ref-parked"
        ) {
          assert.deepEqual(
            (result as HostedAutonomyResultV1).actions,
            [
              "queue:inactive_no_rule",
              `existing-ref:${recovered.id}:preserved`,
            ],
          );
          // The existing ref keeps its single original update: re-proved,
          // never rewritten.
          assert.equal(
            await checked(target.work, [
              "reflog",
              "show",
              "--format=%H",
              original.intent!.branch!,
            ]),
            candidate,
          );
        } else if (inflight) {
          // The explicit dormant queue observation precedes preservation.
          assert.deepEqual(
            (result as HostedAutonomyResultV1).actions,
            ["queue:inactive_no_rule", "current-matrix:ingested:1"],
          );
        }
        assert.equal(
          recovered.nextStep,
          "work",
          "exact native candidate must leave its historical mismatch block",
        );
        assert.equal(recovered.blocker, null);
        assert.equal(recovered.intent, null);
        assert.equal(recovered.target.head, candidate);
        assert.equal(
          recovered.target.candidateState?.preserved?.head,
          candidate,
        );
        assert.equal(
          await checked(target.work, [
            "rev-parse",
            recovered.target.candidateState!.preserved!.ref,
          ]),
          candidate,
        );
        const charges = before.value.snapshot.reservations;
        assert.deepEqual(
          after.value.snapshot.reservations.map((row) => {
            if (row.id !== consumedCharge) return row;
            const charged = charges.find((prior) => prior.id === row.id)!;
            return {
              ...row,
              outcome: charged.outcome,
              settledAt: charged.settledAt,
            };
          }),
          before.value.snapshot.reservations,
        );
        assert.deepEqual(
          after.value.snapshot.work.filter((row) => row.id !== recovered.id),
          before.value.snapshot.work.filter((row) => row.id !== recovered.id),
        );
        await run();
        assert.deepEqual(
          await f.rig.state.readRepair(),
          after,
          "completed recovery is idempotent",
        );
        assert(recoveryPort);
        for (
          const method of [
            "pushHead",
            "createPullRequest",
            "requestReview",
            "observeReview",
            "mergePullRequest",
            "closeIssue",
            "assignIssue",
          ]
        ) {
          await assert.rejects(
            () => Reflect.get(recoveryPort!, method)({}),
            /C maintenance capability refused/,
          );
        }
        if (inflight?.afterRestore || inflight?.published) {
          await inflight.afterRestore?.(inflightState);
          assert.deepEqual(model.requests, []);
          return;
        }
        const publication = new FakeGithub({
          baseSha: base,
          openIssues: [],
          candidateLifecycle: {
            prepareBaseRefresh: () => {
              throw new Error("the stable synthetic base must not refresh");
            },
            refs: {
              [recovered.target.candidateState!.preserved!.ref]: candidate,
            },
          },
          reviewRequestedAt: f.clock.now(),
        });
        assert.notEqual(consumerRevision, f.execution.revision);
        const published = await runRepairCycle({
          ...cycle,
          controllerSha: consumerRevision,
          github: publication,
        }, {
          deadline: f.clock.now() + 3600_000,
          stepLimit: 12,
        });
        assert.notEqual(
          published.status,
          "state_error",
          JSON.stringify(published),
        );
        const reviewed = await f.rig.state.readRepair();
        assert(reviewed.ok && reviewed.value.status === "found");
        const ready = reviewed.value.snapshot.work.find((row) =>
          row.id === recovered.id
        )!;
        assert.equal(
          ready.nextStep,
          "review",
          JSON.stringify({
            published,
            wait: ready.wait,
            blocker: ready.blocker,
            intent: ready.intent?.kind,
            calls: publication.calls,
          }),
        );
        assert.equal(ready.wait?.reason, "review_pending");
        assert.equal(ready.target.head, candidate);
        assert.equal(ready.target.candidateState?.publishedHead, candidate);
        assert.equal(
          publication.calls.filter((call) => call === "createPr").length,
          1,
        );
        assert.equal(
          publication.calls.filter((call) => call === "requestReview").length,
          1,
        );
        assert.deepEqual(
          reviewed.value.snapshot.reservations.filter((row) =>
            row.purpose !== "review_request"
          ),
          after.value.snapshot.reservations,
          "original implementation charges survive through publication",
        );
        const originalReservationIds = new Set(
          before.value.snapshot.reservations.map((row) => row.id),
        );
        assert.deepEqual(
          reviewed.value.snapshot.reservations.filter((row) =>
            !originalReservationIds.has(row.id)
          ).map((row) => row.purpose),
          ["review_request"],
          "only the ordinary review is newly charged",
        );
      } else if (
        blockedCandidate === "expired-plan" ||
        blockedCandidate === "unlisted-plan" ||
        blockedCandidate === "existing-ref-conflict"
      ) {
        // An unrecoverable producer is a typed skip: the run completes its
        // later passes instead of escaping, and nothing is written.
        assert(!(result instanceof Error), String(result));
        const reported = result as HostedAutonomyResultV1;
        assert.notEqual(reported.status, "failed", JSON.stringify(reported));
        for (
          const action of blockedCandidate === "expired-plan"
            ? ["current-matrix:unrecoverable:expired"]
            : blockedCandidate === "unlisted-plan"
            ? ["current-matrix:unrecoverable:unlisted"]
            : [
              `existing-ref:${f.cells[1].taskId}:conflict`,
              "current-matrix:unrecoverable:unlisted",
            ]
        ) {
          assert(reported.actions.includes(action), JSON.stringify(reported));
        }
        assert.deepEqual(after, before);
      } else if (inflight?.consumed && blockedCandidate === "cas-conflict") {
        // A preservation this pass could not finish leaves exactly its
        // consumption, never a failed run: the record waits in flight, still
        // charged, and its producer's next (duplicate) visit finishes it.
        assert(!(result instanceof Error), String(result));
        assert.deepEqual((result as HostedAutonomyResultV1).actions, [
          "queue:inactive_no_rule",
          "current-matrix:ingested:1",
        ]);
        assert.equal(casRefused, 1, "the same pass must reach its CAS");
        const waiting = after.value.snapshot.work.find((row) =>
          row.id === f.cells[1].taskId
        )!;
        assert.equal(isInflightPreservation(waiting), true);
        assert.equal(waiting.target.head, candidate);
        const charge = after.value.snapshot.reservations.find((row) =>
          row.id === f.cells[1].reservationId
        )!;
        assert.equal(charge.outcome, "submitted");
        f.rig.state.writeRepair = originalWrite;
        const revisited = await run();
        assert.deepEqual(revisited.actions, [
          "queue:inactive_no_rule",
          "current-matrix:ingested:1",
        ]);
        const finished = await f.rig.state.readRepair();
        assert(finished.ok && finished.value.status === "found");
        const preserved = finished.value.snapshot.work.find((row) =>
          row.id === waiting.id
        )!;
        assert.deepEqual(preserved, {
          ...waiting,
          intent: null,
          target: {
            ...waiting.target,
            candidateState: {
              preserved: {
                operationKey: waiting.intent!.key,
                base: waiting.target.base,
                head: candidate,
                ref: waiting.intent!.branch!,
              },
              publishedHead: null,
            },
          },
          updatedAt: preserved.updatedAt,
        });
        assert.deepEqual(
          finished.value.snapshot.reservations,
          after.value.snapshot.reservations,
        );
      } else if (blockedCandidate === "protected-refusal") {
        assert(!(result instanceof Error), String(result));
        await expectProtectedRefusal(
          result,
          before,
          after,
          target.work,
          run,
          () => f.rig.state.readRepair(),
        );
      } else if (blockedCandidate === "changed-record") {
        assert(competing !== null, "competing owner must reach the CAS seam");
        assert.deepEqual(
          after,
          competing,
          "CAS never overwrites a changed owner record",
        );
      } else {
        assert.deepEqual(
          after,
          before,
          "unproven or unsupported recovery must leave every state byte unchanged",
        );
      }
      assert.deepEqual(model.requests, []);
      assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      return;
    }
    const originalReleaseRead = f.rig.state.readRelease;
    if (history) {
      const originalHistoryRead = f.rig.state.readReleaseAt!;
      for (
        const fault of [
          "missing",
          "wrong-head",
          "wrong-sequence",
          "cycle",
          "deadline",
        ] as const
      ) {
        f.rig.state.readReleaseAt = async (input) => {
          if (fault === "missing") {
            return portError("unavailable", "offline missing release history");
          }
          const value = await originalHistoryRead(input);
          assert(value.ok && value.value.status === "found");
          // Past the five-minute current-matrix walk bound from its start at
          // T0 + 60 s.
          if (fault === "deadline") f.clock.now = () => T0 + 360_001;
          if (fault === "wrong-head") {
            return portOk({
              ...value.value,
              head: releaseBefore.value.status === "found"
                ? releaseBefore.value.head
                : BASE,
            });
          }
          if (fault === "wrong-sequence") {
            return portOk({
              ...value.value,
              snapshot: {
                ...value.value.snapshot,
                sequence: value.value.snapshot.sequence + 2,
              },
            });
          }
          if (fault === "cycle") {
            return portOk({
              ...value.value,
              snapshot: {
                ...value.value.snapshot,
                hostedRuntimes: [],
                stateHead: releaseBefore.value.status === "found"
                  ? releaseBefore.value.head
                  : BASE,
              },
            });
          }
          return value;
        };
        try {
          if (fault === "deadline") {
            const deferred = await run();
            assert.equal(deferred.status, "skipped");
            assert(deferred.actions.includes("matrix-history:deferred"));
          } else {
            await assert.rejects(run);
          }
        } finally {
          f.rig.state.readReleaseAt = originalHistoryRead;
          f.clock.now = () => T0 + 60_000;
        }
        assert.deepEqual(await f.rig.state.readRepair(), before);
        assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
        console.log(
          JSON.stringify({
            kind: "offline_history_control",
            fault,
            verified: true,
          }),
        );
      }
      for (const fault of ["auth", "pending", "missing"] as const) {
        f.setFault(fault);
        try {
          await assert.rejects(run);
        } finally {
          f.setFault(null);
        }
        assert.deepEqual(await f.rig.state.readRepair(), before);
        assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
        console.log(
          JSON.stringify({
            kind: "offline_history_native_control",
            fault,
            verified: true,
          }),
        );
      }
      const unchangedWrite = f.rig.state.writeRepair;
      let lateWrites = 0;
      f.rig.state.writeRepair = (next, head) => {
        lateWrites++;
        return unchangedWrite(next, head);
      };
      expireCustody = true;
      let lateFinished = false;
      const lateRun = run().then((value) => {
        lateFinished = true;
        return { value, error: null };
      }, (error: unknown) => {
        lateFinished = true;
        return { value: null, error };
      });
      try {
        await Promise.race([
          custodyEntered.promise,
          lateRun.then((outcome) => {
            throw new Error(
              "late custody boundary was not reached: " + String(outcome.error),
            );
          }),
        ]);
        assert.equal(lateFinished, false);
        assert.equal(lateWrites, 0);
        continueCustody.resolve();
        const outcome = await lateRun;
        assert.equal(outcome.error, null);
        assert.equal(outcome.value?.status, "skipped");
        assert(outcome.value?.actions.includes("matrix-history:deferred"));
        assert.equal(lateWrites, 0);
      } finally {
        continueCustody.resolve();
        await lateRun;
        expireCustody = false;
        f.rig.state.writeRepair = unchangedWrite;
        f.rig.state.readRelease = originalReleaseRead;
        f.clock.now = () => T0 + 60_000;
      }
      assert.deepEqual(await f.rig.state.readRepair(), before);
      assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      console.log(
        JSON.stringify({
          kind: "offline_history_late_custody",
          zeroWrites: true,
          joined: true,
        }),
      );
      nativeWriterProbe = true;
      try {
        await assert.rejects(run);
      } finally {
        nativeWriterProbe = false;
        f.rig.state.readRelease = originalReleaseRead;
      }
      assert.equal(nativeWriterAttempted, true);
      assert.deepEqual(await f.rig.state.readRepair(), before);
      assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      console.log(
        JSON.stringify({
          kind: "offline_history_captured_writer",
          verified: true,
        }),
      );
    }
    if (!history) {
      for (const fault of ["auth", "pending", "missing"] as const) {
        f.setFault(fault);
        await assert.rejects(run);
        f.setFault(null);
        assert.deepEqual(await f.rig.state.readRepair(), before);
        assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      }
      nativeWriterProbe = true;
      try {
        await assert.rejects(run);
      } finally {
        nativeWriterProbe = false;
        f.rig.state.readRelease = originalReleaseRead;
      }
      assert.equal(nativeWriterAttempted, true);
      assert.deepEqual(await f.rig.state.readRepair(), before);
    }
    const originalWrite = f.rig.state.writeRepair;
    let unavailableWrites = 0;
    f.rig.state.writeRepair = () => {
      unavailableWrites++;
      return Promise.resolve(
        portError("unavailable", "offline settlement unavailable"),
      );
    };
    try {
      const unavailable = await run();
      assert.equal(unavailable.status, "skipped");
      assert(unavailableWrites > 0, "real settlement consumer must be reached");
      assert.deepEqual(await f.rig.state.readRepair(), before);
      assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      console.log(JSON.stringify({
        kind: "offline_unavailable_settlement",
        zeroWrites: true,
        chargedIntentPreserved: true,
      }));
    } finally {
      f.rig.state.writeRepair = originalWrite;
    }
    let writesBeforeDrift = 0;
    let writeAttempts = 0;
    let actualAppliedHead: GitSha | null = null;
    let actualWriteResult: unknown;
    let partialError: unknown;
    const casEntered = Promise.withResolvers<void>();
    const continueCAS = Promise.withResolvers<void>();
    let partialRun: Promise<unknown> | null = null;
    f.rig.state.writeRepair = async (next, head) => {
      writeAttempts++;
      if (history) {
        casEntered.resolve();
        await continueCAS.promise;
      }
      const written = await originalWrite(next, head);
      actualWriteResult = written;
      if (written.ok && written.value.status === "applied") {
        writesBeforeDrift++;
        actualAppliedHead = written.value.head;
        f.rig.state.readRelease = async () => {
          const current = await originalReleaseRead();
          assert(current.ok && current.value.status === "found");
          return portOk({
            ...current.value,
            snapshot: {
              ...current.value.snapshot,
              sequence: current.value.snapshot.sequence + 1,
            },
          });
        };
      }
      return written;
    };
    try {
      let finished = false;
      const pending = run(throughMain).then((result) => {
        finished = true;
        return throughMain ? result : null;
      }, (error: unknown) => {
        finished = true;
        return error;
      });
      partialRun = pending;
      if (history) {
        await Promise.race([
          casEntered.promise,
          pending.then((error) => {
            throw new Error("CAS boundary was not reached: " + String(error));
          }),
        ]);
        f.clock.now = () => T0 + 120_001;
        await Promise.resolve();
        assert.equal(
          finished,
          false,
          "maintenance must join an already-started CAS",
        );
        assert.equal(writesBeforeDrift, 0);
        continueCAS.resolve();
      }
      const rejected = await pending;
      partialError = rejected;
      if (history && writesBeforeDrift !== 1 && rejected instanceof Error) {
        console.error(
          JSON.stringify({
            kind: "offline_history_partial_exception",
            name: rejected.name,
            message: rejected.message,
            stack: rejected.stack,
          }),
        );
      }
      assert.equal(
        writesBeforeDrift,
        1,
        "older ordinary results remain unconsumed after newer healthy proof replacement",
      );
      if (!throughMain) {
        assert(
          rejected instanceof Error,
          "partial settlement must refuse after custody drift",
        );
      }
    } finally {
      continueCAS.resolve();
      if (partialRun) await partialRun;
      f.rig.state.writeRepair = originalWrite;
      f.rig.state.readRelease = originalReleaseRead;
      f.clock.now = () => T0 + 60_000;
    }
    if (history) {
      console.log(
        JSON.stringify({
          kind: "offline_history_joined_cas",
          writes: writesBeforeDrift,
          settled: true,
        }),
      );
    }
    assert.equal(writesBeforeDrift, 1);
    assert.equal(
      writeAttempts,
      1,
      "custody drift must prevent later native writes",
    );
    const partial = await f.rig.state.readRepair();
    assert(partial.ok && partial.value.status === "found");
    assert.equal(partial.value.head, actualAppliedHead);
    assert.deepEqual(partial.value.snapshot.work, before.value.snapshot.work);
    const partialCharge = partial.value.snapshot.reservations.find((row) =>
      row.id === f.cells[0].reservationId
    )!;
    assert.equal(partialCharge.outcome, "ambiguous");
    assert.notEqual(partialCharge.settledAt, null);
    const originalCharge = before.value.snapshot.reservations.find((row) =>
      row.id === partialCharge.id
    )!;
    assert.deepEqual({
      ...partialCharge,
      outcome: originalCharge.outcome,
      settledAt: originalCharge.settledAt,
    }, originalCharge);
    if (throughMain) {
      assert.equal(mainExit, 1, "applied custody failure must not exit green");
      const reported = partialError as HostedAutonomyResultV1;
      assert.equal(reported.status, "failed");
      assert.equal(reported.reason, "unexpected_failure");
      assert.equal(reported.beforeHead, before.value.head);
      assert.equal(reported.appliedHead, partial.value.head);
      assert.deepEqual(reported.actions, []);
    } else {
      assert(partialError instanceof Error);
      assert.match(
        partialError.message,
        /^current matrix (release custody|producer ancestry) changed$/,
        "joined partial CAS must reject custody drift, not clock expiry",
      );
      assert.equal(isDeferredCurrentMatrixHistoryBudget(partialError), false);
      assert("beforeHead" in partialError);
      assert("appliedHead" in partialError);
      assert("writeResult" in partialError);
      assert.equal(partialError.beforeHead, before.value.head);
      assert.equal(partialError.appliedHead, partial.value.head);
      assert.deepEqual(partialError.writeResult, actualWriteResult);
    }
    f.clock.now = () => T0 + 61_000;
    const result = await run();
    assert.equal(result.status, "applied", JSON.stringify(result));
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    const failed = after.value.snapshot.work.find((row) =>
      row.id === f.records[0].id
    )!;
    const succeeded = after.value.snapshot.work.find((row) =>
      row.id === f.records[1].id
    )!;
    assert.equal(failed.nextStep, "blocked");
    assert.deepEqual(failed.intent, f.records[0].intent);
    assert.equal(succeeded.target.head, candidate);
    assert.equal(succeeded.intent?.kind, "candidate_preservation");
    assert.equal(
      await checked(mirror, ["rev-parse", candidate + "^{commit}"]),
      candidate,
    );
    assert.deepEqual(
      after.value.snapshot.work.find((row) => row.id === f.records[2].id),
      f.records[2],
    );
    assert.deepEqual(
      after.value.snapshot.reviews,
      before.value.snapshot.reviews,
    );
    assert.deepEqual(
      after.value.snapshot.releaseRequests,
      before.value.snapshot.releaseRequests,
    );
    assert.equal(after.value.snapshot.reservations[0].outcome, "ambiguous");
    assert.equal(after.value.snapshot.reservations[1].outcome, "submitted");
    assert.deepEqual(
      after.value.snapshot.reservations.find((row) =>
        row.id === partialCharge.id
      ),
      partialCharge,
    );
    assert.deepEqual(
      after.value.snapshot.reservations[2],
      before.value.snapshot.reservations[2],
    );
    assert.equal(
      after.value.snapshot.reservations.length,
      before.value.snapshot.reservations.length,
    );
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    const replay = await run();
    const replayState = await f.rig.state.readRepair();
    assert(replayState.ok && replayState.value.status === "found");
    assert.equal(replay.status, "applied");
    assert.equal(replay.reason, "retried");
    assert.deepEqual(replay.actions, [
      "queue:inactive_no_rule",
      `retry:${failed.id}:grant=0:other:model run did not complete with a trusted candidate`,
    ]);
    assert.equal(replay.beforeHead, after.value.head);
    assert.equal(replay.appliedHead, replayState.value.head);
    assert.notEqual(replayState.value.head, after.value.head);
    assert.notEqual(
      replayState.value.snapshot.stateHead,
      after.value.snapshot.stateHead,
    );
    assert.equal(
      replayState.value.snapshot.sequence,
      after.value.snapshot.sequence + 1,
    );
    const retried = replayState.value.snapshot.work.find((row) =>
      row.id === failed.id
    )!;
    assert.equal(retried.nextStep, "work");
    assert.equal(retried.blocker, null);
    assert.equal(retried.intent, null);
    assert.equal(retried.target.base, base);
    assert.deepEqual({
      ...replayState.value.snapshot,
      stateHead: after.value.snapshot.stateHead,
      sequence: after.value.snapshot.sequence,
      work: replayState.value.snapshot.work.map((row) =>
        row.id === failed.id
          ? {
            ...row,
            nextStep: failed.nextStep,
            blocker: failed.blocker,
            intent: failed.intent,
          }
          : row
      ),
    }, after.value.snapshot);
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    assert.equal(
      await checked(mirror, ["rev-parse", candidate + "^{commit}"]),
      candidate,
    );
    assert.deepEqual(model.requests, []);
    assert.equal(github.pushes.length, 0);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
    await Deno.remove(targetRoot, { recursive: true });
  }
}
