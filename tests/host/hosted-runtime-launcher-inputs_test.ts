/**
 * The launcher must read every host input its child environment forwards,
 * and every hosted-runtime workflow step must grant each input it reads.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { buildChildEnvironment } from "../../src/host/hosted-runtime-child.ts";
import { HOSTED_RUNTIME_CHILD_ENV_KEYS } from "../../src/host/hosted-runtime-identity.ts";
import {
  HOSTED_RUNTIME_LAUNCHER_INPUT_KEYS,
  readHostedLauncherInputs,
} from "../../src/host/hosted-runtime-main.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/hosted-runtime-launcher-inputs_test\.ts$/,
  "",
);

const IDENTITY = {
  runId: 1,
  runAttempt: 1,
  launcherSha: "a".repeat(40) as GitSha,
  job: "repair" as const,
};
const DIRS = { home: "/h", tmp: "/t", denoDir: "/d" };
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

Deno.test("hosted launcher: the workflow's cooldown switch reaches the child", () => {
  const host: Record<string, string> = {
    PATH: "/usr/bin",
    GITHUB_TOKEN: "native-token",
    UOS_AI_TOKEN: "model-token",
    SENTINEL_COOLDOWN_MODE: "off",
  };
  const inputs = readHostedLauncherInputs((key) => host[key]);
  const child = buildChildEnvironment(inputs, IDENTITY, DIRS);
  assert.equal(child.SENTINEL_COOLDOWN_MODE, "off");
  // An unset switch stays absent, so the child keeps its enforcing default.
  const unset = readHostedLauncherInputs((key) =>
    key === "SENTINEL_COOLDOWN_MODE" ? undefined : host[key]
  );
  const enforced = buildChildEnvironment(unset, IDENTITY, DIRS);
  assert.equal(Object.hasOwn(enforced, "SENTINEL_COOLDOWN_MODE"), false);
});

Deno.test("hosted launcher: every host value the child forwards is a launcher input", () => {
  // Offer a distinct marker for every child key; a key whose marker reaches
  // the child is copied from the host environment, so the launcher must
  // read it or the setting never arrives.
  const marker = (key: string) => `marker-${key}`;
  const offered: Record<string, string> = {};
  for (const key of [...HOSTED_RUNTIME_CHILD_ENV_KEYS, ...IDENTITY_KEYS]) {
    offered[key] = marker(key);
  }
  const child = buildChildEnvironment(offered, IDENTITY, DIRS);
  const copied = Object.keys(child).filter((key) => child[key] === marker(key));
  assert.ok(copied.includes("SENTINEL_COOLDOWN_MODE"));
  const read = new Set<string>(HOSTED_RUNTIME_LAUNCHER_INPUT_KEYS);
  for (const key of copied) {
    assert.ok(read.has(key), `the launcher must read forwarded ${key}`);
  }
});

Deno.test("hosted launcher: every hosted-runtime step grants every launcher input", async () => {
  const workflow = await Deno.readTextFile(
    `${ROOT}/.github/workflows/supervisor.yml`,
  );
  const lines = workflow.split("\n");
  const grantPrefix = "--allow-env=";
  let steps = 0;
  lines.forEach((line, index) => {
    if (line.trim() !== "src/host/hosted-runtime.ts") return;
    steps++;
    // The grant is the nearest preceding --allow-env line of the same run.
    let grant: string | undefined;
    for (let at = index - 1; at >= 0 && grant === undefined; at--) {
      const text = lines[at].trim();
      if (text.startsWith("run:")) break;
      if (text.startsWith(grantPrefix)) grant = text;
    }
    assert.ok(grant !== undefined, `no --allow-env for line ${index + 1}`);
    const granted = new Set(
      grant.slice(grantPrefix.length).replace(/\s*\\$/, "").split(","),
    );
    for (
      const key of [...HOSTED_RUNTIME_LAUNCHER_INPUT_KEYS, ...IDENTITY_KEYS]
    ) {
      assert.ok(
        granted.has(key),
        `hosted-runtime step at line ${index + 1} must grant ${key}`,
      );
    }
  });
  assert.equal(
    steps,
    3,
    "matrix_plan, matrix_cell and repair run the launcher",
  );
});
