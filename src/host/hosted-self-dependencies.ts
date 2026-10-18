/** Fixed-location, source-bound transfer of public offline self dependencies. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import { readCleanGitHead } from "./hosted-runtime-child.ts";
import {
  createSelfDependencyPreparer,
  isSentinelSelfTarget,
  type PrepareCheckoutDependenciesV1,
} from "./self-dependency-preparation.ts";
import {
  buildSelfDependencySeed,
  parseSelfDependencySeed,
} from "./self-dependency-seed.ts";
import {
  DEPENDENCY_REFUSAL,
  fileDigest,
  realDirectory,
  refuse,
  textDigest,
} from "./self-dependency-files.ts";

const SEED_DIRECTORY = ".sentinel/self-dependencies";
const MANIFEST_NAME = "manifest.json";
const SEAL_NAME = "seal.sha256";
const MAX_MANIFEST_BYTES = 512 * 1024;

interface SeedPair {
  manifestText: string;
  seal: string;
}

async function cleanHead(directory: string): Promise<GitSha> {
  await realDirectory(directory);
  return await readCleanGitHead(
    new DenoReplayRuntime(Deno.execPath()),
    directory,
  );
}
async function privateDirectory(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  await realDirectory(path);
}
/** Bound the read itself, then match the independently checked regular-file digest. */
async function boundedText(path: string, maximum: number): Promise<string> {
  const expected = await fileDigest(path, maximum);
  const file = await Deno.open(path, { read: true });
  const bytes = new Uint8Array(maximum + 1);
  let length = 0;
  try {
    for (;;) {
      const count = await file.read(bytes.subarray(length));
      if (count === null) break;
      length += count;
      if (length > maximum) refuse();
    }
  } finally {
    file.close();
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, length),
  );
  if (
    length !== expected.size || textDigest(text) !== expected.sha256 ||
    JSON.stringify(expected) !== JSON.stringify(await fileDigest(path, maximum))
  ) refuse();
  return text;
}
async function readPair(
  launcher: string,
  sourceCommit: GitSha,
): Promise<SeedPair> {
  const directory = `${launcher}/${SEED_DIRECTORY}`;
  await realDirectory(directory);
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entries.length === 2) refuse();
    entries.push(entry);
  }
  if (
    entries.length !== 2 ||
    entries.map((entry) => entry.name).sort().join(",") !==
      `${MANIFEST_NAME},${SEAL_NAME}`
  ) refuse();
  const manifestText = await boundedText(
    `${directory}/${MANIFEST_NAME}`,
    MAX_MANIFEST_BYTES,
  );
  const sealText = await boundedText(`${directory}/${SEAL_NAME}`, 65);
  if (!/^[0-9a-f]{64}\n$/.test(sealText)) refuse();
  const seal = sealText.slice(0, -1);
  if (
    textDigest(manifestText) !== seal ||
    parseSelfDependencySeed(manifestText).sourceCommit !== sourceCommit
  ) refuse();
  return { manifestText, seal };
}
async function writeNew(path: string, text: string): Promise<void> {
  const file = await Deno.open(path, {
    write: true,
    createNew: true,
    mode: 0o600,
  });
  try {
    const data = new TextEncoder().encode(text);
    let written = 0;
    while (written < data.length) {
      written += await file.write(data.subarray(written));
    }
    await file.sync();
  } finally {
    file.close();
  }
}

/**
 * Credential-free workflow producer, after locked npm ci. Derives L from the
 * actual clean checkout; neither commit nor output paths are caller/env inputs.
 * Existing publication is immutable and reusable only for exactly the same pair.
 */
export async function writeHostedSelfDependencySeed(input: {
  launcherDir: string;
  trustedPath: string;
}): Promise<void> {
  let stage: string | null = null;
  try {
    if (!input.launcherDir.endsWith("/launcher")) refuse();
    const sourceCommit = await cleanHead(input.launcherDir);
    const sentinel = `${input.launcherDir}/.sentinel`;
    await privateDirectory(sentinel);
    const seed = await buildSelfDependencySeed({
      sourceRoot: input.launcherDir,
      sourceCommit,
      trustedPath: input.trustedPath,
      scratch: `${sentinel}/self-dependency-git-home`,
    });
    if (await cleanHead(input.launcherDir) !== sourceCommit) refuse();
    const destination = `${input.launcherDir}/${SEED_DIRECTORY}`;
    let present = false;
    try {
      await Deno.lstat(destination);
      present = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (present) {
      const existing = await readPair(input.launcherDir, sourceCommit);
      if (
        existing.manifestText !== seed.text || existing.seal !== seed.sha256
      ) refuse();
      return;
    }
    stage = await Deno.makeTempDir({
      dir: sentinel,
      prefix: ".self-dependencies-",
    });
    await writeNew(`${stage}/${MANIFEST_NAME}`, seed.text);
    await writeNew(`${stage}/${SEAL_NAME}`, `${seed.sha256}\n`);
    await realDirectory(sentinel);
    if (await cleanHead(input.launcherDir) !== sourceCommit) refuse();
    await Deno.rename(stage, destination);
    stage = null;
    const result = await readPair(input.launcherDir, sourceCommit);
    if (result.manifestText !== seed.text || result.seal !== seed.sha256) {
      refuse();
    }
  } catch {
    refuse();
  } finally {
    if (stage !== null) {
      await Deno.remove(stage, { recursive: true }).catch(() => {});
    }
  }
}

export interface HostedSelfDependencyInputV1 {
  /** Canonical runtime directory already verified by the trusted host. */
  runtimeDir: string;
  /** Native identity and saved execution, already authenticated by that host. */
  launcherSha: GitSha;
  executionLauncherSha: GitSha;
  trustedPath: string;
}
async function readBoundSeed(input: HostedSelfDependencyInputV1): Promise<{
  launcher: string;
  pair: SeedPair;
}> {
  if (
    !isGitSha(input.launcherSha) ||
    input.executionLauncherSha !== input.launcherSha ||
    !input.runtimeDir.endsWith("/runtime")
  ) refuse();
  await realDirectory(input.runtimeDir);
  const launcher = `${input.runtimeDir.slice(0, -"runtime".length)}launcher`;
  if (await cleanHead(launcher) !== input.launcherSha) refuse();
  const pair = await readPair(launcher, input.launcherSha);
  if (await cleanHead(launcher) !== input.launcherSha) refuse();
  return { launcher, pair };
}

/**
 * Root ALWAYS injects this callback. Missing/unavailable preparation refuses self
 * sessions; it is never represented as an omitted optional local-model hook.
 * This is public dependency custody, not an App principal or model capability.
 */
export async function readHostedSelfDependencyPreparer(
  supplied: HostedSelfDependencyInputV1,
): Promise<PrepareCheckoutDependenciesV1> {
  const input = { ...supplied };
  let bound: Awaited<ReturnType<typeof readBoundSeed>> | null = null;
  try {
    bound = await readBoundSeed(input);
  } catch { /* Static self refusal below. */ }
  const initial = bound;
  return async (request) => {
    if (!isSentinelSelfTarget(request.repository)) return portOk(undefined);
    try {
      if (initial === null) refuse();
      const current = await readBoundSeed(input);
      if (
        current.launcher !== initial.launcher ||
        current.pair.manifestText !== initial.pair.manifestText ||
        current.pair.seal !== initial.pair.seal
      ) refuse();
      const prepare = createSelfDependencyPreparer({
        seedRoot: current.launcher,
        manifestText: current.pair.manifestText,
        expectedSealSha256: current.pair.seal,
        sourceCommit: input.launcherSha,
      });
      const result = await prepare(request);
      if (!result.ok) return result;
      const after = await readBoundSeed(input);
      if (
        after.pair.manifestText !== initial.pair.manifestText ||
        after.pair.seal !== initial.pair.seal
      ) refuse();
      return portOk(undefined);
    } catch {
      return portError("unavailable", DEPENDENCY_REFUSAL);
    }
  };
}
