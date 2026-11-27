import {
  HOSTED_CONTROLLER_API_PATH,
  HOSTED_CONTROLLER_RUNTIME_ID,
} from "../src/contracts/hosted-controller-deployment.ts";
import { parseHostedRuntimeRecordV1 } from "../src/contracts/hosted-supervisor-runtime.ts";
import { hostedOrdinaryAdmissionMode } from "../src/contracts/hosted-supervisor-verification.ts";
import { sha256Hex } from "../src/state/state-records.ts";
import {
  AGENT_JOB_SHA,
  type AgentJobsGitHubRead,
  readAgentJobsGitHubObject,
} from "./agent-jobs-admission.ts";

const STATE_REF = "refs/heads/sentinel-state/release";

/** Require the actual protected checkout to have a healthy private deployment receipt. */
export async function requireInstalledAgentJobsLauncher(
  launcherSha: string,
  nativeToken: string,
  read: AgentJobsGitHubRead = fetch,
): Promise<void> {
  try {
    if (!AGENT_JOB_SHA.test(launcherSha)) throw new Error();
    const api = "https://api.github.com" + HOSTED_CONTROLLER_API_PATH;
    const ref = await readAgentJobsGitHubObject(
      api + "/git/ref/heads/sentinel-state/release",
      read,
      nativeToken,
    );
    const commit = ref?.object as { type?: unknown; sha?: unknown } | undefined;
    if (
      ref?.ref !== STATE_REF || commit?.type !== "commit" ||
      typeof commit.sha !== "string" || !AGENT_JOB_SHA.test(commit.sha)
    ) throw new Error();
    const path = `hostedRuntimes/${await sha256Hex(
      HOSTED_CONTROLLER_RUNTIME_ID,
    )}.json`;
    const response = await readAgentJobsGitHubObject(
      `${api}/contents/${path}?ref=${commit.sha}`,
      read,
      nativeToken,
    );
    if (
      response?.type !== "file" || response.path !== path ||
      response.encoding !== "base64" || typeof response.content !== "string" ||
      response.content.length > 100_000
    ) throw new Error();
    const body = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(response.content), (char) => char.charCodeAt(0)),
    );
    const runtime = parseHostedRuntimeRecordV1(JSON.parse(body));
    if (
      runtime.activeRevision !== launcherSha ||
      hostedOrdinaryAdmissionMode(runtime) !== "healthy" ||
      runtime.lastHealthyProof?.execution.launcherSha !== launcherSha
    ) throw new Error();
  } catch {
    throw new Error(
      "private agent jobs requires the protected launcher to be installed and healthy",
    );
  }
}
