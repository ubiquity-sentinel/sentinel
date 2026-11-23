/**
 * The private deployment needs no repository variable and two repository
 * secrets (owner, 2026-11-23: "no secrets it's too god damn complicated just
 * hard code in the behavior we need"; docs/DECISIONS.md). Every `vars.*` and
 * `secrets.*` that a job able to run on the private repository reads is
 * listed here with its ABSENT value: what GitHub substitutes when the
 * variable or secret does not exist (an empty string, or the expression's
 * committed `||` fallback). A new read fails this test until its absent value
 * is reviewed. Proven here:
 * - every absent model input resolves to the committed route (the gateway,
 *   the workflow's committed implementation model, the 429 failover, max
 *   reasoning; native review mode selects the reviewer), and the runtime
 *   child receives no DeepSeek key or route override;
 * - the DeepSeek key is only ever a step environment value, so an absent one
 *   is an empty variable nothing requires; the model token is required.
 * The private role's own gates for the remaining absent values (backup CI
 * lists nothing with mode `on`, the dispatcher with auto-follow never runs
 * there, no watchdog filing) are proven by private-deployment-role_test.ts,
 * hosted-workflow-private-gating_test.ts and the finalize role gate.
 */
import assert from "node:assert/strict";
import { parse } from "@std/yaml";
import { asGitSha } from "../../src/contracts/brands.ts";
import { buildChildEnvironment } from "../../src/host/hosted-runtime-child.ts";
import { HOSTED_RUNTIME_STATIC_ENV } from "../../src/host/hosted-runtime-identity.ts";
import {
  DEFAULT_FAILOVER_MODEL_ID,
  GATEWAY_BASE_URL,
  resolveModelRoute,
} from "../../src/host/model-route.ts";

/** Workflows with a job that runs on the private repository. */
const PRIVATE_RUNNING = [
  "supervisor.yml",
  "private-daily.yml",
  "private-sync.yml",
  "ci.yml",
] as const;

/** Every variable they read, with its value when the variable is absent. */
const ABSENT_VARIABLES: Readonly<Record<string, string>> = {
  // Lower-only; the committed ceiling is `off`.
  SENTINEL_MERGE_QUEUE: "",
  SENTINEL_MODEL_BASE_URL: "",
  SENTINEL_IMPLEMENTATION_MODEL_ID: "gpt-6.1-sol",
  // Read but unused by the hosted route; native review mode selects.
  SENTINEL_REVIEW_MODEL_ID: "",
  SENTINEL_MODEL_FALLBACK: "",
  // Inert on the private role: its backup targets list nothing.
  SENTINEL_BACKUP_CI: "on",
  // The private role files no throughput-watchdog issue.
  SENTINEL_SELF_IMPROVE: "on",
};

/** Every secret they read: required, or optional with the committed route. */
const SECRETS: Readonly<Record<string, "required" | "optional">> = {
  SENTINEL_SUPERVISOR_APP_PRIVATE_KEY: "required",
  UOS_AI_TOKEN: "required",
  SENTINEL_DEEPSEEK_API_KEY: "optional",
};

interface Read {
  kind: "vars" | "secrets";
  name: string;
  absent: string;
  path: string;
}

const FORM = /^\s*(vars|secrets)\.([A-Z0-9_]+)(?:\s*\|\|\s*'([^']*)')?\s*$/;

/** The absent value of one `${{ }}` body, or null when it reads neither. */
function absentValue(body: string, path: string): Read | null {
  if (!/\b(vars|secrets)\./.test(body)) return null;
  const match = FORM.exec(body);
  assert.ok(match, `${path}: unreviewed expression \${{${body}}}`);
  const kind = match[1] as Read["kind"];
  return { kind, name: match[2], absent: match[3] ?? "", path };
}

function walk(value: unknown, path: string, out: Read[]): void {
  if (typeof value === "string") {
    for (const [, body] of value.matchAll(/\$\{\{(.*?)\}\}/gs)) {
      const read = absentValue(body, path);
      if (read !== null) out.push(read);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      walk(item, `${path}.${key}`, out);
    }
  }
}

type Obj = Record<string, unknown>;
async function workflow(name: string): Promise<Obj> {
  return parse(await Deno.readTextFile(`.github/workflows/${name}`)) as Obj;
}

async function reads(): Promise<Read[]> {
  const out: Read[] = [];
  for (const name of PRIVATE_RUNNING) walk(await workflow(name), name, out);
  return out;
}

Deno.test("private zero config: every variable is optional, with a reviewed absent value", async () => {
  const variables = new Map<string, Set<string>>();
  for (const read of await reads()) {
    if (read.kind !== "vars") continue;
    const values = variables.get(read.name) ?? new Set<string>();
    variables.set(read.name, values.add(read.absent));
  }
  assert.deepEqual(
    [...variables.keys()].sort(),
    Object.keys(ABSENT_VARIABLES).sort(),
  );
  for (const [name, values] of variables) {
    assert.deepEqual([...values], [ABSENT_VARIABLES[name]], name);
  }
});

Deno.test("private zero config: two required secrets; the DeepSeek key is only an env value", async () => {
  const secrets = (await reads()).filter((read) => read.kind === "secrets");
  assert.deepEqual(
    [...new Set(secrets.map((read) => read.name))].sort(),
    Object.keys(SECRETS).sort(),
  );
  for (const read of secrets) {
    assert.equal(read.absent, "", `${read.path}: a secret has no fallback`);
    if (read.name === "SENTINEL_SUPERVISOR_APP_PRIVATE_KEY") {
      assert.ok(read.path.endsWith(".with.private-key"), read.path);
    } else {
      // A step env value of the same name: absent is an empty variable.
      assert.match(read.path, /\.steps\[\d+\]\.env\.([A-Z0-9_]+)$/);
      assert.ok(read.path.endsWith(`.env.${read.name}`), read.path);
    }
  }
  assert.deepEqual(
    Object.entries(SECRETS).filter(([, need]) => need === "required").map((
      [name],
    ) => name),
    ["SENTINEL_SUPERVISOR_APP_PRIVATE_KEY", "UOS_AI_TOKEN"],
  );
});

/** The runtime steps' env with every variable and the DeepSeek key absent. */
async function runtimeSteps(): Promise<[string, Record<string, string>][]> {
  const jobs = (await workflow("supervisor.yml")).jobs as Record<string, Obj>;
  const out: [string, Record<string, string>][] = [];
  for (const [job, spec] of Object.entries(jobs)) {
    for (const step of (spec.steps ?? []) as Obj[]) {
      if (!String(step.run ?? "").includes("src/host/hosted-runtime.ts")) {
        continue;
      }
      const env: Record<string, string> = {};
      for (const [key, raw] of Object.entries(step.env as Obj)) {
        const text = String(raw);
        const body = /^\$\{\{(.*)\}\}$/s.exec(text)?.[1];
        const read = body === undefined ? null : absentValue(body, key);
        // A secret present at run time, except the optional DeepSeek key.
        env[key] = body === undefined
          ? text
          : read === null || read.name === "UOS_AI_TOKEN" ||
              read.name === "SENTINEL_SUPERVISOR_APP_PRIVATE_KEY"
          ? `present-${key.toLowerCase()}`
          : read.absent;
      }
      out.push([job, env]);
    }
  }
  return out;
}

Deno.test("private zero config: absent model inputs give the committed route and forward no key", async () => {
  const steps = await runtimeSteps();
  assert.deepEqual(
    steps.map(([job]) => job),
    ["matrix_plan", "matrix_cell", "repair_cell", "repair"],
  );
  for (const [job, env] of steps) {
    assert.deepEqual(resolveModelRoute(env), {
      provider: "uos",
      baseUrl: GATEWAY_BASE_URL,
      model: "gpt-6.1-sol",
      reasoning: "max",
      apiKeyEnv: null,
      failoverModel: DEFAULT_FAILOVER_MODEL_ID,
    }, job);
    const launcher = { ...env, PATH: "/usr/bin:/bin" };
    const child = buildChildEnvironment(
      launcher,
      {
        runId: 1,
        runAttempt: 1,
        launcherSha: asGitSha("a".repeat(40)),
        job: "matrix_cell",
      },
      { home: "/h", tmp: "/t", denoDir: "/d" },
      0,
    );
    for (
      const key of [
        "SENTINEL_DEEPSEEK_API_KEY",
        "SENTINEL_MODEL_BASE_URL",
        "SENTINEL_MODEL_FALLBACK",
        "SENTINEL_REVIEW_MODEL_ID",
      ]
    ) assert.equal(child[key], undefined, `${job}: ${key}`);
    assert.equal(child.SENTINEL_MODEL_ID, "gpt-6.1-sol");
    // The model token is required: an absent secret refuses the launch.
    assert.throws(
      () =>
        buildChildEnvironment(
          { ...launcher, UOS_AI_TOKEN: "" },
          {
            runId: 1,
            runAttempt: 1,
            launcherSha: asGitSha("a".repeat(40)),
            job: "matrix_cell",
          },
          { home: "/h", tmp: "/t", denoDir: "/d" },
          0,
        ),
      new Error(HOSTED_RUNTIME_STATIC_ENV),
    );
  }
});
