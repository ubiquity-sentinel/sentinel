import { CAPTURE_ID_A, INCIDENT_A } from "../adapters/gateway/helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { commitWith, gitRun, revParse, testGitEnv } from "../replay/helpers.ts";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Real temporary toy target repository (credential-free; original/candidate).
// The permanent regression test is committed in the toy at BOTH revisions and
// reads the sanitized gateway fixture entries (fixed protocol vocabulary), so
// the ReplayPort can execute the configured command at the exact original and
// candidate revisions inside disposable clones of this local source.
// ---------------------------------------------------------------------------

function toyApp(original: boolean): string {
  return original
    ? `/** Toy gateway stream handler (original). */
export function handleStreamTrace(
  _request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) => c.charCodeAt(0)),
  );
  // ORIGINAL BUG: an SSE stream that ends (eof) without the completion
  // terminator is treated as a server failure.
  const completed = chunkText.includes('"type":"response.completed"') ||
    chunkText.includes("[DONE]");
  if (!completed) {
    return {
      status: 502,
      body: "stream terminated unexpectedly",
      completed: false,
      payload: "",
    };
  }
  return {
    status: 200,
    body: JSON.stringify({ payload: chunkText.slice(0, 80) }),
    completed: true,
    payload: chunkText.slice(0, 80),
  };
}
`
    : `/** Toy gateway stream handler (candidate). */
export function handleStreamTrace(
  _request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) => c.charCodeAt(0)),
  );
  // CANDIDATE FIX: the recorded upstream ends after the final data line
  // without a separate terminator; that is a complete stream, not a failure.
  return {
    status: 200,
    body: JSON.stringify({ payload: chunkText.slice(0, 80) }),
    completed: true,
    payload: chunkText.slice(0, 80),
  };
}
`;
}

function toyRegressionTest(): string {
  return `import assert from "node:assert/strict";
import { handleStreamTrace } from "../src/app.ts";

Deno.test("gateway: stream termination honors recorded upstream", async () => {
  console.log("sentinel-replay-test:gateway:stream-termination");
  const base =
    "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}";
  const request = JSON.parse(
    await Deno.readTextFile(base + "/request.json"),
  );
  const upstream = JSON.parse(
    await Deno.readTextFile(base + "/upstream.json"),
  );
  assert.equal(JSON.parse(request.body).model, "synthetic-model");
  const outcome = handleStreamTrace(request, upstream);
  const body = await outcome.body;
  assert.equal(
    outcome.status,
    200,
    "expected 200 but got " + outcome.status + ": " + body,
  );
  assert.deepEqual(JSON.parse(body), { payload: outcome.payload });
});
`;
}

const TOY_DENO_JSON = JSON.stringify(
  {
    tasks: {
      test: "deno test --allow-read=tests/,src/ tests/",
    },
  },
  null,
  2,
) + "\n";

export interface ToyRepoV1 {
  root: string;
  env: Record<string, string>;
  originalSha: GitSha;
  candidateSha: GitSha;
  cleanup(): Promise<void>;
}

export async function makeToyRepo(prefix: string): Promise<ToyRepoV1> {
  const root = await Deno.makeTempDir({
    prefix: `sentinel-composed-lifecycle-toy-${prefix}-`,
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
      "src/app.ts": toyApp(true),
      "tests/regression_test.ts": toyRegressionTest(),
    },
    "toy original: missing terminator produces 502",
  );
  const originalSha = await revParse(root, env);
  await commitWith(
    root,
    env,
    { "src/app.ts": toyApp(false) },
    "toy candidate: tolerate missing terminator",
  );
  const candidateSha = await revParse(root, env);
  return {
    root,
    env,
    originalSha,
    candidateSha,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}
