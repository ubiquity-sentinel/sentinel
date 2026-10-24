/** Hosted actions-repair-host responsibility. */
import { canonicalStringify } from "../contracts/canonical.ts";
import { hostedOrdinaryAdmitted } from "../contracts/hosted-supervisor-verification.ts";
import { asGitSha } from "../contracts/brands.ts";
import { DenoReplayRuntime, type ReplayRuntimeV1 } from "../replay/runtime.ts";
import { ReviewOwnerChannelClient } from "./review-owner-channel.ts";
import { reviewOwnerChildInput } from "./review-owner-child-input.ts";
import { parseCarrier } from "./matrix-actions-shared.ts";
import { cellCiEvidenceReader } from "./matrix-cell-ci-evidence.ts";
import {
  createTrustedGatewayCapabilities,
  isGatewayTarget,
  type TargetRepairCapabilitiesV1,
  unavailableTargetCapabilities,
} from "./gateway-capabilities.ts";
import {
  COOLDOWN_MODE_ENV,
  parseCooldownModeV1,
} from "../contracts/cooldown-mode.ts";
import { SystemClock } from "../contracts/ports.ts";
import type { GitHubCooldownGateV1, GitHubPort } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import { DEFAULT_STEP_LIMIT } from "../repair/loop-bounds.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { RollingStartBudget } from "../budget/mod.ts";
import {
  type OwnerSuccessorReviewPorts,
  runOwnerSuccessorReviewPhase,
} from "./owner-successor-acceptance.ts";
import { HostedRepairCooldownGate } from "./hosted-cooldown.ts";
import {
  LEGACY_REVIEW_CUTOFF_ENV,
  parseLegacyReviewCutoffEnv,
} from "./legacy-review-cutoff-env.ts";
import {
  parseHostedEnvironment,
  readHostedIdentityEnv,
  readHostedRuntimeExecution,
} from "./hosted-runtime.ts";
import { GitHubApiClient } from "../github/client.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { fetchHttpTransport } from "../github/http.ts";
import { runActionsPreflight } from "./actions-preflight.ts";
import {
  prepareActionsQueueCustody,
  QUEUE_CUSTODY_IDLE_DETAIL,
} from "./actions-queue-custody.ts";
import { runActionsCiApproval } from "./actions-ci.ts";
import { readHostedReleaseReceipt } from "./actions-release.ts";
import { createActionsCandidateRestorer } from "./actions-candidates.ts";
import type { ActionsCandidateRestorerV1 } from "./actions-candidates.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import {
  createDefaultBranchResolver,
  loadTargetConfigsV1,
  STATIC_TARGETS_EMPTY,
} from "./targets.ts";
import { createRepairStateStore, DenoGitRunner } from "../state/mod.ts";
import { GATEWAY_BASE_URL, resolveModelRoute } from "./model-route.ts";
import {
  composeLocalGitHub,
  createLocalRepositoryConfig,
  ensurePrivateDir,
  ensureReviewClient,
  githubGitAuthEnv,
  joinPath,
  LocalCheckoutModelPort,
  LocalSessionTracker,
  prepareSourceRepository,
  refreshDevelopment,
  scopeLocalRepairIssues,
  unavailableIncidents,
  unavailableReplay,
} from "./local.ts";
import {
  ACTIONS_LOGIN,
  APP_INSTALLATION_ENV,
  APP_LOGIN,
  childRunDeadlineV1,
  DEFAULT_APP_INSTALLATION_ID,
  parseAppInstallationId,
  REMOTE_URL,
  scopeTargetConfigV1,
  STATIC_BASE_REFRESH,
  STATIC_DEADLINE,
  STATIC_PREFLIGHT,
  STATIC_RUNNER,
  STATIC_TARGET_UNKNOWN,
  STEP_LIMIT,
  targetsDiagnosticV1,
} from "./actions-target-cycles.ts";
import type {
  ActionsRepairHostDepsV1,
  ActionsRepairHostResultV1,
  ActionsTargetCyclesInputV1,
} from "./actions-target-cycles.ts";
import {
  APP_TOKEN_NOT_AFTER_ENV,
  parseAppTokenNotAfterV1,
} from "./hosted-app-token-window.ts";
import { HOSTED_APP_MINT_GRANT_ENV } from "./hosted-app-grant.ts";
import { readHostedAppCredentials } from "./hosted-app-credentials.ts";
import {
  composeHostedAppGitHub,
  type HostedAppGitHubInput,
} from "./hosted-app-principal.ts";
import { createActionsTargetBindings } from "./actions-target-bindings.ts";
import { readHostedSelfDependencyPreparer } from "./hosted-self-dependencies.ts";
import { createPassportDependencyPreparer } from "./passport-dependencies.ts";
import {
  ensureRepairStateSeed,
  optionalEnv,
  readControllerSha,
  requireEnv,
  resolveExecutable,
} from "./actions-host-io.ts";

/** Run one hosted repair pass through the actual production entrypoint. */
export async function runActionsRepairHost(
  deps: ActionsRepairHostDepsV1 = {},
): Promise<
  ActionsRepairHostResultV1
> {
  // The ONE absolute run deadline for this child run is anchored at the
  // earliest instant this process can observe for itself, BEFORE any identity,
  // credential, state, source or target preparation. The launcher spawned this
  // process and its own 112-minute bound is already ticking, so this origin is
  // later than the launcher's by the child startup and module load already
  // spent: the unchanged 110-minute budget is measured from HERE, which charges
  // every setup step to the child's own work window instead of to the
  // launcher's drain cushion (two minutes minus that unmeasured startup).
  const clock = deps.clock ?? new SystemClock();
  /** One run-environment key: the injected environment, else the process. */
  const readEnv = (name: string): string | undefined =>
    deps.env === undefined ? Deno.env.get(name) : deps.env[name];
  const runOrigin = clock.now();

  // The protected native identity is validated before any credential, state,
  // executable or network work: a malformed job identity fails with no request
  // and no durable write.
  const identity = parseHostedEnvironment(
    deps.env ?? readHostedIdentityEnv(),
    (deps.job ?? "repair") as Parameters<typeof parseHostedEnvironment>[1],
  );

  // A launcher-forwarded App-token window can only make the deadline earlier:
  // no GitHub work is planned past the instant the run's one token stops being
  // certainly valid. A malformed window refuses before any setup.
  const deadline = childRunDeadlineV1(
    runOrigin,
    parseAppTokenNotAfterV1(readEnv(APP_TOKEN_NOT_AFTER_ENV)),
  );
  // One bounded advisory line, emitted before any setup or credential read, so
  // the hosted log records the exact window this run works on even when the
  // setup that follows fails. It carries no `status` property, so the
  // launcher's child-status scan can never read it as a child result.
  console.log(JSON.stringify({
    kind: "sentinel_run_window",
    originAt: runOrigin,
    deadlineAt: deadline,
  }));

  // The trusted model route is resolved EXACTLY ONCE at host start, before any
  // credential read or client composition, and recorded as one bounded
  // advisory line: provider, model id and endpoint only — never the key value
  // and never the key environment's contents. Selection is explicit and
  // deterministic (owner override, then the explicit DeepSeek fallback with
  // its key present, else the primary gateway); it is never a per-request
  // swap, and the resolved model id is the id the runtime requests and records.
  // The route environment is the injected one when the caller supplies it, in
  // which case the literal below is never evaluated and no process key is
  // read; otherwise it is exactly the documented route/review variables read
  // through their own named grants. The process environment is never
  // enumerated, so a named allowlist is sufficient.
  const routeEnv = deps.env ?? {
    SENTINEL_MODEL_BASE_URL: Deno.env.get("SENTINEL_MODEL_BASE_URL"),
    SENTINEL_MODEL_ID: Deno.env.get("SENTINEL_MODEL_ID"),
    SENTINEL_MODEL_FALLBACK: Deno.env.get("SENTINEL_MODEL_FALLBACK"),
    SENTINEL_DEEPSEEK_API_KEY: Deno.env.get("SENTINEL_DEEPSEEK_API_KEY"),
    SENTINEL_REVIEW_MODEL_ID: Deno.env.get("SENTINEL_REVIEW_MODEL_ID"),
  };
  const modelRoute = resolveModelRoute(routeEnv);
  const queueMode = readEnv("SENTINEL_MERGE_QUEUE");
  console.log(JSON.stringify({
    kind: "sentinel_model_route",
    provider: modelRoute.provider,
    model: modelRoute.model,
    baseUrl: modelRoute.baseUrl,
    reviewMode: "native",
  }));
  const githubToken = requireEnv(readEnv, "GITHUB_TOKEN");
  const {
    appToken,
    selfToken,
    selfGrant,
    targetInstallationId,
    selfInstallationId,
  } = readHostedAppCredentials(readEnv);
  // The model token is the route's key when the route names a key environment
  // (read through the existing --allow-env mechanism), else the existing
  // gateway token. The review client ALWAYS uses the gateway token: it is
  // gateway-bound independently of the implementation route, so a
  // DeepSeek-direct implementation route never pairs the gateway-only review
  // model with the DeepSeek endpoint or key.
  const gatewayToken = requireEnv(readEnv, "UOS_AI_TOKEN");
  const modelToken = modelRoute.apiKeyEnv === null
    ? gatewayToken
    : requireEnv(readEnv, modelRoute.apiKeyEnv);
  const trustedPath = requireEnv(readEnv, "PATH");
  // Every code-change write goes through the App token when the workflow
  // minted one; the native token keeps the state store and Actions metadata.
  // An older installed revision has no App credential at all and still runs.
  const writeToken = appToken ?? githubToken;
  const selfWriteToken = selfToken ?? githubToken;
  const login = appToken === undefined ? ACTIONS_LOGIN : APP_LOGIN;
  const sourceDir = deps.workDir ?? Deno.cwd();
  const denoExecutable = Deno.execPath();
  const codexExecutable = await resolveExecutable("codex", trustedPath);
  const stateRoot = joinPath(sourceDir, ".sentinel-actions-state");
  const scratch = joinPath(stateRoot, "state-scratch");
  const sourcePath = joinPath(stateRoot, "source");
  const reviewCheckout = joinPath(stateRoot, "review-checkout");
  const reviewClientHome = joinPath(stateRoot, "clients", "review");
  const reviewTmpDir = joinPath(stateRoot, "tmp", "review");
  const reviewDenoDir = joinPath(stateRoot, "deno", "review");

  await ensurePrivateDir(stateRoot);
  await ensurePrivateDir(scratch);
  const controllerSha = await readControllerSha(sourceDir, trustedPath);

  // The state store uses the same authenticated Git transport as publication,
  // but its role is fixed to repair. GitHub state never shares an index or
  // checkout with the source repository.
  const stateStore = deps.state ?? createRepairStateStore({
    scratchDir: scratch,
    remoteUrl: deps.stateRemoteUrl ?? REMOTE_URL,
    runner: new DenoGitRunner(
      joinPath(scratch, "state-git-home"),
      githubGitAuthEnv(githubToken),
    ),
  });
  // Cells expose literal read capabilities and a refusing internal write adapter.
  // No helper can accidentally reach the remote repair writer in a cell job.
  const state = deps.job === "matrix_cell"
    ? {
      readRepair: () => stateStore.readRepair(),
      readRelease: () => stateStore.readRelease(),
      writeRepair: () =>
        Promise.resolve(
          portError("invalid", "matrix cells cannot write shared state"),
        ),
    }
    : stateStore;
  // The saved supervisor pointer must bind exactly this run, attempt, launcher
  // and controller revision BEFORE any repair seed, source, model, preflight or
  // review-client preparation. A stale or foreign pointer never runs.
  const execution = await readHostedRuntimeExecution({
    state,
    identity,
    controllerSha,
  });
  const childInput = reviewOwnerChildInput(deps.trustedStdin, execution);
  if (
    childInput.reviewCustody !== undefined &&
    (identity.job !== "repair" || execution.purpose !== "ordinary")
  ) throw new Error(STATIC_RUNNER);
  const matrixCarrier = childInput.matrix === undefined
    ? undefined
    : parseCarrier(JSON.parse(childInput.matrix), false);
  if (deps.job !== "matrix_cell") await ensureRepairStateSeed(state, clock);
  // The enforcement mode is injected through the environment and parsed
  // strictly: an absent or empty setting enforces, a typo fails the run before
  // any request, and `off` is the explicit development switch.
  const cooldownMode = parseCooldownModeV1(
    optionalEnv(readEnv, COOLDOWN_MODE_ENV),
  );
  const mutableGate = new HostedRepairCooldownGate({
    state,
    clock,
    mode: cooldownMode,
  });
  const gate: GitHubCooldownGateV1 = deps.job === "matrix_cell"
    ? {
      beforeRequest: (scope) => mutableGate.beforeRequest(scope),
      recordRateLimit: () =>
        Promise.resolve(
          portError("rate_limited", "matrix cell source read was rate limited"),
        ),
    }
    : mutableGate;
  const hostInput = {
    stateRoot,
    sourceDir,
    controllerSha,
    githubToken,
    modelToken,
    codexExecutable,
    denoExecutable,
    trustedPath,
  };

  // The source mirror is private to this run. The SENTINEL mirror is seeded
  // from this run's own checkout (the exact runtime revision) and refreshed
  // here; a FOREIGN target cannot be served by it, because that mirror holds
  // no object from the other repository at all. Each foreign target therefore
  // gets its own mirror below, seeded from its own authenticated remote and
  // fetched at its own base branch. The shared cooldown gate still governs
  // every fetch.
  await prepareSourceRepository(sourcePath, hostInput, scratch);
  const baseSha = deps.refreshSelf === undefined
    ? await refreshDevelopment(sourcePath, hostInput, scratch, gate)
    : await deps.refreshSelf(sourcePath);
  /**
   * Exact private mirror directory for one committed target. The sentinel
   * self-target keeps the original single `source` mirror so every existing
   * path, checkpoint and candidate object of the self-repair lane is
   * unchanged; every other target gets its own directory derived from its
   * validated owner/name.
   */
  /**
   * Exact independent review checkout for one target. It is a real clone of
   * THAT target's mirror, created and detached inside the review snapshot
   * capture, so a review can never read another repository's objects or carry
   * a previous target's checkout state into this target's snapshot.
   */
  const reviewCheckoutFor = (config: RepositoryConfigV1): string =>
    config.repository.owner === templateConfig.repository.owner &&
      config.repository.name === templateConfig.repository.name
      ? reviewCheckout
      : joinPath(
        stateRoot,
        "review-checkouts",
        `${config.repository.owner}-${config.repository.name}`,
      );
  const mirrorPathFor = (config: RepositoryConfigV1): string =>
    config.repository.owner === templateConfig.repository.owner &&
      config.repository.name === templateConfig.repository.name
      ? sourcePath
      : joinPath(
        stateRoot,
        "sources",
        `${config.repository.owner}-${config.repository.name}`,
      );

  // The review client is configured independently of the implementation
  // route: always the gateway provider and endpoint with the gateway token,
  // so the gateway-bound structured reviewer never meets a DeepSeek-direct
  // client config on the fallback path. The implementation route above is
  // untouched.
  await ensureReviewClient({
    reviewCheckout,
    reviewClientHome,
    reviewTmpDir,
    reviewDenoDir,
    token: gatewayToken,
    codexExecutable,
    denoExecutable,
    trustedPath,
    baseUrl: GATEWAY_BASE_URL,
  });

  const tracker = new LocalSessionTracker();
  const http = deps.http ?? fetchHttpTransport();
  // The private context binds the actual App token to clean protected source,
  // native job facts and the already verified saved execution. Metadata alone
  // never grants takeover authority; cells cannot request this capability.
  const sourceRuntime = new DenoReplayRuntime(denoExecutable);
  const sourceProcess: ReplayRuntimeV1 = {
    run: (command) => {
      const remaining = deadline - clock.now();
      if (!Number.isSafeInteger(remaining) || remaining <= 0) {
        return Promise.reject(new Error("hosted App source deadline expired"));
      }
      return sourceRuntime.run({
        ...command,
        maxDurationMs: Math.min(command.maxDurationMs, remaining),
      });
    },
  };
  const takeoverSource = {
    launcherDir: joinPath(sourceDir, "..", "launcher"),
    runtimeDir: sourceDir,
    identity,
    execution,
    process: sourceProcess,
  };
  const bindings = await createActionsTargetBindings({
    selfRepository: createLocalRepositoryConfig().repository,
    selfToken,
    selfWriteToken,
    targetToken: writeToken,
    targetLogin: login,
    actionsLogin: ACTIONS_LOGIN,
    appLogin: APP_LOGIN,
    auth: {
      source: takeoverSource,
      state,
      clock,
      gate,
      http,
      nativeToken: githubToken,
      appTokenNotAfter: readEnv(APP_TOKEN_NOT_AFTER_ENV),
      deadline,
    },
    targetMintGrant: readEnv(HOSTED_APP_MINT_GRANT_ENV),
    selfMintGrant: selfGrant,
    targetInstallationId,
    selfInstallationId,
    contextsAllowed: identity.job !== "matrix_cell",
    sourceProfiles: deps.hostedAppSourceProfiles,
  });
  const { isSelfTarget, tokenFor, loginFor, selfContext } = bindings;
  const takeoverContext = bindings.targetContext;

  const gitExecutable = await resolveExecutable("git", trustedPath);

  // The committed setting is the only target source; the local template only
  // supplies trusted per-repository defaults and the self identity.
  const templateConfig = createLocalRepositoryConfig();
  const targets = await loadTargetConfigsV1({
    template: templateConfig,
    // The setting lives in this run's own checkout, exactly as before.
    root: sourceDir,
    resolveDefaultBranch: deps.resolveDefaultBranch ??
      createDefaultBranchResolver({
        http,
        token: writeToken, // private targets need the App token for branch reads
      }),
  });
  if (targets.configs.length === 0) throw new Error(STATIC_TARGETS_EMPTY);
  const selfRepository = templateConfig.repository;
  const needsAppScope = targets.configs.some((candidate) =>
    candidate.repository.owner !== selfRepository.owner ||
    candidate.repository.name !== selfRepository.name
  );
  const appInstallationId = needsAppScope
    ? parseAppInstallationId(optionalEnv(readEnv, APP_INSTALLATION_ENV))
    : DEFAULT_APP_INSTALLATION_ID;
  const targetConfigs = targets.configs.map((candidate) =>
    scopeTargetConfigV1(candidate, selfRepository, appInstallationId, deps)
  );
  // One lazy restorer per target, bound to that target's own remote and mirror.
  const candidatesBySlug = new Map<string, ActionsCandidateRestorerV1>();
  const candidatesFor = (
    config: RepositoryConfigV1,
  ): ActionsCandidateRestorerV1 => {
    const slug = `${config.repository.owner}/${config.repository.name}`;
    let restorer = candidatesBySlug.get(slug);
    if (restorer === undefined) {
      restorer = createActionsCandidateRestorer({
        state,
        gate,
        token: tokenFor(config),
        http,
        clock,
        sourcePath: mirrorPathFor(config),
        scratch,
        trustedPath,
        gitExecutable,
        repository: config.repository,
      });
      candidatesBySlug.set(slug, restorer);
    }
    return restorer;
  };
  /** The exact mirror each requested repository must be served from. */
  const sourcePathBySlug = new Map<string, string>();
  for (const config of targetConfigs) {
    sourcePathBySlug.set(
      `${config.repository.owner}/${config.repository.name}`,
      mirrorPathFor(config),
    );
  }

  // ONE admission budget for the whole run: it is constructed over every
  // target config, so a reservation for any target resolves its policy against
  // the shared 120-starts-per-hour cap instead of a per-target one.
  const budget = new RollingStartBudget({
    clock,
    state,
    configs: targetConfigs,
  });
  // Native owner settlement always authenticates Sentinel, independently of the reviewed target.
  const nativeSelf = new GitHubApiClient({
    repository: selfRepository,
    apiBaseUrl: "https://api.github.com",
    http,
    clock,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${githubToken}`)),
    },
    cooldownGate: gate,
  });
  let reviewCustody: ReviewOwnerChannelClient | undefined;
  const custodyFor = () => {
    if (childInput.reviewCustody === undefined) return undefined;
    return reviewCustody ??= new ReviewOwnerChannelClient(
      childInput.reviewCustody,
    );
  };
  const nativeReviewOwner = identity.job === "repair" &&
    execution.purpose === "ordinary";
  // The SAME absolute run deadline captured before every setup step above is
  // handed to every target cycle unchanged; it is never recomputed.
  // The port is composed per target: the REST client, review service, trusted
  // git remote and cooldown scope all address exactly that repository.
  let ownerSuccessorPorts: OwnerSuccessorReviewPorts | undefined;
  const composeProductionGithub = (config: RepositoryConfigV1): GitHubPort => {
    const common: HostedAppGitHubInput = {
      queueMode,
      invocationId: nativeReviewOwner ? execution.id : crypto.randomUUID(),
      ...(nativeReviewOwner
        ? { ownerExecution: execution, ownerCustody: custodyFor() }
        : {}),
      ownerSettlement: {
        read: (input) => nativeSelf.readReviewOwnerSettlement(input),
      },
      selfMergeEnabled: config.repository.owner === "ubiquity-sentinel" &&
        config.repository.name === "sentinel" &&
        config.repository.installationId === 0,
      stateRoot,
      sourcePath: mirrorPathFor(config),
      scratch,
      reviewCheckout: reviewCheckoutFor(config),
      reviewClientHome,
      reviewTmpDir,
      reviewDenoDir,
      trustedPath,
      codexExecutable,
      tracker,
      ensureCandidateObjects: candidatesFor(config).ensure,
      modelBaseUrl: modelRoute.baseUrl,
      route: modelRoute,
      onOwnerSuccessorReviewPorts: (ports) => {
        ownerSuccessorPorts = ports;
      },
      repository: config.repository,
      baseBranch: config.baseBranch,
    };
    const local = () =>
      composeLocalGitHub(
        {
          ...common,
          clock,
          state,
          gate,
          http,
          token: tokenFor(config),
          login: loginFor(config),
        },
        // Owner directive 2026-10-24: other people's pull requests never
        // hold or divert Sentinel's own repair, so existing-PR discovery is
        // never activated here (the hosted App composition ships it off too).
        undefined,
        { activated: false },
      );
    const context = isSelfTarget(config) ? selfContext : takeoverContext;
    if (context !== null) {
      return scopeLocalRepairIssues(composeHostedAppGitHub(context, common));
    }
    return scopeLocalRepairIssues(local());
  };
  const targetPorts = new Map<string, GitHubPort>();
  const composeTargetGithub = (config: RepositoryConfigV1): GitHubPort => {
    const key = canonicalStringify({
      repository: config.repository,
      baseBranch: config.baseBranch,
    });
    const cached = targetPorts.get(key);
    if (cached !== undefined) return cached;
    const production = composeProductionGithub(config);
    const port = scopeLocalRepairIssues(
      deps.composeGithub?.(config, production) ?? production,
    );
    targetPorts.set(key, port);
    return port;
  };
  const model = deps.model ?? new LocalCheckoutModelPort({
    stateRoot,
    sourcePath,
    scratch,
    trustedPath,
    codexExecutable,
    denoExecutable,
    modelToken,
    tracker,
    clock,
    route: modelRoute,
    modelId: modelRoute.model,
    failoverModelId: modelRoute.failoverModel,
    localIteration: false,
    preparePassportDependencies: createPassportDependencyPreparer({
      scratch,
      trustedPath,
    }),
    prepareCheckoutDependencies: await readHostedSelfDependencyPreparer({
      runtimeDir: sourceDir,
      launcherSha: identity.launcherSha,
      executionLauncherSha: execution.launcherSha,
      trustedPath,
    }),
    // Both capabilities resolve from the REQUESTED repository, not from the
    // sentinel self-identity: the checkout and the candidate import must use
    // the target's own mirror, and candidate restoration must read the
    // target's own remote. A request for a repository the run did not commit
    // as a target refuses instead of silently using sentinel's mirror.
    ensureCandidateObjects: (input) => {
      const slug = `${input.repository.owner}/${input.repository.name}`;
      const mirror = sourcePathBySlug.get(slug);
      if (mirror === undefined) {
        return Promise.resolve(portError(
          "invalid",
          STATIC_TARGET_UNKNOWN,
        ));
      }
      const config = targetConfigs.find((candidate) =>
        candidate.repository.owner === input.repository.owner &&
        candidate.repository.name === input.repository.name
      );
      if (config === undefined) {
        return Promise.resolve(portError("invalid", STATIC_TARGET_UNKNOWN));
      }
      return candidatesFor(config).ensure({
        base: input.base,
        head: input.head,
      });
    },
    resolveSourcePath: (repository) =>
      sourcePathBySlug.get(`${repository.owner}/${repository.name}`) ??
        sourcePath,
    // A target branch can move while this run is still cycling. A record the
    // intake pinned to the moved head then cannot be checked out from a mirror
    // fetched before the move, so the exact requested base is fetched into
    // THAT target's own mirror on demand, through the same bounded, gated
    // trusted fetch its cycle start already uses. An unknown target, a gate
    // refusal or a failed fetch stays a refusal: the checkout is never
    // prepared from an unproved object.
    ensureBaseObject: async (input) => {
      const config = targetConfigs.find((candidate) =>
        candidate.repository.owner === input.repository.owner &&
        candidate.repository.name === input.repository.name &&
        candidate.repository.installationId ===
          input.repository.installationId
      );
      if (config === undefined) {
        return portError("invalid", STATIC_TARGET_UNKNOWN);
      }
      const remoteUrl =
        `https://github.com/${config.repository.owner}/${config.repository.name}.git`;
      try {
        await refreshDevelopment(
          mirrorPathFor(config),
          { ...hostInput, githubToken: tokenFor(config) },
          scratch,
          gate,
          config.repository.installationId,
          { remoteUrl, baseBranch: config.baseBranch },
        );
      } catch {
        return portError("unavailable", STATIC_BASE_REFRESH);
      }
      return portOk(undefined);
    },
  });

  // The hosted self release path reads the protected supervisor's persisted
  // strict receipt from the same release state this host already reads. No
  // HTTP, token, client or write is involved, and the obsolete raw
  // workflow-green path is gone.
  Object.assign(state, {
    readHostedRelease: (request: ReleaseRequestV1) =>
      readHostedReleaseReceipt({ state }, request),
  });

  // This bounded availability probe starts no model session. Its actual result
  // remains the runtime-health signal even when queue custody holds this pass.
  let startupReady = false;
  try {
    await (deps.preflight ?? runActionsPreflight)(modelRoute);
    startupReady = true;
  } catch {
    startupReady = false;
  }

  /**
   * Prepare ONE target's own private state immediately before its cycle: its
   * mirror seeded from its own authenticated remote, fetched at its own base
   * branch through the shared cooldown gate. The sentinel self-target is
   * already prepared above from this run's own checkout, so it needs nothing
   * here and its existing path is unchanged. A foreign target's preparation
   * failure is contained to that target by the loop, which records it as
   * failed rather than treating it as addressed.
   */
  const capabilitiesByConfig = new Map<string, TargetRepairCapabilitiesV1>();
  const preparedTargets = new Set<string>();
  const prepareTarget = async (config: RepositoryConfigV1): Promise<void> => {
    const slug = `${config.repository.owner}/${config.repository.name}`;
    const committed = targetConfigs.find((entry) =>
      canonicalStringify(entry) === canonicalStringify(config)
    );
    if (
      committed === undefined ||
      sourcePathBySlug.get(slug) !== mirrorPathFor(config)
    ) throw new Error(STATIC_TARGET_UNKNOWN);
    if (preparedTargets.has(canonicalStringify(config))) return;
    if (deps.prepareTarget !== undefined) {
      await deps.prepareTarget(config, mirrorPathFor(config));
    } else if (mirrorPathFor(config) !== sourcePath) {
      const remoteUrl =
        `https://github.com/${config.repository.owner}/${config.repository.name}.git`;
      // A foreign target's mirror MUST authenticate with the App token, never the
      // native Actions token. The native token is scoped to the sentinel
      // repository, and Git applies an `http.<url>.extraheader` to that url: the
      // header is then SENT, the server rejects the credential, and Git fails
      // with "could not read Username" instead of falling back to anonymous
      // access. That is why a public foreign repository still could not be
      // cloned or fetched while the same operation succeeds with the App token.
      const targetInput = { ...hostInput, githubToken: tokenFor(config) };
      await prepareSourceRepository(
        mirrorPathFor(config),
        targetInput,
        scratch,
        remoteUrl,
      );
      await refreshDevelopment(
        mirrorPathFor(config),
        targetInput,
        scratch,
        gate,
        config.repository.installationId,
        { remoteUrl, baseBranch: config.baseBranch },
      );
    }
    // Only a trusted controller receives private capture capabilities. Model cells never do.
    let capabilities: TargetRepairCapabilitiesV1 = {
      incidents: unavailableIncidents,
      replay: unavailableReplay,
    };
    if (isGatewayTarget(config)) {
      capabilities = unavailableTargetCapabilities();
      if (deps.job !== "matrix_cell" && deps.gateway !== undefined) {
        const native = new DenoReplayRuntime(trustedPath);
        const base = await native.run({
          executable: gitExecutable,
          args: [
            "rev-parse",
            "--verify",
            `refs/remotes/origin/${config.baseBranch}`,
          ],
          cwd: mirrorPathFor(config),
          env: { PATH: trustedPath, GIT_CONFIG_NOSYSTEM: "1" },
          maxDurationMs: 30_000,
          maxOutputBytes: 4096,
        });
        if (
          base.outcome === "exited" && base.exitCode === 0 && base.settled &&
          !base.truncated
        ) {
          const resolved = await createTrustedGatewayCapabilities({
            config,
            prepared: {
              config,
              sourcePath: mirrorPathFor(config),
              sourceSha: asGitSha(
                new TextDecoder("utf-8", { fatal: true }).decode(base.stdout)
                  .trim(),
              ),
              controllerSha,
              execution,
              denoExecutable,
              gitExecutable,
            },
            clock,
            authority: deps.gateway,
            authJson: optionalEnv(readEnv, "SENTINEL_GATEWAY_AUTH_JSON") ?? "",
            replayKeyB64: optionalEnv(readEnv, "SENTINEL_REPLAY_KEY_B64") ?? "",
          });
          if (resolved.ok) capabilities = resolved.value;
        }
      }
    }
    capabilitiesByConfig.set(canonicalStringify(config), capabilities);
    preparedTargets.add(canonicalStringify(config));
  };

  // An ordinary execution without current health is a deterministic verification.
  // The purpose string alone is never authority to start implementation/review.
  const releaseRead = await state.readRelease();
  if (!releaseRead.ok || releaseRead.value.status !== "found") {
    throw new Error(STATIC_RUNNER);
  }
  const runtime =
    parseReleaseStateSnapshotV1(releaseRead.value.snapshot).hostedRuntimes[0];
  const healthyOrdinaryExecution = execution.purpose === "ordinary" &&
    runtime?.activeRevision === execution.revision &&
    runtime.generation === execution.generation &&
    canonicalStringify(runtime.execution) === canonicalStringify(execution) &&
    hostedOrdinaryAdmitted(runtime);

  let queueReady = deps.job === "matrix_cell";
  let outcome: RepairCycleOutcomeV1 | null = null;
  let ownerOperationHandled = false;
  let failure: unknown = null;
  try {
    if (!queueReady) {
      queueReady = await prepareActionsQueueCustody({
        state,
        clock,
        token: writeToken,
        http,
        queueMode,
        deadline,
        purpose: execution.purpose,
        configs: targetConfigs,
        prepareTarget,
        composeGithub: composeTargetGithub,
      });
    }
    if (!queueReady) {
      outcome = { status: "idle", detail: QUEUE_CUSTODY_IDLE_DETAIL };
    } else {
      ownerOperationHandled = await runOwnerSuccessorReviewPhase(
        {
          clock,
          state,
          budget,
          nativeOwner: execution,
          latestStartAt: Math.min(runOrigin + 90 * 60_000, deadline),
          settleBy: deadline,
        },
        targetConfigs,
        prepareTarget,
        composeTargetGithub,
        () => ownerSuccessorPorts,
        startupReady && healthyOrdinaryExecution,
      );
      if (ownerOperationHandled) {
        outcome = {
          status: "idle",
          detail: "bounded owner successor review operation settled or pending",
        };
      } else {
        const runTargetCycles = deps.runTargetCycles ??
          (async (input: ActionsTargetCyclesInputV1) => {
            const { runActionsMatrixAggregateCycles } = await import(
              "./matrix-actions.ts"
            );
            return runActionsMatrixAggregateCycles(input);
          });
        const cycles = await runTargetCycles({
          clock,
          state,
          configs: targetConfigs,
          controllerSha,
          githubCooldown: gate,
          premergeCi: bindings.premergeCi,
          // Legacy callers retain a closed pair; each prepared target resolves its own pair below.
          incidents: unavailableIncidents,
          replay: unavailableReplay,
          resolveTargetCapabilities: (config) =>
            capabilitiesByConfig.get(canonicalStringify(config)) ??
              unavailableTargetCapabilities(),
          model,
          budget,
          deadline,
          runOrigin,
          stepLimit: execution.purpose === "bootstrap"
            ? DEFAULT_STEP_LIMIT
            : STEP_LIMIT,
          // Only an ordinary hosted execution may start a model. Bootstrap, prior,
          // candidate and rollback runs execute the deterministic entrypoint with
          // no model starts while keeping every budget, limit and source behavior.
          modelStartsEnabled: startupReady && healthyOrdinaryExecution,
          externalImplementations: deps.job !== undefined,
          // The legacy review class's cutoff, handed over by the launcher that
          // pinned it for exactly this runtime (`review-round-cap.ts`); a missing
          // or malformed value grants no legacy round (fails closed).
          legacyReviewCutoff: parseLegacyReviewCutoffEnv(
            optionalEnv(readEnv, LEGACY_REVIEW_CUTOFF_ENV),
          ),
          host: {
            execution,
            run: {
              runId: identity.runId,
              runAttempt: identity.runAttempt,
              launcherSha: identity.launcherSha,
            },
            artifactRoot: joinPath(sourceDir, "..", ".sentinel-matrix"),
            sourcePathFor: mirrorPathFor,
            expectedProvider: modelRoute.provider,
            // The failover the port above was constructed with (same resolution).
            failoverModel: modelRoute.failoverModel,
            ...(matrixCarrier === undefined ? {} : { matrixCarrier }),
            readExecution: (execution) =>
              nativeSelf.readHostedExecution(execution),
            createArtifactTransport: async (producerState) => {
              const {
                createActionsMatrixArtifactTransport,
                createActionsMatrixArtifactHttpTransport,
              } = await import("./matrix-artifacts.ts");
              return createActionsMatrixArtifactTransport({
                state: producerState ?? {
                  readRepair: () => state.readRepair(),
                  readRelease: () => state.readRelease(),
                },
                token: githubToken,
                http: deps.artifactHttp ??
                  createActionsMatrixArtifactHttpTransport(),
                clock,
                artifactRoot: joinPath(sourceDir, "..", ".sentinel-matrix"),
              });
            },
          },
          prepareTarget,
          composeGithub: composeTargetGithub,
          // A matrix cell reads its CI correction's failure evidence with its own
          // scoped read-only App token (`cellCiEvidenceReader`). The reader never
          // reaches the model worker: only the rendered, fenced text does.
          ...(deps.job === "matrix_cell"
            ? {
              composeCiEvidence: (config: RepositoryConfigV1) =>
                cellCiEvidenceReader({
                  repository: config.repository,
                  http,
                  clock,
                  token: tokenFor(config),
                  gate,
                }),
            }
            : {}),
          // The one advisory line reports every committed target as addressed or
          // skipped (an unavailable default branch, or out of time). It carries no
          // `status` property, so the launcher can never read it as a child record.
          report: (result) => {
            if (targets.targets.length > 1) {
              console.log(JSON.stringify(targetsDiagnosticV1({
                addressed: result.addressed,
                skipped: [...targets.skipped, ...result.skipped],
                failed: result.failed,
              })));
            }
          },
        });
        outcome = cycles.outcome;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await reviewCustody?.close();
    } catch {
      failure ??= new Error(STATIC_RUNNER);
    }
    if (!await tracker.settleAll()) {
      failure ??= new Error(STATIC_RUNNER);
    }
  }
  if (failure !== null) throw failure;
  if (outcome === null) throw new Error(STATIC_DEADLINE);

  // Deterministic CI approval for durable self-target candidates runs after
  // the loop and the tracker drain, even when model startup was unavailable.
  // The helper is bounded and never throws, so an approval failure cannot
  // prevent deterministic bookkeeping or change the original error semantics.
  const ciApproval =
    deps.job === undefined && queueReady && !ownerOperationHandled
      ? await runActionsCiApproval({
        state,
        gate,
        http,
        token: selfWriteToken,
        clock,
        deadline,
      })
      : { approved: 0, pending: 0, unavailable: 0 };

  const result: ActionsRepairHostResultV1 = {
    status: "ran",
    outcome,
    controllerSha,
    baseSha,
    login,
    startupReady,
    ciApproval,
    execution,
  };
  console.log(JSON.stringify(result));
  // The deterministic pass and its drain completed and were logged above; the
  // hosted run must still end red when model startup was unavailable.
  if (!startupReady) throw new Error(STATIC_PREFLIGHT);
  return result;
}
