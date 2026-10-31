/** Passport's issue-only CI capability, bound to the current base's own workflow.
 * Native push jobs execute that base; PR backup jobs count only when the trusted
 * store proves the identical execution tree. Check names alone grant no authority.
 */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type { BackupCiCommitFileV1 } from "../contracts/backup-ci.ts";
import {
  type GitHubChecksV1,
  type GitHubCheckV1,
  portError,
  portOk,
  type PortResultV1,
} from "../contracts/ports.ts";
import {
  type BackupCiClientReadsV1,
  type BackupCiPagesV1,
  backupCiSelectionFor,
} from "./client-backup-ci.ts";
import { completedJobNeverStarted } from "./never-started-job.ts";
import { standInCheck } from "./backup-ci-substitute.ts";

const WORKFLOW = ".github/workflows/ci.yml";
const JOB = "deno";
const REPOSITORY = "ubiquity/passport.ubq.fi";
const row = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const id = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const refused = () => portError("unavailable", "base CI binding unavailable");

/** The existing store is authoritative only for equivalent source and execution. */
function equivalent(
  file: BackupCiCommitFileV1,
  sha: GitSha,
  tree: GitSha,
  blob: GitSha,
  parents: GitSha[],
): boolean {
  const coverage = file.workflows.filter((entry) => entry.path === WORKFLOW);
  return coverage.length > 0 &&
    coverage.every((entry) =>
      entry.supported && entry.blob === blob &&
      entry.expected.length === 1 && entry.expected[0] === JOB
    ) && file.entries.every((entry) => {
      if (entry.state !== "result" || entry.key.checkName !== JOB) return true;
      const binding = entry.binding;
      const expectedParents = entry.key.context === "push"
        ? parents
        : [entry.key.base, sha];
      return entry.key.workflowPath === WORKFLOW &&
        binding.tree === tree && binding.workflowBlob === blob &&
        binding.jobKey === JOB && binding.matrix === null &&
        (entry.key.context !== "push" || binding.execCommit === sha) &&
        binding.parents.length === expectedParents.length &&
        binding.parents.every((parent, index) =>
          parent === expectedParents[index]
        );
    });
}

export async function readPassportBaseReviewChecks(input: {
  sha: GitSha;
  names: readonly string[];
  raws: readonly unknown[];
  checks: readonly GitHubCheckV1[];
  read: (
    path: string,
    query?: Record<string, string>,
  ) => Promise<PortResultV1<unknown>>;
  pages: BackupCiPagesV1;
  backup: BackupCiClientReadsV1 | null;
}): Promise<PortResultV1<GitHubChecksV1>> {
  const { sha, names, raws, read, pages, backup } = input;
  if (
    names.length !== 1 || names[0] !== JOB || raws.length === 0 ||
    raws.length !== input.checks.length
  ) return refused();

  const commitRead = await read(`/git/commits/${sha}`);
  if (!commitRead.ok) return commitRead;
  const commit = row(commitRead.value);
  const tree = row(commit?.tree)?.sha;
  const parents = Array.isArray(commit?.parents)
    ? commit.parents.map((parent) => row(parent)?.sha)
    : [];
  if (
    commit?.sha !== sha || !isGitSha(tree) ||
    !Array.isArray(commit.parents) || !parents.every(isGitSha)
  ) return refused();
  const treeRead = await read(`/git/trees/${tree}`, { recursive: "1" });
  if (!treeRead.ok) return treeRead;
  const source = row(treeRead.value);
  if (
    source?.sha !== tree || source.truncated !== false ||
    !Array.isArray(source.tree)
  ) return refused();
  const workflows = source.tree.map(row).filter((entry) =>
    entry?.path === WORKFLOW
  );
  const workflow = workflows[0];
  if (
    workflows.length !== 1 || workflow?.mode !== "100644" ||
    workflow.type !== "blob" || !isGitSha(workflow.sha)
  ) return refused();
  const blob = workflow.sha;

  const runsRead = await pages(
    "/actions/runs",
    { head_sha: sha },
    "workflow_runs",
  );
  if (!runsRead.ok) return runsRead;
  const jobs = new Map<number, unknown>();
  const checks: GitHubCheckV1[] = [];
  for (let index = 0; index < raws.length; index++) {
    const raw = row(raws[index]);
    const suite = row(raw?.check_suite)?.id;
    const runs = runsRead.value.map(row).filter((run) =>
      id(suite) && run?.check_suite_id === suite
    );
    const run = runs[0];
    if (
      runs.length !== 1 || !run || !id(run.id) || !id(run.run_attempt) ||
      run.path !== WORKFLOW || run.head_sha !== sha ||
      row(run.repository)?.full_name !== REPOSITORY ||
      row(run.head_repository)?.full_name !== REPOSITORY ||
      row(run.head_commit)?.id !== sha ||
      row(run.head_commit)?.tree_id !== tree ||
      (run.event !== "push" && run.event !== "pull_request")
    ) return refused();
    const jobsRead = await pages(
      `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
      {},
      "jobs",
    );
    if (!jobsRead.ok) return jobsRead;
    // Complete paged job coverage, not a matching name from an unrelated suite.
    const job = row(jobsRead.value[0]);
    const check = input.checks[index];
    if (
      jobsRead.value.length !== 1 || !job || !id(job.id) ||
      job.id !== raw?.id || job.run_id !== run.id || job.head_sha !== sha ||
      job.name !== JOB || job.status !== check.status ||
      job.conclusion !== check.conclusion
    ) return refused();
    if (
      check.conclusion === "success" &&
      (!id(job.runner_id) || !Array.isArray(job.steps) ||
        job.steps.length === 0)
    ) return refused();
    jobs.set(job.id, job);
    const neverStarted = completedJobNeverStarted(job, job.id, sha) === true;
    // A native PR run's head SHA alone does not prove its merge execution tree.
    if (!neverStarted && run.event !== "push") return refused();
    checks.push(neverStarted ? { ...check, neverStarted: true } : check);
  }
  if (!checks.some((check) => check.neverStarted) || backup === null) {
    return portOk({ head: sha, checks });
  }

  const reader = backup.reader;
  const ctx: BackupCiClientReadsV1 = {
    ...backup,
    // These listings need this capability's stricter producer verification.
    listings: undefined,
    // Retain the existing all-attempt, calibration, suspension, status-context
    // and producer/workflow rules; additionally bind the store to this base.
    reader: {
      targets: reader.targets,
      target: (repository) => reader.target(repository),
      async read(repository, head) {
        const store = await reader.read(repository, head);
        return store.kind === "ok" && store.file !== null &&
            !equivalent(store.file, sha, tree, blob, parents as GitSha[])
          ? { kind: "invalid", detail: "base CI equivalence unavailable" }
          : store;
      },
    },
    readJob: (jobId) =>
      jobs.has(jobId)
        ? Promise.resolve(jobs.get(jobId))
        : backup.readJob(jobId),
    async pages(path, query, key) {
      const listed = await pages(path, query, key);
      if (listed.ok && key === "check_runs") {
        for (const value of listed.value) {
          const raw = row(value);
          if (raw?.name !== JOB) continue;
          const app = row(raw.app);
          if (
            raw.head_sha !== sha || app?.id !== 15368 ||
            app.slug !== "github-actions"
          ) return refused();
        }
      }
      return listed;
    },
  };
  const selection = await backupCiSelectionFor(ctx, sha, raws, async () => {
    const statuses = await pages(`/commits/${sha}/statuses`, {}, null);
    if (!statuses.ok) return null;
    const contexts = statuses.value.map((status) => row(status)?.context);
    return contexts.every((context) => typeof context === "string")
      ? new Set(contexts as string[])
      : null;
  });
  return portOk({
    head: sha,
    checks: checks.map((check, index) => {
      const checkId = row(raws[index])?.id;
      const standIn = typeof checkId === "number"
        ? selection?.selection.standIns.get(checkId)
        : undefined;
      return backup.mode === "on" && check.neverStarted && standIn !== undefined
        ? standInCheck(check, standIn)
        : check;
    }),
  });
}
