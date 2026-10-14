import {
  TEST_ID,
  TEST_ID_MARKER,
  TEXT_ENCODER,
} from "./causal-capture-fixture.ts";
import { CAPTURE_ID_A, INCIDENT_A } from "../adapters/gateway/helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { commitWith, gitRun, revParse, testGitEnv } from "../replay/helpers.ts";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Real temporary toy target repository (credential-free; original/candidate/
// unrelated). Original bug, candidate fix + permanent regression, and an
// unrelated breakage; the candidate commits the permanent fixture bytes.
// ---------------------------------------------------------------------------

function toyApp(kind: "original" | "candidate" | "unrelated"): string {
  const original = `/** Toy gateway stream handler (original). */
export function handleStreamTrace(
  request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  const req = request as { body?: string };
  let input = "";
  try {
    const parsed = JSON.parse(req.body ?? "{}") as { input?: unknown };
    input = typeof parsed.input === "string" ? parsed.input : "";
  } catch {
    // malformed request body: treated as no input
  }
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) => c.charCodeAt(0)),
  );
  const completed = chunkText.includes('"type":"response.completed"') ||
    chunkText.includes("[DONE]");
  if (input.includes("PRIVATE-TRIGGER-4c9b1e27") || !completed) {
    return { status: 502, body: "stream terminated unexpectedly", completed: false, payload: "" };
  }
  return { status: 200, body: JSON.stringify({ payload: chunkText.slice(0, 80) }), completed: true, payload: chunkText.slice(0, 80) };
}
`;
  const candidate = `/** Toy gateway stream handler (candidate fix). */
export function handleStreamTrace(
  _request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) => c.charCodeAt(0)),
  );
  return { status: 200, body: JSON.stringify({ payload: chunkText.slice(0, 80) }), completed: true, payload: chunkText.slice(0, 80) };
}
`;
  const unrelated = `/** Toy gateway stream handler (unrelated breakage). */
export function handleStreamTrace(
  _request: unknown,
  _upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  return { status: 503, body: "unrelated failure: boom", completed: false, payload: "" };
}
`;
  return { original, candidate, unrelated }[kind];
}

function toyRegressionTest(): string {
  return `import assert from "node:assert/strict";
import { handleStreamTrace } from "../src/app.ts";

Deno.test("gateway: stream termination honors recorded upstream", async () => {
  console.log("${TEST_ID_MARKER}");
  const expectedRequest = "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}/request.json";
  const expectedUpstream = "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}/upstream.json";
  const dispatchBytes = await Deno.readFile(".sentinel-replay-input.json");
  if (dispatchBytes.byteLength > 16 * 1024) Deno.exit(3);
  const dispatch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dispatchBytes));
  assert.equal(dispatch.version, "v1");
  assert.deepEqual(Object.keys(dispatch).sort(), ["requestPath", "testIds", "upstreamPath", "version"]);
  assert.equal(dispatch.requestPath, expectedRequest);
  assert.equal(dispatch.upstreamPath, expectedUpstream);
  assert.deepEqual(dispatch.testIds, ["${TEST_ID}"]);
  const request = JSON.parse(await Deno.readTextFile(dispatch.requestPath));
  const upstream = JSON.parse(await Deno.readTextFile(dispatch.upstreamPath));
  assert.equal(JSON.parse(request.body).model, "synthetic-model");
  const outcome = handleStreamTrace(request, upstream);
  assert.equal(
    outcome.status,
    200,
    "expected 200 but got " + outcome.status + ": " + outcome.body,
  );
});
`;
}

/**
 * The trusted fixed consumer committed at the original SHA as
 * `scripts/replay.ts` — the ONLY consumer path bound to the trusted consumer
 * command identity. It selects its inputs EXCLUSIVELY through the fixed root
 * dispatch metadata (`.sentinel-replay-input.json`, exact canonical
 * `{version,requestPath,upstreamPath,testIds}`) written by the trusted
 * verifier into both snapshots and by the ReplayPort into the candidate
 * checkout; a missing, malformed or differently-selected dispatcher exits 3,
 * so hardcoded fixture reads can never pass. It executes the actual toy
 * target handler against the selected request/upstream fixtures, prints the
 * fixed test identity, then emits the EXACT supported safe failure protocol —
 * the single fixed `sentinel-causal-failure:stream terminated unexpectedly`
 * line on stdout, empty stderr, exit 1 — ONLY for the intended outcome (502,
 * incomplete, exact failure body); status 200 prints only the test ids and
 * exits 0; every other outcome emits only a fixed "unsupported causal
 * outcome" diagnostic and exits 2. Raw request/upstream bytes and raw
 * outcome.body are never printed.
 */
function toyReplayScript(): string {
  return `import { handleStreamTrace } from "../src/app.ts";
const expectedRequest = "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}/request.json";
const expectedUpstream = "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}/upstream.json";
const dispatchBytes = await Deno.readFile(".sentinel-replay-input.json");
if (dispatchBytes.byteLength > 16 * 1024) Deno.exit(3);
const dispatch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dispatchBytes));
if (dispatch.version !== "v1") Deno.exit(3);
if (Object.keys(dispatch).sort().join(",") !== "requestPath,testIds,upstreamPath,version") Deno.exit(3);
if (dispatch.requestPath !== expectedRequest) Deno.exit(3);
if (dispatch.upstreamPath !== expectedUpstream) Deno.exit(3);
if (JSON.stringify(dispatch.testIds) !== JSON.stringify(["${TEST_ID}"])) Deno.exit(3);
const request = JSON.parse(await Deno.readTextFile(dispatch.requestPath));
const upstream = JSON.parse(await Deno.readTextFile(dispatch.upstreamPath));
const outcome = handleStreamTrace(request, upstream);
console.log("${TEST_ID_MARKER}");
if (outcome.status === 502 && outcome.completed === false && outcome.body === "stream terminated unexpectedly") {
  console.log("sentinel-causal-failure:stream terminated unexpectedly");
  Deno.exit(1);
}
if (outcome.status === 200) Deno.exit(0);
console.error("sentinel-causal-failure:unsupported causal outcome");
Deno.exit(2);
`;
}

// The toy's own task read scope mirrors the frozen root-dispatch consumer
// protocol (`--allow-read=.`): the committed consumer and the permanent
// regression test read the fixed root `.sentinel-replay-input.json`
// dispatcher, which is outside `tests/` and `src/`.
const TOY_DENO_JSON = JSON.stringify(
  {
    tasks: {
      replay: "deno run --allow-read=. scripts/replay.ts",
      test: "deno test --allow-read=. tests/",
    },
  },
  null,
  2,
) + "\n";

export interface ToyRepoV1 {
  root: string;
  env: Record<string, string>;
  originalSha: GitSha;
  cleanup(): Promise<void>;
}

/** Phase 1: one real toy repo with the ORIGINAL failing revision only. */
export async function makeToyRepo(prefix: string): Promise<ToyRepoV1> {
  const root = await Deno.makeTempDir({
    prefix: `sentinel-causal-capture-toy-${prefix}-`,
    dir: Deno.cwd(),
  });
  const env = testGitEnv(`${root}/home`);
  await Deno.mkdir(`${root}/home`, { recursive: true });
  const init = await gitRun(root, ["init", "-q", "-b", "main"], env);
  assert.ok(init.ok, `toy init failed: ${init.stderr}`);
  await commitWith(
    root,
    env,
    {
      "deno.json": TOY_DENO_JSON,
      "src/app.ts": toyApp("original"),
      "scripts/replay.ts": toyReplayScript(),
      "tests/regression_test.ts": toyRegressionTest(),
    },
    "toy original: missing terminator produces 502",
  );
  const originalSha = await revParse(root, env);
  return {
    root,
    env,
    originalSha,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

/** Phase 2: commit the candidate fix plus the exact composed fixture bytes. */
export async function commitCandidateFixture(
  toy: ToyRepoV1,
  entries: { path: string; bytes: Uint8Array }[],
): Promise<GitSha> {
  const fixedApp = toyApp("candidate");
  const files: [string, Uint8Array][] = [
    ["src/app.ts", TEXT_ENCODER.encode(fixedApp)],
    ...entries.map((entry) =>
      [entry.path, entry.bytes] as [string, Uint8Array]
    ),
  ];
  await writeCommitBytes(
    toy.root,
    toy.env,
    files,
    "toy candidate: fix + permanent regression fixture",
  );
  return revParse(toy.root, toy.env);
}

/** Phase 3: an unrelated breaking revision on top of the candidate. */
export async function commitUnrelated(toy: ToyRepoV1): Promise<GitSha> {
  await writeCommit(
    toy.root,
    toy.env,
    [["src/app.ts", toyApp("unrelated")]],
    "toy unrelated: different breakage",
  );
  return revParse(toy.root, toy.env);
}

async function writeCommit(
  root: string,
  env: Record<string, string>,
  files: [string, string][],
  message: string,
): Promise<void> {
  for (const [path, text] of files) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  }
  await commitAll(root, env, message);
}

async function writeCommitBytes(
  root: string,
  env: Record<string, string>,
  files: [string, Uint8Array][],
  message: string,
): Promise<void> {
  for (const [path, bytes] of files) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(full, bytes);
  }
  await commitAll(root, env, message);
}

async function commitAll(
  root: string,
  env: Record<string, string>,
  message: string,
): Promise<void> {
  const add = await gitRun(root, ["add", "-A"], env);
  if (!add.ok) throw new Error(`toy add failed: ${add.stderr}`);
  const commit = await gitRun(root, ["commit", "-q", "-m", message], env);
  if (!commit.ok) throw new Error(`toy commit failed: ${commit.stderr}`);
}
