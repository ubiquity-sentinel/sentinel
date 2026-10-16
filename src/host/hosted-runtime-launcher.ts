/** Hosted hosted-runtime-launcher responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { parseHostedRuntimeTerminalV1 } from "../contracts/hosted-execution.ts";
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
  readHostedRuntimeExecution,
  unavailableResult,
} from "./hosted-runtime-identity.ts";
import type {
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
} from "./hosted-runtime-status.ts";
import type { ChildStatusV1 } from "./hosted-runtime-status.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { runRepairOwnerWithReviewCustody } from "./review-owner-custody.ts";
import type { HostedReviewOwnerSettlementV1 } from "../github/review-owner-evidence.ts";

/**
 * Verify the launcher and runtime checkouts as clean worktrees at their exact
 * commits, read the saved execution, run the fixed child entrypoint through the
 * injected owned-group border and settle the one trusted terminal. Any
 * unsettled, truncated, thrown or unattestable result is unavailable with NO
 * terminal; a settled nonzero exit without a child result is an honest failure.
 */
export async function runHostedRuntimeLauncher(
  input: HostedRuntimeLauncherInputV1,
): Promise<HostedRuntimeLauncherResultV1> {
  let result = unavailableResult();
  try {
    result = await launchHostedRuntime(input);
  } catch {
    result = unavailableResult();
  }
  try {
    await input.reviewCustody?.dispose();
  } catch {
    return unavailableResult();
  }
  return result;
}

async function launchHostedRuntime(
  input: HostedRuntimeLauncherInputV1,
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

  const execution = await readHostedRuntimeExecution({
    state: input.state,
    identity,
    controllerSha: runtimeHead,
  });
  if (execution.revision !== runtimeHead) {
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
  const childEnv = buildChildEnvironment(input.env, identity, {
    home: childHome,
    tmp: childTmp,
    denoDir: childDenoDir,
  }, startedAt);
  // Streaming is attached only here, after the exact execution identity has
  // been verified, and only to the actual child command: the bounded Git
  // identity reads above never see a sink.
  const diagnosticStream = input.onDiagnostic === undefined
    ? undefined
    : createHostedDiagnosticStream(execution, input.onDiagnostic);

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
      identity.job === "repair"
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
  const finishedAt = input.clock.now();
  // A backward or invalid clock is a refusal: no terminal instant is ever
  // fabricated to hide it.
  if (!isNonNegativeSafeInteger(finishedAt) || finishedAt < startedAt) {
    return unavailableResult();
  }
  if (identity.job === "matrix_plan" || identity.job === "matrix_cell") {
    return resolveMatrixLauncherResult(run, execution, identity.job, stdin);
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
  if (earlyFailure === null) return withRefusals;
  return { ...withRefusals, earlyFailure };
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
