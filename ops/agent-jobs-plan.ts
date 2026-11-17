/**
 * EXPERIMENTAL manual agent-job lane: the `plan` step.
 *
 * An operator hands Sentinel a list of coding jobs (repository, base branch,
 * prompt). This step validates the request against the committed target array
 * and packs the jobs into at most twenty Actions cells, each running up to
 * `agentsPerCell` agents side by side. It reads no credential, starts no model
 * and writes no authoritative state; the lane never touches repair accounting.
 *
 * Packing uses width before depth: every job gets its own runner until the
 * cell budget is spent, and only then do cells take a second, third... agent.
 * A cell holds jobs of one repository owner, because one App installation
 * token is minted per cell.
 */

export const AGENT_JOBS_MAX_CELLS = 20;
export const AGENT_JOBS_MAX_AGENTS_PER_CELL = 16;
export const AGENT_JOBS_DEFAULT_AGENTS_PER_CELL = 4;
export const AGENT_JOBS_DEFAULT_MINUTES = 120;
export const AGENT_JOBS_MAX_MINUTES = 300;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROMPT_CHARS = 20_000;
const MAX_SETUP_COMMANDS = 8;

/** One validated coding job; one job is one agent. */
export interface AgentJobV1 {
  id: string;
  repository: string;
  /** Base branch; `null` means the repository default branch. */
  base: string | null;
  prompt: string;
  /** Trusted host commands run before the model starts (network on). */
  setup: string[];
  minutes: number;
  /** Gateway model override; `null` keeps the workflow's model. */
  model: string | null;
  /** Open a draft pull request for the pushed branch. */
  pr: boolean;
}

export interface AgentJobsCellV1 {
  cellId: string;
  owner: string;
  /** Comma-separated repository names for the App token mint. */
  repositories: string;
  /** Longest job bound plus setup/publication margin. */
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

function parseJob(value: unknown, targets: ReadonlySet<string>): AgentJobV1 {
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
  ];
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) fail(`unknown job field ${key}`);
  }
  const { id, repository, base, prompt, setup, model, pr } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    fail("job id must match [a-z0-9][a-z0-9-]{0,39}");
  }
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) {
    fail(`job ${id}: repository must be owner/name`);
  }
  if (!targets.has(repository)) {
    fail(`job ${id}: ${repository} is not in sentinel.targets.json`);
  }
  if (
    base !== undefined && base !== null &&
    (typeof base !== "string" || !REF_PATTERN.test(base) || base.includes(".."))
  ) fail(`job ${id}: base is not a plain branch name`);
  if (
    typeof prompt !== "string" || prompt.trim().length === 0 ||
    prompt.length > MAX_PROMPT_CHARS
  ) fail(`job ${id}: prompt must be 1 to ${MAX_PROMPT_CHARS} characters`);
  const commands = setup ?? [];
  if (
    !Array.isArray(commands) || commands.length > MAX_SETUP_COMMANDS ||
    commands.some((item) => typeof item !== "string" || item.length === 0)
  ) fail(`job ${id}: setup must be at most ${MAX_SETUP_COMMANDS} commands`);
  if (
    model !== undefined && model !== null &&
    (typeof model !== "string" || !MODEL_PATTERN.test(model))
  ) fail(`job ${id}: model is not a plain model id`);
  if (pr !== undefined && typeof pr !== "boolean") {
    fail(`job ${id}: pr must be a boolean`);
  }
  return {
    id,
    repository,
    base: base ?? null,
    prompt,
    setup: commands as string[],
    minutes: boundedInt(
      value.minutes,
      AGENT_JOBS_DEFAULT_MINUTES,
      5,
      AGENT_JOBS_MAX_MINUTES,
      `job ${id}: minutes`,
    ),
    model: model ?? null,
    pr: pr ?? false,
  };
}

/** Validate a request and pack it into cells. Pure. */
export function planAgentJobs(
  request: unknown,
  targets: readonly string[],
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
    AGENT_JOBS_MAX_AGENTS_PER_CELL,
    "agentsPerCell",
  );
  const maxCells = boundedInt(
    overrides.maxCells ?? body.maxCells,
    AGENT_JOBS_MAX_CELLS,
    1,
    AGENT_JOBS_MAX_CELLS,
    "maxCells",
  );
  const targetSet = new Set(targets);
  const jobs = body.jobs.map((job) => parseJob(job, targetSet));
  const ids = new Set(jobs.map((job) => job.id));
  if (ids.size !== jobs.length) fail("job ids must be unique");

  const byOwner = new Map<string, AgentJobV1[]>();
  for (const job of jobs) {
    const owner = job.repository.split("/")[0];
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
  for (const [owner, group] of byOwner) {
    const count = counts.get(owner)!;
    const buckets: AgentJobV1[][] = Array.from({ length: count }, () => []);
    group.forEach((job, index) => buckets[index % count].push(job));
    for (const bucket of buckets) {
      const names = [...new Set(bucket.map((job) => job.repository))]
        .map((repository) => repository.split("/")[1]);
      cells.push({
        cellId: `c${String(cells.length + 1).padStart(2, "0")}`,
        owner,
        repositories: names.join(","),
        timeoutMinutes: Math.max(...bucket.map((job) => job.minutes)) + 30,
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
  const targets = JSON.parse(await Deno.readTextFile("sentinel.targets.json"));
  const plan = planAgentJobs(mergeAgentJobRequests(documents), targets, {
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
