/** Continue an exact review-rejected head in a fresh restricted client. */
import { isGitSha } from "../src/contracts/brands.ts";
import { codexChildEnv, ensureTaskClient } from "../src/host/local-client.ts";
import { joinPath, trustedGitPath } from "../src/host/local-io.ts";
import { GIT_MAX_OUTPUT_BYTES } from "../src/host/local-policy.ts";
import { GATEWAY_PROVIDER } from "../src/host/model-route.ts";
import { CodexSubprocessSession } from "../src/repair/codex-transport.ts";
import {
  isBoundedId,
  isValidModelId,
} from "../src/repair/model-port-policy.ts";
import { DenoReplayRuntime } from "../src/replay/runtime.ts";
import {
  type AgentJobRunner,
  type AgentJobV1,
  resolveAgentJobReasoningEffort,
} from "./agent-jobs-plan.ts";

const PROFILE = "sentinel-local";

interface CorrectionInput {
  job: AgentJobV1;
  sourcePath: string;
  headSha: string;
  feedback: string;
  workRoot: string;
  deadlineAtMs: number;
  modelToken: string;
  baseUrl: string;
  defaultModel: string;
  signal?: AbortSignal;
}

class CorrectionError extends Error {}
class CorrectionUnsettled extends CorrectionError {}

function remaining(input: CorrectionInput): number {
  if (input.signal?.aborted) throw new CorrectionError("correction aborted");
  const time = input.deadlineAtMs - Date.now();
  if (!Number.isSafeInteger(time) || time <= 0) {
    throw new CorrectionError("correction deadline exhausted");
  }
  return time;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundId(value: unknown): value is string {
  return typeof value === "string" && isBoundedId(value);
}

async function installedCodex(path: string): Promise<string> {
  for (
    const directory of path.split(":").filter((dir) => dir.startsWith("/"))
  ) {
    try {
      const file = joinPath(directory, "codex");
      if ((await Deno.stat(file)).isFile) return await Deno.realPath(file);
    } catch {
      // Try the next entry in the runner's trusted PATH.
    }
  }
  throw new CorrectionError(
    "correction requires an installed Codex app-server",
  );
}

function checkRunner(runner: AgentJobRunner): void {
  const { os, arch } = Deno.build;
  if (runner === "macos-arm64" && os === "darwin" && arch === "aarch64") return;
  if (runner === "linux-x64" && os === "linux" && arch === "x86_64") return;
  if (
    os === "linux" && arch === "aarch64" &&
    (runner === "linux-arm64" || runner === "linux-arm64-26")
  ) return;
  throw new CorrectionError(
    "correction runner does not match the requested runner",
  );
}

function sandboxCommand(
  session: CodexSubprocessSession,
  input: CorrectionInput,
  checkout: string,
  command: string[],
): Promise<unknown> {
  return session.send("command/exec", {
    command,
    cwd: checkout,
    permissionProfile: PROFILE,
    timeoutMs: Math.min(remaining(input), 5_000),
    outputBytesCap: 2_048,
  });
}

async function proveSandbox(
  session: CodexSubprocessSession,
  input: CorrectionInput,
  root: string,
  checkout: string,
): Promise<void> {
  const name = `.sentinel-probe-${crypto.randomUUID()}`;
  const inside = joinPath(checkout, name);
  const outside = joinPath(root, name);
  const metadata = joinPath(checkout, ".git", name);
  await Deno.writeTextFile(outside, name, { createNew: true, mode: 0o600 });
  await Deno.writeTextFile(metadata, name, { createNew: true, mode: 0o600 });
  try {
    const touch = record(
      await sandboxCommand(session, input, checkout, [
        "/usr/bin/touch",
        inside,
      ]),
    );
    if (touch?.exitCode !== 0 || !(await Deno.lstat(inside)).isFile) {
      throw new CorrectionError("correction sandbox write probe failed");
    }
    const read = record(
      await sandboxCommand(session, input, checkout, [
        "/bin/cat",
        outside,
      ]),
    );
    if (
      typeof read?.exitCode !== "number" || read.exitCode === 0 ||
      typeof read.stdout !== "string" || read.stdout.includes(name)
    ) {
      throw new CorrectionError("correction sandbox exposed a host file");
    }
    for (const marker of [outside, metadata]) {
      const copied = record(
        await sandboxCommand(session, input, checkout, [
          "/bin/cp",
          inside,
          marker,
        ]),
      );
      if (
        typeof copied?.exitCode !== "number" ||
        await Deno.readTextFile(marker) !== name
      ) {
        throw new CorrectionError(
          "correction sandbox allowed a protected write",
        );
      }
    }
    await Deno.remove(inside);
  } catch (error) {
    if (error instanceof CorrectionError) throw error;
    throw new CorrectionError("correction sandbox probe unavailable");
  }
  await Deno.remove(outside);
  await Deno.remove(metadata);
}

async function runCorrection(
  input: CorrectionInput,
  root: string,
  checkout: string,
  path: string,
  endpoint: string,
): Promise<void> {
  const codex = await installedCodex(path);
  const model = input.job.model ?? input.defaultModel;
  const effort = resolveAgentJobReasoningEffort(
    input.job.reasoningEffort,
    input.job.id,
  );
  if (!isValidModelId(model)) {
    throw new CorrectionError("correction model is invalid");
  }
  const clientHome = joinPath(root, "client");
  const tmpDir = joinPath(root, "tmp");
  const denoDir = joinPath(root, "deno");
  await ensureTaskClient({
    clientHome,
    tmpDir,
    denoDir,
    checkout,
    token: input.modelToken,
    codexExecutable: codex,
    denoExecutable: Deno.execPath(),
    trustedPath: path,
    baseUrl: endpoint,
  });

  const session = new CodexSubprocessSession({
    command: [
      codex,
      "app-server",
      "-c",
      `projects.${JSON.stringify(checkout)}.trust_level="untrusted"`,
    ],
    cwd: root,
    env: codexChildEnv(clientHome, tmpDir, denoDir, path),
    operationDeadlineMs: remaining(input),
  });
  let threadId: string | undefined;
  let turnId: string | undefined;
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  let terminalStatus: unknown;
  let invalidEvidence = false;
  let failure: { error: unknown } | undefined;
  try {
    const budgetMs = remaining(input);
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        aborted = true;
        reject(new CorrectionError("correction deadline exhausted"));
      }, budgetMs);
      stop = () => {
        aborted = true;
        reject(new CorrectionError("correction aborted"));
      };
      input.signal?.addEventListener("abort", stop, { once: true });
    });
    session.open();
    const request = (method: string, params: unknown) => {
      remaining(input);
      return Promise.race([session.send(method, params), budget]);
    };
    let resume!: () => void;
    const observed = new Promise<void>((resolve) => resume = resolve);
    const early: { turnId: string; status: unknown; rerouted: boolean }[] = [];
    const observe = (status: unknown, rerouted: boolean) => {
      if (
        rerouted || terminalStatus !== undefined ||
        status !== "completed" && status !== "failed" &&
          status !== "interrupted"
      ) {
        invalidEvidence = true;
      } else {
        terminalStatus = status;
      }
      resume();
    };
    session.onNotification(({ method, params }) => {
      if (method !== "turn/completed" && method !== "model/rerouted") return;
      if (threadId === undefined) return;
      const value = record(params);
      if (!value || !boundId(value.threadId)) {
        invalidEvidence = true;
        resume();
        return;
      }
      if (value.threadId !== threadId) return;
      const rerouted = method === "model/rerouted";
      const turn = record(value.turn);
      const id = rerouted ? value.turnId : turn?.id;
      if (!boundId(id) || early.length >= 16) {
        invalidEvidence = true;
        resume();
      } else if (turnId === undefined) {
        early.push({ turnId: id, status: turn?.status, rerouted });
      } else if (id === turnId) {
        observe(turn?.status, rerouted);
      }
    });

    const initialized = record(
      await request("initialize", {
        clientInfo: { name: "sentinel-agent-job-correction", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
    );
    if (typeof initialized?.userAgent !== "string") {
      throw new CorrectionError("correction client initialization unavailable");
    }
    session.notify("initialized", {});
    const thread = record(
      await request("thread/start", {
        cwd: checkout,
        model,
        modelProvider: GATEWAY_PROVIDER,
        config: { model_reasoning_effort: effort },
        approvalPolicy: "never",
        permissions: PROFILE,
        ephemeral: true,
      }),
    );
    const started = record(thread?.thread)?.id;
    if (
      !boundId(started) || thread?.model !== model ||
      thread.modelProvider !== GATEWAY_PROVIDER ||
      thread.reasoningEffort !== effort || thread.approvalPolicy !== "never" ||
      record(thread.activePermissionProfile)?.id !== PROFILE
    ) {
      throw new CorrectionError(
        "correction model or permission profile was not acknowledged",
      );
    }
    threadId = started;
    await Promise.race([
      proveSandbox(session, input, root, checkout),
      budget,
    ]);
    const turn = record(
      await request("turn/start", {
        threadId,
        input: [{
          type: "text",
          text: [
            `Correct the review-rejected commit ${input.headSha} in this checkout.`,
            "Apply the necessary edits to fulfill the original request and address the review feedback. Leave your edits for Sentinel to commit.",
            "",
            "Original request",
            input.job.prompt,
            "",
            "Review feedback",
            input.feedback,
          ].join("\n"),
          text_elements: [],
        }],
        model,
        effort,
      }),
    );
    const activeTurn = record(turn?.turn)?.id;
    if (!boundId(activeTurn)) {
      throw new CorrectionError("correction turn identity is unavailable");
    }
    turnId = activeTurn;
    for (const event of early) {
      if (event.turnId === turnId) observe(event.status, event.rerouted);
    }
    await Promise.race([observed, budget]);
  } catch (error) {
    failure = { error };
  }
  clearTimeout(timer);
  if (stop !== undefined) input.signal?.removeEventListener("abort", stop);
  if ((aborted || input.signal?.aborted) && threadId && turnId) {
    void session.send("turn/interrupt", { threadId, turnId }).catch(() => {});
  }
  const closed = await session.close().then(
    () => session.isSettled(),
    () => false,
  );
  if (!closed) {
    throw new CorrectionUnsettled(
      "correction client process group did not settle",
    );
  }
  if (failure !== undefined) throw failure.error;
  if (
    session.getFailure() !== null || invalidEvidence ||
    terminalStatus !== "completed"
  ) {
    throw new CorrectionError(
      "correction turn did not complete on the selected model",
    );
  }
  remaining(input);
}

export async function correctAgentJobHead(
  input: CorrectionInput,
): Promise<string> {
  let root: string | undefined;
  let settled = true;
  try {
    remaining(input);
    if (
      !isGitSha(input.headSha) || !input.feedback.trim() ||
      !input.modelToken.trim()
    ) throw new CorrectionError("correction input is incomplete");
    const endpoint = new URL(input.baseUrl);
    if (
      !["https:", "http:"].includes(endpoint.protocol) ||
      endpoint.username || endpoint.password || endpoint.hash || endpoint.search
    ) throw new CorrectionError("correction provider endpoint is invalid");
    checkRunner(input.job.runner);
    const source = await Deno.realPath(input.sourcePath);
    await Deno.mkdir(input.workRoot, { recursive: true, mode: 0o700 });
    root = await Deno.makeTempDir({
      dir: await Deno.realPath(input.workRoot),
      prefix: "correction-",
    });
    const path = (Deno.env.get("PATH") ?? "/usr/bin:/bin").split(":")
      .filter((entry) => entry.startsWith("/")).join(":");
    const trustedRoot = root;
    const checkout = joinPath(root, "checkout");
    const runtime = new DenoReplayRuntime(Deno.execPath());
    const git = async (cwd: string, args: string[]): Promise<string> => {
      const result = await runtime.run({
        executable: trustedGitPath(path),
        cwd,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "submodule.recurse=false",
          ...args,
        ],
        env: {
          PATH: path,
          HOME: trustedRoot,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: "file",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_AUTHOR_NAME: "ubiquity-sentinel[bot]",
          GIT_AUTHOR_EMAIL:
            "319834869+ubiquity-sentinel[bot]@users.noreply.github.com",
          GIT_COMMITTER_NAME: "ubiquity-sentinel[bot]",
          GIT_COMMITTER_EMAIL:
            "319834869+ubiquity-sentinel[bot]@users.noreply.github.com",
        },
        maxDurationMs: remaining(input),
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      });
      if (!result.settled) {
        throw new CorrectionUnsettled(
          "trusted correction Git process did not settle",
        );
      }
      remaining(input);
      if (
        result.outcome !== "exited" || result.exitCode !== 0 ||
        result.truncated
      ) throw new CorrectionError("trusted correction Git command failed");
      return new TextDecoder().decode(result.stdout).trim();
    };
    const fetchHead = (into: string, from: string, sha: string) =>
      git(into, [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        "--",
        from,
        sha,
      ]);

    await git(root, ["init", "--template=", checkout]);
    await fetchHead(checkout, source, input.headSha);
    await git(checkout, ["checkout", "--detach", input.headSha]);
    const before = await git(checkout, [
      "rev-parse",
      `${input.headSha}^{tree}`,
    ]);
    await runCorrection(input, root, checkout, path, endpoint.href);
    if (await git(checkout, ["rev-parse", "HEAD"]) !== input.headSha) {
      throw new CorrectionError("correction checkout head changed");
    }
    await git(checkout, ["add", "-A", "--", "."]);
    const tree = await git(checkout, ["write-tree"]);
    if (!isGitSha(tree) || tree === before) {
      throw new CorrectionError("correction made no tree changes");
    }
    const corrected = await git(checkout, [
      "commit-tree",
      tree,
      "-p",
      input.headSha,
      "-m",
      "sentinel: address agent job review",
    ]);
    if (!isGitSha(corrected)) {
      throw new CorrectionError("correction commit identity is unavailable");
    }
    // Advertise the exact new object to the local transport. The trusted
    // source receives only objects, with no ref or FETCH_HEAD change.
    await git(checkout, [
      "update-ref",
      "refs/sentinel/job-correction",
      corrected,
    ]);
    await fetchHead(source, checkout, corrected);
    const parents = await git(source, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      corrected,
    ]);
    if (parents !== `${corrected} ${input.headSha}`) {
      throw new CorrectionError(
        "correction commit was not imported with its exact parent",
      );
    }
    return corrected;
  } catch (error) {
    settled = !(error instanceof CorrectionUnsettled);
    if (error instanceof CorrectionError) throw error;
    throw new CorrectionError("correction unavailable");
  } finally {
    if (root !== undefined && settled) {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }
}
