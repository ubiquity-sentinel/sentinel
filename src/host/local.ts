/**
 * Concrete local repair host for the authorized ubiquity-sentinel/sentinel target.
 *
 * One bounded hourly pass over real trusted capabilities: a private state
 * root with an exclusive writer lock and crash marker, a persistent local
 * state Git repository, a persistent trusted source checkout, one
 * authenticated GitHub login, one shared durable cooldown gate, the real
 * Codex review transport and a per-task isolated Codex implementation
 * checkout. Incident and replay capability stay explicitly unavailable: no
 * empty fixture is ever reported as success.
 *
 * Trusted inputs only. Tokens are read from the caller/environment, written
 * to mode-0600 files outside every checkout and never reach a model child
 * environment or a log line.
 */

import {
  portError,
  type RepairStateWriter,
  type StateReadView,
  SystemClock,
} from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import {
  createDefaultBranchResolver,
  loadTargetConfigsV1,
  STATIC_TARGETS_EMPTY,
  STATIC_TARGETS_UNSUPPORTED,
} from "./targets.ts";
import { createRepairStateStore } from "../state/mod.ts";
import { composeLocalReleaseReader } from "./local-release.ts";
import { RollingStartBudget } from "../budget/mod.ts";
import { unavailableTargetCapabilities } from "./gateway-capabilities.ts";
import { fetchHttpTransport } from "../github/http.ts";
import { DurableGitHubCooldownGate } from "../repair/github-cooldown.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import { runRepairEntrypoint } from "../main.ts";
import {
  RUN_DEADLINE_MS,
  STATIC_INVALID_OPTIONS,
  STATIC_MARKER,
  STEP_LIMIT,
} from "./local-policy.ts";
import {
  createLocalRepositoryConfig,
  LocalHostOrphanError,
  LocalHostSettlementError,
  type LocalRepairHostOptionsV1,
  type LocalRepairHostRunV1,
  readLocalHostOptions,
} from "./local-config.ts";
import { composeLocalGitHub } from "./local-github.ts";
import { readAuthenticatedLogin } from "./local-github-auth.ts";
import { LocalCheckoutModelPort } from "./local-model.ts";
import { ensureReviewClient, LocalSessionTracker } from "./local-client.ts";
import {
  ensureBareStateRepository,
  prepareSourceRepository,
  readControllerSha,
  refreshDevelopment,
} from "./local-git.ts";
import { writeLocalStatus } from "./local-status.ts";
import {
  ensurePrivateDir,
  joinPath,
  pathExists,
  requireEnv,
  writePrivateFile,
} from "./local-io.ts";

export {
  DEFAULT_UOS_BASE_URL,
  unavailableIncidents,
  unavailableReplay,
} from "./local-policy.ts";
export {
  createLocalRepositoryConfig,
  LocalHostOrphanError,
  LocalHostSettlementError,
  type LocalRepairHostOptionsV1,
  type LocalRepairHostRunV1,
} from "./local-config.ts";
export {
  ensureReviewClient,
  ensureTaskClient,
  type LocalCodexConfigInputV1,
  LocalSessionTracker,
  renderLocalCodexConfig,
} from "./local-client.ts";
export { ensureTaskCheckout, localCheckoutKey } from "./local-checkout.ts";
export { type LocalModelResultReasonV1 } from "./local-model-reason.ts";
export {
  type LocalModelResultProjectionV1,
  writeLocalModelResult,
} from "./local-model-result.ts";
export {
  type LocalModelDiagnosticV1,
  parseLocalModelDiagnosticV1,
} from "./local-model-diagnostic.ts";
export {
  composeLocalGitHub,
  type LocalGitHubInputV1,
  scopeLocalRepairIssues,
} from "./local-github.ts";
export {
  type BaseRefreshObserverV1,
  createPrepareBaseRefresh,
  type PrepareBaseRefreshAdapterInputV1,
  type PrepareBaseRefreshV1,
} from "./local-base-refresh.ts";
export {
  githubGitAuthEnv,
  readAuthenticatedLogin,
} from "./local-github-auth.ts";
export {
  finalizeLocalModelResult,
  LocalCheckoutModelPort,
  type LocalModelInputV1,
} from "./local-model.ts";
export {
  ensureBareStateRepository,
  prepareSourceRepository,
  refreshDevelopment,
} from "./local-git.ts";
export { createLocalCandidateLoader } from "./local-candidate.ts";
export {
  prepareReviewCheckout,
  type PrepareReviewCheckoutInputV1,
  STATIC_REVIEW_CHECKOUT,
} from "./local-review-checkout.ts";
export { type LocalStatusInputV1, writeLocalStatus } from "./local-status.ts";
export { ensurePrivateDir, joinPath } from "./local-io.ts";

// ---------------------------------------------------------------------------
// Exclusive writer lock (narrow, testable)
// ---------------------------------------------------------------------------

/**
 * Acquire the exclusive state-root writer lock without waiting: a held lock
 * returns null immediately. The caller holds the file open and closes it only
 * after every owned session has settled.
 */
export async function tryAcquireLocalHostLock(
  stateRoot: string,
): Promise<Deno.FsFile | null> {
  const lockPath = joinPath(stateRoot, "runner.lock");
  const file = await Deno.open(lockPath, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  try {
    if (file.tryLockSync(true)) return file;
  } catch {
    // fall through to close + refusal
  }
  file.close();
  return null;
}

// ---------------------------------------------------------------------------
// Entrypoints
// ---------------------------------------------------------------------------

/**
 * Run one bounded local repair pass over real trusted capabilities. Returns
 * `busy` when another writer holds the lock; throws on an orphaned marker,
 * an unsettled session set or any host failure. Tokens never leave this
 * process boundary.
 */
export async function runLocalRepairHost(
  options: LocalRepairHostOptionsV1,
): Promise<LocalRepairHostRunV1> {
  const input = readLocalHostOptions(options);
  const clock = new SystemClock();
  const startedAt = clock.now();
  const invocationId = crypto.randomUUID();
  await ensurePrivateDir(input.stateRoot);
  const lock = await tryAcquireLocalHostLock(input.stateRoot);
  if (lock === null) return { status: "busy" };

  const markerPath = joinPath(input.stateRoot, "session-active.json");
  const statusPath = joinPath(input.stateRoot, "status.json");
  const tracker = new LocalSessionTracker();
  const http = fetchHttpTransport();
  let markerWritten = false;
  let settled = true;
  let failure: unknown = null;
  let outcome: RepairCycleOutcomeV1 | null = null;
  let state: (StateReadView & RepairStateWriter) | null = null;
  let login: string | null = null;
  let targetBaseSha: string | null = null;
  let config: RepositoryConfigV1 | null = null;

  try {
    // Fail closed on a prior marker before any new session exists.
    if (await pathExists(markerPath)) throw new LocalHostOrphanError();

    const scratch = joinPath(input.stateRoot, "state-scratch");
    await ensurePrivateDir(scratch);
    const stateGitPath = joinPath(input.stateRoot, "state.git");
    await ensureBareStateRepository(stateGitPath, input, scratch);
    const sourcePath = joinPath(input.stateRoot, "source");
    await prepareSourceRepository(sourcePath, input, scratch);

    state = createRepairStateStore({
      scratchDir: scratch,
      remoteUrl: stateGitPath,
    });
    // The optional local-activation read capability is composed only here, on
    // the privately owned facade: no other host receives it and no repair
    // process ever writes these receipts.
    Object.assign(state, composeLocalReleaseReader(input.stateRoot));

    // One durable gate for the remote refresh, the login read, the API client
    // and the port. It is constructed BEFORE the first remote Git fetch, so a
    // live durable cooldown refuses before any Git runs.
    const gate = new DurableGitHubCooldownGate({ state, clock });
    targetBaseSha = await refreshDevelopment(sourcePath, input, scratch, gate);

    login = await readAuthenticatedLogin(input.githubToken, http, gate, clock);

    // Marker BEFORE any model session or subprocess can start.
    await writePrivateFile(
      markerPath,
      JSON.stringify({
        version: "v1",
        kind: "local_session_active",
        invocationId,
        checkoutPath: sourcePath,
        startedAt,
      }) + "\n",
    );
    markerWritten = true;

    // The committed target setting is the ONLY source of target repositories.
    // The local host addresses exactly one repository (its fixed identity), so
    // the setting must name it: an empty or foreign setting refuses the run
    // instead of repairing a repository the owner never listed.
    const localTemplate = createLocalRepositoryConfig();
    const localTargets = await loadTargetConfigsV1({
      template: localTemplate,
      resolveDefaultBranch: createDefaultBranchResolver({
        http,
        token: input.githubToken,
      }),
      root: sourcePath,
    });
    if (localTargets.configs.length === 0) {
      throw new Error(STATIC_TARGETS_EMPTY);
    }
    const appliedConfig = localTargets.configs.find((candidate) =>
      candidate.repository.owner === localTemplate.repository.owner &&
      candidate.repository.name === localTemplate.repository.name &&
      candidate.repository.installationId ===
        localTemplate.repository.installationId
    );
    if (appliedConfig === undefined) {
      throw new Error(STATIC_TARGETS_UNSUPPORTED);
    }
    config = appliedConfig;
    const reviewCheckout = joinPath(input.stateRoot, "review-checkout");
    const reviewClientHome = joinPath(input.stateRoot, "clients", "review");
    const reviewTmpDir = joinPath(input.stateRoot, "tmp", "review");
    const reviewDenoDir = joinPath(input.stateRoot, "deno", "review");
    await ensureReviewClient({
      reviewCheckout,
      reviewClientHome,
      reviewTmpDir,
      reviewDenoDir,
      token: input.modelToken,
      codexExecutable: input.codexExecutable,
      denoExecutable: input.denoExecutable,
      trustedPath: input.trustedPath,
    });
    const github = composeLocalGitHub({
      clock,
      state,
      gate,
      http,
      token: input.githubToken,
      login,
      invocationId,
      stateRoot: input.stateRoot,
      sourcePath,
      scratch,
      reviewCheckout,
      reviewClientHome,
      reviewTmpDir,
      reviewDenoDir,
      trustedPath: input.trustedPath,
      codexExecutable: input.codexExecutable,
      tracker,
      selfMergeEnabled:
        appliedConfig.repository.owner === "ubiquity-sentinel" &&
        appliedConfig.repository.name === "sentinel" &&
        appliedConfig.repository.installationId === 0,
    });
    const model = new LocalCheckoutModelPort({
      stateRoot: input.stateRoot,
      sourcePath,
      scratch,
      trustedPath: input.trustedPath,
      codexExecutable: input.codexExecutable,
      denoExecutable: input.denoExecutable,
      modelToken: input.modelToken,
      tracker,
      clock,
      modelId: input.modelId,
      localIteration: true,
      targetConfigs: [appliedConfig],
    });
    github.pushHead = () =>
      Promise.resolve(portError(
        "unavailable",
        "Owner local-only iteration: publication and reviews are paused",
      ));
    github.createPullRequest = () =>
      Promise.resolve(portError(
        "unavailable",
        "Owner local-only iteration: publication and reviews are paused",
      ));
    github.requestReview = () =>
      Promise.resolve(portError(
        "unavailable",
        "Owner local-only iteration: publication and reviews are paused",
      ));
    github.mergePullRequest = () =>
      Promise.resolve(portError(
        "unavailable",
        "Owner local-only iteration: publication and reviews are paused",
      ));
    const capabilities = unavailableTargetCapabilities();
    outcome = await runRepairEntrypoint({
      clock,
      state,
      configs: [appliedConfig],
      controllerSha: input.controllerSha,
      github: github,
      githubCooldown: gate,
      incidents: capabilities.incidents,
      replay: capabilities.replay,
      model,
      budget: new RollingStartBudget({
        clock,
        state,
        configs: [appliedConfig],
      }),
    }, {
      deadline: startedAt + RUN_DEADLINE_MS,
      stepLimit: STEP_LIMIT,
    });
  } catch (error) {
    failure = error;
  } finally {
    settled = await tracker.settleAll();
    if (settled) {
      try {
        if (markerWritten) {
          try {
            await Deno.remove(markerPath);
          } catch {
            failure ??= new Error(STATIC_MARKER);
          }
        }
        if (state !== null && outcome !== null && config !== null) {
          // Status is persisted while this run still owns the runner lock so
          // a successor can never be overwritten by a prior runner's write.
          try {
            await writeLocalStatus({
              state,
              statusPath,
              invocationId,
              controllerSha: input.controllerSha,
              targetBaseSha,
              login,
              config,
              modelId: input.modelId,
              startedAt,
              finishedAt: clock.now(),
              outcome,
            });
          } catch (error) {
            failure ??= error;
          }
        }
      } finally {
        lock.close();
      }
    }
  }

  if (!settled) throw new LocalHostSettlementError();
  if (failure !== null) throw failure;
  if (outcome === null) throw new Error(STATIC_INVALID_OPTIONS);
  return { status: "ran", outcome, statusPath };
}

/**
 * Production direct startup. Reads exactly HOME, PATH, GITHUB_TOKEN,
 * UOS_AI_TOKEN and SENTINEL_REVIEW_MODEL_ID; the source directory comes from
 * this module URL and the controller SHA from trusted `git rev-parse HEAD`.
 */
export async function startLocalRepairHostFromEnv(): Promise<
  LocalRepairHostRunV1
> {
  const home = requireEnv("HOME");
  const trustedPath = requireEnv("PATH");
  const githubToken = requireEnv("GITHUB_TOKEN");
  const modelToken = requireEnv("UOS_AI_TOKEN");
  const sourceDir = decodeURIComponent(
    new URL("../../", import.meta.url).pathname,
  );
  const stateRoot = joinPath(home, ".local", "state", "sentinel-local");
  await ensurePrivateDir(stateRoot);
  const scratch = joinPath(stateRoot, "state-scratch");
  await ensurePrivateDir(scratch);
  const controllerSha = await readControllerSha(
    sourceDir,
    trustedPath,
    scratch,
  );
  return await runLocalRepairHost({
    stateRoot,
    sourceDir,
    controllerSha,
    githubToken,
    modelToken,
    codexExecutable: joinPath(home, ".codex", "bin", "codex"),
    denoExecutable: Deno.execPath(),
    trustedPath,
    // Named read only: an unrestricted `Deno.env.toObject()` is denied under
    // the launcher's `--allow-env` allowlist (issue89 regression).
  });
}
