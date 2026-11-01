import {
  type IncidentAdapter,
  portError,
  portOk,
  type RepairStateWriter,
  type ReplayPort,
  type StateReadView,
} from "../src/contracts/ports.ts";
import { CLOSED_C_WAVE } from "../src/host/modern-matrix-recovery.ts";
import { createGitBundleImporter } from "../src/host/matrix-git.ts";
import {
  createDefaultBranchResolver,
  loadTargetConfigsV1,
} from "../src/host/targets.ts";
import {
  parseAppInstallationId,
  scopeTargetConfigV1,
} from "../src/host/actions.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { RollingStartBudget } from "../src/budget/mod.ts";
import { HOSTED_CONTROLLER_SELF } from "../src/contracts/hosted-controller-deployment.ts";
import { GitHubApiClient } from "../src/github/client.ts";
import {
  createDeadline,
  fetchHttpTransport,
  type HttpTransportV1,
} from "../src/github/http.ts";
import { createMatrixArtifactHttp } from "../src/host/matrix-artifact-http.ts";
import { refuse } from "../src/host/matrix-artifact-values.ts";
import { CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE } from "./hosted-autonomy-policy.ts";
import type { HostedClosedMatrixDepsV1 } from "./hosted-autonomy-types.ts";
import { HostedRepairCooldownGate } from "../src/host/hosted-cooldown.ts";
import { parseCooldownModeV1 } from "../src/contracts/cooldown-mode.ts";
import {
  createActionsMatrixArtifactHttpTransport,
  createActionsMatrixArtifactTransport,
} from "../src/host/matrix-artifacts.ts";
import type { HistoricalMatrixQuarantineDepsV1 } from "../src/host/matrix-actions.ts";
import {
  createLocalRepositoryConfig,
  prepareSourceRepository,
  refreshDevelopment,
} from "../src/host/local.ts";
import { HOSTED_HISTORICAL_RELEASE_WITNESSES } from "./hosted-autonomy-matrix-bindings.ts";
import { createHostedCandidateRecoveryPort } from "./hosted-autonomy-candidate-port.ts";
import { isHostedSelf } from "./hosted-autonomy-policy.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { createMaintenanceNativeQueue } from "../src/host/maintenance-native-queue.ts";

/**
 * The credential a maintenance pass may hold for one committed target. The
 * `ubiquity` installation token can never reach `ubiquity-sentinel/sentinel`,
 * so the self repository's candidate reads, pushes and mirror refreshes use
 * the self token (`token`); every foreign target keeps the App token.
 */
export function maintenanceTargetToken(
  repository: Pick<RepositoryIdentityV1, "owner" | "name" | "installationId">,
  tokens: { token: string; apiToken: string },
): string {
  return isHostedSelf({
      owner: repository.owner,
      name: repository.name,
      installationId: repository.installationId,
    })
    ? tokens.token
    : tokens.apiToken;
}

/** The maintenance slice has no implementation, review or publication capability. */
export async function createHostedClosedMatrixRecovery(input: {
  state: StateReadView & RepairStateWriter;
  clock: { now(): number };
  token: string;
  apiToken: string;
  sourceDir: string;
  scratch: string;
  artifactRoot: string;
  appInstallationId?: string;
  cooldownMode?: string;
  http?: HttpTransportV1;
  artifactHttp?: HttpTransportV1;
}): Promise<HostedClosedMatrixDepsV1> {
  const http = input.http ?? fetchHttpTransport();
  const artifactHttp = input.artifactHttp ??
    createActionsMatrixArtifactHttpTransport();
  const template = createLocalRepositoryConfig();
  // Each target's default branch is read with the credential that reaches it.
  const resolvers = {
    self: createDefaultBranchResolver({ http, token: input.token }),
    foreign: createDefaultBranchResolver({ http, token: input.apiToken }),
  };
  const targets = await loadTargetConfigsV1({
    template,
    root: input.sourceDir,
    resolveDefaultBranch: (target) =>
      (target.owner === template.repository.owner &&
          target.name === template.repository.name
        ? resolvers.self
        : resolvers.foreign)(target),
  });
  const configs = targets.configs.map((config) =>
    scopeTargetConfigV1(
      config,
      template.repository,
      parseAppInstallationId(input.appInstallationId),
    )
  );
  const gate = new HostedRepairCooldownGate({
    state: input.state,
    clock: input.clock,
    mode: parseCooldownModeV1(input.cooldownMode),
  });
  const client = new GitHubApiClient({
    repository: template.repository,
    apiBaseUrl: "https://api.github.com",
    http,
    clock: input.clock,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
    cooldownGate: gate,
  });
  const budget = new RollingStartBudget({
    state: input.state,
    clock: input.clock,
    configs,
  });
  function refused<T>(): T {
    return new Proxy({}, {
      get: () => () =>
        Promise.reject(new Error("C maintenance capability refused")),
    }) as T;
  }
  const mirror = (config: typeof configs[number]) =>
    input.scratch + "/sources/" + config.repository.owner + "-" +
    config.repository.name;
  await Deno.mkdir(input.scratch + "/sources", {
    recursive: true,
    mode: 0o700,
  });
  return {
    state: input.state,
    clock: input.clock,
    configs,
    cycleFor: (config, proofPass) => ({
      state: input.state,
      clock: input.clock,
      configs,
      controllerSha: CLOSED_C_WAVE.runtimeSha,
      github: createHostedCandidateRecoveryPort({
        state: input.state,
        clock: input.clock,
        gate,
        config,
        token: maintenanceTargetToken(config.repository, input),
        http,
        sourcePath: mirror(config),
        scratch: input.scratch,
        remoteUrl:
          `https://github.com/${config.repository.owner}/${config.repository.name}.git`,
        ...(proofPass === undefined ? {} : { proofPass }),
      }),
      githubCooldown: gate,
      incidents: refused<IncidentAdapter>(),
      replay: refused<ReplayPort>(),
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          throw new Error("C maintenance model refused");
        },
      },
      budget,
      externalImplementations: true,
    }),
    prepareTarget: async (config) => {
      const host = {
        stateRoot: input.scratch,
        sourceDir: input.sourceDir,
        controllerSha: CLOSED_C_WAVE.runtimeSha,
        githubToken: maintenanceTargetToken(config.repository, input),
        modelToken: "",
        codexExecutable: "",
        denoExecutable: Deno.execPath(),
        trustedPath: "/usr/bin:/bin",
      };
      const remoteUrl =
        `https://github.com/${config.repository.owner}/${config.repository.name}.git`;
      await prepareSourceRepository(
        mirror(config),
        host,
        input.scratch,
        config.repository.name === template.repository.name &&
          config.repository.owner === template.repository.owner
          ? undefined
          : remoteUrl,
      );
      await refreshDevelopment(
        mirror(config),
        host,
        input.scratch,
        gate,
        config.repository.installationId,
        { remoteUrl, baseBranch: config.baseBranch },
      );
    },
    importerFor: (config, bundlesDir) =>
      createGitBundleImporter({ repositoryDir: mirror(config), bundlesDir }),
    transportFor: (state) =>
      createActionsMatrixArtifactTransport({
        state,
        clock: input.clock,
        token: input.token,
        artifactRoot: input.artifactRoot,
        http: artifactHttp,
      }),
    readExecution: (execution) => client.readHostedExecution(execution),
    // The same authenticated, exhaustively paginated native listing the
    // transport reads; it never downloads an archive.
    readPlanArtifact: async (run, deadlineAt) => {
      const startedAt = input.clock.now();
      const until = Math.min(startedAt + PLAN_LISTING_MAX_MS, deadlineAt);
      if (!Number.isSafeInteger(until) || until <= startedAt) {
        throw new Error(CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE);
      }
      const deadline = createDeadline(until - startedAt);
      try {
        const reader = createMatrixArtifactHttp(
          {
            state: input.state,
            clock: input.clock,
            token: input.token,
            artifactRoot: input.artifactRoot,
            http: artifactHttp,
          },
          until,
          deadline,
          { id: null },
        );
        const name = `sentinel-matrix-plan-${run.runId}-${run.runAttempt}`;
        const rows = (await reader.pages(
          `/runs/${run.runId}/artifacts`,
          "artifacts",
        )).filter((row) => row.name === name);
        if (rows.length === 0) return null;
        const [row] = rows;
        if (
          rows.length !== 1 || !Number.isSafeInteger(row.id) ||
          typeof row.expired !== "boolean"
        ) refuse();
        return {
          id: row.id as number,
          digest: typeof row.digest === "string" ? row.digest : null,
          expired: row.expired,
        };
      } finally {
        deadline.dispose();
      }
    },
  };
}

/** One bounded plan listing; the shared walk deadline still applies. */
const PLAN_LISTING_MAX_MS = 30_000;

/** Existing native token and read-only artifact route; no release writer or model. */
export function createHostedHistoricalMatrixQuarantine(input: {
  state: StateReadView & RepairStateWriter;
  clock: { now(): number };
  token: string;
  apiToken?: string;
  artifactRoot: string;
  http?: HttpTransportV1;
  artifactHttp?: HttpTransportV1;
  cooldownMode?: string;
  /**
   * Explicit authenticated not-started revalidation of already-quarantined
   * records. Defaults to false so every existing caller keeps the original
   * closed quarantine pass; the trusted production maintenance route enables
   * it explicitly.
   */
  revalidateNotStarted?: boolean;
  historicalReleaseWitnesses?: readonly {
    commit: GitSha;
    executionId: string;
    logDigest: string;
    reservationIds: readonly string[];
  }[];
}): HistoricalMatrixQuarantineDepsV1 {
  const witnesses = input.historicalReleaseWitnesses ??
    HOSTED_HISTORICAL_RELEASE_WITNESSES;
  const client = new GitHubApiClient({
    repository: HOSTED_CONTROLLER_SELF,
    apiBaseUrl: "https://api.github.com",
    http: input.http ?? fetchHttpTransport(),
    clock: input.clock,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
    cooldownGate: new HostedRepairCooldownGate({
      state: input.state,
      clock: input.clock,
      mode: parseCooldownModeV1(input.cooldownMode),
    }),
  });
  return {
    state: input.state,
    clock: input.clock,
    ...(input.apiToken === undefined ? {} : {
      nativeQueueFor: (repository, state) =>
        createMaintenanceNativeQueue({
          repository,
          state,
          clock: input.clock,
          gate: new HostedRepairCooldownGate({ state, clock: input.clock }),
          token: input.apiToken!,
          http: input.http ?? fetchHttpTransport(),
        }),
    }),
    revalidateNotStarted: input.revalidateNotStarted === true,
    budget: new RollingStartBudget({
      state: input.state,
      clock: input.clock,
      configs: [],
    }),
    readExecution: (execution) => client.readHostedExecution(execution),
    historicalReleaseWitnesses: witnesses.map((witness) => ({
      ...witness,
      reject: (proof, expectedHead, _revalidateNotStarted, deadline) => {
        const historicalState: StateReadView = {
          readRepair: () => input.state.readRepair(),
          readRelease: () =>
            input.state.readReleaseAt
              ? input.state.readReleaseAt({
                commit: witness.commit,
                expectedHead,
              })
              : Promise.resolve(
                portError(
                  "unavailable",
                  "historical release reader unavailable",
                ),
              ),
        };
        return createActionsMatrixArtifactTransport({
          state: historicalState,
          clock: input.clock,
          token: input.token,
          artifactRoot: input.artifactRoot,
          http: input.artifactHttp ??
            createActionsMatrixArtifactHttpTransport(),
        }).rejectHistorical!({
          proof,
          revalidateNotStarted: input.revalidateNotStarted === true,
          ...(deadline === undefined ? {} : { deadline }),
        });
      },
    })),
    transport: createActionsMatrixArtifactTransport({
      state: input.state,
      clock: input.clock,
      token: input.token,
      artifactRoot: input.artifactRoot,
      http: input.artifactHttp ?? createActionsMatrixArtifactHttpTransport(),
    }),
  };
}
