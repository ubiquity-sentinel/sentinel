import { type GitSha, isGitSha } from "../src/contracts/brands.ts";
import { GitReviewSnapshot } from "../src/github/review-snapshot.ts";
import { SENTINEL_AUTHORITY_PATHS } from "../src/host/hosted-authority-protected-paths.ts";
import { DenoReplayRuntime } from "../src/replay/runtime.ts";

export const AGENT_JOB_BUNDLE_REF = "refs/heads/agent-job";
const BASE_REF = "refs/heads/agent-job-base";
const MAX_GIT_MS = 120_000;
const MAX_BUNDLE_HEADER_BYTES = 64 * 1024;
const decode = new TextDecoder();

export class AgentJobGateRefusal extends Error {}

export interface AgentJobGitInput {
  sourcePath: string;
  deadlineAtMs: number;
  now?: () => number;
}

type CandidateInput = AgentJobGitInput & {
  baseSha: string;
  headSha: string;
};

export function agentJobTimeLeft(
  input: Pick<AgentJobGitInput, "deadlineAtMs" | "now">,
): number {
  const remaining = input.deadlineAtMs - (input.now ?? Date.now)();
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new AgentJobGateRefusal("original job deadline elapsed");
  }
  return remaining;
}

async function git(
  input: AgentJobGitInput,
  args: string[],
  options: { transport?: string; commitTime?: string } = {},
): Promise<string> {
  const trustedPath = Deno.env.get("PATH") ?? "/usr/bin:/bin";
  const result = await new DenoReplayRuntime(trustedPath).run({
    executable: "git",
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "fetch.fsckObjects=true",
      "-c",
      "transfer.fsckObjects=true",
      ...args,
    ],
    cwd: input.sourcePath,
    env: {
      PATH: trustedPath,
      HOME: input.sourcePath,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: options.transport ?? "",
      GIT_AUTHOR_NAME: "ubiquity-sentinel[bot]",
      GIT_COMMITTER_NAME: "ubiquity-sentinel[bot]",
      GIT_AUTHOR_EMAIL: "ubiquity-sentinel[bot]@users.noreply.github.com",
      GIT_COMMITTER_EMAIL: "ubiquity-sentinel[bot]@users.noreply.github.com",
      ...(options.commitTime === undefined ? {} : {
        GIT_AUTHOR_DATE: options.commitTime,
        GIT_COMMITTER_DATE: options.commitTime,
      }),
      LC_ALL: "C",
    },
    maxDurationMs: Math.min(MAX_GIT_MS, agentJobTimeLeft(input)),
    maxOutputBytes: 16 * 1024,
  });
  if (
    result.outcome !== "exited" || result.exitCode !== 0 ||
    result.truncated || !result.settled
  ) {
    throw new AgentJobGateRefusal(
      `candidate Git ${args[0]} verification failed`,
    );
  }
  return decode.decode(result.stdout).trim();
}

function assertCandidateShas(
  input: CandidateInput,
): asserts input is CandidateInput & { baseSha: GitSha; headSha: GitSha } {
  if (!isGitSha(input.baseSha) || !isGitSha(input.headSha)) {
    throw new AgentJobGateRefusal("candidate commit identity is malformed");
  }
}

export async function fetchAgentJobBase(
  input: AgentJobGitInput & { base: string; baseSha: string; remote: string },
): Promise<void> {
  await git(input, ["check-ref-format", `refs/heads/${input.base}`]);
  await git(input, ["init", "--bare", "--template=", "--quiet"]);
  await git(input, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-recurse-submodules",
    input.remote,
    `refs/heads/${input.base}:${BASE_REF}`,
  ], { transport: "https:file" });
  if ((await git(input, ["rev-parse", BASE_REF])) !== input.baseSha) {
    throw new AgentJobGateRefusal("pinned base is stale");
  }
}

export async function confirmAgentJobBase(
  input: AgentJobGitInput & { base: string; baseSha: string; remote: string },
): Promise<void> {
  const ref = `refs/heads/${input.base}`;
  const current = await git(input, [
    "ls-remote",
    "--exit-code",
    "--refs",
    input.remote,
    ref,
  ], { transport: "https:file" });
  if (current !== `${input.baseSha}\t${ref}`) {
    throw new AgentJobGateRefusal("pinned base is stale");
  }
}

export async function cloneAgentJobObjects(
  input: AgentJobGitInput & { from: string; to: string },
): Promise<void> {
  await git(input, [
    "clone",
    "--bare",
    "--quiet",
    "--no-hardlinks",
    "--template=",
    input.from,
    input.to,
  ], { transport: "file" });
}

async function assertBundleHeader(
  path: string,
  base: string,
  head: string,
): Promise<void> {
  if (!(await Deno.lstat(path)).isFile) {
    throw new AgentJobGateRefusal("candidate bundle is not a regular file");
  }
  const bytes = new Uint8Array(MAX_BUNDLE_HEADER_BYTES);
  using file = await Deno.open(path, { read: true });
  let length = 0;
  for (;;) {
    const count = await file.read(bytes.subarray(length));
    if (count === null || count === 0) break;
    length += count;
    if (length === bytes.length) break;
  }
  const text = decode.decode(bytes.subarray(0, length));
  const end = text.indexOf("\n\n");
  const lines = end < 0 ? [] : text.slice(0, end).split("\n");
  const version = lines.shift();
  if (version === "# v3 git bundle" && lines[0] === "@object-format=sha1") {
    lines.shift();
  }
  if (
    (version !== "# v2 git bundle" && version !== "# v3 git bundle") ||
    lines.length !== 2 || !lines[0].startsWith(`-${base} `) ||
    lines[1] !== `${head} ${AGENT_JOB_BUNDLE_REF}`
  ) {
    throw new AgentJobGateRefusal("candidate bundle seal does not match");
  }
}

/** Imports one exact advertised commit, using only its pinned base as prerequisite. */
export async function importAgentJobBundle(
  input: CandidateInput & { bundlePath: string },
): Promise<void> {
  assertCandidateShas(input);
  await assertBundleHeader(input.bundlePath, input.baseSha, input.headSha);
  await git(input, ["bundle", "verify", "--quiet", input.bundlePath]);
  await git(input, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-recurse-submodules",
    input.bundlePath,
    `+${AGENT_JOB_BUNDLE_REF}:${AGENT_JOB_BUNDLE_REF}`,
  ], { transport: "file" });
  if (
    (await git(input, ["rev-parse", `${AGENT_JOB_BUNDLE_REF}^{commit}`])) !==
      input.headSha
  ) {
    throw new AgentJobGateRefusal("candidate bundle tip does not match");
  }
  await git(input, [
    "merge-base",
    "--is-ancestor",
    input.baseSha,
    input.headSha,
  ]);
}

async function tree(input: AgentJobGitInput, commit: string): Promise<string> {
  const sha = await git(input, ["rev-parse", "--verify", `${commit}^{tree}`]);
  if (!isGitSha(sha)) {
    throw new AgentJobGateRefusal("candidate tree is missing");
  }
  return sha;
}

export async function agentJobTreeChanged(
  input: CandidateInput,
): Promise<boolean> {
  assertCandidateShas(input);
  return (await tree(input, input.baseSha)) !==
    (await tree(input, input.headSha));
}

export async function normalizeAgentJobCandidate(
  input: CandidateInput & { id: string; createdAtMs: number },
): Promise<string> {
  assertCandidateShas(input);
  const candidateTree = await tree(input, input.headSha);
  if (candidateTree === await tree(input, input.baseSha)) return input.baseSha;
  const commit = await git(input, [
    "commit-tree",
    candidateTree,
    "-p",
    input.baseSha,
    "-m",
    `Sentinel agent job ${input.id}`,
  ], { commitTime: `@${Math.floor(input.createdAtMs / 1000)} +0000` });
  if (!isGitSha(commit)) {
    throw new AgentJobGateRefusal("normalized candidate commit is missing");
  }
  return commit;
}

export async function verifyAgentJobCorrection(
  input: CandidateInput & { rejectedHead: string },
): Promise<void> {
  assertCandidateShas(input);
  if (!isGitSha(input.rejectedHead)) {
    throw new AgentJobGateRefusal("correction parent is malformed");
  }
  const parent = await git(input, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    input.headSha,
  ]);
  if (parent !== `${input.headSha} ${input.rejectedHead}`) {
    throw new AgentJobGateRefusal(
      "correction does not directly follow rejected head",
    );
  }
}

/** One pre-reviewed commit is the entire object graph a publisher may introduce. */
export async function validateAgentJobPublication(
  input: CandidateInput & { repository: string },
): Promise<void> {
  assertCandidateShas(input);
  const parent = await git(input, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    input.headSha,
  ]);
  if (parent !== `${input.headSha} ${input.baseSha}`) {
    throw new AgentJobGateRefusal(
      "publication is not one exact commit on the pinned base",
    );
  }
  const self = [
    "ubiquity-sentinel/sentinel",
    "ubiquity-sentinel-private/sentinel",
  ].includes(input.repository.toLowerCase());
  const protectedPaths = self
    ? [
      ...SENTINEL_AUTHORITY_PATHS,
      ".github/workflows/agent-jobs.yml",
      ".github/workflows/agent-jobs-delivery.yml",
      ".github/workflows/agent-jobs-cleanup.yml",
      "ops/agent-jobs-admission.ts",
      "ops/agent-jobs-cleanup.ts",
      "ops/agent-jobs-correct.ts",
      "ops/agent-jobs-intake.ts",
      "ops/agent-jobs-native-review.ts",
      "ops/agent-jobs-plan.ts",
      "ops/agent-jobs-prepare.ts",
      "ops/agent-jobs-publish.ts",
      "ops/agent-jobs-publish-github.ts",
      "ops/agent-jobs-review.ts",
      "ops/agent-jobs-review-contract.ts",
      "ops/agent-jobs-review-git.ts",
    ]
    : [];
  const check = await new GitReviewSnapshot({
    repositoryDir: input.sourcePath,
    trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    totalDeadlineMs: Math.min(30_000, agentJobTimeLeft(input)),
  }).validatePublication({
    base: input.baseSha,
    head: input.headSha,
    publishedHead: null,
    protectedPaths,
  });
  if (!check.ok) throw new AgentJobGateRefusal(check.error.detail);
}

export async function sealAgentJobBundle(
  input: CandidateInput & { bundlePath: string },
): Promise<void> {
  assertCandidateShas(input);
  await keepAgentJobHead(input);
  await git(input, [
    "bundle",
    "create",
    "--quiet",
    "--version=2",
    input.bundlePath,
    `${input.baseSha}..${AGENT_JOB_BUNDLE_REF}`,
  ]);
  await assertBundleHeader(input.bundlePath, input.baseSha, input.headSha);
}

export async function keepAgentJobHead(
  input: CandidateInput,
): Promise<void> {
  assertCandidateShas(input);
  await git(input, ["update-ref", AGENT_JOB_BUNDLE_REF, input.headSha]);
}
