/** Hosted hosted-runtime-identity responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import { HOSTED_CONTROLLER_REMOTE } from "../contracts/hosted-controller-deployment.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { HostedRuntimeTerminalV1 } from "../contracts/hosted-execution.ts";
import {
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { ReviewOwnerCustodyBroker } from "./review-owner-custody.ts";
import type { HostedReviewOwnerSettlementV1 } from "../github/review-owner-evidence.ts";
import type {
  Clock,
  PortErrorKindV1,
  StateReadView,
} from "../contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type {
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../replay/runtime.ts";
import { joinPath } from "./local.ts";
import type { LocalModelDiagnosticV1 } from "./local.ts";
import type { ModelBoundaryErrorCodeV1 } from "../repair/model-port-diagnostics.ts";
import type { StepLineV1 } from "../repair/step-line.ts";
import type { HostedMatrixPlanDiagnosticV1 } from "./matrix-plan-diagnostic.ts";

/** Exact fixed workflow ref the protected supervisor runs from. */
export const HOSTED_RUNTIME_WORKFLOW_REF =
  `${HOSTED_SUPERVISOR_REPOSITORY}/${HOSTED_SUPERVISOR_WORKFLOW_PATH}@${HOSTED_SUPERVISOR_REF}`;

/** Fixed child entrypoint inside the verified runtime checkout. */
export const HOSTED_RUNTIME_CHILD_ENTRYPOINT = "src/host/actions.ts";

/**
 * 112 minutes, inside the workflow's 120-minute bound. This is the launcher's
 * own bounded wait over the child process, measured from the instant it spawns
 * that process. It is deliberately two minutes longer than the child's own
 * 110-minute budget (`RUN_DEADLINE_MS` in `src/host/actions.ts`), which the
 * child anchors at the earliest instant it can observe for ITSELF, before its
 * own setup. That origin is later than the launcher's by the child startup and
 * module load already spent, so the real drain cushion before this bound is two
 * minutes minus that unmeasured startup: setup inside the child is charged to
 * the child's own budget, never to this cushion.
 */
export const HOSTED_RUNTIME_DEADLINE_MS = 112 * 60 * 1000;

/** Combined retained child stdout+stderr bound (4 MiB). */
export const HOSTED_RUNTIME_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Child environment allow-list: the only keys that may cross into the child.
 * `GITHUB_TOKEN` and `UOS_AI_TOKEN` stay required; the App token
 * (`SENTINEL_SUPERVISOR_TOKEN`) is allowed but never required, because a
 * runtime revision older than the App migration has no such credential.
 */
export const HOSTED_RUNTIME_CHILD_ENV_KEYS = [
  "HOME",
  "PATH",
  "GITHUB_TOKEN",
  "SENTINEL_SUPERVISOR_TOKEN",
  "SENTINEL_SELF_TOKEN",
  "SENTINEL_SELF_TOKEN_MINT_GRANT",
  // Repair only, beside the App token: the instant before which that one
  // token is certainly valid (`hosted-app-token-window.ts`).
  "SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER",
  "SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT",
  "SENTINEL_TARGET_INSTALLATION_ID",
  "SENTINEL_SELF_INSTALLATION_ID",
  "SENTINEL_MODEL_BASE_URL",
  "SENTINEL_MODEL_ID",
  "SENTINEL_MODEL_FALLBACK",
  "SENTINEL_REVIEW_MODEL_ID",
  "SENTINEL_DEEPSEEK_API_KEY",
  "SENTINEL_APP_INSTALLATION_ID",
  // Explicit development switch for the durable GitHub cooldown gates; it
  // crosses only when the launcher was given a non-empty value.
  "SENTINEL_COOLDOWN_MODE",
  "SENTINEL_MERGE_QUEUE",
  // Backup CI's lower-only mode (docs/backup-ci-spec.md §11.8).
  "SENTINEL_BACKUP_CI",
  // The legacy review class's cutoff (`legacy-review-cutoff-env.ts`): set by
  // the launcher itself, only for the exact revision it pinned it for.
  "SENTINEL_LEGACY_REVIEW_CUTOFF",
  "UOS_AI_TOKEN",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_JOB",
  "TMPDIR",
  "TEMP",
  "TMP",
  "DENO_DIR",
] as const;

export const HOSTED_RUNTIME_STATIC_IDENTITY =
  "hosted runtime environment identity is invalid";

export const HOSTED_RUNTIME_STATIC_SOURCE =
  "hosted runtime source checkout is not the exact clean revision";

export const HOSTED_RUNTIME_STATIC_EXECUTION =
  "hosted runtime saved execution is unavailable";

export const HOSTED_RUNTIME_STATIC_ENV =
  "hosted runtime launcher credentials are unavailable";

export const HOSTED_RUNTIME_HEALTHY_DETAIL = "hosted runtime settled healthy";

export const HOSTED_RUNTIME_FAILED_DETAIL = "hosted runtime settled failed";

export const HOSTED_RUNTIME_UNAVAILABLE_DETAIL =
  "hosted runtime result is unavailable";

const ACTIONS_LOGIN = "github-actions[bot]";

const APP_LOGIN = "ubiquity-sentinel[bot]";

/**
 * Bounded transition set: a child at an older installed revision settles as
 * `github-actions[bot]`, a child after this migration as
 * `ubiquity-sentinel[bot]`. This dual acceptance is a scoped transition rule;
 * remove the old login after the first app-login child settles healthy.
 */
export const ACCEPTED_CHILD_LOGINS: readonly string[] = [
  ACTIONS_LOGIN,
  APP_LOGIN,
];

export const REMOTE_URL = HOSTED_CONTROLLER_REMOTE;

export const GIT_EXECUTABLE = "/usr/bin/git";

export const GIT_TIMEOUT_MS = 10_000;

export const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

export const MAX_DETAIL_CHARS = 4_096;

export const HOSTED_TERMINAL_LOOKING = /"kind"\s*:\s*"hosted_runtime_terminal"/;

export const MAX_DIAGNOSTIC_LINE_CHARS = 2_048;

export const MAX_HOSTED_DIAGNOSTICS = 64;

export type HostedRuntimeJobV1 =
  | "prepare"
  | "repair"
  | "finalize"
  | "matrix_plan"
  | "matrix_cell";

/** Core run identity plus the exact protected job this process runs in. */
export interface HostedRuntimeIdentityV1 {
  runId: number;
  runAttempt: number;
  launcherSha: GitSha;
  job: HostedRuntimeJobV1;
}

/**
 * Read ONLY the eight standard native identity keys this boundary validates.
 * Named reads keep the existing per-name Deno env grants sufficient; the whole
 * environment is never dumped, and no App or Actions output key is consulted.
 */
export function readHostedIdentityEnv(): Record<string, string | undefined> {
  return {
    GITHUB_RUN_ID: Deno.env.get("GITHUB_RUN_ID"),
    GITHUB_RUN_ATTEMPT: Deno.env.get("GITHUB_RUN_ATTEMPT"),
    GITHUB_REPOSITORY: Deno.env.get("GITHUB_REPOSITORY"),
    GITHUB_REF: Deno.env.get("GITHUB_REF"),
    GITHUB_SHA: Deno.env.get("GITHUB_SHA"),
    GITHUB_WORKFLOW_SHA: Deno.env.get("GITHUB_WORKFLOW_SHA"),
    GITHUB_WORKFLOW_REF: Deno.env.get("GITHUB_WORKFLOW_REF"),
    GITHUB_JOB: Deno.env.get("GITHUB_JOB"),
  };
}

/**
 * Parse the fixed native identity. Every field is mandatory and exact; a
 * mismatch (including a different caller job) is a static refusal.
 */
export function parseHostedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  expectedJob: HostedRuntimeJobV1,
): HostedRuntimeIdentityV1 {
  const runId = parsePositiveDecimal(env.GITHUB_RUN_ID);
  const runAttempt = parsePositiveDecimal(env.GITHUB_RUN_ATTEMPT);
  if (env.GITHUB_REPOSITORY !== HOSTED_SUPERVISOR_REPOSITORY) failIdentity();
  if (env.GITHUB_REF !== HOSTED_SUPERVISOR_REF) failIdentity();
  const sha = env.GITHUB_SHA;
  if (!isGitSha(sha)) failIdentity();
  if (sha !== env.GITHUB_WORKFLOW_SHA) failIdentity();
  if (env.GITHUB_WORKFLOW_REF !== HOSTED_RUNTIME_WORKFLOW_REF) failIdentity();
  if (env.GITHUB_JOB !== expectedJob) failIdentity();
  return { runId, runAttempt, launcherSha: sha, job: expectedJob };
}

/**
 * Read the exactly one saved runtime pointer from the strict release snapshot
 * and require it to bind this run, attempt, launcher, execution id, controller
 * revision and generation. Any absence, malformation, foreign execution or
 * stale revision is a static refusal; nothing is inferred from list order.
 */
export async function readHostedRuntimeExecution(input: {
  state: StateReadView;
  identity: HostedRuntimeIdentityV1;
  controllerSha: GitSha;
}): Promise<HostedExecutionIntentV1> {
  return (await readHostedRuntimeCustody(input)).execution;
}

/**
 * `readHostedRuntimeExecution` together with the exact release custody it
 * was verified against (the launcher's legacy cutoff is checked against that
 * custody, `legacy-review-cutoff-env.ts`).
 */
export async function readHostedRuntimeCustody(input: {
  state: StateReadView;
  identity: HostedRuntimeIdentityV1;
  controllerSha: GitSha;
}): Promise<
  { execution: HostedExecutionIntentV1; release: ReleaseStateSnapshotV1 }
> {
  let snapshot: ReleaseStateSnapshotV1 | null = null;
  try {
    const read = await input.state.readRelease();
    if (!read.ok) failExecution();
    if (read.value.status !== "found") failExecution();
    snapshot = parseReleaseStateSnapshotV1(read.value.snapshot);
  } catch {
    failExecution();
  }
  if (snapshot === null) failExecution();
  if (snapshot.hostedRuntimes.length !== 1) failExecution();
  const runtime = snapshot.hostedRuntimes[0];
  const execution = runtime.execution;
  if (execution === null) failExecution();
  if (execution.id !== executionIdOf(input.identity)) failExecution();
  if (
    execution.runId !== input.identity.runId ||
    execution.runAttempt !== input.identity.runAttempt ||
    execution.launcherSha !== input.identity.launcherSha
  ) {
    failExecution();
  }
  if (
    runtime.activeRevision !== input.controllerSha ||
    execution.revision !== input.controllerSha
  ) {
    failExecution();
  }
  if (runtime.generation !== execution.generation) failExecution();
  return { execution, release: snapshot };
}

export interface HostedRuntimeLauncherInputV1 {
  state: StateReadView;
  clock: Clock;
  env: Readonly<Record<string, string | undefined>>;
  launcherDir: string;
  runtimeDir: string;
  denoExecutable: string;
  /** The one process border: bounded Git identity reads and the child run. */
  process: ReplayRuntimeV1;
  /** Trusted in-process fixture only; production uses native HTTP and source pins. */
  principalHandoffFixture?: {
    readonly http: import("../github/http.ts").HttpTransportV1;
    readonly sourceProfiles:
      readonly import("./hosted-app-principal-source.ts").HostedAppSourceProfile[];
  };
  /**
   * Optional advisory sink for reconstructed child diagnostics. Each summary
   * is delivered as soon as its complete stdout line is retained, before the
   * child exits; it never attests settlement, health, terminal or authority,
   * and a throwing sink is swallowed. Absent means no streaming at all.
   */
  onDiagnostic?: (diagnostic: HostedModelDiagnosticV1) => void;
  /** Native workflow JSON only: planDigest and optional cellId, never credentials. */
  stdin?: string;
  /** Concrete launcher-owned broker; final trusted composition belongs to m08. */
  reviewCustody?: ReviewOwnerCustodyBroker;
}

export type HostedRuntimeLauncherStatusV1 =
  | "healthy"
  | "failed"
  | "unavailable";

/**
 * One reconstructed advisory diagnostic. The wrapper kind, the advisory flag
 * and the execution intent are stamped by this trusted process only: a child
 * line can never supply them. The nested diagnostic was strictly rebuilt from
 * the child's own summary by the explicit allow-list parser.
 */
export interface HostedModelDiagnosticV1 {
  version: "v1";
  kind: "hosted_model_diagnostic";
  advisory: true;
  execution: HostedExecutionIntentV1;
  diagnostic: LocalModelDiagnosticV1;
}

/**
 * Advisory-only summary of a settled child status record whose outcome was
 * state_error or source_error: the child's own closed status and bounded
 * authored detail, verbatim. It never carries raw stderr, credentials, model
 * or prompt text, and it can never change the terminal, health, settlement or
 * exit status.
 */
export interface HostedRuntimeChildFailureV1 {
  version: "v1";
  kind: "hosted_runtime_child_failure";
  status: "state_error" | "source_error";
  detail: string;
}

/** Closed event kinds of one failed delivery port call. */
export const MERGE_EVENT_KINDS = [
  "merge_port_error",
  "merge_reconcile_read_error",
] as const;

export type MergeEventKindV1 = typeof MERGE_EVENT_KINDS[number];

/** Closed detail codes for the adapter's own static delivery failures. */
export const MERGE_EVENT_DETAIL_CODES = [
  "candidate_binding",
  "candidate_remote",
  "candidate_fetch",
  "ancestry_unavailable",
] as const;

export type MergeEventDetailCodeV1 = typeof MERGE_EVENT_DETAIL_CODES[number];

/**
 * Runtime-emitted closed delivery event for one failed merge port call. It
 * carries only the PR number, the closed port error kind and an allow-listed
 * detail code; never a message, body, URL, path or credential.
 */
export interface SentinelMergeEventV1 {
  version: "v1";
  kind: "sentinel_merge_event";
  event: MergeEventKindV1;
  prNumber: number;
  errorKind: PortErrorKindV1;
  detailCode: MergeEventDetailCodeV1 | null;
}

/**
 * Launcher-stamped advisory wrapper around one accepted delivery event. The
 * wrapper kind, the advisory flag and the execution intent are stamped by
 * the trusted launcher only.
 */
export interface HostedMergeEventV1 {
  version: "v1";
  kind: "hosted_merge_event";
  advisory: true;
  execution: HostedExecutionIntentV1;
  merge: SentinelMergeEventV1;
}

/** Bound on the refused reviewer command advisories one launcher run prints. */
export const MAX_REVIEW_COMMAND_REFUSALS = 50;

/**
 * Launcher re-serialization of one runtime `sentinel_review_command_item_refused`
 * advisory (`reportRefusedCommandItem` in src/github/reviewer-session-state.ts).
 * Every value is a boolean, a closed enum, a bounded count, null or a bounded
 * token; any other string the child printed is replaced by "other".
 */
export interface ReviewCommandItemRefusalV1 {
  event: "sentinel_review_command_item_refused";
  site: string;
  type: string;
  status: string | null;
  idBounded: boolean;
  commandBounded: boolean;
  commandChars: number | null;
  hasActions: boolean;
  cwdMatches: boolean;
  source: string | null;
  provenance: "agent-origin" | "refused";
  pluginId: "absent" | "present";
  scriptPath: "absent" | "present";
  knownItem: boolean;
}

/** The capped refused-command advisories of one settled child capture. */
export interface ReviewCommandItemRefusalsV1 {
  refusals: ReviewCommandItemRefusalV1[];
  /** Accepted advisories beyond the cap; counted, never printed. */
  dropped: number;
}

/** Advisory-only exact native review terminal, never a child result. */
export interface ReviewTerminalAdvisoryV1 {
  event: "sentinel_review_terminal";
  ownerRunId: string;
  requestId: string;
  invocationId: string;
  threadId: string;
  turnId: string;
  terminalStatus: "completed" | "failed" | "interrupted";
  durationMs: number | null;
  errorPresent: boolean;
  errorCode: ModelBoundaryErrorCodeV1 | null;
  httpStatusCode: number | null;
}

/** Log volume bound only; no model admission or review limit. */
export const MAX_REVIEW_TERMINAL_ADVISORIES = 50;

export interface ReviewTerminalAdvisoriesV1 {
  terminals: ReviewTerminalAdvisoryV1[];
  dropped: number;
}

export interface HostedRuntimeLauncherResultV1 {
  status: HostedRuntimeLauncherStatusV1;
  /** The trusted terminal, or null when no honest proof exists. */
  terminal: HostedRuntimeTerminalV1 | null;
  /** Static diagnostic; never raw child output. */
  detail: string;
  /**
   * Reconstructed advisory summaries from settled child stdout. Empty by
   * default; they never attest health, terminal, settlement or any authority.
   */
  diagnostics: HostedModelDiagnosticV1[];
  /** Launcher-created actual reviewer close proofs, distinct from advisory diagnostics. */
  reviewOwnerSettlements?: HostedReviewOwnerSettlementV1[];
  /**
   * Advisory-only, sanitized summary of a settled nonzero child exit that
   * produced no status record. It carries a closed category and a few
   * sanitized stack-frame locations, never raw stderr, and it can never
   * change the terminal, health, settlement or exit status.
   */
  earlyFailure?: HostedRuntimeEarlyFailureV1;
  /**
   * Advisory-only child-authored failure detail for a settled
   * state_error/source_error child record. Present only on failed results
   * whose parsed child record carried that closed detail; it never attests
   * health, terminal, settlement or delivery.
   */
  childFailure?: HostedRuntimeChildFailureV1;
  /**
   * Advisory-only closed delivery events reconstructed from settled child
   * stdout. Empty by default; they never attest health, terminal, settlement
   * or delivery and can never change the wait, intent or exit status.
   */
  mergeEvents?: HostedMergeEventV1[];
  /**
   * Advisory-only refused reviewer command predicates re-parsed from settled
   * child stdout, printed so a refusal is diagnosable from the job log. They
   * never attest health, terminal, settlement or delivery and can never
   * change the resolved status or exit.
   */
  reviewCommandRefusals?: ReviewCommandItemRefusalsV1;
  /** Strictly re-parsed observational terminals; never health or authority. */
  reviewTerminals?: ReviewTerminalAdvisoriesV1;
  /** Authenticated native matrix log carrier; never aggregate terminal proof. */
  matrixCarrier?: Record<string, unknown>;
  /**
   * Advisory-only re-parsed plan diagnostic of an accepted planner carrier
   * (closed keys, integer counts); never acceptance, health or admission.
   */
  matrixPlanDiagnostic?: HostedMatrixPlanDiagnosticV1;
  /**
   * Advisory-only re-parsed `sentinel_step` lines of a settled repair child,
   * bounded; they never attest health, terminal, settlement or delivery.
   */
  stepLines?: StepLineV1[];
  /**
   * Diagnostic-only receipt for a rejected matrix launcher result. Present
   * only when status is "unavailable" from resolveMatrixLauncherResult; it
   * can never change acceptance, mint a terminal or return a carrier.
   */
  launcherRejection?: HostedRuntimeMatrixLauncherRejectionV1;
}

/**
 * Sanitized typed summary of why a matrix launcher result was rejected.
 * Fail-closed acceptance is unchanged: no raw child streams, prompts or
 * secret values are carried, only typed child outcome metadata, the closed
 * rejection condition and a carrier count.
 */
export interface HostedRuntimeMatrixLauncherRejectionV1 {
  version: "v1";
  kind: "hosted_runtime_matrix_launcher_rejection";
  /**
   * Closed condition that fired. Distinguishes rejections that previously
   * collapsed into the same unavailable result: an unsettled child process,
   * a rejected carrier field binding, or a nonunique carrier count.
   */
  condition: "child_unsettled" | "carrier_field" | "carrier_count";
  /**
   * Rejected carrier field group; present only for carrier_field.
   * Revision/generation binding is runtime_sha, launcher identity is
   * identity, and the job-specific validated fields are plan or cell.
   */
  field?: "runtime_sha" | "identity" | "plan" | "cell";
  /** Typed child outcome; the discriminating proof stderr lost. */
  outcome: ReplayCommandResultV1["outcome"];
  exitCode: number | null;
  settled: boolean;
  truncated: boolean;
  /**
   * Carriers parsed before rejection. Absent when the child never settled,
   * since carriers are not parsed in that case.
   */
  carrierCount?: number;
}

/** Closed, non-sensitive category of one settled early child abort. */
export type HostedRuntimeEarlyFailureCategoryV1 =
  | "module_not_found"
  | "permission_denied"
  | "address_in_use"
  | "unauthorized"
  | "forbidden"
  | "tls"
  | "dns"
  | "timeout"
  | "no_space"
  | "syntax"
  | "uncaught"
  | "signalled"
  | "unknown";

/**
 * Closed reason code for one exact code-owned pre-status abort literal that the
 * deployed child runtime (`ac98dc80f`) can throw before it prints a status
 * record. This is a small finite map of named high-value abort sources, never a
 * general error catalogue, and it is never derived from arbitrary stderr text.
 */
export type HostedRuntimeEarlyFailureReasonV1 =
  | "local_git_command_failed"
  | "local_git_output_bound"
  | "targets_invalid"
  | "targets_empty"
  | "repair_credentials_unavailable"
  | "repair_controller_unavailable"
  | "repair_executable_unavailable"
  | "repair_sessions_unsettled"
  | "repair_installation_scope_invalid"
  | "repair_deadline_reached"
  | "historical_custody_unavailable"
  | "c_recovery_state_unavailable";

/**
 * One sanitized advisory summary of a settled nonzero child exit that produced
 * no status record (the genuine early-abort path). The category comes from a
 * closed allow-list and the frames are reduced to `<basename>:<line>:<column>`
 * locations: arbitrary stderr text, arguments, URLs, host paths and credential
 * values are never copied. It is advisory only and is never terminal, health,
 * settlement or authority proof.
 */
export interface HostedRuntimeEarlyFailureV1 {
  version: "v1";
  kind: "hosted_runtime_early_failure";
  advisory: true;
  exitCode: number;
  category: HostedRuntimeEarlyFailureCategoryV1;
  /**
   * Optional nullable closed reason code for one exact code-owned pre-status
   * abort literal recognized in the stripped stderr prefix; null when the
   * message is not one of the finite known literals. It is never raw message
   * text, a URL, a path or a credential.
   */
  reasonCode?: HostedRuntimeEarlyFailureReasonV1 | null;
  /** Bounded basename-only stack locations; empty when none are recognizable. */
  frames: string[];
}

/** Fixed private launcher scratch inside the ignored launcher checkout. */
export function hostedRuntimeSentinelDir(launcherDir: string): string {
  return joinPath(launcherDir, ".sentinel");
}

function executionIdOf(identity: HostedRuntimeIdentityV1): string {
  return `${identity.runId}:${identity.runAttempt}:repair`;
}

function parsePositiveDecimal(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) failIdentity();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) failIdentity();
  return parsed;
}

export function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return path.slice(0, index);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isNonEmptyText(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function failIdentity(): never {
  throw new Error(HOSTED_RUNTIME_STATIC_IDENTITY);
}

function failExecution(): never {
  throw new Error(HOSTED_RUNTIME_STATIC_EXECUTION);
}

export function unavailableResult(): HostedRuntimeLauncherResultV1 {
  return {
    status: "unavailable",
    terminal: null,
    detail: HOSTED_RUNTIME_UNAVAILABLE_DETAIL,
    diagnostics: [],
  };
}
