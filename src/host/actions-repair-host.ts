/** Hosted actions-repair-host responsibility. */
import { canonicalStringify } from "../contracts/canonical.ts";
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
import { HostedRepairCooldownGate } from "./hosted-cooldown.ts";
import {
  parseHostedEnvironment,
  readHostedIdentityEnv,
  readHostedRuntimeExecution,
} from "./hosted-runtime.ts";
import { GitHubApiClient } from "../github/client.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { fetchHttpTransport } from "../github/http.ts";
import { runActionsPreflight } from "./actions-preflight.ts";
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
import {
  GATEWAY_BASE_URL,
  resolveModelRoute,
  resolveReviewModelId,
} from "./model-route.ts";
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
  const deadline = childRunDeadlineV1(runOrigin);
  // One bounded advisory line, emitted before any setup or credential read, so
  // the hosted log records the exact window this run works on even when the
  // setup that follows fails. It carries no `status` property, so the
  // launcher's child-status scan can never read it as a child result.
  console.log(JSON.stringify({
    kind: "sentinel_run_window",
    originAt: runOrigin,
    deadlineAt: deadline,
  }));

  // The protected native identity is validated before any credential, state,
  // executable or network work: a malformed job identity fails with no request
  // and no durable write.
  const identity = parseHostedEnvironment(
    deps.env ?? readHostedIdentityEnv(),
    (deps.job ?? "repair") as Parameters<typeof parseHostedEnvironment>[1],
  );

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
  // The dedicated structured-review model override is resolved EXACTLY ONCE
  // here alongside the route: an unset or blank value yields the owner's
  // preferred default (`codex-auto-review`); a declared-but-invalid value
  // yields the invalid empty sentinel, which the reviewer refuses at prepare.
  const reviewModelId = resolveReviewModelId(routeEnv);
  console.log(JSON.stringify({
    kind: "sentinel_model_route",
    provider: modelRoute.provider,
    model: modelRoute.model,
    baseUrl: modelRoute.baseUrl,
    reviewModel: reviewModelId,
  }));

  const githubToken = requireEnv(readEnv, "GITHUB_TOKEN");
  const appToken = optionalEnv(readEnv, "SENTINEL_SUPERVISOR_TOKEN");
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
  const gitExecutable = await resolveExecutable("git", trustedPath);

  // The committed target setting is the ONLY source of target repositories.
  // It is read before any port is composed, so an unusable setting refuses the
  // run instead of quietly repairing nothing and instead of falling back to a
  // built-in repository. `createLocalRepositoryConfig()` is the trusted
  // per-repository template (commands, protected paths, limits) and names the
  // sentinel self-identity; it is not a target list.
  const templateConfig = createLocalRepositoryConfig();
  const targets = await loadTargetConfigsV1({
    template: templateConfig,
    // The setting lives in this run's own checkout, exactly as before.
    root: sourceDir,
    resolveDefaultBranch: deps.resolveDefaultBranch ??
      createDefaultBranchResolver({
        http,
        token: githubToken,
      }),
  });
  if (targets.configs.length === 0) throw new Error(STATIC_TARGETS_EMPTY);
  // EVERY usable target is addressed, one separately targeted cycle each. The
  // sentinel self-repository keeps the reserved no-App owner scope; every other
  // committed target runs under the App installation scope that can write to
  // it, read once from the one allowlisted environment entry.
  const selfRepository = templateConfig.repository;
  const needsAppScope = targets.configs.some((candidate) =>
    candidate.repository.owner !== selfRepository.owner ||
    candidate.repository.name !== selfRepository.name
  );
  const appInstallationId = needsAppScope
    ? parseAppInstallationId(optionalEnv(readEnv, APP_INSTALLATION_ENV))
    : DEFAULT_APP_INSTALLATION_ID;
  const targetConfigs = targets.configs.map((candidate) =>
    scopeTargetConfigV1(candidate, selfRepository, appInstallationId)
  );
  /**
   * ONE lazy candidate restorer per target, each bound to that target's own
   * mirror, remote and repository identity. Candidate objects live in the
   * remote of the repository that owns them, so a shared restorer pointed at
   * the sentinel remote could never restore a foreign target's candidate, and
   * a shared mirror could never hold it either. Restoration stays lazy: the
   * exact durable objects are fetched only when a review snapshot, an ancestry
   * check or a correction checkout actually needs them, never before the loop.
   */
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
        token: writeToken,
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
  // The SAME absolute run deadline captured before every setup step above is
  // handed to every target cycle unchanged; it is never recomputed.
  // The port is composed per target: the REST client, review service, trusted
  // git remote and cooldown scope all address exactly that repository.
  const composeProductionGithub = (config: RepositoryConfigV1): GitHubPort =>
    scopeLocalRepairIssues(composeLocalGitHub({
      clock,
      state,
      gate,
      http,
      token: writeToken,
      login,
      invocationId: crypto.randomUUID(),
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
      reviewModelId,
      repository: config.repository,
      baseBranch: config.baseBranch,
    }));
  const composeTargetGithub = (config: RepositoryConfigV1): GitHubPort => {
    const production = composeProductionGithub(config);
    return scopeLocalRepairIssues(
      deps.composeGithub?.(config, production) ?? production,
    );
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
          { ...hostInput, githubToken: writeToken },
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

  // Model startup availability is proved once, in-process, before the
  // deterministic pass. The probe already logs its bounded dummy-only failure;
  // a failed probe must not prevent deterministic bookkeeping, it only refuses
  // new model starts for this run.
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
  const prepareTarget = async (config: RepositoryConfigV1): Promise<void> => {
    if (deps.prepareTarget !== undefined) {
      await deps.prepareTarget(config, mirrorPathFor(config));
      return;
    }
    if (mirrorPathFor(config) === sourcePath) return;
    const remoteUrl =
      `https://github.com/${config.repository.owner}/${config.repository.name}.git`;
    // A foreign target's mirror MUST authenticate with the App token, never the
    // native Actions token. The native token is scoped to the sentinel
    // repository, and Git applies an `http.<url>.extraheader` to that url: the
    // header is then SENT, the server rejects the credential, and Git fails
    // with "could not read Username" instead of falling back to anonymous
    // access. That is why a public foreign repository still could not be
    // cloned or fetched while the same operation succeeds with the App token.
    const targetInput = { ...hostInput, githubToken: writeToken };
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
  };

  // An ordinary execution without current health is a deterministic verification.
  // The purpose string alone is never authority to start implementation/review.
  const releaseRead = await state.readRelease();
  if (!releaseRead.ok || releaseRead.value.status !== "found") {
    throw new Error(STATIC_RUNNER);
  }
  const runtime =
    parseReleaseStateSnapshotV1(releaseRead.value.snapshot).hostedRuntimes[0];
  const healthy = runtime?.lastHealthyProof;
  const modelStartsEnabled = startupReady && execution.purpose === "ordinary" &&
    runtime?.activeRevision === execution.revision &&
    runtime.generation === execution.generation &&
    canonicalStringify(runtime.execution) === canonicalStringify(execution) &&
    healthy?.execution.revision === execution.revision &&
    healthy.execution.generation === execution.generation;

  let outcome: RepairCycleOutcomeV1 | null = null;
  let failure: unknown = null;
  try {
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
      // The hosted GitHub adapter is intentionally issue-only for each target.
      // Incident/replay capabilities remain unavailable until their
      // authenticated producer is configured; unavailable is never an empty
      // success and therefore cannot create a fabricated fixture.
      incidents: unavailableIncidents,
      replay: unavailableReplay,
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
      modelStartsEnabled,
      externalImplementations: deps.job !== undefined,
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
        readExecution: (execution) =>
          new GitHubApiClient({
            repository: selfRepository,
            apiBaseUrl: "https://api.github.com",
            http,
            clock,
            auth: {
              authorizationHeader: () =>
                Promise.resolve(portOk(`Bearer ${githubToken}`)),
            },
            cooldownGate: gate,
          }).readHostedExecution(execution),
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
  } catch (error) {
    failure = error;
  } finally {
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
  const ciApproval = deps.job === undefined
    ? await runActionsCiApproval({
      state,
      gate,
      http,
      token: githubToken,
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
