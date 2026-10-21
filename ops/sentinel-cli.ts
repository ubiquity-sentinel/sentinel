#!/usr/bin/env -S deno run --allow-run=gh
/**
 * sentinel - explicit operator access to Ubiquity-Sentinel/sentinel GitHub Actions.
 *
 * The protected supervisor also has a five-minute autonomous dispatcher.
 * Observe and repair remain manual. The runtime supervisor uses the protected
 * `sentinel-supervisor` ref; the observer and repair dispatcher run on
 * `development`.
 *
 * Usage:
 *   sentinel status [--json]
 *   sentinel dispatch <observe|supervisor|repair>
 *   sentinel wait <observe|supervisor|repair> [--timeout-min N] [--dispatch]
 *   sentinel run <observe|supervisor> [--timeout-min N]
 *   sentinel receipts <run-id> [--grep <pattern>]
 */

const REPO = "Ubiquity-Sentinel/sentinel";

type Target = "observe" | "supervisor" | "repair";
interface TargetSpec {
  workflow: string;
  ref: string;
  label: string;
}
const TARGETS: Record<Target, TargetSpec> = {
  observe: {
    workflow: "observe.yml",
    ref: "development",
    label: "sentinel-observe",
  },
  supervisor: {
    workflow: "supervisor.yml",
    ref: "sentinel-supervisor",
    label: "sentinel-supervisor",
  },
  repair: {
    workflow: "repair.yml",
    ref: "development",
    label: "sentinel-repair",
  },
};

interface Run {
  databaseId: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  event: string;
  headSha: string;
  url: string;
}

interface RunIdentity {
  id: number;
  workflowId: number;
  ref: string;
  sha: string;
  attempt: number;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isSha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

function readIdentity(value: unknown): RunIdentity {
  const run = value as Record<string, unknown> | null;
  if (
    !run || !isPositiveInteger(run.id) ||
    !isPositiveInteger(run.workflow_id) ||
    typeof run.head_branch !== "string" || !isSha(run.head_sha) ||
    !isPositiveInteger(run.run_attempt)
  ) throw new Error("run identity is unavailable");
  return {
    id: run.id,
    workflowId: run.workflow_id,
    ref: run.head_branch,
    sha: run.head_sha,
    attempt: run.run_attempt,
  };
}

async function api(path: string, deadline?: number): Promise<unknown> {
  return JSON.parse(
    await gh(["api", `repos/${REPO}/${path}`], undefined, deadline),
  );
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
      else if (arg === "--json" || arg === "--dispatch") {
        const value = argv[i + 1];
        out[arg.slice(2)] = value === "true" || value === "false"
          ? argv[++i]
          : "true";
      } else out[arg.slice(2)] = argv[++i] ?? "true";
    } else out._ = out._ ? `${out._} ${arg}` : arg;
  }
  return out;
}

async function gh(
  args: string[],
  input?: unknown,
  deadline = Date.now() + 30_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, Math.min(30_000, deadline - Date.now())),
  );
  try {
    const child = new Deno.Command("gh", {
      args,
      stdin: input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).spawn();
    if (input !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(input)));
      await writer.close();
    }
    const { code, stdout, stderr } = await child.output();
    const decoder = new TextDecoder();
    if (code !== 0) {
      throw new Error(
        `gh ${args.join(" ")} failed (${code}): ${
          decoder.decode(stderr).trim().slice(0, 500)
        }`,
      );
    }
    return decoder.decode(stdout);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function listRuns(workflow: string, limit: number): Promise<Run[]> {
  const raw = await gh([
    "run",
    "list",
    "-R",
    REPO,
    "--workflow",
    workflow,
    "--limit",
    String(limit),
    "--json",
    "databaseId,status,conclusion,createdAt,event,headSha,url",
  ]);
  return JSON.parse(raw) as Run[];
}

class DispatchIdentityError extends Error {}

type DispatchRequest = {
  target: Target;
  workflowId: number;
  ref: string;
  sha: string;
  requestId: string;
};
type DispatchObservation = DispatchRequest & {
  execution: "pending" | "verified" | "unverified";
  reason?: string;
  id?: number;
  attempt?: number;
  status?: string;
  conclusion?: string | null;
  matchingRuns?: number;
};

async function sourceSha(ref: string, deadline?: number): Promise<string> {
  const source = await api(`git/ref/heads/${ref}`, deadline) as {
    ref?: unknown;
    object?: { type?: unknown; sha?: unknown };
  };
  if (
    source.ref !== `refs/heads/${ref}` || source.object?.type !== "commit" ||
    !isSha(source.object.sha)
  ) throw new DispatchIdentityError("source_identity_unavailable");
  return source.object.sha;
}

async function requireProtocol(spec: TargetSpec, sha: string): Promise<void> {
  const path = `.github/workflows/${spec.workflow}`;
  const file = await api(`contents/${path}?ref=${sha}`) as {
    type?: unknown;
    path?: unknown;
    encoding?: unknown;
    content?: unknown;
    sha?: unknown;
  };
  if (
    file.type !== "file" || file.path !== path || file.encoding !== "base64" ||
    typeof file.content !== "string" || !isSha(file.sha)
  ) throw new DispatchIdentityError("dispatch_protocol_unavailable");
  const bytes = Uint8Array.from(
    atob(file.content),
    (char) => char.charCodeAt(0),
  );
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-1", new Uint8Array([...header, ...bytes])),
  );
  if (
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") !==
      file.sha
  ) throw new DispatchIdentityError("dispatch_protocol_integrity_mismatch");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    .replaceAll("\r\n", "\n");
  const trigger = text.match(/^on:\n((?:[ \t].*\n|\n)*)/m)?.[1] ?? "";
  const input =
    '  workflow_dispatch:\n    inputs:\n      sentinel_dispatch_request:\n        description: Internal operator dispatch identity\n        required: false\n        type: string\n        default: ""';
  const name =
    `run-name: \${{ inputs.sentinel_dispatch_request && format('${spec.label} request {0}', inputs.sentinel_dispatch_request) || '' }}`;
  if (
    !trigger.includes(input) ||
    text.split("\n").filter((line) => line.startsWith("run-name:")).length !==
      1 ||
    !text.split("\n").includes(name)
  ) throw new DispatchIdentityError("dispatch_protocol_incompatible");
}

async function observeDispatch(
  request: DispatchRequest,
  deadline: number,
): Promise<DispatchObservation> {
  if (await sourceSha(request.ref, deadline) !== request.sha) {
    throw new DispatchIdentityError("source_changed");
  }
  const path =
    `repos/${REPO}/actions/workflows/${request.workflowId}/runs?event=workflow_dispatch&head_sha=${request.sha}&per_page=100`;
  const pages = JSON.parse(
    await gh(["api", "--paginate", "--slurp", path], undefined, deadline),
  ) as { total_count?: unknown; workflow_runs?: unknown }[];
  if (
    !Array.isArray(pages) || pages.length === 0 ||
    !pages.every((page) => Array.isArray(page.workflow_runs))
  ) throw new DispatchIdentityError("observation_unavailable");
  const runs = pages.flatMap((page) =>
    page.workflow_runs as Record<string, unknown>[]
  );
  if (
    !Number.isSafeInteger(pages[0].total_count) ||
    pages[0].total_count !== runs.length ||
    !pages.every((page) => page.total_count === pages[0].total_count)
  ) throw new DispatchIdentityError("run_observation_incomplete");
  const name = `${TARGETS[request.target].label} request ${request.requestId}`;
  const matches = runs.filter((run) => run?.display_title === name);
  if (matches.length === 0) {
    return {
      ...request,
      execution: "pending",
      matchingRuns: 0,
      reason: "dispatch_run_pending",
    };
  }
  if (matches.length !== 1) {
    throw new DispatchIdentityError("multiple_matching_runs");
  }
  try {
    const run = readIdentity(matches[0]);
    if (
      run.workflowId !== request.workflowId || run.ref !== request.ref ||
      run.sha !== request.sha || matches[0].event !== "workflow_dispatch"
    ) throw new Error("mismatch");
    const current = await api(`actions/runs/${run.id}`, deadline) as Record<
      string,
      unknown
    >;
    const attempt = await api(
      `actions/runs/${run.id}/attempts/${run.attempt}`,
      deadline,
    ) as Record<string, unknown>;
    for (const value of [current, attempt]) {
      if (
        JSON.stringify(readIdentity(value)) !== JSON.stringify(run) ||
        value.display_title !== name || value.event !== "workflow_dispatch"
      ) throw new Error("mismatch");
    }
    if (
      typeof attempt.status !== "string" ||
      !["queued", "in_progress", "completed", "waiting", "pending", "requested"]
        .includes(attempt.status) ||
      (attempt.conclusion !== null && typeof attempt.conclusion !== "string")
    ) throw new Error("status");
    return {
      ...request,
      execution: "verified",
      id: run.id,
      attempt: run.attempt,
      status: attempt.status,
      conclusion: attempt.conclusion as string | null,
      matchingRuns: 1,
    };
  } catch {
    throw new DispatchIdentityError("run_identity_mismatch");
  }
}

async function dispatch(target: Target, waitMinutes?: number): Promise<void> {
  if (
    waitMinutes !== undefined &&
    (!Number.isFinite(waitMinutes) || waitMinutes < 0)
  ) throw new Error("timeout-min must be finite and nonnegative");
  const spec = TARGETS[target];
  const workflow = await api(`actions/workflows/${spec.workflow}`) as {
    id?: unknown;
    path?: unknown;
  };
  if (
    !isPositiveInteger(workflow.id) ||
    workflow.path !== `.github/workflows/${spec.workflow}`
  ) throw new Error("workflow identity is unavailable");
  const sha = await sourceSha(spec.ref);
  await requireProtocol(spec, sha);
  if (await sourceSha(spec.ref) !== sha) {
    throw new DispatchIdentityError("source_changed");
  }
  const request: DispatchRequest = {
    target,
    workflowId: workflow.id,
    ref: spec.ref,
    sha,
    requestId: crypto.randomUUID(),
  };
  try {
    await gh([
      "api",
      "--method",
      "POST",
      `repos/${REPO}/actions/workflows/${spec.workflow}/dispatches`,
      "--input",
      "-",
    ], {
      ref: spec.ref,
      inputs: { sentinel_dispatch_request: request.requestId },
    });
  } catch {
    console.log(
      JSON.stringify({
        ...request,
        dispatch: "unavailable",
        execution: "unverified",
        reason: "dispatch_submission_unavailable",
      }),
    );
    Deno.exit(1);
  }
  const deadline = Date.now() + (waitMinutes ?? 0) * 60_000;
  let observed: DispatchObservation;
  while (true) {
    try {
      observed = await observeDispatch(
        request,
        waitMinutes ? deadline : Date.now() + 30_000,
      );
    } catch (error) {
      observed = {
        ...request,
        execution: "unverified",
        reason: error instanceof DispatchIdentityError
          ? error.message
          : "observation_unavailable",
      };
    }
    if (
      observed.execution === "unverified" || waitMinutes === undefined ||
      observed.status === "completed" || Date.now() >= deadline
    ) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, deadline - Date.now()))
    );
  }
  console.log(
    JSON.stringify(
      { dispatch: "accepted", observedSourceSha: sha, ...observed },
      null,
      2,
    ),
  );
  if (
    observed.execution === "unverified" ||
    (waitMinutes !== undefined &&
      (observed.status !== "completed" || observed.conclusion !== "success"))
  ) Deno.exit(1);
}

function requireTarget(value: string | undefined): Target {
  if (value === "observe" || value === "supervisor" || value === "repair") {
    return value;
  }
  throw new Error(
    `target must be observe|supervisor|repair, got '${value ?? ""}'`,
  );
}

async function cmdStatus(json: boolean): Promise<void> {
  const rows: Record<string, unknown> = {};
  for (const target of Object.keys(TARGETS) as Target[]) {
    const runs = await listRuns(TARGETS[target].workflow, 3);
    rows[target] = runs.map((r) => ({
      id: r.databaseId,
      conclusion: r.conclusion ?? r.status,
      event: r.event,
      createdAt: r.createdAt,
      url: r.url,
    }));
  }
  const recentBotMerges = JSON.parse(
    await gh([
      "pr",
      "list",
      "-R",
      REPO,
      "--state",
      "merged",
      "--limit",
      "5",
      "--json",
      "number,mergedAt,author",
    ]),
  );
  if (json) {
    console.log(JSON.stringify({ runs: rows, recentBotMerges }, null, 2));
  } else {
    for (const [target, runs] of Object.entries(rows)) {
      console.log(`${target}:`);
      for (const run of runs as Array<Record<string, unknown>>) {
        console.log(
          `  ${run.createdAt}  ${
            String(run.conclusion).padEnd(9)
          }  #${run.id}  ${run.url}`,
        );
      }
    }
    console.log("recent bot merges:");
    for (
      const pr of recentBotMerges as Array<
        { mergedAt: string; number: number; author?: { login?: string } }
      >
    ) {
      console.log(
        `  ${pr.mergedAt}  #${pr.number}  ${pr.author?.login ?? "?"}`,
      );
    }
  }
}

async function cmdReceipts(
  runId: number,
  pattern: string | undefined,
): Promise<void> {
  if (!isPositiveInteger(runId)) throw new Error("run ID must be positive");
  const identity = readIdentity(await api(`actions/runs/${runId}`));
  if (identity.id !== runId) throw new Error("run ID mismatch");
  const workflow = await api(`actions/workflows/${identity.workflowId}`) as {
    id?: unknown;
    path?: unknown;
  };
  const target = (Object.keys(TARGETS) as Target[]).find((candidate) =>
    workflow.path === `.github/workflows/${TARGETS[candidate].workflow}`
  );
  if (
    workflow.id !== identity.workflowId || !target ||
    identity.ref !== TARGETS[target].ref
  ) throw new Error("workflow or ref mismatch");
  const commit = await api(`git/commits/${identity.sha}`) as { sha?: unknown };
  if (commit.sha !== identity.sha) throw new Error("source SHA mismatch");
  const attempt = readIdentity(
    await api(`actions/runs/${runId}/attempts/${identity.attempt}`),
  );
  if (JSON.stringify(attempt) !== JSON.stringify(identity)) {
    throw new Error("run attempt identity mismatch");
  }
  const log = await gh([
    "run",
    "view",
    String(runId),
    "-R",
    REPO,
    "--attempt",
    String(identity.attempt),
    "--log",
  ]);
  const needles = pattern ? [pattern] : [
    "hosted_runtime_terminal",
    "hosted_runtime_early_failure",
    '"startupReady"',
    "issue_delivery",
    "release_request",
  ];
  const lines = log.split("\n").filter((line) =>
    needles.some((n) => line.includes(n))
  );
  console.log(JSON.stringify({ target, ...identity }));
  console.log(lines.slice(-80).join("\n"));
}

async function main(): Promise<void> {
  const argv = Deno.args;
  const command = argv[0];
  const opts = parseArgs(argv.slice(1));
  switch (command) {
    case "status":
      await cmdStatus(opts.json === "true");
      break;
    case "dispatch": {
      const target = requireTarget(opts._);
      await dispatch(target);
      break;
    }
    case "wait": {
      const target = requireTarget(opts._);
      if (opts.dispatch === "true") {
        await dispatch(target, Number(opts["timeout-min"] ?? 60));
        break;
      }
      throw new Error("wait has no bound run identity; use receipts <run-id>");
    }
    case "run": {
      const target = requireTarget(opts._);
      await dispatch(target, Number(opts["timeout-min"] ?? 60));
      break;
    }
    case "receipts":
      await cmdReceipts(Number(opts._), opts.grep);
      break;
    default:
      console.error("usage: sentinel status|dispatch|wait|run|receipts ...");
      Deno.exit(2);
  }
}

await main();
