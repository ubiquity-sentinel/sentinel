/** Hosted actions-supervisor-host responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import { SELF_TOKEN_ENV } from "./hosted-app-grant.ts";
import { HOSTED_CONTROLLER_SELF } from "../contracts/hosted-controller-deployment.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type {
  Clock,
  ReleaseStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import { portOk, SystemClock } from "../contracts/ports.ts";
import {
  COOLDOWN_MODE_ENV,
  type CooldownModeV1,
  parseCooldownModeV1,
} from "../contracts/cooldown-mode.ts";
import {
  checkReviewTaskStatement,
  reviewTaskStatementDigest,
} from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { HostedSupervisorGitHubClient } from "./actions-supervisor-install-api.ts";
import { hostedOrdinaryAdmitted } from "../contracts/hosted-supervisor-verification.ts";
import { fetchHttpTransport } from "../github/http.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import type { ReplayRuntimeV1 } from "../replay/runtime.ts";
import { createReleaseStateStore, DenoGitRunner } from "../state/mod.ts";
import { HostedSupervisorCooldownGate } from "./hosted-cooldown.ts";
import { createActionsMatrixArtifactTransport } from "./matrix-artifacts.ts";
import { emitRunSummary, type RunSummaryDepsV1 } from "./run-summary.ts";
import type { MatrixArtifactTransportV1 } from "./matrix-artifact-port.ts";
import {
  parseHostedEnvironment,
  readCleanGitHead,
  readHostedIdentityEnv,
} from "./hosted-runtime.ts";
import type { HostedRuntimeJobV1 } from "./hosted-runtime.ts";
import { ensurePrivateDir, githubGitAuthEnv, joinPath } from "./local.ts";
import type {
  HostedSupervisorEvidencePortV1,
  HostedSupervisorOutcomeV1,
} from "./actions-supervisor-state.ts";
import {
  ensureHostedReleaseState,
  REMOTE_URL,
  STATIC_TOKEN,
  SUPERVISOR_TOKEN_ENV,
} from "./actions-supervisor-bootstrap.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "./actions-supervisor-controller.ts";

export function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 &&
    !/[\p{Cc}]/u.test(value);
}

/** The self installation owns release state; the foreign target token cannot. */
export function releaseStateToken(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const token = env[SELF_TOKEN_ENV];
  if (!isToken(token)) throw new Error(STATIC_TOKEN);
  return token;
}

// ---------------------------------------------------------------------------
// Production composition: prepare/finalize over the existing core.
// ---------------------------------------------------------------------------

const SUPERVISOR_REPOSITORY: RepositoryIdentityV1 = HOSTED_CONTROLLER_SELF;

const NATIVE_TOKEN_ENV = "GITHUB_TOKEN";

const OUTPUT_ENV = "GITHUB_OUTPUT";
/** Finalize's run summary (#178) appends Markdown here when Actions sets it. */
const STEP_SUMMARY_ENV = "GITHUB_STEP_SUMMARY";

const PATH_ENV = "PATH";

export const STATIC_SOURCE_CHECKOUT =
  "hosted supervisor source checkout is not the exact clean revision";

export const STATIC_JOB = "hosted supervisor job identity is invalid";

export const STATIC_OUTPUT = "hosted supervisor prepare output is unavailable";

export const STATIC_RESULT = "hosted supervisor run result is unavailable";

export interface HostedSupervisorHostInputV1 {
  env: Readonly<Record<string, string | undefined>>;
  sourceDir: string;
  clock: Clock;
  http: HttpTransportV1;
  state: StateReadView & ReleaseStateWriter;
  process: ReplayRuntimeV1;
  /** Existing read-only transport seam; production constructs its native adapter. */
  ownerStartupRecoveryOnly?: boolean;
  matrixArtifacts?: Pick<
    MatrixArtifactTransportV1,
    "confirmCompletedExecution"
  >;
  /** Prepare-only exact output writer; one key=value record per call. */
  writeOutput?: (name: string, value: string) => Promise<void>;
  /**
   * Finalize only (#178): print one run-level summary of the run attempt's
   * runtime jobs and append it to the step summary. Advisory; absent, no
   * job log is read.
   */
  runSummary?: Pick<
    RunSummaryDepsV1,
    "log" | "stepSummaryPath" | "appendFile"
  >;
}

export interface HostedSupervisorHostResultV1 {
  job: HostedRuntimeJobV1;
  status: HostedSupervisorOutcomeV1["status"];
  run: boolean;
  revision: GitSha | null;
  execution: HostedExecutionIntentV1 | null;
  detail: string;
}

/** Only the protected prepare/finalize jobs are accepted here. */
function supervisorJob(value: string | undefined): HostedRuntimeJobV1 {
  if (value === "prepare" || value === "finalize") return value;
  throw new Error(STATIC_JOB);
}

/**
 * Real production composition: exact native identity and the clean protected
 * source are proved BEFORE any auth, API, output or state work, then the
 * existing core prepare/finalize runs with the authenticated native client
 * behind the shared cooldown gate. Prepare writes `run`/`revision`/`modelStartsEnabled`;
 * finalize writes no outputs and never starts a model.
 */
export async function runHostedSupervisorHost(
  input: HostedSupervisorHostInputV1,
): Promise<HostedSupervisorHostResultV1> {
  const job = supervisorJob(input.env.GITHUB_JOB);
  const identity = parseHostedEnvironment(input.env, job);
  const head = await readCleanGitHead(input.process, input.sourceDir);
  if (head !== identity.launcherSha) throw new Error(STATIC_SOURCE_CHECKOUT);
  // The prepare output sink must exist BEFORE any core, API or state work.
  const writeOutput = input.writeOutput;
  if (job === "prepare" && writeOutput === undefined) {
    throw new Error(STATIC_OUTPUT);
  }
  const nativeToken = input.env[NATIVE_TOKEN_ENV];
  if (!isToken(nativeToken)) throw new Error(STATIC_TOKEN);

  // The enforcement mode is injected with the rest of the trusted host input
  // and parsed strictly: an absent or empty setting enforces, and any other
  // unrecognised value fails here, before a single request is gated.
  const cooldownMode: CooldownModeV1 = parseCooldownModeV1(
    input.env[COOLDOWN_MODE_ENV],
  );
  const gate = new HostedSupervisorCooldownGate({
    state: input.state,
    clock: input.clock,
    mode: cooldownMode,
  });
  const client = new HostedSupervisorGitHubClient({
    repository: { ...SUPERVISOR_REPOSITORY },
    apiBaseUrl: "https://api.github.com",
    http: input.http,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${nativeToken}`)),
    },
    cooldownGate: gate,
    clock: input.clock,
  });
  const evidence: HostedSupervisorEvidencePortV1 = {
    readExecution: (saved) => client.readHostedExecution(saved),
    confirmCompletedExecution: async (saved) => {
      if (input.matrixArtifacts !== undefined) {
        return await input.matrixArtifacts.confirmCompletedExecution?.(
          saved,
        ) ===
          true;
      }
      const artifactRoot = await Deno.makeTempDir({
        dir: joinPath(input.sourceDir, ".."),
        prefix: "sentinel-supervisor-completion-",
      });
      try {
        const transport = createActionsMatrixArtifactTransport({
          state: input.state,
          token: nativeToken,
          http: input.http,
          clock: input.clock,
          artifactRoot,
        });
        return await transport.confirmCompletedExecution?.(saved) === true;
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    },
    verifyRevision: (revision) => client.verifyHostedRevision(revision),
    verifyAncestor: (ancestor, descendant) =>
      client.verifyAncestor(ancestor, descendant),
    verifyLauncherCi: (revision) => client.verifyLauncherCi(revision),
    verifyMatrixOrdinaryRevision: (revision) =>
      client.verifyMatrixOrdinaryRevision(revision),
    verifyRequest: (request) => client.verifyHostedReleaseRequest(request),
    // The trusted source-issue statement is read over the same authenticated
    // native client (and the same cooldown gate) as every other supervisor
    // read, immediately before the release authorization it feeds. An
    // unreadable, malformed or over-bound issue is not a statement.
    readIssueTask: async (issueNumber: number) => {
      const issue = await client.readIssue(issueNumber);
      if (!issue.ok) return issue;
      if (issue.value === null) return portOk(null);
      const checked = await checkReviewTaskStatement({
        issueNumber: issue.value.number,
        title: issue.value.title,
        body: issue.value.body,
        digest: await reviewTaskStatementDigest({
          issueNumber: issue.value.number,
          title: issue.value.title,
          body: issue.value.body,
        }),
      });
      return portOk(checked.ok ? checked.statement : null);
    },
  };
  const core = {
    clock: input.clock,
    state: input.state,
    run: {
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      launcherSha: identity.launcherSha,
    },
    evidence,
    ownerStartupRecoveryOnly: input.ownerStartupRecoveryOnly,
  };
  const outcome = job === "prepare"
    ? await runHostedSupervisorPrepare(core)
    : await runHostedSupervisorFinalize(core);
  if (job === "finalize") {
    if (input.runSummary !== undefined) {
      await emitRunSummary({
        ...input.runSummary,
        readJobs: (runId, runAttempt, select) =>
          client.readRunJobSummaries(runId, runAttempt, select),
        // The wedge report v0 (C5.5): one bounded advisory repair-state read.
        readRepair: () => input.state.readRepair(),
        now: () => input.clock.now(),
      }, { runId: identity.runId, runAttempt: identity.runAttempt });
    }
    return {
      job,
      status: outcome.status,
      run: false,
      revision: null,
      execution: null,
      // An `idle` outcome carries its own bounded reason; collapsing it to the
      // bare word made "the supervisor does nothing" undiagnosable.
      detail: outcome.status === "run" ? "run" : outcome.detail,
    };
  }
  if (writeOutput === undefined) throw new Error(STATIC_OUTPUT);
  if (outcome.status !== "run") {
    await writeOutput("run", "false");
    await writeOutput("executionPurpose", "");
    await writeOutput("generation", "");
    return {
      job,
      status: outcome.status,
      run: false,
      revision: null,
      execution: null,
      detail: outcome.detail,
    };
  }
  if (!isGitSha(outcome.execution.revision)) throw new Error(STATIC_RESULT);
  await writeOutput("run", "true");
  await writeOutput("revision", outcome.execution.revision);
  await writeOutput("executionPurpose", outcome.execution.purpose);
  await writeOutput("generation", String(outcome.execution.generation));
  // Only ordinary work with the exact current healthy pointer may fan out.
  // Verification retains the installed runtime's existing repair entrypoint.
  let modelStartsEnabled = false;
  if (outcome.execution.purpose === "ordinary") {
    const current = await input.state.readRelease();
    if (!current.ok || current.value.status !== "found") {
      throw new Error(STATIC_RESULT);
    }
    const runtimes = current.value.snapshot.hostedRuntimes;
    const runtime = runtimes.length === 1 ? runtimes[0] : undefined;
    if (
      runtime === undefined || runtime.execution === null ||
      canonicalStringify(runtime.execution) !==
        canonicalStringify(outcome.execution) ||
      runtime.activeRevision !== outcome.execution.revision ||
      runtime.generation !== outcome.execution.generation
    ) {
      throw new Error(STATIC_RESULT);
    }
    modelStartsEnabled = hostedOrdinaryAdmitted(runtime);
  }
  await writeOutput("modelStartsEnabled", String(modelStartsEnabled));
  return {
    job,
    status: "run",
    run: true,
    revision: outcome.execution.revision,
    execution: outcome.execution,
    detail: "run",
  };
}

/**
 * Production entrypoint: named native environment only, source proof before
 * credentials/scratch, release state through the App Git token, and the native
 * GITHUB_TOKEN for every authenticated API request behind the shared cooldown
 * gate. No model token, no environment dump and no App private key.
 */
export async function main(): Promise<void> {
  if (
    Deno.args.length > 1 ||
    (Deno.args.length === 1 && Deno.args[0] !== "--owner-startup-recovery-only")
  ) {
    throw new Error("hosted supervisor arguments are invalid");
  }
  const env: Record<string, string | undefined> = {
    ...readHostedIdentityEnv(),
    [PATH_ENV]: Deno.env.get(PATH_ENV),
    [NATIVE_TOKEN_ENV]: Deno.env.get(NATIVE_TOKEN_ENV),
    [SUPERVISOR_TOKEN_ENV]: Deno.env.get(SUPERVISOR_TOKEN_ENV),
    [SELF_TOKEN_ENV]: Deno.env.get(SELF_TOKEN_ENV),
    [OUTPUT_ENV]: Deno.env.get(OUTPUT_ENV),
    [COOLDOWN_MODE_ENV]: Deno.env.get(COOLDOWN_MODE_ENV),
  };
  const job = supervisorJob(env.GITHUB_JOB);
  const identity = parseHostedEnvironment(env, job);
  const process = new DenoReplayRuntime(Deno.execPath());
  const sourceDir = Deno.cwd();
  // Exact clean protected source BEFORE credentials, scratch, API or output.
  const head = await readCleanGitHead(process, sourceDir);
  if (head !== identity.launcherSha) throw new Error(STATIC_SOURCE_CHECKOUT);

  const path = env[PATH_ENV];
  const nativeToken = env[NATIVE_TOKEN_ENV];
  const appToken = env[SUPERVISOR_TOKEN_ENV];
  const selfToken = releaseStateToken(env);
  if (
    !isToken(nativeToken) || !isToken(appToken) ||
    typeof path !== "string" || path.length === 0
  ) {
    throw new Error(STATIC_TOKEN);
  }
  // The prepare output sink is validated before any scratch or state write.
  let writeOutput: ((name: string, value: string) => Promise<void>) | undefined;
  if (job === "prepare") {
    const outputPath = env[OUTPUT_ENV];
    if (typeof outputPath !== "string" || outputPath.length === 0) {
      throw new Error(STATIC_OUTPUT);
    }
    writeOutput = async (name, value) => {
      await Deno.writeTextFile(outputPath, `${name}=${value}\n`, {
        append: true,
        create: false,
      });
    };
  }

  const sentinelDir = joinPath(sourceDir, ".sentinel");
  const scratch = joinPath(sentinelDir, "state-scratch");
  const gitHome = joinPath(sentinelDir, "state-git-home");
  await ensurePrivateDir(scratch);
  await ensurePrivateDir(gitHome);
  // Release state lives in the self repository after the org migration; the
  // target-token scope intentionally excludes that repository.
  const state = createReleaseStateStore({
    scratchDir: scratch,
    remoteUrl: REMOTE_URL,
    runner: new DenoGitRunner(gitHome, githubGitAuthEnv(selfToken)),
  });
  const clock = new SystemClock();
  await ensureHostedReleaseState(state, clock.now());
  const result = await runHostedSupervisorHost({
    env,
    sourceDir,
    clock,
    http: fetchHttpTransport(),
    state,
    process,
    writeOutput,
    ownerStartupRecoveryOnly: Deno.args[0] === "--owner-startup-recovery-only",
    runSummary: job === "finalize"
      ? { stepSummaryPath: Deno.env.get(STEP_SUMMARY_ENV) }
      : undefined,
  });
  // Bounded trusted result only; no raw error or credential is ever logged.
  console.log(JSON.stringify({
    job: result.job,
    status: result.status,
    run: result.run,
    revision: result.revision,
    execution: result.execution,
    detail: result.detail,
  }));
}
