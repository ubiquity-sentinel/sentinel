/** Trusted producer/parser. Its digest must arrive through authenticated host wiring. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import { runTrustedGitResult } from "./local-git.ts";
import { SANDBOX_NODE_EXECUTABLE } from "./local-client.ts";
import {
  dependencyFiles,
  type DependencyFileV1,
  fileDigest,
  MAX_DEPENDENCY_BYTES,
  MAX_DEPENDENCY_FILES,
  MAX_FILE_BYTES,
  MAX_NODE_BYTES,
  realDirectory,
  refuse,
  safeRelative,
  SELF_ACTION,
  SELF_ACTION_FILES,
  sourceFiles,
  textDigest,
} from "./self-dependency-files.ts";

export interface SelfDependencySeedV1 {
  version: "v1";
  kind: "sentinel_self_dependency_seed";
  sourceCommit: GitSha;
  source: DependencyFileV1[];
  dependencies: DependencyFileV1[];
  dependencyTreeSha256: string;
  node: {
    path: typeof SANDBOX_NODE_EXECUTABLE;
    size: number;
    sha256: string;
    version: string;
  };
}
const digestPattern = /^[0-9a-f]{64}$/;
export function supportedSelfDependencyNode(version: string): boolean {
  const match = /^v24\.(\d+)\.(\d+)$/.exec(version);
  return match !== null && Number(match[1]) >= 4;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  ) refuse();
  return value as Record<string, unknown>;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) refuse();
  return value;
}
function size(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
    value > maximum
  ) refuse();
  return value;
}
function files(value: unknown, source: boolean): DependencyFileV1[] {
  if (
    !Array.isArray(value) || value.length === 0 ||
    value.length > MAX_DEPENDENCY_FILES
  ) refuse();
  const result: DependencyFileV1[] = [];
  let total = 0;
  for (const entry of value) {
    const row = object(entry, ["path", "size", "sha256"]);
    if (typeof row.path !== "string" || !safeRelative(row.path)) refuse();
    const previous = result.at(-1)?.path;
    if (previous !== undefined && previous >= row.path) refuse();
    const count = size(row.size, MAX_FILE_BYTES);
    total += count;
    if (total > MAX_DEPENDENCY_BYTES) refuse();
    result.push({ path: row.path, size: count, sha256: digest(row.sha256) });
  }
  if (
    source &&
    JSON.stringify(result.map((row) => row.path)) !==
      JSON.stringify(SELF_ACTION_FILES)
  ) refuse();
  return result;
}
/** Strict bounds and projection reject extensions, unsafe paths, duplicate rows, and unknown Node. */
export function parseSelfDependencySeed(text: string): SelfDependencySeedV1 {
  if (
    text.length > 512 * 1024 ||
    new TextEncoder().encode(text).length > 512 * 1024
  ) refuse();
  const value = object(JSON.parse(text), [
    "version",
    "kind",
    "sourceCommit",
    "source",
    "dependencies",
    "dependencyTreeSha256",
    "node",
  ]);
  if (
    value.version !== "v1" || value.kind !== "sentinel_self_dependency_seed" ||
    !isGitSha(value.sourceCommit)
  ) refuse();
  const node = object(value.node, ["path", "size", "sha256", "version"]);
  if (
    node.path !== SANDBOX_NODE_EXECUTABLE || typeof node.version !== "string" ||
    !supportedSelfDependencyNode(node.version)
  ) refuse();
  const dependencies = files(value.dependencies, false);
  const dependencyTreeSha256 = digest(value.dependencyTreeSha256);
  if (textDigest(JSON.stringify(dependencies)) !== dependencyTreeSha256) {
    refuse();
  }
  return {
    version: "v1",
    kind: "sentinel_self_dependency_seed",
    sourceCommit: value.sourceCommit,
    source: files(value.source, true),
    dependencies,
    dependencyTreeSha256,
    node: {
      path: SANDBOX_NODE_EXECUTABLE,
      size: size(node.size, MAX_NODE_BYTES),
      sha256: digest(node.sha256),
      version: node.version,
    },
  };
}
export async function selfDependencyNode(
  root: string,
): Promise<SelfDependencySeedV1["node"]> {
  const before = await fileDigest(SANDBOX_NODE_EXECUTABLE, MAX_NODE_BYTES);
  const result = await new DenoReplayRuntime(Deno.execPath()).run({
    executable: SANDBOX_NODE_EXECUTABLE,
    args: ["--version"],
    cwd: root,
    env: {},
    maxDurationMs: 10_000,
    maxOutputBytes: 1024,
  });
  const version = new TextDecoder().decode(result.stdout).trim();
  if (
    result.outcome !== "exited" || !result.settled || result.truncated ||
    result.exitCode !== 0 ||
    !supportedSelfDependencyNode(version) ||
    JSON.stringify(before) !==
      JSON.stringify(await fileDigest(SANDBOX_NODE_EXECUTABLE, MAX_NODE_BYTES))
  ) refuse();
  return { path: SANDBOX_NODE_EXECUTABLE, ...before, version };
}
/** No installs or target execution. Call only after credential-free locked npm ci. */
export async function buildSelfDependencySeed(input: {
  sourceRoot: string;
  sourceCommit: GitSha;
  trustedPath: string;
  scratch: string;
}): Promise<{ text: string; sha256: string }> {
  if (!isGitSha(input.sourceCommit)) refuse();
  await realDirectory(input.sourceRoot);
  const git = async (args: string[]) => {
    const result = await runTrustedGitResult({
      ...input,
      args,
      cwd: input.sourceRoot,
    });
    if (result.code !== 0) refuse();
    return result.stdout;
  };
  if ((await git(["rev-parse", "HEAD"])).trim() !== input.sourceCommit) {
    refuse();
  }
  const tracked = (await git([
    "ls-tree",
    "-r",
    "--name-only",
    input.sourceCommit,
    "--",
    SELF_ACTION,
  ])).trim().split("\n");
  if (
    JSON.stringify(tracked) !==
      JSON.stringify(SELF_ACTION_FILES.map((path) => `${SELF_ACTION}/${path}`))
  ) refuse();
  const source = await sourceFiles(input.sourceRoot);
  for (const row of source) {
    // All allowlisted action files are UTF-8 text; compare exact Git blob bytes.
    if (
      textDigest(
        await git(["show", `${input.sourceCommit}:${SELF_ACTION}/${row.path}`]),
      ) !== row.sha256
    ) refuse();
  }
  const dependencies = await dependencyFiles(
    `${input.sourceRoot}/${SELF_ACTION}/node_modules`,
  );
  const manifest: SelfDependencySeedV1 = {
    version: "v1",
    kind: "sentinel_self_dependency_seed",
    sourceCommit: input.sourceCommit,
    source,
    dependencies,
    dependencyTreeSha256: textDigest(JSON.stringify(dependencies)),
    node: await selfDependencyNode(input.sourceRoot),
  };
  const text = JSON.stringify(manifest) + "\n";
  parseSelfDependencySeed(text);
  return { text, sha256: textDigest(text) };
}
