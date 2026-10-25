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
const DEFAULT_WORKERS = 1;
const MAX_WORKERS = 8;

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

function validateTestFiles(
  files: readonly string[],
  seconds: Readonly<Record<string, number>>,
): void {
  if (new Set(files).size !== files.length) {
    throw new Error("duplicate CI test file");
  }
  for (const file of files) {
    if (!file.startsWith("tests/") || !testFile.test(file.split("/").at(-1)!)) {
      throw new Error(`invalid CI test file: ${file}`);
    }
    const value = seconds[file] ?? 1;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`invalid CI timing: ${file}`);
    }
  }
}

export function planCiTestShards(
  files: readonly string[],
  seconds: Readonly<Record<string, number>> = timings,
): Record<CiTestShard, string[]> {
  validateTestFiles(files, seconds);
  const plan: Record<CiTestShard, string[]> = {
    modules: [],
    integration: [],
    "host-1": [],
    "host-2": [],
    "host-3": [],
  };
  const host: string[] = [];
  for (const file of files) {
    if (file.startsWith("tests/host/")) host.push(file);
    else if (file.startsWith("tests/integration/")) plan.integration.push(file);
    else plan.modules.push(file);
  }
  const weight = (file: string): number => seconds[file] ?? 1;
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

/**
 * Partition one already-planned shard into balanced isolated worker groups.
 *
 * Each worker is a separate `test-local.ts` process, so it retains its own
 * temporary HOME and DENO_DIR. This changes only work scheduling; every file
 * still runs exactly once and the native aggregate check is unchanged.
 */
export function planCiTestWorkers(
  files: readonly string[],
  workers: number,
  seconds: Readonly<Record<string, number>> = timings,
): string[][] {
  if (!Number.isInteger(workers) || workers < 1 || workers > MAX_WORKERS) {
    throw new Error(
      `invalid CI worker count: ${workers}; expected 1..${MAX_WORKERS}`,
    );
  }
  validateTestFiles(files, seconds);
  if (files.length === 0) return [];
  const count = Math.min(workers, files.length);
  const groups = Array.from({ length: count }, () => [] as string[]);
  const loads = Array.from({ length: count }, () => 0);
  const weight = (file: string): number => seconds[file] ?? 1;
  for (
    const file of [...files].sort((a, b) =>
      weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0)
    )
  ) {
    let index = 0;
    for (let candidate = 1; candidate < count; candidate++) {
      if (
        loads[candidate] < loads[index] ||
        (loads[candidate] === loads[index] &&
          groups[candidate].length < groups[index].length)
      ) {
        index = candidate;
      }
    }
    groups[index].push(file);
    loads[index] += weight(file);
  }
  for (const group of groups) group.sort();
  return groups;
}

function configuredWorkers(): number {
  const raw = Deno.env.get("SENTINEL_TEST_JOBS");
  if (raw === undefined || raw === "") return DEFAULT_WORKERS;
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1 || workers > MAX_WORKERS) {
    throw new Error(
      `invalid SENTINEL_TEST_JOBS: ${raw}; expected 1..${MAX_WORKERS}`,
    );
  }
  return workers;
}

/** Run one shard in an isolated test-local worker pool. */
export async function runCiShard(name: CiTestShard): Promise<number> {
  if (!CI_TEST_SHARDS.includes(name)) {
    throw new Error(`expected one CI shard: ${CI_TEST_SHARDS.join(", ")}`);
  }
  const files = planCiTestShards(await discoverCiTests())[name];
  if (files.length === 0) throw new Error(`empty CI test shard: ${name}`);
  const groups = planCiTestWorkers(files, configuredWorkers());
  const path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
  const statuses = await Promise.all(groups.map((group, index) => {
    console.log(
      `CI shard ${name} worker ${
        index + 1
      }/${groups.length}: ${group.length} test files`,
    );
    return new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env=PATH",
        "--allow-run=deno,git",
        "--allow-write",
        "test-local.ts",
        "--tests",
        ...group,
      ],
      clearEnv: true,
      env: { PATH: path },
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
  }));
  return statuses.every((status) => status.success) ? 0 : 1;
}

if (import.meta.main) {
  const name = Deno.args[0] as CiTestShard;
  if (Deno.args.length !== 1) {
    throw new Error(`expected one CI shard: ${CI_TEST_SHARDS.join(", ")}`);
  }
  Deno.exit(await runCiShard(name));
}
