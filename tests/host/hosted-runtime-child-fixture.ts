/** Shared credential-free hosted test fixtures; this module registers no tests. */
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type {
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { T0 } from "../state/helpers.ts";
import { OBSERVED_BASE } from "./hosted-runtime-fixture.ts";

// Synthetic private fixture inputs for the real owned-group child: the actual
// local host writes these through its real projection and advisory paths.
const HOSTED_FIXTURE_TASK_ID = "hosted-fixture-issue";

export const HOSTED_FIXTURE_ISSUE_BODY = "hosted-fixture-issue-body-marker";

export const HOSTED_FIXTURE_EVIDENCE_REF = "hosted-fixture-evidence-ref-marker";

export const HOSTED_FIXTURE_RAW_ERROR = "hosted-fixture-raw-error-marker";

export const HOSTED_FIXTURE_CHANGED_PATH =
  "src/hosted-fixture-changed-path-marker.ts";

export const HOSTED_FIXTURE_FAILURE_DETAIL =
  "hosted-fixture-child-failure-detail-marker";

export const HOSTED_FIXTURE_INVOCATION = "hosted-fixture-invocation-marker";

export const HOSTED_FIXTURE_PROVIDER = "hosted-fixture-provider-marker";

const HOSTED_FIXTURE_THREAD = "hosted-fixture-thread-marker";

const HOSTED_FIXTURE_TURN = "hosted-fixture-turn-marker";

const HOSTED_FIXTURE_MODEL = "hosted-fixture-observed-model-marker";

const HOSTED_FIXTURE_REASONING = "hosted-fixture-observed-reasoning-marker";

/** One valid Luna/max request bound to the observed base with marker inputs. */
export function hostedFixtureRequest(): ModelRunRequestV1 {
  return {
    taskId: asWorkItemId(HOSTED_FIXTURE_TASK_ID),
    repository: {
      owner: "Ubiquity-Sentinel",
      name: "sentinel",
      installationId: 0,
    },
    base: OBSERVED_BASE,
    issue: { number: 53, title: "fixture", body: HOSTED_FIXTURE_ISSUE_BODY },
    evidence: [{ kind: "replay_result", ref: HOSTED_FIXTURE_EVIDENCE_REF }],
    model: "gpt-reserve",
    reasoning: "max",
    maxDurationMs: 1_200_000,
    maxOutputChars: 400_000,
  };
}

/** Synthetic failed host-timeout receipt carrying private marker identity. */
export function hostedFixtureReceipt(): PortResultV1<ModelRunReceiptV1> {
  return portOk({
    invocationId: HOSTED_FIXTURE_INVOCATION,
    outcome: "failed",
    actual: {
      evidenceKind: "request-runtime",
      provider: HOSTED_FIXTURE_PROVIDER,
      threadId: HOSTED_FIXTURE_THREAD,
      turnId: HOSTED_FIXTURE_TURN,
      terminalOrigin: "host-timeout",
      observedTerminalStatus: null,
      observedModel: HOSTED_FIXTURE_MODEL,
      observedReasoning: HOSTED_FIXTURE_REASONING,
      durationMs: 4_321,
      outputChars: 99,
    },
    candidate: null,
    error: HOSTED_FIXTURE_RAW_ERROR,
  });
}

/**
 * Real fixture child that writes a marker, prints the exact captured advisory
 * stdout, leaves a descendant, then a record.
 */
export function validFixtureScript(
  diagnosticStdout: string,
  outcome: { status: string; detail: string } = {
    status: "idle",
    detail: "fixture",
  },
): string {
  return `const decoder = new TextDecoder();
const runId = Number(Deno.env.get("GITHUB_RUN_ID"));
const runAttempt = Number(Deno.env.get("GITHUB_RUN_ATTEMPT"));
const launcherSha = Deno.env.get("GITHUB_SHA");
const head = decoder.decode(new Deno.Command("git", {
  args: ["rev-parse", "HEAD"],
  cwd: Deno.cwd(),
}).outputSync().stdout).trim();
const execution = {
  id: runId + ":" + runAttempt + ":repair",
  runId,
  runAttempt,
  launcherSha,
  purpose: "ordinary",
  revision: head,
  generation: 1,
  releaseId: null,
  createdAt: ${T0},
};
Deno.writeTextFileSync("child-ran.txt", "ran\\n");
// The exact advisory stdout captured from actual local model-result writes,
// embedded as one safe JavaScript string literal.
console.log(${JSON.stringify(diagnosticStdout)});
// A descendant that outlives the leader holds the captured pipe: settlement
// must span the whole owned group, not just the direct child exit.
new Deno.Command("sleep", { args: ["0.3"] }).spawn();
console.log(JSON.stringify({
  status: "ran",
  outcome: ${JSON.stringify(outcome)},
  controllerSha: head,
  baseSha: "${OBSERVED_BASE}",
  login: "github-actions[bot]",
  startupReady: true,
  ciApproval: { approved: 0, pending: 0, unavailable: 0 },
  execution,
}));
`;
}

/** Real fixture child attempting to forge the wrapper terminal kind. */
export function forgedFixtureScript(): string {
  return `Deno.writeTextFileSync("child-ran.txt", "ran\\n");
console.log(JSON.stringify({
  version: "v1",
  kind: "hosted_runtime_terminal",
  outcome: "healthy",
  startupReady: true,
  settled: true,
  baseSha: null,
}));
`;
}

/**
 * Real fixture child for the streaming case. It prints one valid advisory line
 * in two pipe writes, waits (bounded) for the sink's acknowledgement file so
 * the emission provably precedes the finish marker it writes below, then
 * prints ignored inputs, an oversized line whose parseable-looking suffix
 * arrives only after the retained bound was exceeded, a stderr advisory, a
 * resumed valid advisory, and finally its status record.
 */
export function streamingFixtureScript(input: {
  firstHalf: string;
  secondHalf: string;
  ignoredLines: string[];
  oversizedSuffix: string;
  afterLine: string;
  stderrLine: string;
}): string {
  return `const encoder = new TextEncoder();
const write = (text: string) => Deno.stdout.writeSync(encoder.encode(text));
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};
const decoder = new TextDecoder();
const runId = Number(Deno.env.get("GITHUB_RUN_ID"));
const runAttempt = Number(Deno.env.get("GITHUB_RUN_ATTEMPT"));
const launcherSha = Deno.env.get("GITHUB_SHA");
const head = decoder.decode(new Deno.Command("git", {
  args: ["rev-parse", "HEAD"],
  cwd: Deno.cwd(),
}).outputSync().stdout).trim();
const execution = {
  id: runId + ":" + runAttempt + ":repair",
  runId,
  runAttempt,
  launcherSha,
  purpose: "ordinary",
  revision: head,
  generation: 1,
  releaseId: null,
  createdAt: ${T0},
};
// One valid advisory line split across two pipe writes: the retained partial
// line must be assembled across the chunk boundary.
write(${JSON.stringify(input.firstHalf)});
await pause(80);
write(${JSON.stringify(input.secondHalf)} + "\\n");
// Bounded handshake: the sink acknowledges the first streamed advisory by
// creating this file, so the finish marker below provably follows it. A
// runtime without streaming lets the bound expire and still exits normally.
for (let i = 0; i < 500 && !exists("release-child.txt"); i++) await pause(10);
for (const line of ${JSON.stringify(input.ignoredLines)}) write(line + "\\n");
// Oversized line: the retained bound is exceeded first, and only then does the
// parseable-looking suffix arrive; the whole line must be discarded.
write("x".repeat(2_100));
await pause(30);
write(${JSON.stringify(input.oversizedSuffix)} + "\\n");
// stderr is never forwarded to the advisory sink.
console.error(${JSON.stringify(input.stderrLine)});
write(${JSON.stringify(input.afterLine)} + "\\n");
// The finish marker is written after every advisory attempt and before the
// status record: its absence at emission time proves the child had not exited.
Deno.writeTextFileSync("child-finished.txt", "finished\\n");
console.log(JSON.stringify({
  status: "ran",
  outcome: { status: "idle", detail: "fixture" },
  controllerSha: head,
  baseSha: "${OBSERVED_BASE}",
  login: "github-actions[bot]",
  startupReady: true,
  ciApproval: { approved: 0, pending: 0, unavailable: 0 },
  execution,
}));
`;
}
