/**
 * EXPERIMENTAL manual agent-job lane: one Actions cell.
 *
 * Runs the cell's jobs side by side on one runner. For each job the host
 * clones the target with a read-only token, runs the job's setup commands and
 * starts `codex exec` with no sandbox: the agent has the runner's full
 * filesystem, toolchains and network for up to the cell's six-hour window.
 * The host commits whatever the agent left uncommitted and seals the branch
 * into a Git bundle. The cell holds no write credential;
 * `agent-jobs-publish.ts` pushes the bundles from a separate job.
 *
 * Agent output is kept out of the job log and the artifact (targets may be
 * private while this controller is public); only the bundle, the agent's
 * final message and a status row leave the runner.
 */
import {
  cloneBranch,
  configureCheckoutIdentity,
  git,
  githubRemoteUrl,
  gitOk,
  type RemoteUrl,
} from "./agent-jobs-git.ts";
import { AGENT_JOB_SHA } from "./agent-jobs-admission.ts";
import {
  startTraceProxy,
  type TraceProxy,
  type TraceSummaryV1,
} from "./agent-jobs-trace-proxy.ts";
import {
  AGENT_JOBS_MAX_MINUTES,
  type AgentJobReasoningEffort,
  type AgentJobsPlanV1,
  type AgentJobV1,
  resolveAgentJobReasoningEffort,
} from "./agent-jobs-plan.ts";

export const AGENT_JOB_BRANCH = "agent-job";
/**
 * Every agent of a request starts three seconds after the previous one (first
 * slot of every cell, then the second slot of every cell...), so the gateway
 * never sees a burst of session starts.
 */
export const START_STAGGER_SECONDS = 3;
/** In-session retries of a 429/5xx; verified to be honored by Codex 0.169. */
const MODEL_MAX_RETRIES = 12;
const MODEL_PROVIDER = "uos";
const KILL_GRACE_SECONDS = 30;
/** Leave time for command teardown and host result assembly. */
const WORK_EXIT_RESERVE_SECONDS = KILL_GRACE_SECONDS + 5;
/**
 * Codex exits with this line once it gives up on HTTP 429 (measured against a
 * local endpoint: 0.154 after one request, 0.169 after its retry budget). The
 * gateway answers bursts and exhausted account pools with 429, so the cell
 * backs off and restarts the agent inside the job deadline.
 */
const RATE_LIMITED_MARKER = "exceeded retry limit, last status: 429";
export const RATE_LIMIT_BACKOFF_SECONDS = 60;
export const RATE_LIMIT_BACKOFF_MAX_SECONDS = 300;
const RESTART_NOTE =
  "\n\n(Note: an earlier attempt at this task was cut off by a model rate limit. The working tree may already hold partial work; inspect it and continue.)";

/**
 * Codex exits with this line when the model stream drops mid-response and its
 * own reconnects are used up (seen after 30-40 minutes on long max-effort
 * turns through the public gateway). The work so far is on disk, so the cell
 * restarts the agent in the same checkout instead of ending the job.
 */
/** Seconds between liveness lines of a running agent. */
export const HEARTBEAT_SECONDS = 300;
/**
 * Every Nth liveness line is also raised as a notice annotation. The API does
 * not serve the log of a running job, but it does serve its annotations, so
 * this is the only view of a running agent from outside the Actions page. A
 * step keeps ten notices: the first line and every seventh after it cover a
 * full 350 minute job.
 */
export const HEARTBEAT_NOTICE_EVERY = 7;
/** Every Nth liveness line also publishes the job's progress text. */
export const HEARTBEAT_PROGRESS_EVERY = 3;
/** A liveness line as a workflow command that raises a notice annotation. */
export function heartbeatNotice(id: string, line: string): string {
  const data = line.replace(/%/g, "%25").replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  return `::notice title=agent ${id.replace(/[^a-z0-9-]/g, "")}::${data}`;
}
const DISCONNECTED_MARKER = "stream disconnected before completion";
export const DISCONNECT_BACKOFF_SECONDS = 15;
/** Restarts after dropped streams per job; the job deadline still applies. */
export const DISCONNECT_RESTART_LIMIT = 40;
const DISCONNECT_NOTE =
  "\n\n(Note: an earlier attempt at this task was cut off by a dropped model connection. The working tree may already hold partial work, including commits; inspect it and continue from there. Commit small steps often.)";

type Interruption = "rate_limit" | "disconnect" | null;

async function interruption(errFile: string): Promise<Interruption> {
  const text = await Deno.readTextFile(errFile).catch(() => "");
  const tail = text.slice(-4000);
  if (tail.includes(RATE_LIMITED_MARKER)) return "rate_limit";
  if (tail.includes(DISCONNECTED_MARKER)) return "disconnect";
  return null;
}

/**
 * The client's own last error line, so a failed job can be diagnosed without
 * the transcript. Only lines the client marks as errors are considered, long
 * token-like runs are redacted, and the result is capped.
 */
/**
 * One liveness line for a running agent: what it has committed, what is
 * uncommitted, and how long ago it last produced output. A job's log is the
 * only view into a runner while it works, so a silent multi-hour job cannot be
 * told apart from a stuck one without these. Subjects are cut short and long
 * tokens redacted; the line never includes agent output.
 */
export async function agentHeartbeat(probe: {
  id: string;
  checkout: string;
  baseSha: string;
  logFile: string;
  startedAtMs: number;
  restarts: number;
}): Promise<string> {
  const run = async (args: string[]) => {
    const done = await new Deno.Command("git", {
      // A background status must leave the index lock available to the agent and host.
      args: ["--no-optional-locks", ...args],
      cwd: probe.checkout,
      stdout: "piped",
      stderr: "null",
    }).output().catch(() => null);
    return done === null || done.code !== 0
      ? ""
      : new TextDecoder().decode(done.stdout).trim();
  };
  const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));
  const now = Date.now();
  const commits = await run(["rev-list", "--count", `${probe.baseSha}..HEAD`]);
  const last = await run(["log", "-1", "--format=%h %ct %s"]);
  const dirty = (await run(["status", "--porcelain"])).split("\n")
    .filter((line) => line.length > 0).length;
  let lastCommit = "none";
  if (commits !== "" && commits !== "0" && last !== "") {
    const [sha, epoch, ...subject] = last.split(" ");
    const text = subject.join(" ").replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>")
      .slice(0, 60);
    lastCommit = `${sha} ${minutes(now - Number(epoch) * 1000)}m ago "${text}"`;
  }
  let bytes = 0;
  let quietMs = now - probe.startedAtMs;
  for (const path of [probe.logFile, `${probe.logFile}.err`]) {
    const stat = await Deno.stat(path).catch(() => null);
    if (stat === null) continue;
    bytes += stat.size;
    if (stat.mtime !== null) {
      quietMs = Math.min(quietMs, now - stat.mtime.getTime());
    }
  }
  return `${probe.id}: alive ${minutes(now - probe.startedAtMs)}m, ` +
    `restarts ${probe.restarts}, commits ${commits === "" ? "?" : commits} ` +
    `(last ${lastCommit}), uncommitted files ${dirty}, ` +
    `agent output ${Math.round(bytes / 1024)} KiB, ` +
    `quiet ${Math.round(quietMs / 1000)}s`;
}

/**
 * The distinct client error and reconnect lines of one agent attempt, most
 * frequent first, with counts. Only lines the client itself marks as an error,
 * warning or reconnect are kept, cut short and with long tokens redacted, so
 * the summary can be published with the result.
 */
export async function agentErrorLines(
  errFile: string,
  limit = 20,
): Promise<{ line: string; count: number }[]> {
  const text = await Deno.readTextFile(errFile).catch(() => "");
  const counts = new Map<string, number>();
  for (const raw of text.slice(-400_000).split("\n")) {
    const line = raw.replaceAll(String.fromCharCode(27), "")
      .replace(/\[[0-9;]*m/g, "").trim();
    if (
      !/^(error|warn|warning|fatal|panic)\b|reconnect|stream (disconnected|error)|retry limit|status:? \d{3}/i
        .test(line)
    ) continue;
    const key = line.replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>")
      .replace(/\d+\/\d+/g, "N/N").replace(/\s+/g, " ").slice(0, 200);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit)
    .map(([line, count]) => ({ line, count }));
}

export async function agentFailureReason(errFile: string): Promise<string> {
  const text = await Deno.readTextFile(errFile).catch(() => "");
  const lines = text.slice(-16000).split("\n")
    .map((line) =>
      line.replaceAll(String.fromCharCode(27), "").replace(/^\[[0-9;]*m/, "")
        .trim()
    )
    .filter((line) => /^(error|fatal|panic)\b/i.test(line));
  const last = lines.at(-1);
  if (last === undefined) return "";
  return last.replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>")
    .replace(/\s+/g, " ").slice(0, 300);
}

export type AgentJobStatus =
  | "changed"
  | "no_changes"
  | "timed_out"
  | "agent_failed"
  | "setup_failed"
  | "host_failed";

export interface AgentJobResultV1 {
  id: string;
  repository: string;
  /** Resolved base branch and its commit; null when the clone failed. */
  base: string | null;
  baseSha: string | null;
  status: AgentJobStatus;
  /** Committed agent work, present for `changed` and a `timed_out` remainder. */
  headSha: string | null;
  bundle: string | null;
  elapsedSeconds: number;
  pr: boolean;
  title: string;
  detail: string;
}

export interface AgentJobsCellResultV1 {
  schema: "sentinel.agent-jobs.cell-result/v1";
  cellId: string;
  results: AgentJobResultV1[];
}

/** Paths and settings one agent process is started with. */
export interface AgentStartV1 {
  job: AgentJobV1;
  checkout: string;
  clientHome: string;
  model: string;
  reasoningEffort: AgentJobReasoningEffort;
  lastMessageFile: string;
}

export interface AgentJobsCellPorts {
  remoteUrl: RemoteUrl;
  /** Argument vector of the agent process; tests substitute a fake agent. */
  agentCommand: (start: AgentStartV1) => string[];
  /** Write the Codex client home (config and model token). */
  prepareClient: (start: AgentStartV1) => Promise<void>;
  /** The runner environment handed to setup commands and agents. */
  agentEnv: () => Record<string, string>;
  now?: () => number;
  sleep: (seconds: number) => Promise<void>;
  log: (line: string) => void;
  /**
   * Publish a job's progress text where it can be read while the cell runs.
   * `sequence` starts at 1 and makes each publication distinct. Optional;
   * failures are ignored.
   */
  publishProgress?: (
    jobId: string,
    sequence: number,
    text: string,
  ) => Promise<void>;
  /** The job's model requests as seen by the trace proxy. Optional. */
  requestTrace?: (jobId: string) => TraceSummaryV1;
}

export interface AgentJobsCellInput {
  plan: AgentJobsPlanV1;
  cellId: string;
  workRoot: string;
  outDir: string;
  readToken: string | null;
  defaultModel: string;
  /** Epoch ms after which the cell must be committing, not running agents. */
  deadlineAtMs: number;
  /** Seconds between liveness lines for a running agent; default 300. */
  heartbeatSeconds?: number;
  ports: AgentJobsCellPorts;
}

async function bounded(
  argv: string[],
  options: {
    seconds: number;
    cwd: string;
    env: Record<string, string>;
    stdin: string | null;
    logFile: string;
    /** Called at this interval while the command runs; failures are ignored. */
    heartbeat?: { seconds: number; emit: () => Promise<void> };
  },
): Promise<{ code: number; timedOut: boolean }> {
  // coreutils timeout runs the command in its own process group and signals
  // the whole group, so a deadline also ends the agent's child processes.
  const sink = (path: string) =>
    Deno.open(path, { create: true, append: true, write: true });
  const [out, err] = [
    await sink(options.logFile),
    await sink(`${options.logFile}.err`),
  ];
  const child = new Deno.Command("timeout", {
    args: [
      `--kill-after=${KILL_GRACE_SECONDS}`,
      `${options.seconds}s`,
      ...argv,
    ],
    cwd: options.cwd,
    clearEnv: true,
    env: options.env,
    stdin: options.stdin === null ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (options.stdin !== null) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  const beat = options.heartbeat;
  let beating = false;
  const timer = beat === undefined ? null : setInterval(() => {
    if (beating) return;
    beating = true;
    beat.emit().catch(() => {}).finally(() => {
      beating = false;
    });
  }, beat.seconds * 1000);
  const [status] = await Promise.all([
    child.status,
    child.stdout.pipeTo(out.writable),
    child.stderr.pipeTo(err.writable),
  ]).finally(() => {
    if (timer !== null) clearInterval(timer);
  });
  return {
    code: status.code,
    timedOut: status.code === 124 || status.code === 137,
  };
}

function titleOf(job: AgentJobV1): string {
  const line = job.prompt.trim().split("\n")[0].trim();
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}

async function runJob(
  input: AgentJobsCellInput,
  job: AgentJobV1,
  startDelaySeconds: number,
): Promise<AgentJobResultV1> {
  const { ports } = input;
  const now = ports.now ?? Date.now;
  const started = now();
  const createdAtMs = input.plan.createdAtMs;
  const admitted = createdAtMs !== undefined;
  const workDeadlineAtMs = admitted
    ? Math.min(input.deadlineAtMs, createdAtMs + job.minutes * 60_000)
    : input.deadlineAtMs;
  const remainingSeconds = () => {
    const seconds = Math.floor((workDeadlineAtMs - now()) / 1000);
    return admitted
      ? Math.max(0, seconds - WORK_EXIT_RESERVE_SECONDS)
      : Math.max(1, seconds);
  };
  const result: AgentJobResultV1 = {
    id: job.id,
    repository: job.repository,
    base: null,
    baseSha: null,
    status: "host_failed",
    headSha: null,
    bundle: null,
    elapsedSeconds: 0,
    pr: job.pr,
    title: titleOf(job),
    detail: "",
  };
  const settle = (status: AgentJobStatus, detail: string) => {
    result.status = status;
    result.detail = detail;
    result.elapsedSeconds = Math.round((now() - started) / 1000);
    ports.log(`${job.id}: ${status}${detail ? ` (${detail})` : ""}`);
    return result;
  };
  const root = `${input.workRoot}/${job.id}`;
  const checkout = `${root}/checkout`;
  const tmpDir = `${root}/tmp`;
  try {
    if (
      admitted &&
      (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0 ||
        createdAtMs > started)
    ) throw new Error("job admission time is invalid");
    if (remainingSeconds() === 0) {
      return settle("timed_out", "work deadline before checkout");
    }
    const reasoningEffort = resolveAgentJobReasoningEffort(
      job.reasoningEffort,
      job.id,
    );
    await Deno.mkdir(tmpDir, { recursive: true });
    const base = await cloneBranch({
      url: ports.remoteUrl(job.repository),
      base: job.base,
      directory: checkout,
      token: input.readToken,
    });
    if (
      job.baseSha !== undefined &&
      (job.base !== base.branch || !AGENT_JOB_SHA.test(job.baseSha))
    ) throw new Error("job base does not match the admitted plan");
    const baseSha = job.baseSha ?? base.sha;
    await gitOk(["checkout", "--quiet", "-b", AGENT_JOB_BRANCH, baseSha], {
      cwd: checkout,
    });
    result.base = base.branch;
    result.baseSha = baseSha;
    await configureCheckoutIdentity(checkout);

    const env = { ...ports.agentEnv(), TMPDIR: tmpDir };
    for (const command of job.setup) {
      const seconds = remainingSeconds();
      if (seconds === 0) {
        return settle("timed_out", "work deadline before setup");
      }
      const setup = await bounded(["bash", "-c", command], {
        seconds,
        cwd: checkout,
        env,
        stdin: null,
        logFile: `${root}/setup.log`,
      });
      if (admitted && setup.timedOut) {
        return settle("timed_out", "work deadline during setup");
      }
      if (setup.code !== 0) {
        return settle("setup_failed", `exit ${setup.code}: ${command}`);
      }
    }

    const start: AgentStartV1 = {
      job,
      checkout,
      clientHome: `${root}/client`,
      model: job.model ?? input.defaultModel,
      reasoningEffort,
      lastMessageFile: `${root}/last-message.md`,
    };
    if (admitted && remainingSeconds() <= startDelaySeconds) {
      return settle("timed_out", "work deadline before model stagger");
    }
    await ports.sleep(startDelaySeconds);
    if (remainingSeconds() === 0) {
      return settle("timed_out", "work deadline before preparing model");
    }
    await ports.prepareClient(start);
    const deadlineSeconds = Math.min(job.minutes * 60, remainingSeconds());
    let spentSeconds = 0;
    const canWait = (wait: number) =>
      admitted
        ? wait < remainingSeconds()
        : spentSeconds + wait < deadlineSeconds;
    const jobStartedAtMs = now();
    let attempt = 0;
    let limited = false;
    let rateLimitAttempts = 0;
    let disconnects = 0;
    let restartNote = "";
    const telemetry = {
      schema: "sentinel.agent-jobs.telemetry/v1",
      id: job.id,
      attempts: [] as {
        attempt: number;
        seconds: number;
        exitCode: number;
        timedOut: boolean;
        cause: string;
        errors: { line: string; count: number }[];
      }[],
      heartbeats: [] as string[],
      requests: null as TraceSummaryV1 | null,
    };
    let agent = { code: 124, timedOut: true };
    for (;;) {
      const seconds = admitted
        ? remainingSeconds()
        : Math.max(1, deadlineSeconds - spentSeconds);
      if (seconds === 0) {
        agent = { code: 124, timedOut: true };
        break;
      }
      const logFile = `${root}/agent-${attempt}.log`;
      const attemptStarted = now();
      agent = await bounded(ports.agentCommand(start), {
        seconds,
        cwd: checkout,
        env: { ...env, CODEX_HOME: start.clientHome },
        stdin: job.prompt + restartNote,
        logFile,
        heartbeat: {
          seconds: input.heartbeatSeconds ?? HEARTBEAT_SECONDS,
          emit: async () => {
            const line = await agentHeartbeat({
              id: job.id,
              checkout,
              baseSha,
              logFile,
              startedAtMs: jobStartedAtMs,
              restarts: attempt,
            });
            const traced = ports.requestTrace?.(job.id);
            const modelLine = traced === undefined
              ? null
              : `${job.id}: model requests ${traced.requests}, ` +
                `model time ${Math.round(traced.modelSeconds / 60)}m, ` +
                `ends ${JSON.stringify(traced.byEnd)}, ` +
                `streams without completion ${traced.incompleteStreams}`;
            telemetry.heartbeats.push(line);
            ports.log(line);
            if (modelLine !== null) ports.log(modelLine);
            if (
              (telemetry.heartbeats.length - 1) % HEARTBEAT_NOTICE_EVERY === 0
            ) {
              ports.log(heartbeatNotice(job.id, line));
            }
            const beats = telemetry.heartbeats.length;
            if (
              ports.publishProgress !== undefined &&
              (beats - 1) % HEARTBEAT_PROGRESS_EVERY === 0
            ) {
              const commits = await new Deno.Command("git", {
                args: ["log", "--format=%h %cI %s", `${baseSha}..HEAD`],
                cwd: checkout,
                stdout: "piped",
                stderr: "null",
              }).output().catch(() => null);
              const log = commits === null || commits.code !== 0
                ? "(unavailable)"
                : new TextDecoder().decode(commits.stdout)
                  .replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>");
              await ports.publishProgress(
                job.id,
                Math.floor((beats - 1) / HEARTBEAT_PROGRESS_EVERY) + 1,
                [
                  `job ${job.id}`,
                  "",
                  "liveness lines so far:",
                  ...telemetry.heartbeats,
                  "",
                  ...(traced === undefined ? [] : [
                    "model requests (trace proxy):",
                    modelLine ?? "",
                    "last streams that ended without completion " +
                    "(start time, gateway request id, how it ended, ms):",
                    ...traced.recent.filter((row) =>
                      row.end !== "complete" || row.sawCompleted === false
                    ).slice(-12).map((row) =>
                      `${row.startedAt} ${row.gatewayRequestId ?? "-"} ` +
                      `${row.end} status ${row.status} ${row.durationMs}ms` +
                      (row.streamError === null
                        ? ""
                        : ` error ${JSON.stringify(row.streamError)}`) +
                      (row.lastEvents === null
                        ? ""
                        : ` events ${row.lastEvents.join(",")}`)
                    ),
                    "",
                  ]),
                  "commits since the base, newest first:",
                  log.trim().length === 0 ? "(none)" : log.trim(),
                  "",
                ].join("\n"),
              ).catch(() => {});
            }
          },
        },
      });
      spentSeconds += (now() - attemptStarted) / 1000;
      const cause: Interruption = !agent.timedOut && agent.code !== 0
        ? await interruption(`${logFile}.err`)
        : null;
      limited = cause === "rate_limit";
      const attemptSeconds = Math.round((now() - attemptStarted) / 1000);
      const errors = await agentErrorLines(`${logFile}.err`);
      telemetry.attempts.push({
        attempt,
        seconds: attemptSeconds,
        exitCode: agent.code,
        timedOut: agent.timedOut,
        cause: cause ?? (agent.timedOut ? "deadline" : "exit"),
        errors,
      });
      const seen = errors.reduce((sum, row) => sum + row.count, 0);
      ports.log(
        `${job.id}: attempt ${attempt} ended after ${attemptSeconds}s, exit ${agent.code}, ` +
          `${seen} client error or reconnect lines` +
          (errors.length > 0
            ? `, most frequent x${errors[0].count}: ${errors[0].line}`
            : ""),
      );
      if (cause === null) break;
      if (cause === "disconnect") {
        if (disconnects >= DISCONNECT_RESTART_LIMIT) break;
        const wait = DISCONNECT_BACKOFF_SECONDS;
        if (!canWait(wait)) break;
        disconnects += 1;
        ports.log(
          `${job.id}: model stream dropped, restart ${disconnects} in ${wait}s`,
        );
        await ports.sleep(wait);
        spentSeconds += wait;
        restartNote = DISCONNECT_NOTE;
        attempt += 1;
        continue;
      }
      const wait = Math.min(
        RATE_LIMIT_BACKOFF_MAX_SECONDS,
        RATE_LIMIT_BACKOFF_SECONDS * 2 ** rateLimitAttempts,
      );
      if (!canWait(wait)) break;
      ports.log(`${job.id}: model 429, restarting in ${wait}s`);
      await ports.sleep(wait);
      spentSeconds += wait;
      restartNote = RESTART_NOTE;
      rateLimitAttempts += 1;
      attempt += 1;
    }
    await Deno.mkdir(input.outDir, { recursive: true });
    telemetry.requests = ports.requestTrace?.(job.id) ?? null;
    await Deno.writeTextFile(
      `${input.outDir}/${job.id}.telemetry.json`,
      JSON.stringify(telemetry, null, 2) + "\n",
    );
    // The model token must not outlive the agent on this runner.
    await Deno.remove(start.clientHome, { recursive: true }).catch(() => {});

    // The agent may have committed on its own; the host commits the rest.
    await gitOk(["add", "--all"], { cwd: checkout });
    const staged = await git(["diff", "--cached", "--quiet"], {
      cwd: checkout,
    });
    if (staged.code !== 0) {
      await gitOk(
        ["commit", "--quiet", "-m", `agent job ${job.id}`, "-m", result.title],
        { cwd: checkout },
      );
    }
    const head = await gitOk(["rev-parse", "HEAD"], { cwd: checkout });
    if (head !== baseSha) {
      await gitOk(["update-ref", `refs/heads/${AGENT_JOB_BRANCH}`, head], {
        cwd: checkout,
      });
      result.headSha = head;
      result.bundle = `${job.id}.bundle`;
      await gitOk([
        "bundle",
        "create",
        "--quiet",
        `${input.outDir}/${result.bundle}`,
        `${baseSha}..refs/heads/${AGENT_JOB_BRANCH}`,
      ], { cwd: checkout });
    }
    await Deno.copyFile(start.lastMessageFile, `${input.outDir}/${job.id}.md`)
      .catch(() => {});
    if (agent.timedOut) {
      return settle(
        "timed_out",
        admitted
          ? "admitted work deadline"
          : `deadline ${Math.round(deadlineSeconds / 60)} min`,
      );
    }
    if (agent.code !== 0) {
      return settle(
        "agent_failed",
        limited
          ? `model rate limited (429) through ${rateLimitAttempts + 1} attempts`
          : await (async () => {
            const reason = await agentFailureReason(
              `${root}/agent-${attempt}.log.err`,
            );
            return reason
              ? `exit ${agent.code}: ${reason}`
              : `exit ${agent.code}`;
          })(),
      );
    }
    return settle(result.headSha === null ? "no_changes" : "changed", "");
  } catch (error) {
    return settle(
      "host_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Run every job of one cell concurrently and write `result.json`. */
export async function runAgentJobsCell(
  input: AgentJobsCellInput,
): Promise<AgentJobsCellResultV1> {
  const index = input.plan.cells.findIndex((cell) =>
    cell.cellId === input.cellId
  );
  if (index < 0) throw new Error(`plan has no cell ${input.cellId}`);
  await Deno.mkdir(input.outDir, { recursive: true });
  const results = await Promise.all(
    input.plan.cells[index].jobs.map((job, slot) =>
      runJob(
        input,
        job,
        (slot * input.plan.cells.length + index) * START_STAGGER_SECONDS,
      )
    ),
  );
  const cellResult: AgentJobsCellResultV1 = {
    schema: "sentinel.agent-jobs.cell-result/v1",
    cellId: input.cellId,
    results,
  };
  await Deno.writeTextFile(
    `${input.outDir}/result.json`,
    JSON.stringify(cellResult, null, 2),
  );
  return cellResult;
}

/** Credentials of the cell process that no agent or setup command inherits. */
const WITHHELD_ENV = [
  "UOS_AI_TOKEN",
  "AGENT_JOBS_READ_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RESULTS_URL",
  "AGENT_JOBS_PROGRESS_SCRIPT",
];

export function codexExecCommand(start: AgentStartV1): string[] {
  return [
    "codex",
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    start.checkout,
    "-m",
    start.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(start.reasoningEffort)}`,
    "-o",
    start.lastMessageFile,
    "-",
  ];
}

/** CLI for `.github/workflows/agent-jobs.yml`. */
if (import.meta.main) {
  const startedAtMs = Date.now();
  const env = (name: string) => Deno.env.get(name) ?? "";
  const modelToken = env("UOS_AI_TOKEN");
  if (modelToken.length === 0) throw new Error("UOS_AI_TOKEN is not set");
  const workspace = env("GITHUB_WORKSPACE") || Deno.cwd();
  const progressScript = env("AGENT_JOBS_PROGRESS_SCRIPT");
  const baseUrl = env("SENTINEL_MODEL_BASE_URL") || "https://ai.ubq.fi/v1";
  // Telemetry only: a loopback pass-through that records each model request's
  // gateway request id and how its stream ended. Set AGENT_JOBS_TRACE_PROXY=0
  // to bypass it; if it cannot start, agents talk to the gateway directly.
  let traceProxy: TraceProxy | null = null;
  if (env("AGENT_JOBS_TRACE_PROXY") !== "0") {
    try {
      traceProxy = startTraceProxy(baseUrl);
    } catch (error) {
      console.log(`trace proxy unavailable: ${String(error).slice(0, 200)}`);
    }
  }
  const plan = JSON.parse(
    await Deno.readTextFile(env("AGENT_JOBS_PLAN")),
  ) as AgentJobsPlanV1;
  const cell = await runAgentJobsCell({
    plan,
    cellId: env("AGENT_JOBS_CELL_ID"),
    workRoot: `${env("RUNNER_TEMP") || "/tmp"}/agent-jobs`,
    outDir: `${workspace}/.agent-jobs/out`,
    readToken: null,
    defaultModel: env("SENTINEL_MODEL_ID") || "gpt-6.1-sol",
    deadlineAtMs: startedAtMs + AGENT_JOBS_MAX_MINUTES * 60_000,
    ports: {
      remoteUrl: githubRemoteUrl,
      agentCommand: codexExecCommand,
      prepareClient: async (start) => {
        await Deno.mkdir(start.clientHome, { recursive: true, mode: 0o700 });
        const tokenFile = `${start.clientHome}/model.token`;
        await Deno.writeTextFile(tokenFile, modelToken, { mode: 0o600 });
        // A newer Codex waits out a 429 by its Retry-After inside the
        // session, keeping the conversation; the cell restart is the backstop.
        await Deno.writeTextFile(
          `${start.clientHome}/config.toml`,
          [
            `model_provider = "${MODEL_PROVIDER}"`,
            `[model_providers.${MODEL_PROVIDER}]`,
            `name = "${MODEL_PROVIDER}"`,
            `base_url = ${
              JSON.stringify(traceProxy?.baseFor(start.job.id) ?? baseUrl)
            }`,
            'wire_api = "responses"',
            `request_max_retries = ${MODEL_MAX_RETRIES}`,
            `stream_max_retries = ${MODEL_MAX_RETRIES}`,
            `[model_providers.${MODEL_PROVIDER}.auth]`,
            'command = "/bin/cat"',
            `args = [${JSON.stringify(tokenFile)}]`,
            "",
          ].join("\n"),
        );
      },
      agentEnv: () => {
        const all = Deno.env.toObject();
        for (const name of WITHHELD_ENV) delete all[name];
        return all;
      },
      sleep: (seconds) =>
        new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
      log: (line) => console.log(line),
      requestTrace: traceProxy === null
        ? undefined
        : (jobId) => traceProxy.summary(jobId),
      publishProgress: progressScript.length === 0 ||
          env("ACTIONS_RUNTIME_TOKEN").length === 0
        ? undefined
        : async (jobId, sequence, text) => {
          const dir = `${env("RUNNER_TEMP") || "/tmp"}/agent-jobs-progress`;
          await Deno.mkdir(dir, { recursive: true });
          const file = `${dir}/${jobId}.progress.txt`;
          await Deno.writeTextFile(file, text);
          const name = `agent-jobs-progress-${env("GITHUB_RUN_ID")}-` +
            `${env("GITHUB_RUN_ATTEMPT")}-${jobId}-` +
            String(sequence).padStart(3, "0");
          const done = await new Deno.Command("timeout", {
            args: ["60", "node", progressScript, name, file],
            stdout: "null",
            stderr: "piped",
          }).output();
          if (done.code !== 0) {
            const reason = new TextDecoder().decode(done.stderr).trim()
              .split("\n").pop() ?? "";
            console.log(
              `${jobId}: progress publication ${sequence} failed: ` +
                reason.replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>").slice(
                  0,
                  200,
                ),
            );
          }
        },
    },
  });
  await traceProxy?.close().catch(() => {});
  const summary = env("GITHUB_STEP_SUMMARY");
  if (summary) {
    const rows = cell.results.map((row) =>
      `| ${row.id} | ${row.repository} | ${row.status} | ${
        Math.round(row.elapsedSeconds / 60)
      } min |`
    );
    await Deno.writeTextFile(
      summary,
      `| job | repository | status | elapsed |\n|---|---|---|---|\n${
        rows.join("\n")
      }\n`,
      { append: true },
    );
  }
  // A failed agent is a result, not a failed cell: publish still runs.
}
