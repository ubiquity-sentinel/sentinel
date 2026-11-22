import { dirname, resolve } from "node:path";
import { isGitSha, isSha256Hex } from "../src/contracts/brands.ts";
import type { AgentJobsPlanV1 } from "./agent-jobs-plan.ts";
import { AGENT_JOBS_MAX_MINUTES } from "./agent-jobs-plan.ts";
import type {
  AgentJobReviewV1,
  PinnedAgentJobV1,
  ReviewedAgentJobResultV1,
  ReviewedAgentJobsCellResultV1,
} from "./agent-jobs-review-contract.ts";
import type {
  agentJobReviewRoundVerdict,
  agentJobTask,
  reviewAgentJobHead,
} from "./agent-jobs-native-review.ts";
import type { correctAgentJobHead } from "./agent-jobs-correct.ts";
import { githubRemoteUrl } from "./agent-jobs-git.ts";
import {
  AgentJobGateRefusal,
  type AgentJobGitInput,
  agentJobTimeLeft,
  cloneAgentJobObjects,
  confirmAgentJobBase,
  fetchAgentJobBase,
  importAgentJobBundle,
  keepAgentJobHead,
  normalizeAgentJobCandidate,
  sealAgentJobBundle,
  validateAgentJobPublication,
  verifyAgentJobCorrection,
} from "./agent-jobs-review-git.ts";

const RESULT_SCHEMA = "sentinel.agent-jobs.cell-result/v1" as const;
const PLAN_SCHEMA = "sentinel.agent-jobs.plan/v1";
const MAX_CELL_RESULT_BYTES = 4 * 1024 * 1024;
const JOB_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const CELL_ID = /^c[0-9]{2,3}$/;
const RUN_TAG = /^[1-9][0-9]*-[1-9][0-9]*$/;

type ReviewPlan = AgentJobsPlanV1 & { createdAtMs?: number };
type RecordValue = Record<string, unknown>;

export interface AgentJobsReviewInput {
  plan: ReviewPlan;
  cellId: string;
  artifactDir: string;
  reviewedDir: string;
  workRoot: string;
  runTag: string;
  modelToken: string;
  baseUrl: string;
  defaultModel: string;
  ports: {
    publicRepository: (repository: string) => Promise<void>;
    remoteUrl: (repository: string) => string;
    task: typeof agentJobTask;
    review: typeof reviewAgentJobHead;
    verdict: typeof agentJobReviewRoundVerdict;
    correct: typeof correctAgentJobHead;
    log: (line: string) => void;
    now?: () => number;
  };
}

function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function trustedCell(input: AgentJobsReviewInput): {
  createdAtMs: number;
  jobs: PinnedAgentJobV1[];
} {
  const { plan, cellId, runTag } = input;
  const createdAtMs = plan.createdAtMs;
  if (
    plan.schema !== PLAN_SCHEMA || !Array.isArray(plan.cells) ||
    !CELL_ID.test(cellId) || !RUN_TAG.test(runTag) ||
    !Number.isSafeInteger(createdAtMs) || createdAtMs === undefined ||
    createdAtMs <= 0 || createdAtMs > (input.ports.now ?? Date.now)()
  ) throw new Error("trusted agent job plan identity is invalid");
  const cells = plan.cells.filter((candidate) => candidate.cellId === cellId);
  if (
    cells.length !== 1 || !Array.isArray(cells[0].jobs) ||
    cells[0].jobs.length === 0
  ) {
    throw new Error("trusted agent job cell is missing or ambiguous");
  }
  const jobs = cells[0].jobs as PinnedAgentJobV1[];
  const ids = new Set<string>();
  for (const job of jobs) {
    if (
      typeof job.id !== "string" || !JOB_ID.test(job.id) || ids.has(job.id) ||
      typeof job.repository !== "string" || !REPOSITORY.test(job.repository) ||
      typeof job.base !== "string" || job.base.length === 0 ||
      !isGitSha(job.baseSha) || typeof job.prompt !== "string" ||
      !Number.isSafeInteger(job.minutes) || job.minutes < 1 ||
      job.minutes > AGENT_JOBS_MAX_MINUTES || typeof job.pr !== "boolean" ||
      (job.review !== undefined && typeof job.review !== "boolean")
    ) throw new Error("trusted agent job binding is malformed");
    ids.add(job.id);
  }
  return { createdAtMs, jobs };
}

async function cellRows(
  input: AgentJobsReviewInput,
  jobs: readonly PinnedAgentJobV1[],
): Promise<Map<string, RecordValue>> {
  const path = resolve(input.artifactDir, "result.json");
  try {
    const info = await Deno.lstat(path);
    if (!info.isFile || info.size > MAX_CELL_RESULT_BYTES) return new Map();
    const payload = record(JSON.parse(await Deno.readTextFile(path)));
    if (
      payload?.schema !== RESULT_SCHEMA || payload.cellId !== input.cellId ||
      !Array.isArray(payload.results)
    ) return new Map();
    const ids = new Set(jobs.map((job) => job.id));
    const rows = new Map<string, RecordValue>();
    for (const item of payload.results) {
      const row = record(item);
      if (
        row === null || typeof row.id !== "string" || !ids.has(row.id) ||
        rows.has(row.id)
      ) return new Map();
      rows.set(row.id, row);
    }
    return rows;
  } catch {
    return new Map();
  }
}

function candidateHead(
  job: PinnedAgentJobV1,
  row: RecordValue | undefined,
): string | null {
  if (
    row === undefined || row.repository !== job.repository ||
    row.base !== job.base || row.baseSha !== job.baseSha || row.pr !== job.pr ||
    Object.hasOwn(row, "review")
  ) {
    throw new AgentJobGateRefusal(
      "cell result identity does not match trusted plan",
    );
  }
  if (
    row.status === "no_changes" && row.headSha === null && row.bundle === null
  ) {
    return null;
  }
  if (row.status !== "changed") {
    throw new AgentJobGateRefusal("cell did not produce a complete candidate");
  }
  if (!isGitSha(row.headSha) || row.bundle !== `${job.id}.bundle`) {
    throw new AgentJobGateRefusal("cell candidate identity or path is invalid");
  }
  return row.headSha;
}

function resultRow(
  job: PinnedAgentJobV1,
  runTag: string,
): ReviewedAgentJobResultV1 {
  const detail = "trusted review has not settled";
  return {
    id: job.id,
    repository: job.repository,
    base: job.base,
    baseSha: job.baseSha,
    status: "host_failed",
    headSha: null,
    bundle: null,
    elapsedSeconds: 0,
    pr: job.pr,
    title: job.prompt.split("\n", 1)[0].replaceAll("\r", "").slice(0, 120) ||
      `Sentinel agent job ${job.id}`,
    detail,
    review: {
      id: job.id,
      repository: job.repository,
      base: job.base,
      baseSha: job.baseSha,
      headSha: job.baseSha,
      runTag,
      taskDigest: "",
      verdict: "blocked",
      rounds: [],
      detail,
    },
  };
}

async function normalizeInitialCandidate(
  input: AgentJobsReviewInput,
  job: PinnedAgentJobV1,
  git: AgentJobGitInput,
  rawHead: string,
  root: string,
  createdAtMs: number,
): Promise<string> {
  const quarantined = resolve(root, "candidate-input");
  await cloneAgentJobObjects({ ...git, from: git.sourcePath, to: quarantined });
  const candidate = { ...git, sourcePath: quarantined, baseSha: job.baseSha };
  await importAgentJobBundle({
    ...candidate,
    headSha: rawHead,
    bundlePath: resolve(input.artifactDir, `${job.id}.bundle`),
  });
  const headSha = await normalizeAgentJobCandidate({
    ...candidate,
    id: job.id,
    headSha: rawHead,
    createdAtMs,
  });
  if (headSha === job.baseSha) return headSha;
  const bundlePath = resolve(root, "normalized.bundle");
  await sealAgentJobBundle({ ...candidate, headSha, bundlePath });
  await importAgentJobBundle({
    ...git,
    baseSha: job.baseSha,
    headSha,
    bundlePath,
  });
  return headSha;
}

async function gateOne(
  input: AgentJobsReviewInput,
  row: ReviewedAgentJobResultV1,
  job: PinnedAgentJobV1,
  candidate: RecordValue | undefined,
  createdAtMs: number,
  recordStart: (
    kind: "review" | "correction",
    headSha: string,
    round: number,
  ) => Promise<void>,
): Promise<void> {
  const { ports } = input;
  const task = await ports.task(job, input.runTag);
  if (!isSha256Hex(task.digest)) {
    throw new AgentJobGateRefusal("trusted job task digest is unavailable");
  }
  row.review.taskDigest = task.digest;
  const rawHead = candidateHead(job, candidate);
  if (rawHead === null) {
    try {
      await Deno.lstat(resolve(input.artifactDir, `${job.id}.bundle`));
      throw new AgentJobGateRefusal(
        "unchanged cell result also contains a candidate bundle",
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const deadlineAtMs = createdAtMs + job.minutes * 60_000;
  agentJobTimeLeft({ deadlineAtMs, now: ports.now });
  // No target Git process is permitted before the trusted public metadata read.
  await ports.publicRepository(job.repository);
  const root = await Deno.makeTempDir({
    dir: input.workRoot,
    prefix: `${job.id}-`,
  });
  const sourcePath = resolve(root, "source.git");
  await Deno.mkdir(sourcePath);
  const git = { sourcePath, deadlineAtMs, now: ports.now };
  const upstream = { ...git, ...job, remote: ports.remoteUrl(job.repository) };
  await fetchAgentJobBase(upstream);
  let headSha = rawHead === null
    ? job.baseSha
    : await normalizeInitialCandidate(
      input,
      job,
      git,
      rawHead,
      root,
      createdAtMs,
    );
  const finish = async (
    verdict: Exclude<AgentJobReviewV1["verdict"], "blocked">,
  ) => {
    await ports.publicRepository(job.repository);
    await confirmAgentJobBase(upstream);
    const changed = verdict === "accepted";
    if (changed) {
      const bundle = `${job.id}.bundle`;
      const bundlePath = resolve(root, bundle);
      await sealAgentJobBundle({
        ...git,
        baseSha: job.baseSha,
        headSha,
        bundlePath,
      });
      await Deno.rename(bundlePath, resolve(input.reviewedDir, bundle));
      row.bundle = bundle;
      row.headSha = headSha;
    }
    row.status = changed ? "changed" : "no_changes";
    row.review.verdict = verdict;
    row.review.headSha = headSha;
    row.detail = row.review.detail = verdict === "accepted"
      ? "current head accepted by native review"
      : verdict === "already_satisfied"
      ? "native review verified the task at the pinned base"
      : "no code output against the verified pinned base";
  };
  if (job.review === false) {
    if (headSha !== job.baseSha) {
      throw new AgentJobGateRefusal(
        "review can be disabled only for an unchanged tree",
      );
    }
    return await finish("skipped_no_diff");
  }

  const seen = new Set<string>();
  let confirmingBaseSatisfaction = false;
  for (;;) {
    if (seen.has(headSha)) {
      throw new AgentJobGateRefusal(
        "correction did not produce a new candidate tree",
      );
    }
    seen.add(headSha);
    row.review.headSha = headSha;
    const candidate = {
      ...git,
      repository: job.repository,
      baseSha: job.baseSha,
      headSha,
    };
    if (headSha !== job.baseSha) await validateAgentJobPublication(candidate);
    await confirmAgentJobBase(upstream);
    const round = row.review.rounds.length + 1;
    const roundRoot = resolve(root, `round-${round}`);
    await Deno.mkdir(roundRoot);
    await recordStart("review", headSha, round);
    agentJobTimeLeft(git);
    const result = await ports.review({
      job,
      runTag: input.runTag,
      sourcePath,
      headSha,
      workRoot: resolve(roundRoot, "review"),
      deadlineAtMs,
      round,
      history: row.review.rounds,
      modelToken: input.modelToken,
      baseUrl: input.baseUrl,
    });
    if (
      result.round !== round || result.headSha !== headSha ||
      result.baseSha !== job.baseSha || result.taskDigest !== task.digest
    ) {
      throw new AgentJobGateRefusal(
        "native review evidence does not bind this candidate",
      );
    }
    row.review.rounds.push(result);
    const verdict = await ports.verdict(result, {
      baseSha: job.baseSha,
      headSha,
      taskDigest: task.digest,
    });
    if (confirmingBaseSatisfaction && verdict !== "already_satisfied") {
      throw new AgentJobGateRefusal(
        "native review did not confirm the task at the pinned base",
      );
    }
    if (verdict === "accepted" && headSha !== job.baseSha) {
      return await finish(verdict);
    }
    if (verdict === "already_satisfied") {
      if (headSha === job.baseSha) return await finish(verdict);
      confirmingBaseSatisfaction = true;
      headSha = job.baseSha;
      continue;
    }
    if (verdict !== "correct" || result.feedback.trim().length === 0) {
      throw new AgentJobGateRefusal(
        "native review did not authorize delivery or correction",
      );
    }
    await confirmAgentJobBase(upstream);
    await recordStart("correction", headSha, round);
    agentJobTimeLeft(git);
    const corrected = await ports.correct({
      job,
      sourcePath,
      headSha,
      feedback: result.feedback,
      workRoot: resolve(roundRoot, "correction"),
      deadlineAtMs,
      modelToken: input.modelToken,
      baseUrl: input.baseUrl,
      defaultModel: input.defaultModel,
    });
    await verifyAgentJobCorrection({
      ...candidate,
      headSha: corrected,
      rejectedHead: headSha,
    });
    headSha = await normalizeAgentJobCandidate({
      ...candidate,
      headSha: corrected,
      id: job.id,
      createdAtMs,
    });
    if (headSha !== job.baseSha) {
      // A clean clone of the source must be able to fetch this normalized tip.
      await keepAgentJobHead({ ...candidate, headSha });
    }
  }
}

/** The fresh gate writes one manifest plus only accepted, regenerated bundles. */
export async function reviewAgentJobsCell(
  input: AgentJobsReviewInput,
): Promise<ReviewedAgentJobsCellResultV1> {
  const { createdAtMs, jobs } = trustedCell(input);
  const rows = await cellRows(input, jobs);
  await Deno.mkdir(input.workRoot, { recursive: true });
  await Deno.mkdir(dirname(input.reviewedDir), { recursive: true });
  await Deno.mkdir(input.reviewedDir);
  const result: ReviewedAgentJobsCellResultV1 = {
    schema: RESULT_SCHEMA,
    cellId: input.cellId,
    results: jobs.map((job) => resultRow(job, input.runTag)),
    modelStarts: [],
  };
  let writing = Promise.resolve();
  const flush = () => {
    const bytes = JSON.stringify(result) + "\n";
    writing = writing.then(() =>
      Deno.writeTextFile(resolve(input.reviewedDir, "result.json"), bytes)
    );
    return writing;
  };
  await flush();
  await Promise.all(jobs.map(async (job, index) => {
    const row = result.results[index];
    const now = input.ports.now ?? Date.now;
    const started = now();
    try {
      await gateOne(
        input,
        row,
        job,
        rows.get(job.id),
        createdAtMs,
        async (kind, headSha, round) => {
          const at = now();
          agentJobTimeLeft({
            deadlineAtMs: createdAtMs + job.minutes * 60_000,
            now,
          });
          const intent = { id: job.id, kind, headSha, round, at };
          result.modelStarts.push(intent);
          input.ports.log(
            JSON.stringify({
              event: "agent_job_model_start_intent",
              ...intent,
            }),
          );
          await flush();
        },
      );
    } catch (error) {
      row.detail = row.review.detail = error instanceof AgentJobGateRefusal
        ? error.message
        : "trusted review gate could not verify candidate";
    }
    row.elapsedSeconds = Math.max(0, Math.round((now() - started) / 1000));
    input.ports.log(`${row.id}: ${row.review.verdict} (${row.review.detail})`);
    await flush();
  }));
  return result;
}

if (import.meta.main) {
  const native = await import("./agent-jobs-native-review.ts");
  const correction = await import("./agent-jobs-correct.ts");
  const { readPublicAgentJobRepository } = await import(
    "./agent-jobs-admission.ts"
  );
  const env = (key: string) => Deno.env.get(key) ?? "";
  const required = (key: string) => {
    const value = env(key);
    if (value.length === 0) throw new Error(`missing required ${key}`);
    return value;
  };
  await reviewAgentJobsCell({
    plan: JSON.parse(await Deno.readTextFile(required("AGENT_JOBS_PLAN"))),
    cellId: required("AGENT_JOBS_CELL_ID"),
    artifactDir: resolve(required("AGENT_JOBS_ARTIFACT_DIR")),
    reviewedDir: resolve(required("AGENT_JOBS_REVIEWED_DIR")),
    workRoot: resolve(required("RUNNER_TEMP"), "agent-jobs-review"),
    runTag: `${required("GITHUB_RUN_ID")}-${required("GITHUB_RUN_ATTEMPT")}`,
    modelToken: env("UOS_AI_TOKEN"),
    baseUrl: required("SENTINEL_CODEX_BASE_URL"),
    defaultModel: env("SENTINEL_MODEL_ID") || "gpt-6.1-sol",
    ports: {
      publicRepository: async (repository) => {
        await readPublicAgentJobRepository(repository);
      },
      remoteUrl: githubRemoteUrl,
      task: native.agentJobTask,
      review: native.reviewAgentJobHead,
      verdict: native.agentJobReviewRoundVerdict,
      correct: correction.correctAgentJobHead,
      log: console.log,
    },
  });
}
