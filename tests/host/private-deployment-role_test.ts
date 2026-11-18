/**
 * The private role through real consumers: a copy of this tree whose committed
 * private entry is bound (test ids) and wired, run as the private deployment
 * (GitHub's GITHUB_REPOSITORY), executes `private-deployment-role-cases.ts`.
 * Only the runtime rig's own literal self identity is renamed in the copy;
 * production source is the committed source plus those two binding edits.
 */
import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../../", import.meta.url));
const PRIVATE = "ubiquity-sentinel-private/sentinel";
const PUBLIC = ["ubiquity-sentinel", "sentinel"].join("/");
const RIG_FIXTURES = [
  "tests/host/matrix-actions-fixtures.ts",
  "tests/host/targets-deferral-fixtures.ts",
];

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

Deno.test("private role: a bound, wired copy runs as its own deployment and never as the public one", async () => {
  const scratch = SOURCE + ".sentinel-artifacts";
  await Deno.mkdir(scratch, { recursive: true });
  const root = await Deno.makeTempDir({
    dir: scratch,
    prefix: "private-role-",
  });
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
    await rewrite(copy + "src/contracts/hosted-controller-deployment.ts", [
      ["supervisorWorkflowId: null,", "supervisorWorkflowId: 793001,"],
      ["ciWorkflowId: null,", "ciWorkflowId: 793002,"],
      [
        "const PRIVATE_ROLE_WIRED = false;",
        "const PRIVATE_ROLE_WIRED = true;",
      ],
    ]);
    for (const fixture of RIG_FIXTURES) {
      await rewrite(copy + fixture, [[PUBLIC, PRIVATE]]);
    }
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--frozen",
        `--allow-read=.,/usr,/bin,${Deno.execPath()}`,
        "--allow-run",
        "--allow-write",
        "--allow-env=PATH,NODE_V8_COVERAGE,GITHUB_REPOSITORY",
        "tests/host/private-deployment-role-cases.ts",
      ],
      cwd: copy,
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        GITHUB_REPOSITORY: PRIVATE,
        NO_COLOR: "1",
      },
      signal: AbortSignal.timeout(240_000),
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const output = decode(result.stdout) + decode(result.stderr);
    assert.equal(result.code, 0, output);
    assert.match(output, /ok \| 7 passed \| 0 failed/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
