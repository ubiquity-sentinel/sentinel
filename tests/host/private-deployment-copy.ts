/**
 * Builds a copy of this tree whose committed private entry is bound (test
 * ids), runs one private-role cases file in it as the private deployment
 * (GitHub's GITHUB_REPOSITORY) and returns the test output. The copied
 * fixtures derive controller identity from the selected binding.
 */
import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HOSTED_CONTROLLER_DEPLOYMENTS } from "../../src/contracts/hosted-controller-deployment.ts";

const SOURCE = fileURLToPath(new URL("../../", import.meta.url));
export const PRIVATE_REPOSITORY = "ubiquity-sentinel-private/sentinel";

async function rewrite(
  path: string,
  edits: readonly (readonly [string, string])[],
): Promise<void> {
  let text = await Deno.readTextFile(path);
  for (const [from, to] of edits) {
    assert(text.includes(from), `${path}: ${from}`);
    text = text.replaceAll(from, to);
  }
  await Deno.writeTextFile(path, text);
}

/** The committed (wired) private entry with test workflow ids. */
const privateDeployment = HOSTED_CONTROLLER_DEPLOYMENTS[1].deployment;
const BINDING: readonly (readonly [string, string])[] = [
  [
    `supervisorWorkflowId: ${privateDeployment.supervisorWorkflowId},`,
    "supervisorWorkflowId: 793001,",
  ],
  [`ciWorkflowId: ${privateDeployment.ciWorkflowId},`, "ciWorkflowId: 793002,"],
];

/** Starts a separate test process with GitHub's repository identity. */
export async function runDeploymentCases(
  cases: string,
  repository: string,
  cwd = SOURCE,
): Promise<{ code: number; output: string }> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--frozen",
      `--allow-read=.,/usr,/bin,${Deno.execPath()}`,
      "--allow-run",
      "--allow-write",
      "--allow-env=PATH,NODE_V8_COVERAGE,GITHUB_REPOSITORY",
      cases,
    ],
    cwd,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      GITHUB_REPOSITORY: repository,
      NO_COLOR: "1",
    },
    signal: AbortSignal.timeout(240_000),
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    code: result.code,
    output: decode(result.stdout) + decode(result.stderr),
  };
}

/** Runs `cases` in a bound private copy; resolves to the combined output. */
export async function runAsPrivateDeployment(
  cases: string,
  prefix: string,
): Promise<{ code: number; output: string }> {
  const scratch = SOURCE + ".sentinel-artifacts";
  await Deno.mkdir(scratch, { recursive: true });
  const root = await Deno.makeTempDir({ dir: scratch, prefix });
  try {
    const copy = root + "/";
    for (const name of ["src", "ops", "tests"]) {
      await cp(SOURCE + name, copy + name, { recursive: true });
    }
    for (
      const name of [
        "deno.json",
        "deno.lock",
        "sentinel.targets.json",
        "sentinel.backup-ci-targets.json",
      ]
    ) await Deno.copyFile(SOURCE + name, copy + name);
    await rewrite(
      copy + "src/contracts/hosted-controller-deployment.ts",
      BINDING,
    );
    return await runDeploymentCases(cases, PRIVATE_REPOSITORY, copy);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
