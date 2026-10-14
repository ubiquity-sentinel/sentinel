// ---------------------------------------------------------------------------
// Toy application source (real files committed to the toy git repository)
// ---------------------------------------------------------------------------

export const TOY_DENO_JSON = JSON.stringify(
  {
    tasks: {
      test: "deno test --allow-read=tests/,src/ tests/",
      replay: "deno run --allow-read=tests/,src/ scripts/replay.ts",
    },
  },
  null,
  2,
) + "\n";

export const APP_BUGGY = `/** Toy streaming gateway handler. */
export interface StreamFixture {
  lines: string[];
  completed: boolean;
}

export async function handleRequest(
  fixture: StreamFixture,
): Promise<Response> {
  const payload = fixture.lines
    .map((line) => line.replace(/^data: /, ""))
    .join("\\n");
  if (!fixture.completed) {
    // ORIGINAL BUG: a stream that ends without the completion terminator
    // is treated as a server failure.
    return new Response("stream terminated unexpectedly", { status: 500 });
  }
  return new Response(JSON.stringify({ payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
`;

export const APP_FIXED = `/** Toy streaming gateway handler. */
export interface StreamFixture {
  lines: string[];
  completed: boolean;
}

export async function handleRequest(
  fixture: StreamFixture,
): Promise<Response> {
  const payload = fixture.lines
    .map((line) => line.replace(/^data: /, ""))
    .join("\\n");
  // CANDIDATE FIX: the recorded upstream ends after the final data line
  // without a separate terminator; that is a complete stream, not a failure.
  return new Response(JSON.stringify({ payload, completed: fixture.completed }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
`;

export const APP_UNRELATED = `/** Toy streaming gateway handler. */
export interface StreamFixture {
  lines: string[];
  completed: boolean;
}

export async function handleRequest(
  _fixture: StreamFixture,
): Promise<Response> {
  // UNRELATED BREAKAGE: fails for a different reason than the regression.
  return new Response("unrelated failure: boom", { status: 503 });
}
`;

// ---------------------------------------------------------------------------
// Trusted sanitized fixture bundle (the exact candidate regression test plus
// the recorded upstream data, replayed locally — no network)
// ---------------------------------------------------------------------------

export const FIXTURE_JSON = JSON.stringify(
  { lines: ["data: hello", "data: world"], completed: false },
  null,
  2,
) + "\n";

export const REGRESSION_TEST = `import assert from "node:assert/strict";
import { handleRequest } from "../src/app.ts";

Deno.test("gateway: stream termination honors recorded upstream", async () => {
  console.log("sentinel-replay-test:gateway:stream-termination");
  const recorded = JSON.parse(
    await Deno.readTextFile("tests/fixtures/upstream.json"),
  );
  const response = await handleRequest(recorded);
  const body = await response.text();
  assert.equal(
    response.status,
    200,
    \`expected 200 but got \${response.status}: \${body}\`,
  );
  assert.deepEqual(JSON.parse(body), {
    payload: "hello\\nworld",
    completed: false,
  });
});
`;

export const REPLAY_SCRIPT = `import { handleRequest } from "../src/app.ts";

const recorded = JSON.parse(
  await Deno.readTextFile("tests/fixtures/upstream.json"),
);
const response = await handleRequest(recorded);
const body = await response.text();
console.log("sentinel-replay-test:gateway:stream-termination");
console.log(\`status=\${response.status}\`);
if (response.status !== 200) {
  console.error(body);
  Deno.exit(1);
}
`;

/** The exact toy bundle files, as delivered into the toy's normal CI. */
export const TOY_BUNDLE_FILES: Record<string, string> = {
  "tests/regression_test.ts": REGRESSION_TEST,
  "tests/fixtures/upstream.json": FIXTURE_JSON,
  "scripts/replay.ts": REPLAY_SCRIPT,
};

/** The candidate implementation bytes (fix only; tests live in the bundle). */
export const TOY_APP_FIXED = APP_FIXED;
