/** Hosted actions-target-cycles responsibility. */
import type { GitSha } from "../contracts/brands.ts";
import { HOSTED_CONTROLLER_REMOTE } from "../contracts/hosted-controller-deployment.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
  ImplementationPort,
  IncidentAdapter,
  RepairStateWriter,
  ReplayPort,
  StateReadView,
} from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import type { BudgetControllerV1 } from "../budget/mod.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
} from "../contracts/hosted-supervisor.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import type { MatrixRunIdentityV1 } from "../contracts/matrix.ts";
import type { MatrixArtifactTransportV1 } from "./matrix-artifact-port.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import { runRepairEntrypoint } from "../main.ts";
import { OPERATION_MARGIN_MS } from "../repair/loop-bounds.ts";
import type { ActionsCiApprovalSummaryV1 } from "./actions-ci.ts";
import type { TargetSlugV1 } from "./targets.ts";
import type { ModelRouteV1 } from "./model-route.ts";
import type { CiEvidenceReaderV1 } from "../repair/ci-evidence-types.ts";

export const REMOTE_URL = HOSTED_CONTROLLER_REMOTE;

/**
 * Public base URL of the primary gateway route. The trusted route resolver
 * (`src/host/model-route.ts`) owns route selection; this constant only names
 * the primary endpoint for callers that refer to it.
 */
export const ACTIONS_UOS_BASE_URL = "https://ai.ubq.fi/v1";

// Leave the workflow's final ten minutes for bounded drain and runner exit.
const RUN_DEADLINE_MS = 110 * 60 * 1000;

// Progress/no-progress tracking and the absolute deadline bound the host pass.
export const STEP_LIMIT = Number.POSITIVE_INFINITY;

export const ACTIONS_LOGIN = "github-actions[bot]";

export const APP_LOGIN = "ubiquity-sentinel[bot]";

export const STATIC_ENV =
  "hosted repair host requires its configured credentials";

export const STATIC_CONTROLLER =
  "hosted repair host could not read an exact controller commit";

export const STATIC_EXECUTABLE = "hosted repair host could not resolve Codex";

export const STATIC_RUNNER = "hosted repair host sessions did not settle";

export const STATIC_PREFLIGHT =
  "hosted Codex startup unavailable; deterministic repair pass completed";

const STATIC_APP_INSTALLATION =
  "hosted repair host rejected: SENTINEL_APP_INSTALLATION_ID is not a positive safe integer";

export const STATIC_DEADLINE =
  "hosted repair host reached its run deadline before addressing any target";

export const STATIC_TARGET_UNKNOWN =
  "hosted repair host rejected: the requested repository is not a committed target";

export const STATIC_BASE_REFRESH =
  "hosted repair host rejected: the exact requested base could not be fetched into its target mirror";

/**
 * The App installation scope of `ubiquity-sentinel`. Every committed target
 * that is not the sentinel self-repository is addressed under this one scope
 * (`SENTINEL_APP_INSTALLATION_ID` overrides it); the sentinel self-target
 * keeps installation scope 0, the reserved no-App owner scope, exactly as the
 * trusted template defines it. This is a scope key, never a credential: the
 * App token itself still arrives through `SENTINEL_SUPERVISOR_TOKEN`.
 */
export const DEFAULT_APP_INSTALLATION_ID = 155_687_488;

/** The one allowlisted environment entry that may override that scope. */
export const APP_INSTALLATION_ENV = "SENTINEL_APP_INSTALLATION_ID";

/**
 * Read the App installation scope for non-sentinel targets. An absent value
 * keeps the one fixed default; anything that is not a positive safe integer
 * is refused instead of guessed.
 */
export function parseAppInstallationId(value: string | undefined): number {
  if (value === undefined) return DEFAULT_APP_INSTALLATION_ID;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(STATIC_APP_INSTALLATION);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(STATIC_APP_INSTALLATION);
  }
  return parsed;
}

/**
 * Apply the per-target installation scope. The sentinel self-repository keeps
 * the reserved no-App owner scope from the trusted template; every other
 * committed target is addressed under the App installation scope that can
 * actually write to it. Nothing except the identity changes, so a slug can
 * still never introduce a command, limit or protection of its own.
 */
export function scopeTargetConfigV1(
  config: RepositoryConfigV1,
  selfRepository: RepositoryIdentityV1,
  appInstallationId: number,
  options: { issueOnly?: boolean } = {},
): RepositoryConfigV1 {
  const installationId = config.repository.owner === selfRepository.owner &&
      config.repository.name === selfRepository.name
    ? selfRepository.installationId
    : appInstallationId;
  const scoped = config.repository.installationId === installationId
    ? config
    : {
      ...config,
      repository: { ...config.repository, installationId },
    };
  // An issue-only repair host reads every target through the GitHub adapter.
  // Every Actions entrypoint (the ordinary and rollback repair children and
  // the matrix plan/cell host) is issue-only; the gateway adapter is kept only
  // for a host that supplies its own gateway runtime (`src/host/repair.ts`).
  return options.issueOnly === true && scoped.adapter.kind === "gateway"
    ? { ...scoped, adapter: { kind: "github" } }
    : scoped;
}

/**
 * The one advisory multi-target diagnostic line. It reports the targets that
 * were addressed and the ones that were skipped (an unavailable default
 * branch, or the absolute run deadline). It carries no `status` property, so
 * the launcher's child-status scan can never read it as a child result.
 */
export function targetsDiagnosticV1(input: {
  readonly addressed: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly string[];
}): Record<string, unknown> {
  return {
    version: "v1",
    kind: "sentinel_targets_diagnostic",
    addressed: [...input.addressed],
    skipped: [...input.skipped],
    failed: [...input.failed],
  };
}

export interface ActionsRepairHostResultV1 {
  status: "ran";
  outcome: RepairCycleOutcomeV1;
  controllerSha: GitSha;
  baseSha: string;
  login: string;
  /** False when the model startup diagnostic failed for this run. */
  startupReady: boolean;
  /** Bounded deterministic CI approval counts for this run. */
  ciApproval: ActionsCiApprovalSummaryV1;
  /** The exact saved supervisor execution this run settles. */
  execution: HostedExecutionIntentV1;
}

/** The exact capability set one multi-target host pass runs on. */
export interface ActionsTargetCyclesInputV1 {
  clock: Clock;
  state: StateReadView & RepairStateWriter;
  /** Every committed, usable target configuration, in setting order. */
  configs: readonly RepositoryConfigV1[];
  controllerSha: GitSha;
  /** THE one durable gate shared by every cycle and every composed port. */
  githubCooldown: GitHubCooldownGateV1;
  incidents: IncidentAdapter;
  replay: ReplayPort;
  /** Private target-bound pair, resolved only after its own preparation. */
  resolveTargetCapabilities?: (config: RepositoryConfigV1) => {
    incidents: IncidentAdapter;
    replay: ReplayPort;
  };
  /** THE one model port shared by every cycle. */
  model: ImplementationPort;
  /** THE one admission controller, constructed over every target config. */
  budget: BudgetControllerV1;
  /** ONE absolute run deadline shared by every cycle; never restarted. */
  deadline: number;
  /**
   * Trusted origin of THIS child invocation, captured before any identity,
   * credential, state, source or target preparation. A matrix cell anchors its
   * own bounded start window here, so a long planner run or a queued runner
   * cannot spend the cell's window before its runner starts. Ordinary serial
   * and aggregate callers keep their existing entrypoint anchor.
   */
  runOrigin?: number;
  stepLimit: number;
  modelStartsEnabled: boolean;
  externalImplementations?: boolean;
  /**
   * The one-time legacy review class's cutoff the launcher handed this run
   * (`SENTINEL_LEGACY_REVIEW_CUTOFF`, `review-round-cap.ts`); absent or null
   * means no record is legacy.
   */
  legacyReviewCutoff?: number | null;
  /** Exact trusted runtime assembly supplied to the matrix executable seam. */
  host?: {
    execution: HostedExecutionIntentV1;
    run: MatrixRunIdentityV1;
    artifactRoot: string;
    sourcePathFor: (config: RepositoryConfigV1) => string;
    expectedProvider: string;
    /**
     * The trusted route's HTTP 429 failover model id (the same value the
     * implementation port fails over to); a matrix receipt naming it verifies
     * against its planned primary request. Omitted: the planned model only.
     */
    failoverModel?: string;
    matrixCarrier?: import("./matrix-actions-shared.ts").MatrixNativeCarrierV1;
    createArtifactTransport: (
      producerState?: StateReadView,
    ) => Promise<MatrixArtifactTransportV1>;
    readExecution?: (
      execution: HostedExecutionIntentV1,
    ) => Promise<PortResultV1<HostedExecutionSettlementV1 | null>>;
  };
  /**
   * Prepare one target's own private state before its port is composed: its
   * source mirror and that mirror's base fetch. A target whose preparation
   * fails is recorded and skipped instead of stopping every other target,
   * because a foreign remote is a failure mode the self-target must not
   * inherit. Omitted callers need no preparation.
   */
  prepareTarget?: (config: RepositoryConfigV1) => Promise<void>;
  /** Compose the exact port for one target repository. */
  composeGithub: (config: RepositoryConfigV1) => GitHubPort;
  /**
   * One bounded pre-merge CI dispatch before a target's cycle, for a target
   * whose CI runs on a Sentinel pull request only when asked. It requests
   * evidence and never writes state; a failure is reported, never fatal.
   */
  premergeCi?: (config: RepositoryConfigV1) => Promise<unknown>;
  /**
   * Plain-language progress comments (#183): the target's work records before
   * and after its cycle, posted by the trusted host. Never fatal, never a
   * state write; omitted in matrix cells.
   */
  progressComments?: (
    config: RepositoryConfigV1,
    before: readonly WorkRecordV1[],
    after: readonly WorkRecordV1[],
  ) => Promise<unknown>;
  /**
   * A matrix cell's read-only CI failure evidence reader for one target,
   * on the cell's scoped read token (generation 81). Absent elsewhere.
   */
  composeCiEvidence?: (config: RepositoryConfigV1) => CiEvidenceReaderV1;
  /** The production entrypoint; injectable for deterministic tests only. */
  runCycle?: typeof runRepairEntrypoint;
  /** One bounded advisory report of the targets addressed and skipped. */
  report?: (result: ActionsTargetCyclesResultV1) => void;
}

/** The per-target outcome of one host pass. */
export interface ActionsTargetCyclesResultV1 {
  /** The LAST addressed cycle's outcome, or null when none was addressed. */
  readonly outcome: RepairCycleOutcomeV1 | null;
  /** `owner/name` of every target whose cycle was started, in setting order. */
  readonly addressed: readonly string[];
  /** `owner/name` of every target not attempted because time ran out. */
  readonly skipped: readonly string[];
  /**
   * `owner/name: reason` of every target whose own preparation failed. It is
   * disjoint from `addressed` and `skipped` and is never a success claim.
   */
  readonly failed: readonly string[];
}

/** The repair state's work records, or null when they cannot be read. */
async function workSnapshot(
  state: StateReadView,
): Promise<readonly WorkRecordV1[] | null> {
  try {
    const read = await state.readRepair();
    return read.ok && read.value.status === "found"
      ? read.value.snapshot.work
      : null;
  } catch {
    return null;
  }
}

/**
 * Run ONE separately targeted repair cycle per committed target repository,
 * sequentially, over the shared state store, cooldown gate, admission budget,
 * model port and absolute run deadline.
 *
 * The injected GitHub port targets one repository. The frozen
 * `GitHubIssueV1` carries no repository field, so each cycle associates its
 * rows with its SOLE configuration instead of guessing: the host injects a
 * separately targeted cycle rather than one port for several repositories.
 * The absolute deadline is re-checked before every cycle and never restarted;
 * once it has passed, the remaining targets are reported as skipped and no
 * further port, cycle or model start is composed.
 */
export async function runActionsTargetCycles(
  input: ActionsTargetCyclesInputV1,
): Promise<ActionsTargetCyclesResultV1> {
  const runCycle = input.runCycle ?? runRepairEntrypoint;
  const addressed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let outcome: RepairCycleOutcomeV1 | null = null;
  /** Report every target not attempted because the absolute deadline ran out. */
  const skipFrom = (index: number): void => {
    for (const remaining of input.configs.slice(index)) {
      skipped.push(
        `${remaining.repository.owner}/${remaining.repository.name}`,
      );
    }
  };
  try {
    for (const [index, config] of input.configs.entries()) {
      if (!(input.clock.now() < input.deadline)) {
        // The deadline is absolute and the clock only moves forward: every
        // remaining target is reported as not attempted, and none is started.
        skipFrom(index);
        break;
      }
      const slug = `${config.repository.owner}/${config.repository.name}`;
      if (input.prepareTarget !== undefined) {
        // An earlier cycle's mandatory review drain may run up to the
        // deadline. A later target's preparation (an authenticated clone or
        // fetch, each bounded only by its own Git timeout) is not begun
        // inside the final operation margin, the same margin in which every
        // cycle stops planning GitHub work, so it never runs into the end of
        // the run's App-token window. The first addressed target keeps the
        // existing rule, so a pass still reports an outcome exactly as before.
        if (
          addressed.length > 0 &&
          input.deadline - input.clock.now() < OPERATION_MARGIN_MS
        ) {
          skipFrom(index);
          break;
        }
        try {
          await input.prepareTarget(config);
        } catch (error) {
          // This target's own private state could not be prepared. Record the
          // exact reason and leave every other target untouched: a target that
          // cannot be prepared was never addressed, so it is not reported as
          // one.
          const reason = error instanceof Error
            ? error.message
            : "target preparation failed";
          failed.push(`${slug}: ${reason}`);
          continue;
        }
        // A target's own preparation (its source mirror seed and that mirror's
        // base refresh) is setup time charged against the SAME absolute
        // deadline. A preparation that reached the deadline leaves no bounded
        // work to start, so neither this target nor any remaining target is
        // attempted instead of spending the run's remaining budget on a doomed
        // cycle.
        if (!(input.clock.now() < input.deadline)) {
          skipFrom(index);
          break;
        }
      }
      addressed.push(slug);
      if (input.premergeCi !== undefined) {
        try {
          await input.premergeCi(config);
        } catch (error) {
          console.log(JSON.stringify({
            kind: "sentinel_premerge_ci",
            repository: slug,
            decision: "failed",
            detail: error instanceof Error
              ? error.message
              : "pre-merge CI dispatch failed",
          }));
        }
      }
      const capabilities = input.resolveTargetCapabilities?.(config) ?? input;
      const before = input.progressComments === undefined
        ? null
        : await workSnapshot(input.state);
      outcome = await runCycle({
        clock: input.clock,
        state: input.state,
        configs: [config],
        controllerSha: input.controllerSha,
        github: input.composeGithub(config),
        githubCooldown: input.githubCooldown,
        incidents: capabilities.incidents,
        replay: capabilities.replay,
        model: input.model,
        budget: input.budget,
        externalImplementations: input.externalImplementations,
        legacyReviewCutoff: input.legacyReviewCutoff ?? null,
      }, {
        deadline: input.deadline,
        stepLimit: input.stepLimit,
        modelStartsEnabled: input.modelStartsEnabled,
      });
      if (input.progressComments !== undefined && before !== null) {
        try {
          const after = await workSnapshot(input.state);
          if (after !== null) {
            await input.progressComments(config, before, after);
          }
        } catch (error) {
          console.log(JSON.stringify({
            kind: "sentinel_progress_comments",
            repository: slug,
            failed: true,
            detail: error instanceof Error
              ? error.message
              : "progress comments failed",
          }));
        }
      }
    }
  } finally {
    // The advisory report is emitted even when a cycle threw, so the targets
    // actually addressed are never silently lost.
    input.report?.({
      outcome,
      addressed: [...addressed],
      skipped: [...skipped],
      failed: [...failed],
    });
  }
  return { outcome, addressed, skipped, failed };
}

/**
 * The ONE absolute deadline for one child run: the earliest origin this child
 * can observe for itself plus the unchanged 110-minute budget, never later than
 * the instant before which the run's one App token is certainly valid when the
 * trusted launcher forwarded it (`hosted-app-token-window.ts`): GitHub work
 * planned past that instant could only fail authentication, so it waits for the
 * next run's fresh token instead. It is the only place that arithmetic exists,
 * so no cycle can ever receive a deadline anchored anywhere else.
 */
export function childRunDeadlineV1(
  runOrigin: number,
  appTokenNotAfter?: number,
): number {
  const budget = runOrigin + RUN_DEADLINE_MS;
  return appTokenNotAfter === undefined
    ? budget
    : Math.min(budget, appTokenNotAfter);
}

/**
 * Optional deterministic wiring for one hosted pass. Every field defaults to
 * the exact production behavior, so the production entrypoint, the launcher and
 * the workflow call `runActionsRepairHost()` with no arguments and unchanged
 * semantics. A field exists only where a deterministic test must replace an
 * external boundary (clock, environment, state remote, remote fetch, GitHub
 * default-branch read, Codex startup probe) or observe the production
 * multi-target call itself.
 */
export interface ActionsRepairHostDepsV1 {
  /** Raw private publisher stdin; decoded only after the saved native execution matches. */
  trustedStdin?: string;
  /** Ordinary hosted repair reads GitHub issues only; gateway adapters are scoped to GitHub. */
  issueOnly?: boolean;
  /** Approved private persistence/cache/replay policy; absence keeps capture unavailable. */
  gateway?: import("./gateway-capabilities.ts").TrustedGatewayRuntimeV1;
  /** Native job role selected by the fixed matrix executable, never a product flag. */
  job?: "matrix_plan" | "matrix_cell";
  /** Fake external ports/transports for the actual hosted composition checks. */
  http?: HttpTransportV1;
  /** Fake external artifact HTTP boundary; production uses its bounded binary factory. */
  artifactHttp?: HttpTransportV1;
  /** Deterministic state transport injection; production always uses the Git store. */
  state?: StateReadView & RepairStateWriter;
  /** Trusted fixture source pins only; production uses reviewed source JSON. */
  hostedAppSourceProfiles?: unknown;
  model?: ImplementationPort;
  composeGithub?: (
    config: RepositoryConfigV1,
    production: GitHubPort,
  ) => GitHubPort;
  prepareTarget?: (
    config: RepositoryConfigV1,
    sourcePath: string,
  ) => Promise<void>;
  /** The run clock; defaults to the system clock. */
  clock?: Clock;
  /** The run environment (identity, credentials, PATH, route); defaults to the process environment. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The run's own checkout directory; defaults to the process working directory. */
  workDir?: string;
  /** Release/repair state remote; defaults to the committed production remote. */
  stateRemoteUrl?: string;
  /** Refresh the sentinel self mirror and return its base SHA; defaults to the production fetch. */
  refreshSelf?: (sourcePath: string) => Promise<string>;
  /** Resolve one target's default branch; defaults to the trusted GitHub read. */
  resolveDefaultBranch?: (
    target: TargetSlugV1,
  ) => Promise<string | null>;
  /** Prove model startup; defaults to the production Codex diagnostic. */
  preflight?: (route: ModelRouteV1) => Promise<void>;
  /** The production multi-target loop; overridable so a test can observe its exact input. */
  runTargetCycles?: typeof runActionsTargetCycles;
}
