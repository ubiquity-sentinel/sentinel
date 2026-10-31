/** Hosted hosted-runtime-launcher responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { parseHostedRuntimeTerminalV1 } from "../contracts/hosted-execution.ts";
import type { HostedRuntimeSummaryV1 } from "../contracts/hosted-execution.ts";
import type {
  IssueSourceErrorContextV1,
  SkippedIssueV1,
  StateReadView,
} from "../contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  sanitizeIssueSourceContext,
  sanitizeSkippedIssue,
} from "../github/client-response.ts";
import { createDeadline } from "../github/http.ts";
import { readTargetSlugsV1 } from "./targets.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { tryParse } from "../contracts/validation.ts";
import type { ReplayCommandResultV1 } from "../replay/runtime.ts";
import { ensurePrivateDir, joinPath } from "./local.ts";
import {
  HOSTED_RUNTIME_CHILD_ENTRYPOINT,
  HOSTED_RUNTIME_DEADLINE_MS,
  HOSTED_RUNTIME_FAILED_DETAIL,
  HOSTED_RUNTIME_HEALTHY_DETAIL,
  HOSTED_RUNTIME_MAX_OUTPUT_BYTES,
  HOSTED_RUNTIME_STATIC_ENV,
  HOSTED_RUNTIME_STATIC_EXECUTION,
  HOSTED_RUNTIME_STATIC_SOURCE,
  hostedRuntimeSentinelDir,
  isNonNegativeSafeInteger,
  parseHostedEnvironment,
  readHostedRuntimeCustody,
  unavailableResult,
} from "./hosted-runtime-identity.ts";
import type {
  HostedRuntimeIdentityV1,
  HostedRuntimeLauncherInputV1,
  HostedRuntimeLauncherResultV1,
  ReviewCommandItemRefusalsV1,
} from "./hosted-runtime-identity.ts";
import {
  nativeMatrixStdin,
  resolveMatrixLauncherResult,
  runtimeJob,
} from "./hosted-runtime-matrix.ts";
import {
  buildChildEnvironment,
  readCleanGitHead,
  resolveRuntimeDirectories,
} from "./hosted-runtime-child.ts";
import {
  createHostedDiagnosticStream,
  earlyChildFailureDiagnostic,
  scanChildDiagnostics,
  scanChildMergeEvents,
} from "./hosted-runtime-diagnostics.ts";
import {
  parseChildStatus,
  scanChildStatusRecords,
  scanReviewCommandItemRefusals,
  scanReviewTerminalAdvisories,
} from "./hosted-runtime-status.ts";
import type { ChildStatusV1 } from "./hosted-runtime-status.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { legacyReviewCutoffForExecution } from "./legacy-review-cutoff-env.ts";
import { runRepairOwnerWithReviewCustody } from "./review-owner-custody.ts";
import type { HostedReviewOwnerSettlementV1 } from "../github/review-owner-evidence.ts";
import { allowsHostedExecution } from "./hosted-runtime-compatibility.ts";
import type { QueueRuntimeCapability } from "./queue-runtime-capability.ts";
import type { ExistingPrRuntimeCapability } from "./existing-pr-runtime-capability.ts";
import { retainVerifiedHostedAppGrant } from "./hosted-runtime-principal-handoff.ts";
import { needsHostedLegacyStateView } from "./hosted-runtime-rollback-state.ts";
import { HOSTED_RUNTIME_ROLLBACK_ENTRYPOINT } from "./hosted-runtime-rollback.ts";
import { scanPlanDiagnostic } from "./matrix-plan-diagnostic.ts";
import { scanStepLines } from "../repair/step-line.ts";

/**
 * Verify the launcher and runtime checkouts as clean worktrees at their exact
 * commits, read the saved execution, run the fixed child entrypoint through the
 * injected owned-group border and settle the one trusted terminal. Any
 * unsettled, truncated, thrown or unattestable result is unavailable with NO
 * terminal; a settled nonzero exit without a child result is an honest failure.
 */
export async function runHostedRuntimeLauncher(
  input: HostedRuntimeLauncherInputV1,
  /** Trusted in-process fixture only; production uses launcher source pins. */
  capability?: QueueRuntimeCapability,
  custodyCapability?: ExistingPrRuntimeCapability,
): Promise<
  HostedRuntimeLauncherResultV1 & { summary: HostedRuntimeSummaryV1 }
> {
  let result = unavailableResult();
  const observation: SummaryObservationV1 = {};
  try {
    result = await launchHostedRuntime(
      input,
      capability,
      custodyCapability,
      observation,
    );
  } catch {
    result = unavailableResult();
  }
  try {
    await input.reviewCustody?.dispose();
  } catch {
    result = unavailableResult();
  }
  return {
    ...result,
    summary: await summarizeHostedRuntime(input, result, observation),
  };
}

async function launchHostedRuntime(
  input: HostedRuntimeLauncherInputV1,
  capability?: QueueRuntimeCapability,
  custodyCapability?: ExistingPrRuntimeCapability,
  observation: SummaryObservationV1 = {},
): Promise<HostedRuntimeLauncherResultV1> {
  const identity = parseHostedEnvironment(
    input.env,
    runtimeJob(input.env.GITHUB_JOB),
  );
  const dirs = await resolveRuntimeDirectories(
    input.launcherDir,
    input.runtimeDir,
  );

  // Both source checkouts must be clean at their exact commits before the
  // child exists; HEAD commits, never refs or inputs, are the authority.
  const launcherHead = await readCleanGitHead(input.process, dirs.launcher);
  if (launcherHead !== identity.launcherSha) {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  const runtimeHead = await readCleanGitHead(input.process, dirs.runtime);
  if (!isGitSha(runtimeHead)) throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);

  // Scratch exists only after the source is verified; the read-only release
  // state is then read through it. No repair or release write happens here.
  const sentinelDir = hostedRuntimeSentinelDir(dirs.launcher);
  const childHome = joinPath(sentinelDir, "child-home");
  const childTmp = joinPath(sentinelDir, "child-tmp");
  const childDenoDir = joinPath(sentinelDir, "child-deno");
  await ensurePrivateDir(joinPath(sentinelDir, "state-scratch"));
  await ensurePrivateDir(joinPath(sentinelDir, "state-git-home"));
  await ensurePrivateDir(childHome);
  await ensurePrivateDir(childTmp);
  await ensurePrivateDir(childDenoDir);

  const { execution, release } = await readHostedRuntimeCustody({
    state: input.state,
    identity,
    controllerSha: runtimeHead,
  });
  if (
    execution.revision !== runtimeHead ||
    !allowsHostedExecution(
      execution,
      release.hostedReleases,
      capability,
      custodyCapability,
    )
  ) {
    throw new Error(HOSTED_RUNTIME_STATIC_EXECUTION);
  }

  if (identity.job !== "repair" && execution.purpose !== "ordinary") {
    throw new Error(HOSTED_RUNTIME_STATIC_EXECUTION);
  }
  const stdin = nativeMatrixStdin(input.stdin, identity.job);
  const startedAt = input.clock.now();
  if (!isNonNegativeSafeInteger(startedAt)) {
    throw new Error(HOSTED_RUNTIME_STATIC_ENV);
  }
  const childEnv = buildChildEnvironment(
    input.env,
    identity,
    { home: childHome, tmp: childTmp, denoDir: childDenoDir },
    startedAt,
    legacyReviewCutoffForExecution(execution, release),
  );
  await retainVerifiedHostedAppGrant(
    input,
    { ...dirs, identity, execution },
    childEnv,
  );
  // Streaming is attached only here, after the exact execution identity has
  // been verified, and only to the actual child command: the bounded Git
  // identity reads above never see a sink.
  const diagnosticStream = input.onDiagnostic === undefined
    ? undefined
    : createHostedDiagnosticStream(execution, input.onDiagnostic);

  // Read-only observations for the advisory. They never reserve work or gate execution.
  observation.identity = identity;
  observation.execution = execution;
  observation.targets = (await readTargetSlugsV1({ root: dirs.runtime })).map((
    target,
  ) => target.slug);
  observation.before = await readSummaryState(input.state);

  const custody = input.reviewCustody;
  let childStdin = stdin;
  if (custody !== undefined) {
    if (
      identity.job !== "repair" ||
      canonicalStringify(custody.execution) !== canonicalStringify(execution)
    ) throw new Error(HOSTED_RUNTIME_STATIC_EXECUTION);
    const descriptor = await custody.start(sentinelDir);
    childStdin = JSON.stringify({
      ...(stdin === undefined ? {} : JSON.parse(stdin)),
      reviewCustody: descriptor,
    });
  }
  const command = {
    executable: input.denoExecutable,
    args: [
      "run",
      "-A",
      needsHostedLegacyStateView(release, execution)
        ? joinPath(dirs.launcher, HOSTED_RUNTIME_ROLLBACK_ENTRYPOINT)
        : identity.job === "repair"
        ? HOSTED_RUNTIME_CHILD_ENTRYPOINT
        : "src/host/matrix-actions.ts",
    ],
    ...(childStdin === undefined ? {} : { stdin: childStdin }),
    cwd: dirs.runtime,
    env: childEnv,
    maxDurationMs: HOSTED_RUNTIME_DEADLINE_MS,
    maxOutputBytes: HOSTED_RUNTIME_MAX_OUTPUT_BYTES,
    ...(diagnosticStream === undefined
      ? {}
      : { onStdoutChunk: diagnosticStream }),
  };
  let reviewOwnerSettlements: HostedReviewOwnerSettlementV1[] = [];
  let run: ReplayCommandResultV1;
  if (custody === undefined) run = await input.process.run(command);
  else {
    const owned = await runRepairOwnerWithReviewCustody(
      custody,
      input.process,
      command,
    );
    run = owned.run;
    reviewOwnerSettlements = owned.settlements;
  }
  observation.run = run;
  const finishedAt = input.clock.now();
  // A backward or invalid clock is a refusal: no terminal instant is ever
  // fabricated to hide it.
  if (!isNonNegativeSafeInteger(finishedAt) || finishedAt < startedAt) {
    return unavailableResult();
  }
  if (identity.job === "matrix_plan" || identity.job === "matrix_cell") {
    const matrix = resolveMatrixLauncherResult(
      run,
      execution,
      identity.job,
      stdin,
    );
    return identity.job === "matrix_plan"
      ? attachPlanDiagnostic(matrix, run, execution)
      : matrix;
  }
  const resolved = resolveLauncherResult({
    run,
    execution,
    startedAt,
    finishedAt,
  });
  // Advisory summaries are attached independently of the resolved status and
  // never replace the trusted terminal or the existing unhealthy exit.
  const result = attachDiagnostics(resolved, run, execution);
  return reviewOwnerSettlements.length === 0
    ? result
    : { ...result, reviewOwnerSettlements };
}

interface LauncherTerminalInputV1 {
  run: ReplayCommandResultV1;
  execution: HostedExecutionIntentV1;
  startedAt: number;
  finishedAt: number;
}

function resolveLauncherResult(
  input: LauncherTerminalInputV1,
): HostedRuntimeLauncherResultV1 {
  const { run } = input;
  // Truncated capture, an invocation that never began and an unproven
  // settlement are all uncertain: no terminal is ever minted from them.
  if (run.truncated) return unavailableResult();
  if (run.outcome === "spawn_failed") return unavailableResult();
  if (
    (run.outcome === "exited" || run.outcome === "timed_out") && !run.settled
  ) {
    return unavailableResult();
  }
  if (run.outcome !== "exited" && run.outcome !== "timed_out") {
    return unavailableResult();
  }

  const scan = scanChildStatusRecords(new TextDecoder().decode(run.stdout));
  if (scan.kind === "uncertain") return unavailableResult();
  const child = scan.kind === "one"
    ? parseChildStatus(scan.value, input.execution)
    : null;
  // A present-but-unusable record is uncertain, never silently ignored.
  if (scan.kind === "one" && child === null) return unavailableResult();

  // A settled owned-group timeout is an objective failed invocation; the
  // observed child metadata is preserved when a valid record exists.
  if (run.outcome === "timed_out") return failedResult(input, child);

  if (run.exitCode === null) return unavailableResult();
  if (child === null) {
    // A settled nonzero exit with no attestable child result is an honest
    // early failure; a zero exit with no result is unattestable.
    if (run.exitCode === 0) return unavailableResult();
    return failedResult(input, null);
  }
  if (run.exitCode !== 0 || !child.healthy || child.baseSha === null) {
    // A nonzero exit is a failure even beside a healthy-looking record, and a
    // child that did not attest startup health or its observed base cannot be
    // healthy; its observed metadata is still preserved.
    return failedResult(input, child);
  }
  return terminalResult(input, "healthy", true, child.baseSha);
}

function failedResult(
  input: LauncherTerminalInputV1,
  child: ChildStatusV1 | null,
): HostedRuntimeLauncherResultV1 {
  // An early no-child failure has no observed metadata; an actual child record
  // keeps its own observed startup flag and valid base SHA.
  // Raw stderr never enters detail. The separate advisory projects only
  // closed categories, known reason codes and allow-listed frame locations.
  const result = terminalResult(
    input,
    "failed",
    child?.startupReady ?? false,
    child?.baseSha ?? null,
  );
  if (child?.failure == null) return result;
  return {
    ...result,
    childFailure: {
      version: "v1",
      kind: "hosted_runtime_child_failure",
      status: child.failure.status,
      detail: child.failure.detail,
    },
  };
}

function terminalResult(
  input: LauncherTerminalInputV1,
  outcome: "healthy" | "failed",
  startupReady: boolean,
  baseSha: GitSha | null,
): HostedRuntimeLauncherResultV1 {
  const parsed = tryParse(parseHostedRuntimeTerminalV1, {
    version: "v1",
    kind: "hosted_runtime_terminal",
    execution: input.execution,
    controllerSha: input.execution.revision,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome,
    startupReady,
    settled: true,
    baseSha,
  });
  if (!parsed.ok) return unavailableResult();
  return {
    status: outcome,
    terminal: parsed.value,
    detail: outcome === "healthy"
      ? HOSTED_RUNTIME_HEALTHY_DETAIL
      : HOSTED_RUNTIME_FAILED_DETAIL,
    diagnostics: [],
  };
}

/**
 * Scan only a complete bounded untruncated settled child capture for advisory
 * summaries. Each accepted line is strictly re-parsed through the shared
 * allow-list, then stamped with the already-verified execution intent; a child
 * can never supply the wrapper kind, the advisory flag or the execution.
 * Malformed, oversized, unrecognized or forged records are ignored and never
 * copied. Nothing is invented from the host duration or the exit code, and a
 * diagnostic can never create terminal or health proof.
 */
function attachDiagnostics(
  result: HostedRuntimeLauncherResultV1,
  run: ReplayCommandResultV1,
  execution: HostedExecutionIntentV1,
): HostedRuntimeLauncherResultV1 {
  const diagnostics = scanChildDiagnostics(run, execution);
  const mergeEvents = scanChildMergeEvents(run, execution);
  const earlyFailure = earlyChildFailureDiagnostic(result, run);
  const refusals = reviewCommandRefusals(run);
  const withAdvisories = diagnostics.length === 0 && mergeEvents.length === 0
    ? result
    : {
      ...result,
      diagnostics,
      ...(mergeEvents.length === 0 ? {} : { mergeEvents }),
    };
  const withRefusals = refusals === null
    ? withAdvisories
    : { ...withAdvisories, reviewCommandRefusals: refusals };
  let withTerminals = withRefusals;
  try {
    const terminals = scanReviewTerminalAdvisories(run, execution);
    if (terminals !== null) {
      withTerminals = { ...withRefusals, reviewTerminals: terminals };
    }
  } catch {
    // Advisory parsing cannot change the resolved child result.
  }
  let withSteps = withTerminals;
  try {
    const stepLines = scanStepLines(new TextDecoder().decode(run.stdout));
    if (stepLines.length > 0) withSteps = { ...withTerminals, stepLines };
  } catch {
    // Advisory parsing cannot change the resolved child result.
  }
  if (earlyFailure === null) return withSteps;
  return { ...withSteps, earlyFailure };
}

/**
 * The accepted planner carrier's sanitized plan diagnostic (C5.1), re-parsed
 * from the same settled capture; a rejected carrier carries none, and a scan
 * that throws is no diagnostic.
 */
function attachPlanDiagnostic(
  result: HostedRuntimeLauncherResultV1,
  run: ReplayCommandResultV1,
  execution: HostedExecutionIntentV1,
): HostedRuntimeLauncherResultV1 {
  if (result.matrixCarrier === undefined) return result;
  try {
    const diagnostic = scanPlanDiagnostic(
      new TextDecoder().decode(run.stdout),
      execution,
    );
    return diagnostic === null
      ? result
      : { ...result, matrixPlanDiagnostic: diagnostic };
  } catch {
    return result;
  }
}

/**
 * The runtime's bounded refused reviewer command advisories, re-parsed only so
 * the CLI result printer can surface their predicates in the job log. A scan
 * that throws is no advisory: it can never turn a resolved result unavailable.
 */
function reviewCommandRefusals(
  run: ReplayCommandResultV1,
): ReviewCommandItemRefusalsV1 | null {
  try {
    return scanReviewCommandItemRefusals(run);
  } catch {
    return null;
  }
}

interface SummaryObservationV1 {
  identity?: HostedRuntimeIdentityV1;
  execution?: HostedExecutionIntentV1;
  targets?: string[];
  /** null is a positively absent state; undefined is an unavailable read. */
  before?: RepairStateSnapshotV1 | null;
  run?: ReplayCommandResultV1;
}

interface SummaryIntakeV1 {
  repository: string;
  openIssues: number | null;
  skippedIssues: SkippedIssueV1[] | null;
  error?: IssueSourceErrorContextV1;
}

/** An advisory read has its own finite bound and cannot fail the child run. */
async function readSummaryState(
  state: StateReadView,
): Promise<RepairStateSnapshotV1 | null | undefined> {
  const deadline = createDeadline(5_000);
  try {
    const read = await deadline.race(
      Promise.resolve().then(() => state.readRepair()),
    );
    if (!read.ok) return undefined;
    return read.value.status === "absent"
      ? null
      : parseRepairStateSnapshotV1(read.value.snapshot);
  } catch {
    return undefined;
  } finally {
    deadline.dispose();
  }
}

/** Unknown is explicit, including an entrypoint failure before a child exists. */
export function fallbackHostedRuntimeSummary(
  result: HostedRuntimeLauncherResultV1,
  identity?: HostedRuntimeIdentityV1,
  observedExecution?: HostedExecutionIntentV1,
): HostedRuntimeSummaryV1 {
  const execution = observedExecution ?? result.terminal?.execution;
  const summary: HostedRuntimeSummaryV1 = {
    version: "v1",
    kind: "hosted_runtime_summary",
    runId: execution?.runId ?? identity?.runId ?? null,
    attempt: execution?.runAttempt ?? identity?.runAttempt ?? null,
    launcherSha: execution?.launcherSha ?? identity?.launcherSha ?? null,
    runtimeSha: execution?.revision ?? null,
    generation: execution?.generation ?? null,
    purpose: execution?.purpose ?? null,
    targets: [],
    admittedWorkCount: null,
    modelStarts: null,
    prsTouched: [],
    outcome: result.status,
    reasonCode: result.childFailure?.status ??
      (result.status === "healthy"
        ? "healthy"
        : result.status === "failed"
        ? "child_failed"
        : "runtime_unavailable"),
    explanation: "",
    nextAction: "",
  };
  explainHostedSummary(summary);
  return summary;
}

async function summarizeHostedRuntime(
  input: HostedRuntimeLauncherInputV1,
  result: HostedRuntimeLauncherResultV1,
  observation: SummaryObservationV1,
): Promise<HostedRuntimeSummaryV1> {
  const summary = fallbackHostedRuntimeSummary(
    result,
    observation.identity,
    observation.execution,
  );
  try {
    const intake = scanSummaryIntake(observation.run);
    const targets = observation.targets?.length
      ? observation.targets
      : [...intake.keys()];
    const after = observation.execution === undefined
      ? undefined
      : await readSummaryState(input.state);
    const before = observation.before;
    const retainedAdmissions = new Set(
      (after?.reservations ?? []).map((row) => row.id),
    );
    // Missing history, a regressing snapshot or removed admissions cannot prove zero.
    const comparable = observation.run?.settled === true &&
      before !== undefined && after !== undefined &&
      (before === null ||
        (after !== null && after.sequence >= before.sequence &&
          before.reservations.every((row) => retainedAdmissions.has(row.id))));
    const prior = new Map(
      (before?.reservations ?? []).map((row) => [row.id, row]),
    );
    const admitted = comparable
      ? (after?.reservations ?? []).filter((row) => !prior.has(row.id))
      : null;
    summary.targets = targets.map((repository) => ({
      repository,
      openIssues: intake.get(repository)?.openIssues ?? null,
      admitted: admitted === null ? null : new Set(
        admitted.filter((row) =>
          repository === `${row.repository.owner}/${row.repository.name}`
        ).map((row) => row.taskId),
      ).size,
      skippedIssues: intake.get(repository)?.skippedIssues ?? null,
    }));
    if (admitted !== null) {
      summary.admittedWorkCount = new Set(admitted.map((row) =>
        `${row.repository.owner}/${row.repository.name}:${row.taskId}`
      )).size;
      const pendingBefore = (before?.reservations ?? []).some((row) =>
        row.outcome === "reserved"
      );
      // Ambiguous and pending starts remain unknown, never refunded or assumed started.
      summary.modelStarts = pendingBefore || admitted.some((row) =>
          row.outcome === "reserved" || row.outcome === "ambiguous"
        )
        ? null
        : admitted.filter((row) =>
          row.outcome === "submitted"
        ).length;
      const previous = new Map(
        (before?.work ?? []).map((row) => [row.id, row]),
      );
      const publications = new Map<
        string,
        HostedRuntimeSummaryV1["prsTouched"][number]
      >();
      for (const row of after?.work ?? []) {
        const old = previous.get(row.id);
        if (
          row.target.pr === null || row.target.head === null ||
          (old?.target.pr === row.target.pr &&
            old.target.head === row.target.head)
        ) {
          continue;
        }
        const repository = `${row.repository.owner}/${row.repository.name}`;
        publications.set(`${repository}#${row.target.pr}`, {
          repository,
          number: row.target.pr,
          head: row.target.head,
          action: old?.target.pr === row.target.pr ? "updated" : "recorded",
        });
      }
      summary.prsTouched = [...publications.values()];
    }
    const sourceError = [...intake.values()].find((row) =>
      row.error !== undefined
    )?.error;
    explainHostedSummary(summary, sourceError);
  } catch {
    // Counts and diagnostics are advisory; terminal evidence and exit status stay fixed.
  }
  return summary;
}

/** Rebuild source observations only; never accept a child-authored summary. */
function scanSummaryIntake(
  run?: ReplayCommandResultV1,
): Map<string, SummaryIntakeV1> {
  const result = new Map<string, SummaryIntakeV1>();
  if (
    run === undefined || run.truncated || !run.settled ||
    (run.outcome !== "exited" && run.outcome !== "timed_out")
  ) return result;
  for (const line of new TextDecoder().decode(run.stdout).split("\n")) {
    if (!line.includes('"sentinel_issue_intake"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      row === null || typeof row !== "object" ||
      row.kind !== "sentinel_issue_intake" ||
      typeof row.repository !== "string" ||
      !/^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(row.repository) ||
      !(row.openIssues === null || nonnegativeSummaryCount(row.openIssues))
    ) continue;
    let skippedIssues: SkippedIssueV1[] | null = null;
    if (
      Array.isArray(row.skippedIssues) && row.skippedIssues.length <= 10_000
    ) {
      const parsed = row.skippedIssues.map((skip: unknown) =>
        sanitizeSkippedIssue(skip, row.repository)
      );
      if (parsed.some((skip: SkippedIssueV1 | null) => skip === null)) continue;
      skippedIssues = parsed as SkippedIssueV1[];
    } else if (row.skippedIssues !== null) continue;
    const previous = result.get(row.repository)?.skippedIssues;
    if (previous !== undefined && previous !== null && skippedIssues !== null) {
      skippedIssues = [
        ...new Map(
          [...previous, ...skippedIssues].map((skip) => [skip.number, skip]),
        ).values(),
      ];
    }
    const error = sanitizeIssueSourceContext(row.error);
    result.set(row.repository, {
      repository: row.repository,
      openIssues: row.openIssues,
      skippedIssues,
      ...(error?.target === row.repository ? { error } : {}),
    });
  }
  return result;
}

function nonnegativeSummaryCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function explainHostedSummary(
  summary: HostedRuntimeSummaryV1,
  source?: IssueSourceErrorContextV1,
): void {
  const label = summary.purpose === "ordinary"
    ? "Ordinary run"
    : "Verification run";
  const generation = summary.generation === null
    ? "an unknown generation"
    : `generation ${summary.generation}`;
  const outcome = summary.outcome === "healthy"
    ? "settled healthy"
    : summary.outcome === "failed"
    ? "failed"
    : "could not be verified";
  const skipped = summary.targets.reduce(
    (count, target) => count + (target.skippedIssues?.length ?? 0),
    0,
  );
  let detail = summary.admittedWorkCount === null
    ? "work counts are unavailable"
    : `admitted ${summary.admittedWorkCount} work item${
      summary.admittedWorkCount === 1 ? "" : "s"
    }`;
  summary.nextAction = summary.outcome === "healthy"
    ? "Wait for the next scheduled run"
    : "Inspect the runtime failure diagnostics";
  if (source !== undefined) {
    const http = source.httpStatus === null
      ? "received no HTTP response"
      : `returned HTTP ${source.httpStatus}`;
    detail = `GitHub issue listing for ${source.target} ${http}`;
    summary.reasonCode = `issue_source_${source.stage}_error`;
    if (source.code === "malformed_json") {
      detail += " but its JSON was malformed";
    } else if (source.code === "bound_exceeded") {
      detail += ` but ${
        source.issueNumber === undefined
          ? "the response"
          : `issue #${source.issueNumber}`
      } exceeded ${
        source.limit === undefined
          ? "a contract"
          : `the ${source.limit}-character`
      } bound`;
    } else if (source.stage === "validation") {
      detail += ` but failed validation (${source.code})`;
    }
    summary.nextAction = source.code === "bound_exceeded"
      ? "Correct the unsupported issue fields or install a runtime with the appropriate bound"
      : "Check GitHub issue-source access and response diagnostics";
  } else if (summary.reasonCode === "source_error") {
    detail = "an intake source was unavailable";
    summary.nextAction = "Inspect the issue and incident source diagnostics";
  } else if (summary.reasonCode === "state_error") {
    detail = "the repair state could not be trusted";
  }
  if (skipped > 0) {
    detail += `; skipped ${skipped} issue${
      skipped === 1 ? "" : "s"
    } exceeding contract bounds`;
    if (summary.outcome === "healthy") {
      summary.nextAction = "Correct the skipped issue fields";
    }
  }
  summary.explanation =
    `${label} on ${generation} ${outcome}: ${detail}; next: ${
      summary.nextAction.charAt(0).toLowerCase()
    }${summary.nextAction.slice(1)}.`;
}
