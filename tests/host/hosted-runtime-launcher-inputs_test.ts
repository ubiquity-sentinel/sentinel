/**
 * The launcher must read every host input its child environment forwards,
 * and every hosted-runtime workflow step must grant each input it reads.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { buildChildEnvironment } from "../../src/host/hosted-runtime-child.ts";
import type { HostedRuntimeJobV1 } from "../../src/host/hosted-runtime-identity.ts";
import {
  HOSTED_RUNTIME_LAUNCHER_INPUT_KEYS,
  HOSTED_RUNTIME_OPTIONAL_LAUNCHER_INPUT_KEYS,
  readHostedLauncherInputs,
  readJobScopedLauncherEnv,
} from "../../src/host/hosted-runtime-main.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/hosted-runtime-launcher-inputs_test\.ts$/,
  "",
);

const LAUNCHER_JOBS = ["matrix_plan", "matrix_cell", "repair"] as const;
/**
 * Job-scoped launcher inputs: each is read only for the one job whose step
 * grants it (the planner's output file; planner/repair App mint evidence).
 */
const JOB_INPUTS: Readonly<Record<string, readonly string[]>> = {
  matrix_plan: [
    "GITHUB_OUTPUT",
    "SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE",
    "SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT",
  ],
  repair: [
    "SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE",
    "SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT",
  ],
};
const MINT_BOUND = "SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE";
const DIRS = { home: "/h", tmp: "/t", denoDir: "/d" };
/** The launcher's own clock when it builds the child environment. */
const NOW = 1_800_000_000_000;
const IDENTITY_KEYS = [
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_JOB",
];

function identity(job: HostedRuntimeJobV1) {
  return {
    runId: 1,
    runAttempt: 1,
    launcherSha: "a".repeat(40) as GitSha,
    job,
  };
}

Deno.test("hosted launcher: the workflow's cooldown switch reaches the child", () => {
  const host: Record<string, string> = {
    PATH: "/usr/bin",
    GITHUB_TOKEN: "native-token",
    UOS_AI_TOKEN: "model-token",
    SENTINEL_COOLDOWN_MODE: "off",
  };
  const inputs = readHostedLauncherInputs((key) => host[key]);
  const child = buildChildEnvironment(inputs, identity("repair"), DIRS, NOW);
  assert.equal(child.SENTINEL_COOLDOWN_MODE, "off");
  // An unset switch stays absent, so the child keeps its enforcing default.
  const unset = readHostedLauncherInputs((key) =>
    key === "SENTINEL_COOLDOWN_MODE" ? undefined : host[key]
  );
  const enforced = buildChildEnvironment(unset, identity("repair"), DIRS, NOW);
  assert.equal(Object.hasOwn(enforced, "SENTINEL_COOLDOWN_MODE"), false);
});

Deno.test("hosted launcher: every host key the child builder reads is a launcher input", () => {
  const read = new Set<string>([
    ...HOSTED_RUNTIME_LAUNCHER_INPUT_KEYS,
    // Read tolerantly: a step may not grant it yet (backup CI, §11.8).
    ...HOSTED_RUNTIME_OPTIONAL_LAUNCHER_INPUT_KEYS,
  ]);
  for (const job of LAUNCHER_JOBS) {
    // Record every key the production child builder consults, whatever list
    // it comes from, by offering a value for any key it asks for.
    const consulted = new Set<string>();
    const host = new Proxy({} as Record<string, string | undefined>, {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        consulted.add(key);
        // The mint bound is an epoch instant the builder validates; any
        // other value would refuse the launch instead of revealing a read.
        if (key === MINT_BOUND) return String(NOW - 60_000);
        return `value-${key}`;
      },
    });
    const child = buildChildEnvironment(host, identity(job), DIRS, NOW);
    assert.equal(child.SENTINEL_COOLDOWN_MODE, "value-SENTINEL_COOLDOWN_MODE");
    const allowed = new Set([...read, ...(JOB_INPUTS[job] ?? [])]);
    for (const key of consulted) {
      assert.ok(allowed.has(key), `${job}: the launcher must read ${key}`);
    }
    // Only the trusted repair/planner children receive a derived App window.
    assert.equal(consulted.has(MINT_BOUND), job !== "matrix_cell", job);
    assert.equal(
      Object.hasOwn(child, "SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER"),
      job !== "matrix_cell",
      job,
    );
  }
});

Deno.test("hosted launcher: each job reads exactly its own job-scoped inputs", () => {
  for (const job of LAUNCHER_JOBS) {
    const asked: string[] = [];
    const scoped = readJobScopedLauncherEnv(job, (key) => {
      asked.push(key);
      return `value-${key}`;
    });
    assert.deepEqual(asked.sort(), [...(JOB_INPUTS[job] ?? [])].sort(), job);
    assert.deepEqual(Object.keys(scoped).sort(), asked, job);
    // A job-scoped input is never also a fixed input every job reads.
    for (const key of asked) {
      assert.ok(
        !(HOSTED_RUNTIME_LAUNCHER_INPUT_KEYS as readonly string[]).includes(
          key,
        ),
        key,
      );
    }
  }
});

Deno.test("hosted launcher: the entrypoint reads its inputs only through the named list", async () => {
  // A re-inlined env object (the shape that once dropped the cooldown switch)
  // would bypass the list the tests above pin.
  const source = await Deno.readTextFile(
    `${ROOT}/src/host/hosted-runtime-main.ts`,
  );
  assert.ok(source.includes("...readHostedLauncherInputs(),"));
  const reads = source.match(/Deno\.env\.get\(/g) ?? [];
  assert.equal(
    reads.length,
    2,
    "only the list reader and the job-scoped input reader touch env",
  );
});

Deno.test("hosted launcher: every hosted-runtime step grants every launcher input", async () => {
  const workflow = await Deno.readTextFile(
    `${ROOT}/.github/workflows/supervisor.yml`,
  );
  const lines = workflow.split("\n");
  const references = lines.filter((line) =>
    !line.trim().startsWith("#") && line.includes("src/host/hosted-runtime.ts")
  );
  const jobs: string[] = [];
  lines.forEach((line, index) => {
    if (line.trim() !== "src/host/hosted-runtime.ts") return;
    // The owning job is the nearest preceding two-space job key.
    let job: string | undefined;
    for (let at = index; at >= 0 && job === undefined; at--) {
      const match = /^ {2}([a-z_]+):\s*$/.exec(lines[at]);
      if (match !== null) job = match[1];
    }
    assert.ok(job !== undefined, `no job owns line ${index + 1}`);
    jobs.push(job);
    // The grant must belong to this invocation's own command: scan back only
    // to the line that starts it.
    let grant: string | undefined;
    for (let at = index - 1; at >= 0; at--) {
      const text = lines[at].trim();
      if (text.startsWith("--allow-env=")) grant = text;
      // The command may be the tail of a pipeline ("fi | deno run").
      if (/(^|\|\s*)deno run\b/.test(text)) break;
      assert.ok(!text.startsWith("run:"), `line ${index + 1} has no deno run`);
    }
    assert.ok(grant !== undefined, `no --allow-env for line ${index + 1}`);
    const granted = new Set(
      grant.slice("--allow-env=".length).replace(/\s*\\$/, "").split(","),
    );
    const required = [
      ...HOSTED_RUNTIME_LAUNCHER_INPUT_KEYS,
      ...IDENTITY_KEYS,
      ...(JOB_INPUTS[job] ?? []),
    ];
    for (const key of required) {
      assert.ok(
        granted.has(key),
        `${job} (line ${index + 1}) must grant ${key}`,
      );
    }
  });
  // Every reference is one of the recognised standalone invocations.
  assert.equal(references.length, jobs.length);
  assert.deepEqual(jobs.sort(), [...LAUNCHER_JOBS].sort());
});
