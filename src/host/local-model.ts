import { type GitSha, isGitSha } from "../contracts/brands.ts";
import {
  type Clock,
  type ImplementationPort,
  type ModelRunReceiptV1,
  type ModelRunRequestV1,
  portError,
  type PortResultV1,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { ModelRunOptionsV1 } from "../contracts/ports-model.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { ModelRouteV1 } from "./model-route.ts";
import { CodexSubprocessSession } from "../repair/codex-transport.ts";
import {
  type CandidateCommitterV1,
  CodexImplementationPort,
  LocalCandidateCommitter,
} from "../repair/model-port.ts";
import {
  DEFAULT_IMPLEMENTATION_MODEL,
  DEFAULT_PROVIDER_NAME,
  SESSION_DEADLINE_MS,
  STATIC_CHECKOUT,
  STATIC_IMPORT,
  STATIC_MODEL_INPUT,
  STATIC_MODEL_RESULT,
  STATIC_RECEIPT_DIAGNOSTIC,
} from "./local-policy.ts";
import {
  ensureTaskCheckout,
  importCandidate,
  localCheckoutKey,
  prepareMergeCheckout,
} from "./local-checkout.ts";
import {
  LocalMergeCommitter,
  LocalMergeResolver,
  type PlannedMergeV1,
} from "../repair/model-port-checkout.ts";
import { writeLocalModelResult } from "./local-model-result.ts";
import { commitObjectPresent } from "./local-git.ts";
import {
  codexChildEnv,
  ensureTaskClient,
  type LocalSessionTracker,
} from "./local-client.ts";
import { joinPath } from "./local-io.ts";
import {
  isSentinelSelfTarget,
  type PrepareCheckoutDependenciesV1,
} from "./self-dependency-preparation.ts";
import type { PreparePassportDependenciesV1 } from "./passport-dependencies.ts";
import { isPassportTarget } from "./target-policy.ts";

// ---------------------------------------------------------------------------
// Implementation port: one persistent isolated checkout per task
// ---------------------------------------------------------------------------

export interface LocalModelInputV1 {
  stateRoot: string;
  sourcePath: string;
  scratch: string;
  trustedPath: string;
  codexExecutable: string;
  denoExecutable: string;
  modelToken: string;
  tracker: LocalSessionTracker;
  clock: Clock;
  /**
   * Trusted route selection for the implementation client: the endpoint, the
   * route model id and the provider name are taken from it. Omitted callers
   * keep the frozen gateway defaults (`uos` over the loopback endpoint with
   * `gpt-reserve`).
   */
  route?: ModelRouteV1;
  /**
   * Route-selected implementation model id this port submits and records.
   * Defaults to the route's model and then to the frozen gateway model
   * (`gpt-reserve`) for callers that pass neither; the id is never rewritten.
   */
  modelId?: string;
  /**
   * Gateway failover model id for HTTP 429 retries. Defaults to the route's
   * failover model; an invalid value disables the failover.
   */
  failoverModelId?: string;
  /** Provider endpoint used by the isolated implementation client. */
  modelBaseUrl?: string;
  /** Provider name used by the isolated implementation client config. */
  providerName?: string;
  /** Explicit owner-local pause; hosted Actions must leave this false. */
  localIteration?: boolean;
  /**
   * Hosted capability that restores an exact durable candidate before a fresh
   * correction checkout is created. Local callers omit it because their
   * persistent source object repository already imports candidates.
   */
  ensureCandidateObjects?: (
    input: {
      base: GitSha;
      head: GitSha;
      /**
       * Exact repository the objects belong to. A multi-target host owns one
       * source mirror and one authenticated remote per target, and the objects
       * of a foreign target exist only in that target's mirror and remote.
       */
      repository: RepositoryIdentityV1;
    },
  ) => Promise<PortResultV1<void>>;
  /**
   * Exact private source object repository for one requested repository.
   * A multi-target host owns one mirror per target, so a task's checkout and
   * candidate import must use ITS target's mirror; a mirror seeded from
   * another repository cannot resolve that target's base commit at all.
   * Omitted callers keep the single `sourcePath` mirror.
   */
  resolveSourcePath?: (repository: RepositoryIdentityV1) => string;
  /**
   * Trusted on-demand base fetch for one requested target. A run fetches its
   * mirrors when a target cycle starts, and the target branch can move while
   * that same cycle is still running: a record created after the move is
   * pinned to the newer base, and a mirror fetched before it can never check
   * that base out. The host ensures the EXACT requested base object through
   * its own bounded, gated git fetch; the model session itself never fetches.
   * Omitted callers keep the fail-closed behavior (a missing base refuses the
   * start instead of being repaired).
   */
  ensureBaseObject?: (
    input: { repository: RepositoryIdentityV1; base: GitSha },
  ) => Promise<PortResultV1<void>>;
  /** Trusted, source-bound offline self dependencies; never executes target code. */
  prepareCheckoutDependencies?: PrepareCheckoutDependenciesV1;
  /** Trusted exact-base frozen Passport preparation, before any client starts. */
  preparePassportDependencies?: PreparePassportDependenciesV1;
  /**
   * The run's trusted target configs. The prompt names the configured
   * protected path prefixes of the REQUESTED repository's config; a request
   * for an unconfigured repository names none (the candidate's own
   * protected-path check is unchanged either way).
   */
  targetConfigs?: readonly Pick<
    RepositoryConfigV1,
    "repository" | "protectedPaths"
  >[];
}

/** The configured protected prefixes of exactly `repository`, or none. */
export function protectedPathsFor(
  configs: LocalModelInputV1["targetConfigs"],
  repository: RepositoryIdentityV1,
): readonly string[] {
  return configs?.find((config) =>
    config.repository.owner === repository.owner &&
    config.repository.name === repository.name
  )?.protectedPaths ?? [];
}

/**
 * Model port wrapper over the existing CodexImplementationPort. It owns one
 * persistent private checkout per task (never reset or recloned), commits
 * model edits atop the saved candidate, persists a private minimal result
 * receipt, and imports the exact candidate head into the trusted source
 * object repository before returning.
 */
export class LocalCheckoutModelPort implements ImplementationPort {
  /**
   * Exact route-selected implementation model id this port submits and
   * records: the explicit `modelId`, else the route's model, else the frozen
   * gateway default. It is never rewritten after construction.
   */
  readonly modelId: string;
  /** Exact route provider name the app-server session and config both name. */
  private readonly providerName: string;
  /** Gateway failover model id for HTTP 429 retries; "" disables. */
  private readonly failoverModelId: string;

  constructor(private readonly input: LocalModelInputV1) {
    this.modelId = input.modelId ?? input.route?.model ??
      DEFAULT_IMPLEMENTATION_MODEL;
    this.providerName = input.providerName ?? input.route?.provider ??
      DEFAULT_PROVIDER_NAME;
    this.failoverModelId = input.failoverModelId ??
      input.route?.failoverModel ?? "";
  }

  async runModel(
    request: ModelRunRequestV1,
    options?: ModelRunOptionsV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    // The caller's model start boundary: checkout preparation below is
    // charged to the same session budget a gateway 429 backoff may use.
    const sessionStartedAt = this.input.clock.now();
    if (
      request === null || typeof request !== "object" || !isGitSha(request.base)
    ) {
      return portError("unavailable", STATIC_MODEL_INPUT);
    }
    if (
      request.checkoutBase !== undefined &&
      !isGitSha(request.checkoutBase)
    ) {
      return portError("unavailable", STATIC_MODEL_INPUT);
    }
    const checkoutBase = request.checkoutBase ?? request.base;
    if (!isGitSha(checkoutBase)) {
      return portError("unavailable", STATIC_MODEL_INPUT);
    }
    // A conflict resolution merges a distinct new base into the published
    // candidate it continues; any other shape is not a valid merge request.
    const mergeBase = request.mergeBase;
    if (
      mergeBase !== undefined &&
      (!isGitSha(mergeBase) || request.checkoutBase === undefined ||
        mergeBase === request.base || mergeBase === checkoutBase)
    ) {
      return portError("unavailable", STATIC_MODEL_INPUT);
    }
    // A valid request whose exact checkout cannot be prepared exits through the
    // SAME finalized-result path as a completed run: the failure is persisted
    // privately and its static reason code is emitted. No candidate exists, so
    // the finalizer never imports, and a failed persistence still fails closed.
    const failCheckout = () =>
      finalizeLocalModelResult({
        stateRoot: this.input.stateRoot,
        request,
        result: portError("unavailable", STATIC_CHECKOUT),
        observedAt: this.input.clock.now(),
        importCandidate: () => Promise.resolve(false),
      });
    if (
      checkoutBase !== request.base &&
      this.input.ensureCandidateObjects !== undefined
    ) {
      let restored: PortResultV1<void>;
      try {
        restored = await this.input.ensureCandidateObjects({
          base: request.base,
          head: checkoutBase,
          repository: request.repository,
        });
      } catch {
        return await failCheckout();
      }
      if (!restored.ok) return await failCheckout();
    }
    const key = await localCheckoutKey(request.taskId);
    // This request's OWN target mirror: the base commit of a foreign target
    // does not exist in the sentinel mirror.
    const sourcePath = this.input.resolveSourcePath?.(request.repository) ??
      this.input.sourcePath;
    // The exact base object must exist in that mirror BEFORE a checkout is
    // prepared. Requiring it here is what turns a mirror that was fetched
    // before the branch moved into a bounded, gated catch-up instead of an
    // unexplained checkout refusal for every record pinned to the newer base.
    // A conflict resolution needs the base it merges in the same way.
    const objectReady = async (sha: GitSha): Promise<boolean> => {
      const present = () =>
        commitObjectPresent({
          sourcePath,
          sha,
          scratch: this.input.scratch,
          trustedPath: this.input.trustedPath,
        });
      if (await present()) return true;
      if (this.input.ensureBaseObject === undefined) return false;
      let ensured: PortResultV1<void>;
      try {
        ensured = await this.input.ensureBaseObject({
          repository: request.repository,
          base: sha,
        });
      } catch {
        return false;
      }
      return ensured.ok && await present();
    };
    if (!await objectReady(checkoutBase)) return await failCheckout();
    if (mergeBase !== undefined && !await objectReady(mergeBase)) {
      return await failCheckout();
    }
    const prepared = await ensureTaskCheckout({
      taskId: request.taskId,
      base: checkoutBase,
      key,
      stateRoot: this.input.stateRoot,
      sourcePath,
      scratch: this.input.scratch,
      trustedPath: this.input.trustedPath,
    });
    if (!prepared.ok) return await failCheckout();
    // A conflict resolution starts from the exact published candidate with
    // the base merged in and its conflicts left in the tree; the trusted
    // merge committer and resolver below replace the ordinary pair.
    let planned: PlannedMergeV1 | null = null;
    if (mergeBase !== undefined) {
      if (prepared.commitBase !== checkoutBase) return await failCheckout();
      const merge = await prepareMergeCheckout({
        checkout: prepared.checkout,
        head: checkoutBase,
        mergeBase,
        sourcePath,
        stateRoot: this.input.stateRoot,
        scratch: this.input.scratch,
        trustedPath: this.input.trustedPath,
      });
      if (!merge.ok) return await failCheckout();
      planned = {
        head: checkoutBase,
        mergeBase,
        conflictedPaths: merge.conflictedPaths,
      };
    }

    if (
      isSentinelSelfTarget(request.repository) &&
      this.input.prepareCheckoutDependencies !== undefined
    ) {
      try {
        const dependencies = await this.input.prepareCheckoutDependencies({
          repository: request.repository,
          checkout: prepared.checkout,
        });
        if (!dependencies.ok) return await failCheckout();
      } catch {
        return await failCheckout();
      }
    }

    if (isPassportTarget(request.repository)) {
      try {
        const prepare = this.input.preparePassportDependencies;
        if (prepare === undefined) return await failCheckout();
        const dependencies = await prepare({
          repository: request.repository,
          checkout: prepared.checkout,
          sourcePath,
          base: mergeBase ?? request.base,
        });
        if (!dependencies.ok) return await failCheckout();
      } catch {
        return await failCheckout();
      }
    }

    const clientHome = joinPath(this.input.stateRoot, "clients", key);
    const tmpDir = joinPath(this.input.stateRoot, "tmp", key);
    const denoDir = joinPath(this.input.stateRoot, "deno", key);
    await ensureTaskClient({
      clientHome,
      tmpDir,
      denoDir,
      checkout: prepared.checkout,
      token: this.input.modelToken,
      codexExecutable: this.input.codexExecutable,
      denoExecutable: this.input.denoExecutable,
      trustedPath: this.input.trustedPath,
      route: this.input.route,
      baseUrl: this.input.modelBaseUrl ?? this.input.route?.baseUrl,
    });

    const commitBase = prepared.commitBase;
    const localCommitter: CandidateCommitterV1 = planned === null
      ? new LocalCandidateCommitter(prepared.checkout)
      : new LocalMergeCommitter(prepared.checkout, planned);
    const committer: CandidateCommitterV1 = {
      // Later review corrections commit uncommitted edits atop the saved
      // candidate; the default resolver still binds request.base. A merge
      // commits onto exactly the planned candidate.
      commit: () => localCommitter.commit(commitBase),
      get refusalCode() {
        return localCommitter.refusalCode;
      },
    };
    const port = new CodexImplementationPort({
      openSession: () =>
        Promise.resolve(
          this.input.tracker.open(() =>
            new CodexSubprocessSession({
              command: [this.input.codexExecutable, "app-server"],
              cwd: prepared.checkout,
              env: codexChildEnv(
                clientHome,
                tmpDir,
                denoDir,
                this.input.trustedPath,
              ),
              operationDeadlineMs: SESSION_DEADLINE_MS,
            })
          ),
        ),
      checkoutDir: prepared.checkout,
      localIteration: this.input.localIteration === true,
      modelProvider: this.providerName,
      modelId: this.modelId,
      failoverModelId: this.failoverModelId,
      clock: this.input.clock,
      sessionStartedAt,
      permissionProfile: "sentinel-local",
      commitCandidate: committer,
      protectedPaths: protectedPathsFor(
        this.input.targetConfigs,
        request.repository,
      ),
      ...(planned === null
        ? {}
        : { checkout: new LocalMergeResolver(prepared.checkout, planned) }),
    });

    // The durable request keeps the reviewed development base for state
    // evidence, while the implementation port receives the exact rejected
    // head so its committer and resolver continue that candidate's history.
    const modelRequest = checkoutBase === request.base
      ? request
      : { ...request, base: checkoutBase };
    // CI failure evidence (a CI correction cell) passes through unchanged; it
    // reaches only the user turn's prompt, never the persisted request or
    // receipt.
    const result = await port.runModel(modelRequest, options);
    return await finalizeLocalModelResult({
      stateRoot: this.input.stateRoot,
      request,
      result,
      observedAt: this.input.clock.now(),
      importCandidate: (head) =>
        importCandidate({
          sourcePath,
          checkout: prepared.checkout,
          head,
          key,
          scratch: this.input.scratch,
          trustedPath: this.input.trustedPath,
        }),
    });
  }
}

/**
 * Post-run trusted bookkeeping for exactly one local model invocation.
 *
 * The private minimal diagnostic is still persisted BEFORE any candidate
 * import, and a non-completed port error keeps its original conservative
 * behavior (an unsaved diagnostic or a failed import stays `unavailable`).
 *
 * A TRUSTED COMPLETED receipt is different: its execution/accounting meaning
 * is preserved unchanged when either the diagnostic write or the best-effort
 * local import fails. The diagnostic failure is reported as one static line
 * and the original receipt (including its exact candidate head and actual
 * runtime fields) is returned unchanged; no durability claim is made and
 * nothing is published here. The persistent checkout is never touched.
 */
export async function finalizeLocalModelResult(input: {
  stateRoot: string;
  request: ModelRunRequestV1;
  result: PortResultV1<ModelRunReceiptV1>;
  observedAt: number;
  /** Exact-head import into the trusted source mirror; best effort. */
  importCandidate: (head: GitSha) => Promise<boolean>;
}): Promise<PortResultV1<ModelRunReceiptV1>> {
  const completedHead: GitSha | null = input.result.ok
    ? input.result.value.candidate?.head ?? null
    : null;
  const completed = completedHead !== null && input.result.ok &&
    input.result.value.outcome === "completed";
  let diagnosticSaved = false;
  try {
    await writeLocalModelResult(
      input.stateRoot,
      input.request,
      input.result,
      input.observedAt,
    );
    diagnosticSaved = true;
  } catch {
    if (!completed) return portError("unavailable", STATIC_MODEL_RESULT);
    // Static sanitized line only: no task content, candidate identity or raw
    // error is ever logged, and the receipt below keeps its full meaning.
    console.log(STATIC_RECEIPT_DIAGNOSTIC);
  }
  if (!input.result.ok) return input.result;
  if (completedHead !== null && diagnosticSaved) {
    let imported = false;
    try {
      imported = await input.importCandidate(completedHead);
    } catch {
      imported = false;
    }
    // A trusted completed run never turns a failed best-effort import into
    // model-unavailable accounting; durability remains a separate obligation.
    if (!imported && !completed) {
      return portError("unavailable", STATIC_IMPORT);
    }
  }
  return input.result;
}
