/** Complete deterministic test partition; historical native file times balance host thirds. */
import timings from "./ci-test-timings.json" with { type: "json" };

// Conservative maximum module intervals from native runs 39306919556 (a1ba60d67b)
// and 39255082743 (ff8763f901). Unknown/new host tests receive a one-second weight.

export const CI_TEST_SHARDS = [
  "modules",
  "integration",
  "host-1",
  "host-2",
  "host-3",
] as const;
export type CiTestShard = typeof CI_TEST_SHARDS[number];
const testFile = /(?:^test|[._]test)\.[cm]?[jt]sx?$/;

/** New directories and test files enter a shard automatically. */
export async function discoverCiTests(root = "tests"): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isSymlink) throw new Error(`CI test symlink refused: ${path}`);
    if (entry.isDirectory) files.push(...await discoverCiTests(path));
    else if (entry.isFile && testFile.test(entry.name)) files.push(path);
  }
  return files.sort();
}

export function planCiTestShards(
  files: readonly string[],
  seconds: Readonly<Record<string, number>> = timings,
): Record<CiTestShard, string[]> {
  if (new Set(files).size !== files.length) {
    throw new Error("duplicate CI test file");
  }
  const plan: Record<CiTestShard, string[]> = {
    modules: [],
    integration: [],
    "host-1": [],
    "host-2": [],
    "host-3": [],
  };
  const host: string[] = [];
  for (const file of files) {
    if (!file.startsWith("tests/") || !testFile.test(file.split("/").at(-1)!)) {
      throw new Error(`invalid CI test file: ${file}`);
    }
    if (file.startsWith("tests/host/")) host.push(file);
    else if (file.startsWith("tests/integration/")) plan.integration.push(file);
    else plan.modules.push(file);
  }
  const weight = (file: string): number => {
    const value = seconds[file] ?? 1;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`invalid CI timing: ${file}`);
    }
    return value;
  };
  const loads = [0, 0, 0];
  const names = ["host-1", "host-2", "host-3"] as const;
  for (
    const file of host.sort((a, b) =>
      weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0)
    )
  ) {
    const index = [0, 1, 2].sort((a, b) =>
      loads[a] - loads[b] || plan[names[a]].length - plan[names[b]].length ||
      a - b
    )[0];
    plan[names[index]].push(file);
    loads[index] += weight(file);
  }
  for (const name of CI_TEST_SHARDS) plan[name].sort();
  return plan;
}

if (import.meta.main) {
  const name = Deno.args[0] as CiTestShard;
  if (Deno.args.length !== 1 || !CI_TEST_SHARDS.includes(name)) {
    throw new Error(`expected one CI shard: ${CI_TEST_SHARDS.join(", ")}`);
  }
  const files = planCiTestShards(await discoverCiTests())[name];
  if (files.length === 0) throw new Error(`empty CI test shard: ${name}`);
  console.log(`CI shard ${name}: ${files.length} test files`);
  const status = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env=PATH",
      "--allow-run=deno,git",
      "--allow-write",
      "test-local.ts",
      "--tests",
      ...files,
    ],
    clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  Deno.exit(status.code);
}
