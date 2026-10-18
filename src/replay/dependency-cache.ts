import { canonicalStringify } from "../contracts/canonical.ts";
import { DenoReplayRuntime } from "./runtime.ts";
import type { ReplayRuntimeV1 } from "./runtime.ts";

/** A trusted public dependency seed. Neither paths nor identities come from a target. */
export interface ReplayDependencyCacheV1 {
  root: string;
  sourceSha: string;
  manifestDigest: string;
  /** Optional trusted task-owned directory for private copies outside the checkout. */
  runScratchDir?: string;
}

export interface PublicDependencyPreparationV1 {
  sourceDir: string;
  sourceSha: string;
  root: string;
  entrypoints: readonly string[];
  /** Official pinned Deno archive; checksum is supplied by the trusted public-download controller. */
  denoArtifact?: { path: string; sha256: string };
  bunPath?: string;
  nodePath?: string;
  /** Deterministic public-download port for local tests; production uses the real bounded runtime. */
  runtime?: ReplayRuntimeV1;
}

interface CacheEntry {
  path: string;
  kind: "file" | "symlink";
  digest: string;
  executable: boolean;
}

interface RuntimeIdentity {
  platform: string;
  denoVersion: string;
  binaries: { path: string; digest: string }[];
  artifact: { archiveSha256: string; version: string; platform: string } | null;
}

interface CacheManifest {
  version: "v1";
  sourceSha: string;
  inputs: { path: string; digest: string }[];
  entrypoints: string[];
  runtime: RuntimeIdentity;
  entries: CacheEntry[];
}

export interface ReplayDependencyRunV1 {
  denoDir: string;
  toolsDir: string;
  ownedDir: string;
  runtimeDir: string;
}

const INPUTS = [
  "deno.json",
  "deno.lock",
  "tools/lint/package.json",
  "tools/lint/bun.lock",
  "scripts/verify.sh",
  "scripts/_bootstrap.sh",
];
const PRIVATE_NAMES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  ".netrc",
  "auth.json",
  "credentials",
  "credentials.json",
  "config.toml",
]);
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * Download only the declared pinned public graph in a fresh task-owned tree.
 * Bun install hooks are disabled, both locks are frozen, and no host home,
 * environment, pre-existing cache or private package configuration is read.
 */
export async function preparePublicDependencyCache(
  options: PublicDependencyPreparationV1,
): Promise<ReplayDependencyCacheV1> {
  if (!SHA.test(options.sourceSha)) {
    throw new TypeError("invalid cache source identity");
  }
  const source = await realDirectory(options.sourceDir);
  const root = absoluteOwnedPath(options.root);
  await realDirectory(root.slice(0, root.lastIndexOf("/")) || "/");
  await rejectPrivateConfiguration(source);
  const inputs = await sourceInputs(source);
  const entrypoints = [...options.entrypoints];
  if (entrypoints.length === 0 || entrypoints.some((path) => !safePath(path))) {
    throw new TypeError("invalid public dependency entrypoints");
  }
  for (const path of entrypoints) await regularAt(source, path);
  await Deno.mkdir(root, { recursive: false });
  const tools = `${root}/tools`;
  const deno = `${root}/deno`;
  const home = `${root}/preparation-home`;
  await Deno.mkdir(tools);
  await Deno.mkdir(`${tools}/node_modules`);
  await Deno.mkdir(deno);
  await Deno.mkdir(home);
  await Deno.mkdir(`${root}/runtime`);
  const artifact = await stageDeno(options, source);
  const runtime = await runtimeIdentity(
    `${root}/runtime/deno`,
    options.bunPath ?? "/usr/local/bin/bun",
    options.nodePath ?? "/usr/local/bin/node",
    artifact,
  );
  await Deno.copyFile(runtime.binaries[2].path, `${root}/runtime/node`);
  await Deno.chmod(`${root}/runtime/node`, 0o755);
  for (const path of ["package.json", "bun.lock"]) {
    await Deno.copyFile(`${source}/tools/lint/${path}`, `${tools}/${path}`);
  }
  const env = {
    PATH,
    HOME: home,
    TMPDIR: root,
    DENO_DIR: deno,
    BUN_INSTALL_CACHE_DIR: `${root}/download-cache`,
    DENO_NO_UPDATE_CHECK: "1",
    NODE_V8_COVERAGE: "",
  };
  const runner = options.runtime ?? new DenoReplayRuntime(PATH);
  for (
    const command of [
      {
        executable: runtime.binaries[1].path,
        cwd: tools,
        args: [
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--no-summary",
        ],
      },
      {
        executable: runtime.binaries[0].path,
        cwd: source,
        args: [
          "cache",
          "--frozen",
          "--config=deno.json",
          "--lock=deno.lock",
          ...entrypoints,
        ],
      },
    ]
  ) {
    const result = await runner.run({
      ...command,
      env,
      maxDurationMs: 280_000,
      maxOutputBytes: 1_048_576,
    });
    const label = command.cwd === tools ? "tooling" : "deno";
    await Deno.writeFile(`${root}/preparation-${label}.stdout`, result.stdout);
    await Deno.writeFile(`${root}/preparation-${label}.stderr`, result.stderr);
    console.log(
      JSON.stringify({
        preparation: label,
        outcome: result.outcome,
        exitCode: result.exitCode,
        settled: result.settled,
        truncated: result.truncated,
      }),
    );
    if (
      !result.settled || result.outcome !== "exited" || result.exitCode !== 0 ||
      result.truncated
    ) {
      throw new Error("pinned public dependency preparation failed");
    }
  }
  if (
    canonicalStringify(inputs) !==
      canonicalStringify(await sourceInputs(source))
  ) {
    throw new Error("cache source inputs changed during preparation");
  }
  const manifest: CacheManifest = {
    version: "v1",
    sourceSha: options.sourceSha,
    inputs,
    entrypoints,
    runtime,
    entries: await cacheEntries(root),
  };
  const text = canonicalStringify(manifest);
  await Deno.writeTextFile(`${root}/manifest.json`, text, { createNew: true });
  return {
    root,
    sourceSha: options.sourceSha,
    manifestDigest: await hash(new TextEncoder().encode(text)),
  };
}

/**
 * Verify the trusted seed against current protected inputs and runtime, then
 * make a new writable Deno copy for one run. The shared seed is never mounted
 * writable; target code can mutate only its disposable copy.
 */
export async function materializeDependencyCache(
  cache: ReplayDependencyCacheV1,
  checkout: string,
  _scratch: string,
): Promise<ReplayDependencyRunV1> {
  const root = await realDirectory(absoluteOwnedPath(cache.root));
  if (!SHA.test(cache.sourceSha) || !DIGEST.test(cache.manifestDigest)) {
    throw new TypeError("invalid trusted dependency cache identity");
  }
  const bytes = await Deno.readFile(await regularAt(root, "manifest.json"));
  if (
    bytes.byteLength > 8 * 1024 * 1024 ||
    await hash(bytes) !== cache.manifestDigest
  ) {
    throw new Error("dependency cache manifest integrity mismatch");
  }
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as CacheManifest;
  if (manifest.version !== "v1" || manifest.sourceSha !== cache.sourceSha) {
    throw new Error("dependency cache source mismatch");
  }
  await rejectPrivateConfiguration(checkout);
  if (
    canonicalStringify(manifest.inputs) !==
      canonicalStringify(await sourceInputs(checkout))
  ) {
    throw new Error("dependency cache lock or configuration mismatch");
  }
  if (
    canonicalStringify(manifest.entries) !==
      canonicalStringify(await cacheEntries(root))
  ) {
    throw new Error("dependency cache contents or symlink integrity mismatch");
  }
  if (manifest.runtime.binaries[0].path !== `${root}/runtime/deno`) {
    throw new Error("dependency cache runtime path mismatch");
  }
  const runtime = await runtimeIdentity(
    manifest.runtime.binaries[0].path,
    manifest.runtime.binaries[1].path,
    manifest.runtime.binaries[2].path,
    manifest.runtime.artifact,
  );
  if (
    canonicalStringify(runtime) !== canonicalStringify(manifest.runtime) ||
    (await pinnedDenoVersion(checkout) !== null &&
      await pinnedDenoVersion(checkout) !== runtime.denoVersion)
  ) {
    throw new Error("dependency cache runtime or platform mismatch");
  }
  // The fixed destination may be absent or a real directory, never a link.
  const destination = `${checkout}/tools/lint/node_modules`;
  await safeDirectoryDestination(checkout, "tools/lint/node_modules");
  await Deno.mkdir(destination, { recursive: true });
  const runScratch = await realDirectory(
    absoluteOwnedPath(
      cache.runScratchDir ?? root.slice(0, root.lastIndexOf("/")),
    ),
  );
  const ownedDir = await Deno.makeTempDir({
    dir: runScratch,
    prefix: "sentinel-dependency-run-",
  });
  const denoDir = `${ownedDir}/deno`;
  try {
    await copyCacheTree(`${root}/deno`, denoDir);
    return {
      ownedDir,
      denoDir,
      toolsDir: `${root}/tools/node_modules`,
      runtimeDir: `${root}/runtime`,
    };
  } catch (error) {
    await Deno.remove(ownedDir, { recursive: true });
    throw error;
  }
}

/** Delete only a settled invocation's exact owned scratch directory. */
export async function removeDependencyRun(
  run: ReplayDependencyRunV1,
): Promise<void> {
  await Deno.remove(run.ownedDir, { recursive: true });
}

async function runtimeIdentity(
  deno: string,
  bun: string,
  node: string,
  artifact: RuntimeIdentity["artifact"],
): Promise<RuntimeIdentity> {
  const binaries = [];
  for (const path of [deno, bun, node]) {
    const real = await Deno.realPath(path);
    if (
      (!real.startsWith("/usr/") && real !== "/opt/node-lts/bin/node" &&
        real !== deno) ||
      !(await Deno.lstat(real)).isFile
    ) {
      throw new TypeError(
        "dependency preparation tool is not a trusted system binary",
      );
    }
    binaries.push({
      path: real,
      digest: await hash(await Deno.readFile(real)),
    });
  }
  const version = await new DenoReplayRuntime(PATH).run({
    executable: deno,
    args: ["--version"],
    cwd: "/",
    env: { PATH, NODE_V8_COVERAGE: "" },
    maxDurationMs: 5000,
    maxOutputBytes: 4096,
  });
  const text = new TextDecoder().decode(version.stdout);
  const denoVersion = /^deno ([0-9]+\.[0-9]+\.[0-9]+)/.exec(text)?.[1];
  if (
    !version.settled || version.exitCode !== 0 || denoVersion === undefined ||
    !text.includes(Deno.build.target)
  ) {
    throw new Error("dependency cache Deno runtime identity is unavailable");
  }
  return {
    platform: Deno.build.target,
    denoVersion,
    binaries,
    artifact,
  };
}

async function sourceInputs(root: string) {
  const result = [];
  for (const path of INPUTS) {
    result.push({
      path,
      digest: await hash(await Deno.readFile(await regularAt(root, path))),
    });
  }
  try {
    const path = ".github/workflows/deno-deploy.yml";
    result.push({
      path,
      digest: await hash(await Deno.readFile(await regularAt(root, path))),
    });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return result;
}

async function pinnedDenoVersion(source: string): Promise<string | null> {
  try {
    const text = await Deno.readTextFile(
      await regularAt(source, ".github/workflows/deno-deploy.yml"),
    );
    const versions = [
      ...text.matchAll(/deno-version:\s*([0-9]+\.[0-9]+\.[0-9]+)/g),
    ].map((match) => match[1]);
    if (versions.length === 0 || new Set(versions).size !== 1) {
      throw new Error("target Deno runtime pin is unavailable");
    }
    return versions[0];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function stageDeno(
  options: PublicDependencyPreparationV1,
  source: string,
): Promise<RuntimeIdentity["artifact"]> {
  const target = `${options.root}/runtime/deno`;
  const version = await pinnedDenoVersion(source);
  let artifact: RuntimeIdentity["artifact"] = null;
  if (options.denoArtifact === undefined) {
    if (version !== null && version !== Deno.version.deno) {
      throw new Error(
        "pinned target runtime needs its authenticated public archive",
      );
    }
    await Deno.copyFile(Deno.execPath(), target);
  } else {
    const archivePath = absoluteOwnedPath(options.denoArtifact.path);
    const archiveParent = await realDirectory(
      archivePath.slice(0, archivePath.lastIndexOf("/")),
    );
    const archive = await regularAt(
      archiveParent,
      archivePath.slice(archivePath.lastIndexOf("/") + 1),
    );
    if (
      version === null || !DIGEST.test(options.denoArtifact.sha256) ||
      await hash(await Deno.readFile(archive)) !==
        options.denoArtifact.sha256
    ) {
      throw new Error("pinned Deno archive integrity or source pin mismatch");
    }
    const extracted = await new DenoReplayRuntime(PATH).run({
      executable: "/usr/bin/unzip",
      args: ["-p", archive, "deno"],
      cwd: "/",
      env: { PATH, NODE_V8_COVERAGE: "" },
      maxDurationMs: 15_000,
      maxOutputBytes: 128 * 1024 * 1024,
    });
    if (!extracted.settled || extracted.exitCode !== 0 || extracted.truncated) {
      throw new Error("pinned Deno archive extraction failed");
    }
    await Deno.writeFile(target, extracted.stdout, { createNew: true });
    artifact = {
      archiveSha256: options.denoArtifact.sha256,
      version,
      platform: Deno.build.target,
    };
  }
  await Deno.chmod(target, 0o755);
  return artifact;
}

async function rejectPrivateConfiguration(root: string): Promise<void> {
  for (const directory of [root, `${root}/tools/lint`]) {
    for await (const entry of Deno.readDir(directory)) {
      if (
        entry.name === ".env" || entry.name.startsWith(".env.") ||
        PRIVATE_NAMES.has(entry.name)
      ) {
        throw new Error(
          "private configuration is not a public dependency input",
        );
      }
    }
  }
}

async function cacheEntries(root: string): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = [];
  for (const path of ["deno", "tools/node_modules", "runtime"]) {
    await walk(`${root}/${path}`, path, root, entries);
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(
  path: string,
  relative: string,
  root: string,
  entries: CacheEntry[],
): Promise<void> {
  const info = await Deno.lstat(path);
  if (info.isSymlink) {
    const link = await Deno.readLink(path);
    const real = await Deno.realPath(path);
    const tree = relative.startsWith("deno/")
      ? `${root}/deno`
      : `${root}/tools/node_modules`;
    if (
      link.startsWith("/") || !real.startsWith(`${tree}/`) ||
      !(await Deno.stat(real)).isFile
    ) {
      throw new Error("dependency cache symlink escapes its public tree");
    }
    entries.push({
      path: relative,
      kind: "symlink",
      digest: await hash(new TextEncoder().encode(link)),
      executable: false,
    });
  } else if (info.isDirectory) {
    for await (const entry of Deno.readDir(path)) {
      if (
        PRIVATE_NAMES.has(entry.name) || entry.name === ".env" ||
        entry.name.startsWith(".env.")
      ) {
        throw new Error(
          "private configuration is forbidden in public dependency cache",
        );
      }
      await walk(
        `${path}/${entry.name}`,
        `${relative}/${entry.name}`,
        root,
        entries,
      );
    }
  } else if (info.isFile) {
    entries.push({
      path: relative,
      kind: "file",
      digest: await hash(await Deno.readFile(path)),
      executable: ((info.mode ?? 0) & 0o111) !== 0,
    });
  } else {
    throw new Error("dependency cache contains a non-regular entry");
  }
}

async function copyCacheTree(
  source: string,
  destination: string,
): Promise<void> {
  await Deno.mkdir(destination);
  for await (const entry of Deno.readDir(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${destination}/${entry.name}`;
    const info = await Deno.lstat(from);
    if (info.isDirectory) await copyCacheTree(from, to);
    else if (info.isFile) await Deno.copyFile(from, to);
    else {throw new Error(
        "Deno dependency cache must contain regular files only",
      );}
  }
}

async function regularAt(root: string, relative: string): Promise<string> {
  if (!safePath(relative)) {
    throw new TypeError("invalid public dependency path");
  }
  const parts = relative.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current += `/${parts[index]}`;
    const info = await Deno.lstat(current);
    if (
      info.isSymlink ||
      (index + 1 === parts.length ? !info.isFile : !info.isDirectory)
    ) {
      throw new Error(
        "public dependency input is not a regular contained file",
      );
    }
  }
  return current;
}

async function safeDirectoryDestination(
  root: string,
  relative: string,
): Promise<void> {
  let current = root;
  for (const part of relative.split("/")) {
    current += `/${part}`;
    try {
      const info = await Deno.lstat(current);
      if (!info.isDirectory || info.isSymlink) {
        throw new Error("dependency destination is not a real directory");
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  }
}

async function realDirectory(path: string): Promise<string> {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new TypeError("cache path must be absolute");
  }
  const real = await Deno.realPath(path);
  if (real !== path || !(await Deno.lstat(path)).isDirectory) {
    throw new TypeError("dependency cache directory must not be a symlink");
  }
  return real;
}

function absoluteOwnedPath(path: string): string {
  if (!path.startsWith("/") || !safePath(path.slice(1))) {
    throw new TypeError("dependency cache must be a task-owned absolute path");
  }
  return path;
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") &&
    !path.split("/").some((part) =>
      part === "" || part === "." || part === ".."
    ) &&
    !Array.from(path).some((character) =>
      character === "\\" || character.charCodeAt(0) < 32 ||
      character.charCodeAt(0) === 127
    );
}

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
