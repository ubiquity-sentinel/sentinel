/**
 * EXPERIMENTAL manual agent-job lane: the `plan` step.
 *
 * An operator hands Sentinel a list of coding jobs (repository, base branch,
 * prompt). This step checks the request's shape and packs the jobs into
 * Actions cells, each running `agentsPerCell` agents side by side. It reads no
 * credential, starts no model and writes no authoritative state; the lane
 * never touches repair accounting.
 *
 * Packing uses width before depth: every job gets its own runner until the
 * cell budget is spent, and only then do cells take a second, third... agent.
 * A cell holds jobs of one repository owner, because one App installation
 * token is minted per cell.
 *
 * The only bounds are platform facts: a matrix holds 256 jobs and a hosted
 * job ends after six hours.
 */

/** GitHub's matrix size limit. */
export const AGENT_JOBS_MAX_CELLS = 256;
/** The Free plan's concurrent-job limit; more cells would only queue. */
export const AGENT_JOBS_DEFAULT_CELLS = 20;
export const AGENT_JOBS_DEFAULT_AGENTS_PER_CELL = 4;
/** GitHub ends a hosted job at 360 minutes. */
export const AGENT_JOBS_CELL_TIMEOUT_MINUTES = 360;
/** Agent time inside that: the rest is toolchain install and upload. */
export const AGENT_JOBS_MAX_MINUTES = 350;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
// A gateway model id: plain segments, optionally namespaced with single
// slashes (`vendor/model`). The id is only ever passed as one argument.
const MODEL_PATTERN =
  /^(?=.{1,96}$)[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * Hosted runner kinds a job may ask for, and the `runs-on` label of each.
 * The default stays the x64 Linux runner every job used before this field.
 */
export const AGENT_JOB_RUNNERS = {
  "linux-x64": "ubuntu-latest",
  "linux-arm64": "ubuntu-24.04-arm",
  // A newer image whose packages (Clang 21, Boost 1.90) build current C++
  // trees without compiling a toolchain first.
  "linux-arm64-26": "ubuntu-26.04-arm",
  "macos-arm64": "macos-latest",
} as const;
export type AgentJobRunner = keyof typeof AGENT_JOB_RUNNERS;

/** One validated coding job; one job is one agent. */
export interface AgentJobV1 {
  id: string;
  repository: string;
  /** Base branch; `null` means the repository default branch. */
  base: string | null;
  prompt: string;
  /** Host commands run in the checkout before the model starts. */
  setup: string[];
  minutes: number;
  /** Gateway model override; `null` keeps the workflow's model. */
  model: string | null;
  /** Open a draft pull request for the pushed branch. */
  pr: boolean;
  /** Hosted runner kind the agent runs on. */
  runner: AgentJobRunner;
}

export interface AgentJobsCellV1 {
  cellId: string;
  owner: string;
  /** Comma-separated repository names for the App token mint. */
  repositories: string;
  /** `runs-on` label; every job of a cell asked for this runner kind. */
  runner: string;
  timeoutMinutes: number;
  jobs: AgentJobV1[];
}

export interface AgentJobsPlanV1 {
  schema: "sentinel.agent-jobs.plan/v1";
  cells: AgentJobsCellV1[];
}

function fail(message: string): never {
  throw new Error(`agent jobs request refused: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "string" ? Number(value) : value;
  if (
    typeof number !== "number" || !Number.isInteger(number) || number < min ||
    number > max
  ) fail(`${name} must be an integer from ${min} to ${max}`);
  return number;
}

function parseJob(value: unknown): AgentJobV1 {
  if (!record(value)) fail("every job must be an object");
  const known = [
    "id",
    "repository",
    "base",
    "prompt",
    "setup",
    "minutes",
    "model",
    "pr",
    "runner",
  ];
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) fail(`unknown job field ${key}`);
  }
  const { id, repository, base, prompt, setup, model, pr, runner } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    fail("job id must match [a-z0-9][a-z0-9-]{0,39}");
  }
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) {
    fail(`job ${id}: repository must be owner/name`);
  }
  if (
    base !== undefined && base !== null &&
    (typeof base !== "string" || !REF_PATTERN.test(base) || base.includes(".."))
  ) fail(`job ${id}: base is not a plain branch name`);
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    fail(`job ${id}: prompt must not be empty`);
  }
  const commands = setup ?? [];
  if (
    !Array.isArray(commands) ||
    commands.some((item) => typeof item !== "string" || item.length === 0)
  ) fail(`job ${id}: setup must be a list of commands`);
  if (
    model !== undefined && model !== null &&
    (typeof model !== "string" || !MODEL_PATTERN.test(model))
  ) fail(`job ${id}: model is not a plain model id`);
  if (pr !== undefined && typeof pr !== "boolean") {
    fail(`job ${id}: pr must be a boolean`);
  }
  if (
    runner !== undefined && runner !== null &&
    (typeof runner !== "string" || !Object.hasOwn(AGENT_JOB_RUNNERS, runner))
  ) {
    fail(
      `job ${id}: runner must be one of ${
        Object.keys(AGENT_JOB_RUNNERS).join(", ")
      }`,
    );
  }
  return {
    id,
    repository,
    base: base ?? null,
    prompt,
    setup: commands as string[],
    minutes: boundedInt(
      value.minutes,
      AGENT_JOBS_MAX_MINUTES,
      1,
      AGENT_JOBS_MAX_MINUTES,
      `job ${id}: minutes`,
    ),
    model: model ?? null,
    pr: pr ?? false,
    runner: (runner ?? "linux-x64") as AgentJobRunner,
  };
}

/** Validate a request and pack it into cells. Pure. */
export function planAgentJobs(
  request: unknown,
  overrides: { agentsPerCell?: unknown; maxCells?: unknown } = {},
): AgentJobsPlanV1 {
  const body = Array.isArray(request) ? { jobs: request } : request;
  if (!record(body) || !Array.isArray(body.jobs) || body.jobs.length === 0) {
    fail('expected {"jobs":[...]} with at least one job');
  }
  const agentsPerCell = boundedInt(
    overrides.agentsPerCell ?? body.agentsPerCell,
    AGENT_JOBS_DEFAULT_AGENTS_PER_CELL,
    1,
    Number.MAX_SAFE_INTEGER,
    "agentsPerCell",
  );
  const maxCells = boundedInt(
    overrides.maxCells ?? body.maxCells,
    AGENT_JOBS_DEFAULT_CELLS,
    1,
    AGENT_JOBS_MAX_CELLS,
    "maxCells",
  );
  const jobs = body.jobs.map((job) => parseJob(job));
  const ids = new Set(jobs.map((job) => job.id));
  if (ids.size !== jobs.length) fail("job ids must be unique");

  // A cell is one runner with one App token: one owner and one runner kind.
  const byOwner = new Map<string, AgentJobV1[]>();
  for (const job of jobs) {
    const owner = `${job.repository.split("/")[0]}\n${job.runner}`;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), job]);
  }
  // Minimum cells per owner, then spend the spare budget where it is densest.
  const counts = new Map<string, number>();
  let used = 0;
  for (const [owner, group] of byOwner) {
    const minimum = Math.ceil(group.length / agentsPerCell);
    counts.set(owner, minimum);
    used += minimum;
  }
  if (used > maxCells) {
    fail(
      `${jobs.length} jobs need ${used} cells at ${agentsPerCell} agents per cell; the limit is ${maxCells}`,
    );
  }
  while (used < maxCells) {
    let densest: string | null = null;
    let density = 1;
    for (const [owner, group] of byOwner) {
      const ratio = group.length / counts.get(owner)!;
      if (ratio > density) [densest, density] = [owner, ratio];
    }
    if (densest === null) break;
    counts.set(densest, counts.get(densest)! + 1);
    used += 1;
  }

  const cells: AgentJobsCellV1[] = [];
  for (const [key, group] of byOwner) {
    const count = counts.get(key)!;
    const owner = key.split("\n")[0];
    const buckets: AgentJobV1[][] = Array.from({ length: count }, () => []);
    group.forEach((job, index) => buckets[index % count].push(job));
    for (const bucket of buckets) {
      const names = [...new Set(bucket.map((job) => job.repository))]
        .map((repository) => repository.split("/")[1]);
      cells.push({
        cellId: `c${String(cells.length + 1).padStart(2, "0")}`,
        owner,
        repositories: names.join(","),
        runner: AGENT_JOB_RUNNERS[group[0].runner],
        timeoutMinutes: AGENT_JOBS_CELL_TIMEOUT_MINUTES,
        jobs: bucket,
      });
    }
  }
  return { schema: "sentinel.agent-jobs.plan/v1", cells };
}

/** Merge several request documents (push-triggered inbox files) into one. */
export function mergeAgentJobRequests(documents: unknown[]): unknown {
  const jobs: unknown[] = [];
  for (const document of documents) {
    const list = Array.isArray(document)
      ? document
      : record(document) && Array.isArray(document.jobs)
      ? document.jobs
      : fail("a request document has no jobs array");
    jobs.push(...list);
  }
  return { jobs };
}

/**
 * CLI: `AGENT_JOBS_JSON` (dispatch input) or request file paths as arguments
 * (pushed inbox files). Writes `plan.json` and the matrix output.
 */
if (import.meta.main) {
  const inline = Deno.env.get("AGENT_JOBS_JSON") ?? "";
  const documents = inline.trim().length > 0
    ? [JSON.parse(inline)]
    : await Promise.all(
      Deno.args.map(async (path) => JSON.parse(await Deno.readTextFile(path))),
    );
  if (documents.length === 0) fail("no job request was supplied");
  const plan = planAgentJobs(mergeAgentJobRequests(documents), {
    agentsPerCell: Deno.env.get("AGENT_JOBS_PER_CELL"),
    maxCells: Deno.env.get("AGENT_JOBS_MAX_CELLS"),
  });
  await Deno.mkdir(".agent-jobs", { recursive: true });
  await Deno.writeTextFile(".agent-jobs/plan.json", JSON.stringify(plan));
  const matrix = {
    include: plan.cells.map((cell) => ({
      cellId: cell.cellId,
      owner: cell.owner,
      repositories: cell.repositories,
      runner: cell.runner,
      timeoutMinutes: cell.timeoutMinutes,
    })),
  };
  const output = Deno.env.get("GITHUB_OUTPUT");
  if (output) {
    await Deno.writeTextFile(output, `matrix=${JSON.stringify(matrix)}\n`, {
      append: true,
    });
  }
  const agents = plan.cells.reduce((sum, cell) => sum + cell.jobs.length, 0);
  console.log(`planned ${agents} agents in ${plan.cells.length} cells`);
  for (const cell of plan.cells) {
    console.log(`${cell.cellId}: ${cell.jobs.map((job) => job.id).join(", ")}`);
  }
}
