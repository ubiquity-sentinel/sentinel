/**
 * EXPERIMENTAL manual agent-job lane: the `publish` step.
 *
 * Runs in its own job, after the model has exited, and is the only place a
 * write token exists. For each sealed bundle of one cell it clones the target
 * base, verifies that the bundle's tip is the recorded commit and descends
 * from the recorded base, and pushes it (never forced) to a fresh
 * `agent-jobs/<job>-<run>` branch. A draft pull request is opened only when
 * the job asked for one. It writes no Sentinel state and merges nothing.
 */
import { resolve } from "node:path";
import {
  cloneBranch,
  git,
  gitAuthEnv,
  githubRemoteUrl,
  gitOk,
} from "./agent-jobs-git.ts";
import type { RemoteUrl } from "./agent-jobs-git.ts";
import { AGENT_JOB_BRANCH } from "./agent-jobs-cell.ts";
import type {
  AgentJobResultV1,
  AgentJobsCellResultV1,
} from "./agent-jobs-cell.ts";

export interface AgentJobPublicationV1 {
  id: string;
  repository: string;
  status: AgentJobResultV1["status"];
  branch: string | null;
  headSha: string | null;
  pullRequest: string | null;
  detail: string;
}

export interface AgentJobsPublishPorts {
  remoteUrl: RemoteUrl;
  /** Open a draft pull request and return its URL. */
  openPullRequest: (input: {
    repository: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }) => Promise<string>;
  log: (line: string) => void;
}

export interface AgentJobsPublishInput {
  cell: AgentJobsCellResultV1;
  /** Directory holding the cell's bundles and final messages. */
  artifactDir: string;
  workRoot: string;
  /** Unique per workflow run attempt; part of every pushed branch name. */
  runTag: string;
  writeToken: string | null;
  ports: AgentJobsPublishPorts;
}

/**
 * The agent's final message links files by their path on the runner, which
 * leads nowhere in a pull request. Links into this job's checkout become
 * links to the pushed commit; any other absolute-path link keeps its label
 * only.
 */
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

async function publishOne(
  input: AgentJobsPublishInput,
  result: AgentJobResultV1,
): Promise<AgentJobPublicationV1> {
  const publication: AgentJobPublicationV1 = {
    id: result.id,
    repository: result.repository,
    status: result.status,
    branch: null,
    headSha: null,
    pullRequest: null,
    detail: result.detail,
  };
  if (
    result.bundle === null || result.headSha === null ||
    result.base === null || result.baseSha === null
  ) return publication;
  if (!/^[a-z0-9-]+\.bundle$/.test(result.bundle)) {
    throw new Error("bundle name is not a plain file name");
  }
  const bundle = resolve(input.artifactDir, result.bundle);
  const directory = `${input.workRoot}/${result.id}`;
  const url = input.ports.remoteUrl(result.repository);
  await cloneBranch({
    url,
    base: result.base,
    directory,
    token: input.writeToken,
  });
  const cwd = { cwd: directory };
  await gitOk(["cat-file", "-e", `${result.baseSha}^{commit}`], cwd);
  await gitOk(["bundle", "verify", "--quiet", bundle], cwd);
  const branch = `agent-jobs/${result.id}-${input.runTag}`;
  await gitOk([
    "fetch",
    "--quiet",
    bundle,
    `refs/heads/${AGENT_JOB_BRANCH}:refs/heads/${branch}`,
  ], cwd);
  const tip = await gitOk(["rev-parse", `refs/heads/${branch}`], cwd);
  if (tip !== result.headSha) {
    throw new Error("bundle tip is not the commit the cell recorded");
  }
  const descends = await git(
    ["merge-base", "--is-ancestor", result.baseSha, tip],
    cwd,
  );
  if (descends.code !== 0) {
    throw new Error("bundle tip does not descend from the recorded base");
  }
  await gitOk(
    ["push", "--quiet", url, `refs/heads/${branch}:refs/heads/${branch}`],
    { ...cwd, env: gitAuthEnv(input.writeToken) },
  );
  publication.branch = branch;
  publication.headSha = tip;
  if (result.pr) {
    const message = await Deno.readTextFile(
      `${input.artifactDir}/${result.id}.md`,
    ).catch(() => "");
    publication.pullRequest = await input.ports.openPullRequest({
      repository: result.repository,
      head: branch,
      base: result.base,
      title: result.title,
      body: `Manual Sentinel agent job \`${result.id}\`.\n\n${
        linkAgentMessage(message, {
          id: result.id,
          repository: result.repository,
          headSha: tip,
        })
      }`.slice(0, 60_000),
    });
  }
  return publication;
}

/** Publish every bundle of one cell; one failure does not stop the others. */
export async function publishAgentJobsCell(
  input: AgentJobsPublishInput,
): Promise<AgentJobPublicationV1[]> {
  const publications: AgentJobPublicationV1[] = [];
  for (const result of input.cell.results) {
    try {
      publications.push(await publishOne(input, result));
    } catch (error) {
      publications.push({
        id: result.id,
        repository: result.repository,
        status: result.status,
        branch: null,
        headSha: null,
        pullRequest: null,
        detail: `publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    const last = publications[publications.length - 1];
    input.ports.log(
      `${last.id}: ${last.status} ${
        last.pullRequest ?? last.branch ?? ""
      } ${last.detail}`
        .trim(),
    );
  }
  return publications;
}

/** CLI for `.github/workflows/agent-jobs.yml`. */
if (import.meta.main) {
  const env = (name: string) => Deno.env.get(name) ?? "";
  const token = env("AGENT_JOBS_WRITE_TOKEN");
  if (token.length === 0) throw new Error("AGENT_JOBS_WRITE_TOKEN is not set");
  const artifactDir = env("AGENT_JOBS_ARTIFACT_DIR");
  const cell = JSON.parse(
    await Deno.readTextFile(`${artifactDir}/result.json`),
  ) as AgentJobsCellResultV1;
  const publications = await publishAgentJobsCell({
    cell,
    artifactDir,
    workRoot: `${env("RUNNER_TEMP") || "/tmp"}/agent-jobs-publish`,
    runTag: `${env("GITHUB_RUN_ID")}-${env("GITHUB_RUN_ATTEMPT")}`,
    writeToken: token,
    ports: {
      remoteUrl: githubRemoteUrl,
      openPullRequest: async (request) => {
        const response = await fetch(
          `https://api.github.com/repos/${request.repository}/pulls`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
            },
            body: JSON.stringify({
              title: request.title,
              head: request.head,
              base: request.base,
              body: request.body,
              draft: true,
            }),
          },
        );
        if (!response.ok) {
          throw new Error(`pull request refused: HTTP ${response.status}`);
        }
        return (await response.json()).html_url as string;
      },
      log: (line) => console.log(line),
    },
  });
  const summary = env("GITHUB_STEP_SUMMARY");
  if (summary) {
    const rows = publications.map((row) =>
      `| ${row.id} | ${row.repository} | ${row.status} | ${
        row.pullRequest ?? row.branch ?? "-"
      } | ${row.detail} |`
    );
    await Deno.writeTextFile(
      summary,
      `| job | repository | status | pushed | detail |\n|---|---|---|---|---|\n${
        rows.join("\n")
      }\n`,
      { append: true },
    );
  }
  if (publications.some((row) => row.detail.startsWith("publish failed"))) {
    Deno.exit(1);
  }
}
