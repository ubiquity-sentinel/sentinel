import type { GitSha } from "../src/contracts/brands.ts";
import {
  type HostedMaintenanceCompatibilityFixture,
  preflightHostedMaintenance,
  writeHostedMigrationOutput,
} from "./hosted-autonomy-compatibility.ts";
import { emitHostedParkSummary } from "./hosted-autonomy-summary.ts";
import {
  upkeepDeferralReason,
  writeQueueCustodyOutput,
  writeUpkeepDeferralOutput,
} from "./hosted-autonomy-queue-output.ts";
import { createHostedQueueCoordinator } from "./hosted-autonomy-queue-host.ts";
import { createMaintenancePublicationFor } from "../src/host/maintenance-existing-pr-publication.ts";
import { DurableGitHubCooldownGate } from "../src/repair/github-cooldown.ts";
import {
  createMatrixUncertaintyMaintenance,
  runMatrixUncertaintyMaintenance,
} from "../src/host/matrix-uncertainty-maintenance.ts";
import { parseRepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { buildMemoryLessonsV1 } from "../src/repair/memory-lessons.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";
import { createRepairStateStore, DenoGitRunner } from "../src/state/mod.ts";
import { GitMaintenanceIndex } from "../src/state/maintenance-index.ts";
import type { StateReadView } from "../src/contracts/ports.ts";
import {
  HOSTED_CONTROLLER_REMOTE,
  isHostedControllerMaintenanceIdentity,
} from "../src/contracts/hosted-controller-deployment.ts";
import { runHostedAutonomy } from "./hosted-autonomy-runner.ts";
import { GitDeliveryTrainStore } from "../src/state/delivery-train-store.ts";
import { verifyCiMinuteSchedulingBasis } from "../src/budget/ci-minutes.ts";
import {
  ciStateGitArgs,
  composePrivateCiMinutes,
  type HostedPrivateCiCapabilities,
} from "../src/host/hosted-app-principal.ts";
import {
  acceptedCiMinutePolicy,
  CI_MINUTE_PRIVATE_REMOTE,
} from "../src/contracts/ci-minute-budget.ts";
import {
  HOSTED_AUTONOMY_PASS_DEADLINE_MS,
  HOSTED_AUTONOMY_PHASE_RESERVE_MS,
} from "./hosted-autonomy-continuation.ts";
import {
  APP_TOKEN_MINTED_NOT_BEFORE_ENV,
  APP_TOKEN_NOT_AFTER_ENV,
  deriveAppTokenNotAfterV1,
  parseAppTokenNotAfterV1,
} from "../src/host/hosted-app-token-window.ts";
import { readHostedPrivateCiData } from "../src/host/hosted-app-principal-native.ts";
import { fetchHttpTransport } from "../src/github/http.ts";
import { readHostedMaintenanceCompatibility } from "./hosted-autonomy-runtime-compatibility.ts";
import { readHostedMaintenanceQueueObservation } from "./hosted-autonomy-compatibility-queue.ts";
import {
  deliveryCountsFromActions,
  writeDeliveryCountsOutput,
} from "../src/host/delivery-counts-output.ts";
import {
  tierCountsFromActions,
  writeTierCountsOutput,
} from "../src/host/tier-counts-output.ts";
import { createTrainComposerFor } from "./hosted-autonomy-train-git.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "./hosted-autonomy-producer-recovery.ts";
import { ClosedCWaveRecoveryIntegrityFailure } from "../src/host/modern-matrix-recovery.ts";
import {
  beginMaintenanceProgress,
  failed,
  HistoricalQuarantineIncomplete,
  isHardAutonomyFailure,
  maintenanceFailureCategory,
  skipped,
} from "./hosted-autonomy-state.ts";
import { createHostedAutonomyGitHub } from "./hosted-autonomy-github.ts";
import {
  composeBackupCi,
  readBackupCiMode,
  readBackupCiTargets,
} from "../src/host/backup-ci-compose.ts";
import { repeatFailureRouteIdentity } from "./hosted-autonomy-repeat-failure.ts";
import {
  CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE,
  hostedRepositoryKey,
  isDeferredCurrentMatrixHistoryBudget,
  isHostedSelf,
} from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";
import {
  createHostedClosedMatrixRecovery,
  createHostedHistoricalMatrixQuarantine,
} from "./hosted-autonomy-matrix-adapters.ts";
import { createHostedOpenIssueLister } from "./hosted-autonomy-open-issues.ts";
import { createMetricsCollectorV1 } from "../src/contracts/throughput-metrics-collector.ts";

export const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Hosted entry point: identity first, then the two bounded passes. */
/** Bounded read-only learning digest emitted by the live maintenance entry. */
export async function emitMemoryDigest(state: StateReadView): Promise<void> {
  try {
    const read = await state.readRepair();
    if (!read.ok || read.value.status !== "found") return;
    const snapshot = parseRepairStateSnapshotV1(read.value.snapshot);
    const lessons = await buildMemoryLessonsV1(snapshot, Date.now());
    let refused = 0;
    let regressions = 0;
    let resolved = 0;
    for (const record of lessons) {
      for (const entry of record.entries) {
        if (entry.refused) refused++;
        if (entry.regression) regressions++;
        if (entry.resolved) resolved++;
      }
    }
    // Version-control awareness: name the exact older working revision of
    // each currently failing family (bounded, closed fields only), so the
    // rollback/restore signal is actionable for an operator instead of only
    // a count. Advisory: the installer chain remains the only rollback
    // authority.
    const versioned: {
      taskId: string;
      detail: string;
      priorSuccessRevision: string;
      failuresAtCurrentRevision: number;
    }[] = [];
    for (const memory of snapshot.attemptMemory) {
      const successRevision = memory.lastSuccessRevision ?? null;
      const successAt = memory.lastSuccessAtMs ?? null;
      if (successRevision === null || successAt === null) continue;
      for (const entry of memory.entries) {
        if (entry.controllerSha === successRevision) continue;
        if (entry.lastAtMs <= successAt) continue;
        versioned.push({
          taskId: String(memory.taskId),
          detail: entry.detail,
          priorSuccessRevision: successRevision,
          failuresAtCurrentRevision: entry.count,
        });
      }
    }
    versioned.sort((left, right) =>
      right.failuresAtCurrentRevision - left.failuresAtCurrentRevision
    );
    console.log(JSON.stringify({
      kind: "sentinel_memory_digest",
      records: snapshot.attemptMemory.length,
      refused,
      regressions,
      resolved,
      versionedRegressions: versioned.slice(0, 5),
    }));
  } catch {
    // Advisory only; never blocks the pass.
  }
}

export interface HostedAutonomyMainInputV1 {
  /** Trusted in-process test transport; native checkout identity remains mandatory. */
  env: Readonly<Record<string, string | undefined>>;
  deps: HostedAutonomyDepsV1;
  compatibility?: HostedMaintenanceCompatibilityFixture;
}

export async function runHostedAutonomyMain(
  input?: HostedAutonomyMainInputV1,
): Promise<number> {
  const env = (key: string) =>
    input === undefined ? readEnv(key) : input.env[key] ?? null;
  // A missing output reads as no deferral; the result line stays authoritative.
  await writeUpkeepDeferralOutput(env("GITHUB_OUTPUT"), null);
  await writeDeliveryCountsOutput(env("GITHUB_OUTPUT"), null);
  await writeTierCountsOutput(env("GITHUB_OUTPUT"), null);
  const result = await runHostedAutonomyMainResult(input, env);
  await writeUpkeepDeferralOutput(
    env("GITHUB_OUTPUT"),
    upkeepDeferralReason(result),
  );
  // #330/#338: the delivery pass's counts for finalize's metrics record.
  await writeDeliveryCountsOutput(
    env("GITHUB_OUTPUT"),
    deliveryCountsFromActions(result.actions),
  );
  // #324/#338: the repair-tier step's counts for the same record.
  await writeTierCountsOutput(
    env("GITHUB_OUTPUT"),
    tierCountsFromActions(result.actions),
  );
  return report(result);
}

async function runHostedAutonomyMainResult(
  input: HostedAutonomyMainInputV1 | undefined,
  env: (key: string) => string | null,
): Promise<HostedAutonomyResultV1> {
  const nativeTurnOrigin = Date.now();
  const tokenDeadline = Math.min(
    parseAppTokenNotAfterV1(env(APP_TOKEN_NOT_AFTER_ENV) ?? undefined) ??
      Infinity,
    deriveAppTokenNotAfterV1(
      env(APP_TOKEN_MINTED_NOT_BEFORE_ENV) ?? undefined,
      nativeTurnOrigin,
    ) ?? Infinity,
  );
  const nativeTurnDeadline = Math.min(
    nativeTurnOrigin + HOSTED_AUTONOMY_PASS_DEADLINE_MS -
      HOSTED_AUTONOMY_PHASE_RESERVE_MS,
    tokenDeadline,
  );
  // Missing output and every failure before custody are closed at the workflow boundary.
  await writeQueueCustodyOutput(env("GITHUB_OUTPUT"), false);
  await writeHostedMigrationOutput(env("GITHUB_OUTPUT"), null);
  const onQueueCustodyReady = async (ready: boolean) => {
    await writeQueueCustodyOutput(env("GITHUB_OUTPUT"), ready);
    await input?.deps.onQueueCustodyReady?.(ready);
  };
  const facts = await readCheckoutFacts();
  const validated = isHostedControllerMaintenanceIdentity({
    repository: env("GITHUB_REPOSITORY"),
    ref: env("GITHUB_REF"),
    job: env("GITHUB_JOB"),
    runId: env("GITHUB_RUN_ID"),
    runAttempt: env("GITHUB_RUN_ATTEMPT"),
    workflowRef: env("GITHUB_WORKFLOW_REF"),
    sha: env("GITHUB_SHA"),
    workflowSha: env("GITHUB_WORKFLOW_SHA"),
    checkoutHead: facts.head,
    checkoutClean: facts.clean,
  });
  if (!validated) return failed("identity_rejected", null);
  const runFromVerifiedSource = (deps: HostedAutonomyDepsV1) =>
    runHostedAutonomy({
      ...deps,
      acceptanceCorrectionSourceRevision: facts.head as GitSha,
    });
  // Split by purpose, mirroring the hosted runtime: the scoped sentinel App
  // token authenticates every repository-visible code-change op (merge, issue
  // closure, CI approval) so it is attributed to ubiquity-sentinel[bot], while
  // the native Actions token keeps owning the state refs it has always owned.
  const stateToken = env("GITHUB_TOKEN");
  const apiToken = env("SENTINEL_SUPERVISOR_TOKEN") ?? stateToken;
  // The self repository never falls back to the `ubiquity` installation token
  // (it cannot reach `ubiquity-sentinel`); the native token is the fallback.
  const selfToken = env("SENTINEL_SELF_TOKEN") ?? stateToken;
  if (
    stateToken === null || stateToken.length === 0 ||
    apiToken === null || apiToken.length === 0 ||
    selfToken === null || selfToken.length === 0
  ) {
    return failed("identity_rejected", null);
  }
  const compatibility = async (
    state: StateReadView,
    clock: HostedAutonomyDepsV1["clock"],
  ) => {
    const finish = beginMaintenanceProgress("preflight");
    try {
      return await preflightHostedMaintenance({
        state,
        clock,
        nativeToken: stateToken,
        queueToken: apiToken,
        run: {
          runId: Number(env("GITHUB_RUN_ID")),
          runAttempt: Number(env("GITHUB_RUN_ATTEMPT")),
          launcherSha: facts.head as GitSha,
        },
        output: env("GITHUB_OUTPUT"),
        fixture: input?.compatibility,
      });
    } finally {
      finish();
    }
  };
  let result: HostedAutonomyResultV1;
  let summaryActions: readonly string[] = [];
  try {
    if (input) {
      try {
        result = await compatibility(input.deps.state, input.deps.clock) ??
          await runFromVerifiedSource({
            ...input.deps,
            onQueueCustodyReady,
          });
        summaryActions = result.actions;
      } finally {
        const finish = beginMaintenanceProgress("summary_park");
        try {
          await emitHostedParkSummary(
            input.deps.state,
            env("GITHUB_STEP_SUMMARY"),
            summaryActions,
          );
        } finally {
          finish();
        }
      }
    } else {
      const scratch = `${Deno.cwd()}/.hosted-autonomy`;
      Deno.mkdirSync(scratch, { recursive: true, mode: 0o700 });
      const runner = new DenoGitRunner(
        `${scratch}/git-home`,
        githubGitAuthEnv(stateToken),
      );
      const state = createRepairStateStore({
        scratchDir: `${scratch}/state`,
        remoteUrl: HOSTED_CONTROLLER_REMOTE,
        runner,
      });
      const disposition = await compatibility(state, { now: () => Date.now() });
      if (disposition !== null) {
        const finish = beginMaintenanceProgress("summary_park");
        try {
          await emitHostedParkSummary(
            state,
            env("GITHUB_STEP_SUMMARY"),
            disposition.actions,
          );
        } finally {
          finish();
        }
        return disposition;
      }
      // One backup CI consumer for every surface (spec §11.4, §11.8): the
      // lower-only mode and the committed targets; absent, all reads native.
      const backupCi = await composeBackupCi({
        mode: readBackupCiMode(env),
        root: Deno.cwd(),
        scratch: `${scratch}/backup-ci`,
        clock: { now: () => Date.now() },
      });
      // One surface per exact repository identity: the durable snapshot may
      // carry work for several repositories, and each record is delivered under
      // its OWN repository, never under the self repository.
      const surfaces = new Map<string, HostedAutonomyGitHubV1>();
      const ciClock = { now: () => Date.now() };
      const ciScratch = `${scratch}/ci-minutes-private`;
      // Derived only here: the production branch has passed native identity,
      // clean source and ordinary maintenance custody. Test input cannot mint it.
      const privateCiAuthority = async (
        limit: number,
      ): Promise<HostedPrivateCiCapabilities | null> => {
        const foreign = env("SENTINEL_SUPERVISOR_TOKEN");
        if (
          foreign === null || foreign.trim() === "" || ciClock.now() >= limit
        ) return null;
        const gate = new DurableGitHubCooldownGate({ state, clock: ciClock });
        const http = fetchHttpTransport();
        const request = (path: string, deadline: number) =>
          readHostedPrivateCiData({
            http,
            token: foreign,
            clock: ciClock,
            gate,
            deadline,
          }, path);
        const verify = async (deadline: number) => {
          const current = await readCheckoutFacts();
          if (
            !current.clean || current.head !== facts.head ||
            ciClock.now() >= deadline
          ) return false;
          const custody = await readHostedMaintenanceCompatibility({
            state,
            clock: ciClock,
            native: {
              token: stateToken,
              run: {
                runId: Number(env("GITHUB_RUN_ID")),
                runAttempt: Number(env("GITHUB_RUN_ATTEMPT")),
                launcherSha: facts.head as GitSha,
              },
              deadline,
            },
            readQueueReady: () =>
              readHostedMaintenanceQueueObservation({
                state,
                clock: ciClock,
                token: foreign,
                deadline,
              }),
          });
          if (custody.status !== "ordinary") return false;
          const repo = await request("/repos/ubiquity/prospector", deadline) as
            | Record<string, unknown>
            | null;
          return repo?.id === 1337190500 &&
            repo.full_name === "ubiquity/prospector" && repo.private === true &&
            ciClock.now() < deadline;
        };
        if (!await verify(limit)) return null;
        await Deno.mkdir(ciScratch, { recursive: true, mode: 0o700 });
        if (
          (await Deno.lstat(ciScratch)).isSymlink ||
          await Deno.realPath(ciScratch) !== ciScratch
        ) return null;
        await Deno.chmod(ciScratch, 0o700);
        const ciRunner = new DenoGitRunner(
          ciScratch,
          githubGitAuthEnv(foreign, CI_MINUTE_PRIVATE_REMOTE),
        );
        return Object.freeze({
          verify,
          request,
          async runGit(
            args: string[],
            options: Parameters<HostedPrivateCiCapabilities["runGit"]>[1],
          ) {
            if (
              ciClock.now() >= limit ||
              !options.cwd.startsWith(ciScratch + "/") ||
              options.cwd.split("/").includes("..") ||
              !ciStateGitArgs(args) ||
              (args[0] === "push" && !await verify(limit))
            ) {
              return { ok: false, code: -1, stdout: "", stderr: "" };
            }
            const env = Object.fromEntries(
              Object.entries(options.env ?? {}).filter(([key]) =>
                [
                  "GIT_AUTHOR_NAME",
                  "GIT_AUTHOR_EMAIL",
                  "GIT_COMMITTER_NAME",
                  "GIT_COMMITTER_EMAIL",
                ].includes(key)
              ),
            );
            return await ciRunner.runGit(args, { ...options, env });
          },
        });
      };
      const ciMinutes = composePrivateCiMinutes({
        policy: acceptedCiMinutePolicy(),
        clock: ciClock,
        scratch: ciScratch,
        deadlineAt: nativeTurnDeadline,
        authority: privateCiAuthority,
        billingBasis: verifyCiMinuteSchedulingBasis,
      });
      await ciMinutes.reconcile(nativeTurnDeadline);
      const githubFor = (
        repository: RepositoryIdentityV1,
      ): HostedAutonomyGitHubV1 => {
        const key = hostedRepositoryKey(repository);
        const cached = surfaces.get(key);
        if (cached !== undefined) return cached;
        const created = createHostedAutonomyGitHub(
          isHostedSelf(repository) ? selfToken : apiToken,
          repository,
          backupCi,
          ciMinutes,
        );
        surfaces.set(key, created);
        return created;
      };
      const artifactRoot = await Deno.makeTempDir({
        prefix: "sentinel-maintenance-matrix-",
      });
      try {
        result = await runFromVerifiedSource({
          ciMinutes,
          state,
          currentMatrixIndex: new GitMaintenanceIndex({
            scratchDir: `${scratch}/maintenance-index`,
            remoteUrl: HOSTED_CONTROLLER_REMOTE,
            runner,
          }),
          githubFor,
          backupCiTargets: (await readBackupCiTargets(Deno.cwd())).map((
            target,
          ) => target.repository),
          clock: { now: () => Date.now() },
          queue: createHostedQueueCoordinator({
            queueMode: env("SENTINEL_MERGE_QUEUE"),
            state,
            githubFor,
            token: apiToken,
            clock: { now: () => Date.now() },
            publicationFor: createMaintenancePublicationFor({
              sourceDir: Deno.cwd(),
              scratch,
              state,
              clock: { now: () => Date.now() },
              token: apiToken,
              gate: new DurableGitHubCooldownGate({
                state,
                clock: { now: () => Date.now() },
              }),
            }),
          }),
          onQueueCustodyReady,
          // Sentinel #330: one validated train per foreign repository per
          // pass. The ledger is the trains state sidecar (written only by the
          // delivery pass); each target's composer is its own git store,
          // fetch and push over the target token.
          deliveryTrain: {
            journal: new GitDeliveryTrainStore({
              scratchDir: `${scratch}/delivery-trains`,
              remoteUrl: HOSTED_CONTROLLER_REMOTE,
              runner,
            }),
            composerFor: createTrainComposerFor({
              scratch,
              tokenFor: () => apiToken,
            }),
          },
          // #338: the pass's in-process collector, filled by the delivery and
          // tier steps. It is not persisted from here: the step outputs
          // (deliveryCounts, tierCounts) carry the counts to finalize.
          metrics: createMetricsCollectorV1(),
          // The same trusted repair writer moves rows between hot and cold.
          repairTiers: {
            store: state,
            listOpenIssueNumbers: createHostedOpenIssueLister((repository) =>
              isHostedSelf(repository) ? selfToken : apiToken
            ),
          },
          // Route selector names only, never a key: a changed model route
          // re-arms the records the repeat-failure bound parked.
          modelRoute: repeatFailureRouteIdentity({
            baseUrl: env("SENTINEL_MODEL_BASE_URL"),
            model: env("SENTINEL_MODEL_ID"),
            fallback: env("SENTINEL_MODEL_FALLBACK"),
          }),
          uncertainMatrix: (guardedState = state, protectedRecordIds) =>
            runMatrixUncertaintyMaintenance({
              ...createMatrixUncertaintyMaintenance({
                state: guardedState,
                clock: { now: () => Date.now() },
                token: stateToken,
                apiToken,
                artifactRoot,
              }),
              protectedRecordIds,
            }),
          closedMatrix: (guardedState = state) =>
            createHostedClosedMatrixRecovery({
              state: guardedState,
              clock: { now: () => Date.now() },
              token: selfToken,
              apiToken,
              sourceDir: Deno.cwd(),
              scratch,
              artifactRoot,
              appInstallationId: env("SENTINEL_APP_INSTALLATION_ID") ??
                undefined,
              cooldownMode: env("SENTINEL_COOLDOWN_MODE") ?? undefined,
            }),
          historicalMatrix: createHostedHistoricalMatrixQuarantine({
            state,
            clock: { now: () => Date.now() },
            token: selfToken,
            apiToken,
            artifactRoot,
            cooldownMode: env("SENTINEL_COOLDOWN_MODE") ?? undefined,
            // The trusted production maintenance route is the one caller that
            // revalidates already-quarantined records against authenticated
            // not-started evidence.
            revalidateNotStarted: true,
          }),
        });
        summaryActions = result.actions;
      } finally {
        // Advisory visibility follows the unconditional queue custody prelude.
        const finishMemory = beginMaintenanceProgress("summary_memory");
        try {
          await emitMemoryDigest(state);
        } finally {
          finishMemory();
        }
        const finishPark = beginMaintenanceProgress("summary_park");
        try {
          await emitHostedParkSummary(
            state,
            env("GITHUB_STEP_SUMMARY"),
            summaryActions,
          );
        } finally {
          finishPark();
        }
        const finishCleanup = beginMaintenanceProgress("artifact_cleanup");
        try {
          await Deno.remove(artifactRoot, { recursive: true });
        } finally {
          finishCleanup();
        }
      }
    }
  } catch (error) {
    if (error instanceof ClosedCWaveRecoveryIntegrityFailure) {
      console.log(JSON.stringify({
        kind: "sentinel_autonomy_failure_detail",
        category: maintenanceFailureCategory(error),
      }));
      return failed("unexpected_failure", error.beforeHead);
    }
    if (error instanceof CurrentMatrixRecoveryIntegrityFailure) {
      console.log(JSON.stringify({
        kind: "sentinel_autonomy_failure_detail",
        category: maintenanceFailureCategory(error),
      }));
      return {
        ...failed("unexpected_failure", error.beforeHead),
        appliedHead: error.appliedHead,
      };
    }
    if (isDeferredCurrentMatrixHistoryBudget(error)) {
      // Availability, not integrity: the walk wrote nothing after its bound,
      // so report a bounded deferral and keep the maintenance job green.
      console.log(JSON.stringify({
        kind: "sentinel_current_matrix_deferred",
        detail: CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE,
      }));
      return {
        kind: "hosted_autonomy",
        status: "skipped",
        reason: "deferred_matrix_history_budget",
        beforeHead: null,
        appliedHead: null,
        actions: ["matrix-history:deferred"],
        revisions: [],
      };
    }
    // Bounded diagnostic: only a fixed category code from this codebase's
    // own failure taxonomy is echoed; no raw error text can reach the log.
    console.log(JSON.stringify({
      kind: "sentinel_autonomy_failure_detail",
      category: maintenanceFailureCategory(error),
    }));
    if (error instanceof HistoricalQuarantineIncomplete) {
      // Only a changed or conflicting custody refusal fails closed. Every
      // other incomplete upkeep pass wrote nothing, so it is a bounded
      // deferral: prepare, planning and delivery continue this run.
      if (error.integrity) {
        return failed("historical_quarantine_incomplete", null);
      }
      console.log(JSON.stringify({
        kind: "sentinel_autonomy_deferred",
        reason: "historical_quarantine_deferred",
        category: "historical_quarantine_incomplete",
      }));
      return skipped("deferred_historical_quarantine", null, [
        "historical-matrix:deferred",
      ]);
    }
    result = {
      kind: "hosted_autonomy",
      status: "skipped",
      reason: "deferred_unexpected_error",
      beforeHead: null,
      appliedHead: null,
      actions: ["maintenance:deferred_unexpected_error"],
      revisions: [],
    };
    // Self-healing: log the deferral for observability. Only the fixed
    // category code is emitted; raw error text is never logged.
    console.log(JSON.stringify({
      kind: "sentinel_autonomy_deferred",
      reason: "unexpected_error_deferred",
      category: maintenanceFailureCategory(error),
    }));
  }
  return result;
}

export function report(result: HostedAutonomyResultV1): number {
  console.log(JSON.stringify(result));
  return isHardAutonomyFailure(result.reason) ? 1 : 0;
}

export function readEnv(key: string): string | null {
  try {
    return Deno.env.get(key) ?? null;
  } catch {
    return null;
  }
}

export async function readCheckoutFacts(): Promise<
  { head: string | null; clean: boolean }
> {
  const env: Record<string, string> = {
    PATH: readEnv("PATH") ?? "/usr/bin:/bin",
    HOME: readEnv("HOME") ?? "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  try {
    const cwd = Deno.cwd();
    const head = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "null",
    }).output();
    const headSha = head.success
      ? new TextDecoder().decode(head.stdout).trim()
      : "";
    const status = await new Deno.Command("git", {
      args: ["status", "--porcelain"],
      cwd,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "null",
    }).output();
    return {
      head: GIT_SHA_PATTERN.test(headSha) ? headSha : null,
      clean: status.success &&
        new TextDecoder().decode(status.stdout).trim() === "",
    };
  } catch {
    return { head: null, clean: false };
  }
}
