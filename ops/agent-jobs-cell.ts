/**
 * EXPERIMENTAL manual agent-job lane: one Actions cell.
 *
 * Runs the cell's jobs side by side on one runner. For each job the trusted
 * host clones the target with a read-only token, runs the job's setup
 * commands (network on, no credential in their environment), and only then
 * writes the model token and starts `codex exec` under the same sandboxed
 * client configuration the supervisor's issue cells use: the checkout is
 * writable, `.git` is read-only, the network is off and the shell environment
 * is empty. The host commits whatever the agent changed and seals it into a
 * Git bundle. The cell holds no write credential; `agent-jobs-publish.ts`
 * pushes the bundles from a separate job.
 *
 * Agent output is kept out of the job log and the artifact (targets may be
 * private while this controller is public); only the bundle, the agent's
 * final message and a status row leave the runner.
 */
import { codexChildEnv, ensureTaskClient } from "../src/host/local-client.ts";
import { cloneBranch, git, githubRemoteUrl, gitOk } from "./agent-jobs-git.ts";
import type { RemoteUrl } from "./agent-jobs-git.ts";
import type { AgentJobsPlanV1, AgentJobV1 } from "./agent-jobs-plan.ts";

export const AGENT_JOB_BRANCH = "agent-job";
/** Starts are spread so 20 cells x N agents never hit the gateway at once. */
export const CELL_STAGGER_SECONDS = 6;
export const SLOT_STAGGER_SECONDS = 120;
const SETUP_TIMEOUT_SECONDS = 900;
const KILL_GRACE_SECONDS = 30;
/**
 * Codex 0.154 does not retry an HTTP 429 from a custom provider: it makes one
 * request and exits with this line (measured against a local endpoint; a 503
 * is retried). The gateway answers bursts and exhausted account pools with
 * 429, so the cell backs off and restarts the agent inside the job deadline.
 */
const RATE_LIMITED_MARKER = "exceeded retry limit, last status: 429";
export const RATE_LIMIT_BACKOFF_SECONDS = 60;
export const RATE_LIMIT_BACKOFF_MAX_SECONDS = 300;
const RESTART_NOTE =
  "\n\n(Note: an earlier attempt at this task was cut off by a model rate limit. The working tree may already hold partial work; inspect it and continue.)";

async function rateLimited(errFile: string): Promise<boolean> {
  const text = await Deno.readTextFile(errFile).catch(() => "");
  return text.slice(-4000).includes(RATE_LIMITED_MARKER);
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
  tmpDir: string;
  denoDir: string;
  model: string;
  lastMessageFile: string;
}

export interface AgentJobsCellPorts {
  remoteUrl: RemoteUrl;
  /** Argument vector of the agent process; tests substitute a fake agent. */
  agentCommand: (start: AgentStartV1) => string[];
  /** Write the sandboxed client home; tests need none. */
  prepareClient: (start: AgentStartV1) => Promise<void>;
  sleep: (seconds: number) => Promise<void>;
  log: (line: string) => void;
}

export interface AgentJobsCellInput {
  plan: AgentJobsPlanV1;
  cellId: string;
  workRoot: string;
  outDir: string;
  readToken: string | null;
  defaultModel: string;
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
  const [status] = await Promise.all([
    child.status,
    child.stdout.pipeTo(out.writable),
    child.stderr.pipeTo(err.writable),
  ]);
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
  const started = Date.now();
  const { ports } = input;
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
    result.elapsedSeconds = Math.round((Date.now() - started) / 1000);
    ports.log(`${job.id}: ${status}${detail ? ` (${detail})` : ""}`);
    return result;
  };
  const root = `${input.workRoot}/${job.id}`;
  const checkout = `${root}/checkout`;
  const tmpDir = `${root}/tmp`;
  try {
    await Deno.mkdir(tmpDir, { recursive: true });
    const base = await cloneBranch({
      url: ports.remoteUrl(job.repository),
      base: job.base,
      directory: checkout,
      token: input.readToken,
    });
    result.base = base.branch;
    result.baseSha = base.sha;
    await gitOk(["checkout", "--quiet", "-b", AGENT_JOB_BRANCH], {
      cwd: checkout,
    });

    const path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    for (const command of job.setup) {
      const setup = await bounded(["bash", "-c", command], {
        seconds: SETUP_TIMEOUT_SECONDS,
        cwd: checkout,
        env: { PATH: path, HOME: tmpDir, TMPDIR: tmpDir, CI: "1" },
        stdin: null,
        logFile: `${root}/setup.log`,
      });
      if (setup.code !== 0) {
        return settle("setup_failed", `exit ${setup.code}: ${command}`);
      }
    }

    const start: AgentStartV1 = {
      job,
      checkout,
      clientHome: `${root}/client`,
      tmpDir,
      denoDir: `${root}/deno`,
      model: job.model ?? input.defaultModel,
      lastMessageFile: `${root}/last-message.md`,
    };
    await ports.sleep(startDelaySeconds);
    await ports.prepareClient(start);
    const deadlineSeconds = job.minutes * 60;
    let spentSeconds = 0;
    let attempt = 0;
    let limited = false;
    let agent: { code: number; timedOut: boolean };
    for (;;) {
      const logFile = `${root}/agent-${attempt}.log`;
      const attemptStarted = Date.now();
      agent = await bounded(ports.agentCommand(start), {
        seconds: Math.max(1, deadlineSeconds - spentSeconds),
        cwd: checkout,
        env: codexChildEnv(start.clientHome, tmpDir, start.denoDir, path),
        stdin: attempt === 0 ? job.prompt : job.prompt + RESTART_NOTE,
        logFile,
      });
      spentSeconds += (Date.now() - attemptStarted) / 1000;
      limited = !agent.timedOut && agent.code !== 0 &&
        await rateLimited(`${logFile}.err`);
      if (!limited) break;
      const wait = Math.min(
        RATE_LIMIT_BACKOFF_MAX_SECONDS,
        RATE_LIMIT_BACKOFF_SECONDS * 2 ** attempt,
      );
      if (spentSeconds + wait >= deadlineSeconds) break;
      ports.log(`${job.id}: model 429, restarting in ${wait}s`);
      await ports.sleep(wait);
      spentSeconds += wait;
      attempt += 1;
    }
    // The model token must not outlive the agent on this runner.
    await Deno.remove(start.clientHome, { recursive: true }).catch(() => {});

    await gitOk(["add", "--all"], { cwd: checkout });
    const staged = await git(["diff", "--cached", "--quiet"], {
      cwd: checkout,
    });
    if (staged.code !== 0) {
      await gitOk([
        "commit",
        "--quiet",
        "-m",
        `agent job ${job.id}`,
        "-m",
        result.title,
      ], {
        cwd: checkout,
      });
      result.headSha = await gitOk(["rev-parse", "HEAD"], { cwd: checkout });
      result.bundle = `${job.id}.bundle`;
      await gitOk([
        "bundle",
        "create",
        "--quiet",
        `${input.outDir}/${result.bundle}`,
        `${base.sha}..refs/heads/${AGENT_JOB_BRANCH}`,
      ], { cwd: checkout });
    }
    await Deno.copyFile(start.lastMessageFile, `${input.outDir}/${job.id}.md`)
      .catch(() => {});
    if (agent.timedOut) {
      return settle("timed_out", `deadline ${job.minutes} min`);
    }
    if (agent.code !== 0) {
      return settle(
        "agent_failed",
        limited
          ? `model rate limited (429) through ${attempt + 1} attempts`
          : `exit ${agent.code}`,
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
        index * CELL_STAGGER_SECONDS + slot * SLOT_STAGGER_SECONDS,
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

async function resolveExecutable(name: string): Promise<string> {
  const which = await new Deno.Command("which", {
    args: [name],
    stdout: "piped",
  }).output();
  const path = new TextDecoder().decode(which.stdout).trim();
  if (which.code !== 0 || path.length === 0) {
    throw new Error(`${name} is not installed on this runner`);
  }
  return await Deno.realPath(path);
}

/** CLI for `.github/workflows/agent-jobs.yml`. */
if (import.meta.main) {
  const env = (name: string) => Deno.env.get(name) ?? "";
  const modelToken = env("UOS_AI_TOKEN");
  if (modelToken.length === 0) throw new Error("UOS_AI_TOKEN is not set");
  const codex = await resolveExecutable("codex");
  const workspace = env("GITHUB_WORKSPACE") || Deno.cwd();
  const plan = JSON.parse(
    await Deno.readTextFile(env("AGENT_JOBS_PLAN")),
  ) as AgentJobsPlanV1;
  const cell = await runAgentJobsCell({
    plan,
    cellId: env("AGENT_JOBS_CELL_ID"),
    workRoot: `${env("RUNNER_TEMP") || "/tmp"}/agent-jobs`,
    outDir: `${workspace}/.agent-jobs/out`,
    readToken: env("AGENT_JOBS_READ_TOKEN") || null,
    defaultModel: env("SENTINEL_MODEL_ID") || "gpt-6.1-sol",
    ports: {
      remoteUrl: githubRemoteUrl,
      agentCommand: (start) => [
        codex,
        "exec",
        "-C",
        start.checkout,
        "-m",
        start.model,
        "-c",
        'model_reasoning_effort="max"',
        "-o",
        start.lastMessageFile,
        "-",
      ],
      prepareClient: (start) =>
        ensureTaskClient({
          clientHome: start.clientHome,
          tmpDir: start.tmpDir,
          denoDir: start.denoDir,
          checkout: start.checkout,
          token: modelToken,
          codexExecutable: codex,
          denoExecutable: Deno.execPath(),
          trustedPath: env("PATH"),
          baseUrl: env("SENTINEL_MODEL_BASE_URL") || "https://ai.ubq.fi/v1",
        }),
      sleep: (seconds) =>
        new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
      log: (line) => console.log(line),
    },
  });
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
