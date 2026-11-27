import { dirname, resolve } from "node:path";
import {
  AGENT_JOB_BASE_REF,
  agentJobBaseBundlePath,
  type PrivateAgentJobBase,
} from "./agent-jobs-admission.ts";
import {
  gitAuthEnv,
  githubRemoteUrl,
  gitOk,
  type RemoteUrl,
} from "./agent-jobs-git.ts";

/** Capture one selected commit in a bundle; temporary Git storage stays on this runner. */
export async function stagePrivateAgentJobBase(
  directory: string,
  { repository, sha, readToken }: PrivateAgentJobBase,
  remoteUrl: RemoteUrl = githubRemoteUrl,
): Promise<void> {
  const output = resolve(directory, agentJobBaseBundlePath(repository, sha));
  await Deno.mkdir(dirname(output), { recursive: true });
  const cwd = await Deno.makeTempDir({ dir: directory, prefix: "stage-git-" });
  try {
    await gitOk(["init", "--quiet", "--bare"], { cwd });
    await gitOk([
      "-c",
      "http.followRedirects=false",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      remoteUrl(repository),
      `${sha}:${AGENT_JOB_BASE_REF}`,
    ], { cwd, env: gitAuthEnv(readToken) });
    if (
      await gitOk(["rev-parse", "--verify", AGENT_JOB_BASE_REF], { cwd }) !==
        sha
    ) {
      throw new Error("staged base changed");
    }
    await gitOk(["bundle", "create", output, AGENT_JOB_BASE_REF], { cwd });
  } catch {
    throw new Error("private agent job base could not be staged");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
}
