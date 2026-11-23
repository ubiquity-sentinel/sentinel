/** Trusted on-demand publication of the exact candidate accepted by native review. */
import { resolve } from "node:path";
import { type GitSha, isGitSha } from "../src/contracts/brands.ts";
import { portError, portOk } from "../src/contracts/ports.ts";
import { pushGuardRefusal } from "../src/github/push-content-guard.ts";
import { sentinelWorksRepositoryV1 } from "../src/repair/target-visibility.ts";
import type { TargetVisibilityV1 } from "../src/repair/target-visibility.ts";
import { git, gitAuthEnv, githubRemoteUrl } from "./agent-jobs-git.ts";
import type { RemoteUrl } from "./agent-jobs-git.ts";
import {
  agentJobReviewRoundVerdict,
  agentJobTask,
} from "./agent-jobs-native-review.ts";
import type { AgentJobsPlanV1, AgentJobV1 } from "./agent-jobs-plan.ts";
import {
  agentJobTreeChanged,
  importAgentJobBundle,
  validateAgentJobPublication,
} from "./agent-jobs-review-contract.ts";
import type { AgentJobReviewV1 } from "./agent-jobs-review-contract.ts";
import {
  AgentJobPublicationRefusal,
  githubAgentJobsPublishPorts,
} from "./agent-jobs-publish-github.ts";

const RUN_TAG = /^([1-9]\d*)-([1-9]\d*)$/;
const JOB_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const BASE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const REVIEWED_VERDICTS = [
  "accepted",
  "already_satisfied",
  "skipped_no_diff",
  "blocked",
] as const;
const CONTROLLER = "ubiquity-sentinel/sentinel";

type PublishStatus =
  | "published"
  | "skipped_no_diff"
  | "already_satisfied"
  | "blocked";

export interface AgentJobPublicationV1 {
  id: string;
  repository: string;
  status: PublishStatus;
  reviewVerdict: AgentJobReviewV1["verdict"] | null;
  taskDigest: string | null;
  reviewedHeadSha: string | null;
  branch: string | null;
  headSha: string | null;
  reviewCommentUrl: string | null;
  pullRequest: string | null;
  detail: string;
}

export interface AgentJobCommitReviewInput {
  id: string;
  repository: string;
  headSha: string;
  runTag: string;
  taskDigest: string;
}

export interface AgentJobDraftInput extends AgentJobCommitReviewInput {
  head: string;
  base: string;
  baseSha: string;
  title: string;
  body: string;
}

export interface AgentJobsPublishPorts {
  remoteUrl: RemoteUrl;
  repositoryVisibility: (repository: string) => Promise<TargetVisibilityV1>;
  ensureReviewComment: (input: AgentJobCommitReviewInput) => Promise<string>;
  ensureDraftPullRequest: (input: AgentJobDraftInput) => Promise<string>;
  log: (line: string) => void;
}

export interface AgentJobsPublishInput {
  plan: AgentJobsPlanV1;
  cellId: string;
  reviewed: unknown;
  artifactDir: string;
  workRoot: string;
  runTag: string;
  writeToken: string | null;
  ports: AgentJobsPublishPorts;
}

function refuse(detail: string): never {
  throw new AgentJobPublicationRefusal(detail);
}

function record(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
}

/** A publish-only Actions retry can reuse a protected review from an earlier attempt. */
export function agentJobsPublicationRunTag(
  runId: string,
  currentAttempt: string,
  reviewedRunTag: string,
): string {
  const current = RUN_TAG.exec(`${runId}-${currentAttempt}`);
  const reviewed = RUN_TAG.exec(reviewedRunTag);
  if (
    !current || !reviewed || reviewed[1] !== current[1] ||
    BigInt(reviewed[2]) > BigInt(current[2])
  ) {
    refuse("reviewed run identity does not match this workflow run");
  }
  return reviewedRunTag;
}

/** Retained for reading historical final-message links. Publication uses immutable task text. */
export function linkAgentMessage(
  message: string,
  target: { id: string; repository: string; headSha: string },
): string {
  const checkout = `/agent-jobs/${target.id}/checkout/`;
  return message.replace(
    /\[([^\]\n]+)\]\((\/[^)\s]*)\)/g,
    (_link, label: string, path: string) => {
      const at = path.indexOf(checkout);
      if (at < 0) return label;
      const [, file, colon, anchor] = /^([^#:]+)(?::(\d+))?(?:#L(\d+))?/.exec(
        path.slice(at + checkout.length),
      ) ?? [];
      if (!file) return label;
      const line = colon ?? anchor;
      return `[${label}](https://github.com/${target.repository}/blob/${target.headSha}/${file}${
        line ? `#L${line}` : ""
      })`;
    },
  );
}

function trustedJobs(input: AgentJobsPublishInput): AgentJobV1[] {
  if (
    input.plan.schema !== "sentinel.agent-jobs.plan/v1" ||
    !RUN_TAG.test(input.runTag)
  ) {
    refuse("trusted plan or run identity is malformed");
  }
  const cells = input.plan.cells.filter((cell) => cell.cellId === input.cellId);
  if (cells.length !== 1 || cells[0].jobs.length === 0) {
    refuse("trusted plan has no unique nonempty cell");
  }
  const jobs = cells[0].jobs;
  const ids = new Set<string>();
  for (const job of jobs) {
    if (
      !JOB_ID.test(job.id) || ids.has(job.id) ||
      !REPOSITORY.test(job.repository) ||
      typeof job.prompt !== "string" || typeof job.pr !== "boolean" ||
      (job.review !== undefined && typeof job.review !== "boolean") ||
      typeof job.base !== "string" || !BASE_BRANCH.test(job.base) ||
      !isGitSha(job.baseSha)
    ) {
      refuse("trusted plan has an invalid job identity");
    }
    ids.add(job.id);
  }
  return jobs;
}

async function checkReviewedRow(
  row: Record<string, unknown> | null,
  job: AgentJobV1,
  runTag: string,
  base: string,
  baseSha: GitSha,
): Promise<AgentJobReviewV1> {
  const review = record(row?.review);
  const task = await agentJobTask(job, runTag);
  const verdict = REVIEWED_VERDICTS.find((possible) =>
    review?.verdict === possible
  );
  if (
    !row || row.id !== job.id || row.repository !== job.repository ||
    row.base !== base || row.baseSha !== baseSha || row.pr !== job.pr ||
    !review || review.id !== job.id || review.repository !== job.repository ||
    review.base !== base || review.baseSha !== baseSha ||
    review.runTag !== runTag ||
    review.taskDigest !== task.digest || !isGitSha(review.headSha) ||
    verdict === undefined || !Array.isArray(review.rounds)
  ) {
    refuse("reviewed result does not bind the trusted job");
  }
  if (verdict === "blocked") return review as unknown as AgentJobReviewV1;

  const noDiff = verdict !== "accepted";
  if (
    (noDiff && (row.status !== "no_changes" || row.bundle !== null ||
      row.headSha !== null || review.headSha !== baseSha)) ||
    (!noDiff &&
      (row.status !== "changed" || row.bundle !== `${job.id}.bundle` ||
        row.headSha !== review.headSha || review.headSha === baseSha))
  ) {
    refuse("review verdict does not match the reviewed candidate");
  }
  if (verdict === "skipped_no_diff") {
    if (job.review !== false || review.rounds.length !== 0) {
      refuse("review skip has no matching no-change authorization");
    }
    return review as unknown as AgentJobReviewV1;
  }
  if (job.review === false || review.rounds.length === 0) {
    refuse("completed native review is required for this verdict");
  }
  const requests = new Set<unknown>();
  for (const [index, value] of review.rounds.entries()) {
    const round = record(value);
    const final = index === review.rounds.length - 1;
    const headSha = final ? review.headSha : round?.headSha;
    if (
      !round || round.round !== index + 1 || !isGitSha(headSha) ||
      requests.has(round.requestId) ||
      record(round.execution)?.ownerRunId !== `agent-job:${runTag}:${job.id}`
    ) {
      refuse("native review history is malformed");
    }
    const disposition = await agentJobReviewRoundVerdict(round, {
      baseSha,
      headSha,
      taskDigest: task.digest,
    });
    if (
      final ? disposition !== verdict : disposition !== "correct" &&
        !(verdict === "already_satisfied" &&
          disposition === "already_satisfied" &&
          index === review.rounds.length - 2 && headSha !== baseSha)
    ) {
      refuse("native review evidence does not authorize the reported verdict");
    }
    requests.add(round.requestId);
  }
  return review as unknown as AgentJobReviewV1;
}

async function readRemoteRef(
  url: string,
  ref: string,
  env: Record<string, string>,
): Promise<GitSha | null> {
  const remote = await git([
    "-c",
    "http.followRedirects=false",
    "ls-remote",
    "--refs",
    "--exit-code",
    url,
    ref,
  ], { env });
  if (remote.code === 2) return null;
  const [sha, actualRef] = remote.stdout.split("\t");
  if (remote.code !== 0 || actualRef !== ref || !isGitSha(sha)) {
    refuse("remote branch identity could not be verified");
  }
  return sha;
}

async function checkCurrentBase(
  input: AgentJobsPublishInput,
  job: AgentJobV1,
  url: string,
  base: string,
  baseSha: GitSha,
  env: Record<string, string>,
): Promise<void> {
  if (
    !sentinelWorksRepositoryV1(
      await input.ports.repositoryVisibility(job.repository),
    )
  ) {
    refuse("target visibility is private or unavailable");
  }
  if (await readRemoteRef(url, `refs/heads/${base}`, env) !== baseSha) {
    refuse("target base changed since review");
  }
}

async function publishOne(
  input: AgentJobsPublishInput,
  row: Record<string, unknown> | null,
  job: AgentJobV1,
  publication: AgentJobPublicationV1,
): Promise<void> {
  const { base, baseSha } = job;
  if (base === null || !isGitSha(baseSha)) {
    refuse("trusted base is unavailable");
  }
  const review = await checkReviewedRow(row, job, input.runTag, base, baseSha);
  publication.reviewVerdict = review.verdict;
  publication.taskDigest = review.taskDigest;
  publication.reviewedHeadSha = review.headSha;
  if (review.verdict === "blocked") {
    refuse("trusted review gate blocked publication");
  }
  const head = review.headSha;
  if (!isGitSha(head)) refuse("reviewed head is malformed");
  const url = input.ports.remoteUrl(job.repository);
  const env = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "https:file",
    ...gitAuthEnv(input.writeToken),
  };
  await checkCurrentBase(input, job, url, base, baseSha, env);
  if (review.verdict !== "accepted") {
    publication.status = review.verdict;
    return;
  }

  const directory = await Deno.makeTempDir({
    dir: input.workRoot,
    prefix: `${job.id}-`,
  });
  const target = resolve(directory, "objects");
  const cloned = await git([
    "-c",
    "http.followRedirects=false",
    "clone",
    "--no-checkout",
    "--no-tags",
    "--single-branch",
    "--branch",
    base,
    url,
    target,
  ], { env });
  const options = { cwd: target };
  const checkedOut = cloned.code === 0
    ? await git(["rev-parse", "HEAD"], options)
    : null;
  if (checkedOut?.code !== 0 || checkedOut.stdout !== baseSha) {
    refuse("fresh clone did not resolve the reviewed base");
  }
  const checked = {
    repository: job.repository,
    sourcePath: target,
    baseSha,
    headSha: head,
    deadlineAtMs: Date.now() + 120_000,
  };
  try {
    await importAgentJobBundle({
      ...checked,
      bundlePath: resolve(input.artifactDir, `${job.id}.bundle`),
    });
    if (!await agentJobTreeChanged(checked)) {
      refuse(
        "a tree-equivalent head cannot be published as a changed candidate",
      );
    }
    // The shared inspection proves this is one commit directly on base and
    // checks every object it would expose, including commit metadata and blobs.
    await validateAgentJobPublication(checked);
  } catch (error) {
    if (error instanceof AgentJobPublicationRefusal) throw error;
    refuse("reviewed bundle or candidate publication checks failed");
  }
  const guarded = await pushGuardRefusal(
    async (original, candidate) => {
      const paths = await git([
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        original,
        candidate,
      ], options);
      return paths.code === 0
        ? portOk(paths.stdout.split("\0").filter((path) => path !== ""))
        : portError("unavailable", "candidate paths could not be read");
    },
    {
      base: baseSha,
      ownRepository: job.repository.toLowerCase() === CONTROLLER,
      // The manual plan carries no independently verified issue provenance.
      trust: () => Promise.resolve("unavailable"),
    },
    head,
  );
  if (guarded !== null) {
    refuse("candidate paths could not be authorized for publication");
  }

  const branch = `agent-jobs/${job.id}-${input.runTag}`;
  const ref = `refs/heads/${branch}`;
  await checkCurrentBase(input, job, url, base, baseSha, env);
  const before = await readRemoteRef(url, ref, env);
  if (before !== null && before !== head) {
    refuse("result branch already points to a different commit");
  }
  let pushExit = 0;
  if (before === null) {
    // An empty lease means the destination MUST be absent. This is create-only,
    // including against a racing ancestor ref that a plain push could fast-forward.
    const pushed = await git([
      "-c",
      "http.followRedirects=false",
      "push",
      "--quiet",
      `--force-with-lease=${ref}:`,
      url,
      `${head}:${ref}`,
    ], { ...options, env });
    pushExit = pushed.code;
  }
  const actual = await readRemoteRef(url, ref, env);
  if (actual === null && pushExit !== 0) {
    refuse(`result branch creation failed (Git exit ${pushExit})`);
  }
  if (actual !== head) {
    refuse("result branch does not carry the exact reviewed commit");
  }
  publication.branch = branch;
  publication.headSha = head;
  await checkCurrentBase(input, job, url, base, baseSha, env);
  if (await readRemoteRef(url, ref, env) !== head) {
    refuse("result branch moved before review comment creation");
  }
  const reviewInput = {
    id: job.id,
    repository: job.repository,
    headSha: head,
    runTag: input.runTag,
    taskDigest: review.taskDigest,
  };
  publication.reviewCommentUrl = await input.ports.ensureReviewComment(
    reviewInput,
  );
  if (job.pr) {
    await checkCurrentBase(input, job, url, base, baseSha, env);
    if (await readRemoteRef(url, ref, env) !== head) {
      refuse("result branch moved before draft creation");
    }
    const firstLine = job.prompt.trim().split("\n")[0].trim();
    publication.pullRequest = await input.ports.ensureDraftPullRequest({
      ...reviewInput,
      head: branch,
      base,
      baseSha,
      title: firstLine.slice(0, 72),
      body:
        `Sentinel on-demand job \`${job.id}\`.\n\nNative review verdict: **accepted**.\n\nReviewed commit: \`${head}\`.`,
    });
  }
  await checkCurrentBase(input, job, url, base, baseSha, env);
  if (await readRemoteRef(url, ref, env) !== head) {
    refuse("result branch moved during publication");
  }
  publication.status = "published";
}

/** Retain accepted siblings even when another trusted job is blocked. */
export async function publishAgentJobsCell(
  input: AgentJobsPublishInput,
): Promise<AgentJobPublicationV1[]> {
  const jobs = trustedJobs(input);
  const cell = record(input.reviewed);
  if (
    cell?.schema !== "sentinel.agent-jobs.cell-result/v1" ||
    cell.cellId !== input.cellId ||
    !Array.isArray(cell.results)
  ) {
    refuse("reviewed artifact does not match the trusted cell");
  }
  const rows = new Map<string, Record<string, unknown>>();
  const ids = new Set(jobs.map((job) => job.id));
  for (const raw of cell.results) {
    const row = record(raw);
    if (
      !row || typeof row.id !== "string" || !ids.has(row.id) || rows.has(row.id)
    ) {
      refuse("reviewed artifact contains a duplicate or foreign job");
    }
    rows.set(row.id, row);
  }
  await Deno.mkdir(input.workRoot, { recursive: true, mode: 0o700 });
  const publications: AgentJobPublicationV1[] = [];
  for (const job of jobs) {
    const publication: AgentJobPublicationV1 = {
      id: job.id,
      repository: job.repository,
      status: "blocked",
      reviewVerdict: null,
      taskDigest: null,
      reviewedHeadSha: null,
      branch: null,
      headSha: null,
      reviewCommentUrl: null,
      pullRequest: null,
      detail: "",
    };
    try {
      await publishOne(input, rows.get(job.id) ?? null, job, publication);
    } catch (error) {
      publication.detail = error instanceof AgentJobPublicationRefusal
        ? error.message
        : "publication could not be completed";
    }
    publications.push(publication);
    input.ports.log(
      `${job.id}: ${publication.status}${
        publication.detail ? ` (${publication.detail})` : ""
      }`,
    );
  }
  return publications;
}

async function readJson(path: string): Promise<unknown> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size > MAX_ARTIFACT_BYTES) {
    refuse("publication input is missing or over its size bound");
  }
  return JSON.parse(await Deno.readTextFile(path));
}

if (import.meta.main) {
  const env = (name: string) => Deno.env.get(name) ?? "";
  const directory = env("AGENT_JOBS_PUBLICATION_DIR");
  const artifactDir = env("AGENT_JOBS_REVIEWED_DIR");
  const cellId = env("AGENT_JOBS_CELL_ID");
  const token = env("AGENT_JOBS_WRITE_TOKEN");
  if (!directory) refuse("publication output directory is missing");
  let runTag = "";
  let publications: AgentJobPublicationV1[] = [];
  let detail = "";
  try {
    runTag = agentJobsPublicationRunTag(
      env("GITHUB_RUN_ID"),
      env("GITHUB_RUN_ATTEMPT"),
      env("AGENT_JOBS_REVIEW_RUN_TAG"),
    );
    if (!token || !artifactDir) {
      refuse("publication input or credential is missing");
    }
    publications = await publishAgentJobsCell({
      plan: await readJson(env("AGENT_JOBS_PLAN")) as AgentJobsPlanV1,
      cellId,
      reviewed: await readJson(resolve(artifactDir, "result.json")),
      artifactDir,
      workRoot: `${env("RUNNER_TEMP") || "/tmp"}/agent-jobs-publish`,
      runTag,
      writeToken: token,
      ports: githubAgentJobsPublishPorts(token, githubRemoteUrl),
    });
  } catch (error) {
    detail = error instanceof AgentJobPublicationRefusal
      ? error.message
      : "publication inputs could not be verified";
  }
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    resolve(directory, "result.json"),
    JSON.stringify(
      {
        schema: "sentinel.agent-jobs.publication/v1",
        cellId,
        runTag,
        results: publications,
        detail,
      },
      null,
      2,
    ) + "\n",
  );
  const summary = env("GITHUB_STEP_SUMMARY");
  if (summary) {
    const rows = publications.map((row) =>
      `| ${row.id} | ${row.repository} | ${
        row.reviewVerdict ?? "-"
      } | ${row.status} | ${
        row.pullRequest ?? row.branch ?? "-"
      } | ${row.detail} |`
    );
    await Deno.writeTextFile(
      summary,
      `| Job | Repository | Review verdict | Publication | Result | Detail |\n|---|---|---|---|---|---|\n${
        rows.join("\n")
      }\n\n${detail}\n`,
      { append: true },
    );
  }
  if (detail || publications.some((row) => row.status === "blocked")) {
    Deno.exit(1);
  }
}
