import { createHash } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import {
  BUN_READER_BOOTSTRAP,
  BUN_READER_BOOTSTRAP_PATH,
  BUN_READER_PREFLIGHT,
  BUN_READER_PREFLIGHT_PATH,
} from "./bun-reader-bootstrap.ts";
import {
  buildSentinelReplayInputMetadata,
  MAX_SENTINEL_REPLAY_INPUT_BYTES,
  SENTINEL_REPLAY_INPUT_PATH,
} from "./causal-dispatch.ts";
import { bytesEqual } from "./causal-verifier-protocol.ts";

/** Independently authenticated immutable release, supplied only by the trusted host. */
export interface BunFrozenReaderBindingV1 {
  kind: "bun";
  sourceSha: string;
  artifact: {
    root: string;
    archivePath: string;
    id: number;
    digest: string;
    manifestDigest: string;
  };
  runtime: {
    path: string;
    version: "1.4.0";
    archiveDigest: string;
    binaryDigest: string;
  };
}

interface ReleaseManifest {
  schema: 3;
  git_sha: string;
  source_archive_sha256: string;
  source_tree_sha256: string;
  dependency_lock_sha256: string;
  dependency_tree_sha256: string;
  permissions_tree_sha256: string;
  platform: "linux";
  architecture: "arm64";
  runtime: Record<string, unknown>;
  native_kv: {
    tree_sha256: string;
    artifact_sha256: string;
    provenance_sha256: string;
    inputs_sha256: string;
    inputs_manifest: "tools/native-kv/inputs.json";
  };
}

export interface PreparedBunReaderV1 {
  kind: "bun";
  binding: BunFrozenReaderBindingV1;
  manifest: ReleaseManifest;
  bootstrapDigest: string;
  preflightDigest: string;
}

export const BUN_LINUX_ARM64_PIN = Object.freeze({
  version: "1.4.0",
  platform: "linux",
  arch: "arm64",
  url:
    "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-aarch64.zip",
  member: "bun-linux-aarch64/bun",
  archiveBytes: 36641863,
  archiveSha256:
    "4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e",
  binaryBytes: 80600240,
  binarySha256:
    "086c4121c8738a8e0f5ed730e8a461bc3973b4444e372ddb77aef9a747fa2ae9",
});
const DIGEST = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const GENERATED = new Set([
  "node_modules",
  ".uos-permissions",
  ".native",
  ".uos-release.json",
]);
const BUNFIG =
  '[install]\nexact = true\n\n[install.scopes]\n"@jsr" = "https://npm.jsr.io"\n\n[install.cache]\ndir = ".bun-cache"\n';

function fail(): never {
  throw new TypeError("frozen Bun reader integrity or platform mismatch");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail();
  }
  return value as Record<string, unknown>;
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function physical(path: string, directory = false): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    fail();
  }
  const info = await Deno.lstat(path);
  if (
    info.isSymlink || (directory ? !info.isDirectory : !info.isFile) ||
    await Deno.realPath(path) !== path
  ) fail();
  return path;
}

async function fileDigest(path: string): Promise<string> {
  return digest(await Deno.readFile(await physical(path)));
}

/** Exact gateway ops/io.ts format: sorted paths, modes, links and file digests. */
export async function gatewayReleaseTreeDigest(
  root: string,
  excluded: ReadonlySet<string> = new Set(),
  ignoredDirectoryRecords: ReadonlySet<string> = new Set(),
): Promise<string> {
  await physical(root, true);
  const entries: string[] = [];
  const walk = async (path: string): Promise<void> => {
    const names: string[] = [];
    for await (const entry of Deno.readDir(`${root}/${path}`)) {
      names.push(entry.name);
    }
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const local = path ? `${path}/${name}` : name;
      if (excluded.has(local)) continue;
      const absolute = `${root}/${local}`;
      const info = await Deno.lstat(absolute);
      if (info.mode === null) fail();
      const mode = info.mode & 0o777;
      if (info.isSymlink) {
        const target = await Deno.readLink(absolute);
        const resolved = await Deno.realPath(absolute);
        if (
          isAbsolute(target) || !resolved.startsWith(`${root}/`) ||
          dirname(absolute) === resolved ||
          dirname(absolute).startsWith(`${resolved}/`)
        ) fail();
        const targetInfo = await Deno.lstat(resolved);
        if (!targetInfo.isFile && !targetInfo.isDirectory) fail();
        entries.push(JSON.stringify([local, "link", mode, target]));
      } else if (info.isFile) {
        entries.push(
          JSON.stringify([
            local,
            "file",
            mode,
            digest(await Deno.readFile(absolute)),
          ]),
        );
      } else if (info.isDirectory) {
        if (!ignoredDirectoryRecords.has(local)) {
          entries.push(JSON.stringify([local, "directory", mode]));
        }
        await walk(local);
      } else fail();
    }
  };
  await walk("");
  return digest(entries.join("\n"));
}

function parseManifest(value: unknown, sourceSha: string): ReleaseManifest {
  const m = record(value);
  if (
    m.schema !== 3 || m.git_sha !== sourceSha || m.platform !== "linux" ||
    m.architecture !== "arm64" ||
    ![
      m.source_archive_sha256,
      m.source_tree_sha256,
      m.dependency_lock_sha256,
      m.dependency_tree_sha256,
      m.permissions_tree_sha256,
    ].every((v) => typeof v === "string" && DIGEST.test(v)) ||
    JSON.stringify(m.runtime) !== JSON.stringify(BUN_LINUX_ARM64_PIN)
  ) fail();
  const n = record(m.native_kv);
  if (
    Object.keys(n).sort().join(",") !==
      "artifact_sha256,inputs_manifest,inputs_sha256,provenance_sha256,tree_sha256" ||
    n.inputs_manifest !== "tools/native-kv/inputs.json" ||
    ![n.tree_sha256, n.artifact_sha256, n.provenance_sha256, n.inputs_sha256]
      .every((v) => typeof v === "string" && DIGEST.test(v))
  ) fail();
  return m as unknown as ReleaseManifest;
}

/** Authenticate every immutable input before creating any private snapshot files. */
export async function prepareBunFrozenReader(
  supplied: BunFrozenReaderBindingV1,
): Promise<PreparedBunReaderV1> {
  const binding = structuredClone(supplied);
  if (
    Deno.build.os !== "linux" || Deno.build.arch !== "aarch64" ||
    binding.kind !== "bun" || !SHA.test(binding.sourceSha) ||
    !Number.isSafeInteger(binding.artifact.id) || binding.artifact.id < 1 ||
    !DIGEST.test(binding.artifact.digest) ||
    !DIGEST.test(binding.artifact.manifestDigest) ||
    binding.runtime.version !== BUN_LINUX_ARM64_PIN.version ||
    binding.runtime.archiveDigest !== BUN_LINUX_ARM64_PIN.archiveSha256 ||
    binding.runtime.binaryDigest !== BUN_LINUX_ARM64_PIN.binarySha256
  ) fail();
  const root = await physical(binding.artifact.root, true);
  try {
    await Deno.lstat(`${root}/.bunfig.toml`);
    fail();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (
    await fileDigest(binding.artifact.archivePath) !==
      binding.artifact.digest ||
    (await Deno.lstat(await physical(binding.runtime.path))).size !==
      BUN_LINUX_ARM64_PIN.binaryBytes ||
    await fileDigest(binding.runtime.path) !== binding.runtime.binaryDigest
  ) fail();
  const manifestBytes = await Deno.readFile(
    await physical(`${root}/.uos-release.json`),
  );
  if (
    manifestBytes.byteLength > 16_384 ||
    digest(manifestBytes) !== binding.artifact.manifestDigest
  ) fail();
  const manifest = parseManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
    binding.sourceSha,
  );
  if (
    await gatewayReleaseTreeDigest(root, GENERATED) !==
      manifest.source_tree_sha256 ||
    await fileDigest(`${root}/bun.lock`) !== manifest.dependency_lock_sha256 ||
    await gatewayReleaseTreeDigest(`${root}/node_modules`) !==
      manifest.dependency_tree_sha256 ||
    await gatewayReleaseTreeDigest(`${root}/.uos-permissions`) !==
      manifest.permissions_tree_sha256 ||
    await gatewayReleaseTreeDigest(`${root}/.native`) !==
      manifest.native_kv.tree_sha256 ||
    await fileDigest(`${root}/.native/kv/native-kv.node`) !==
      manifest.native_kv.artifact_sha256 ||
    await fileDigest(`${root}/.native/kv/native-kv.provenance.json`) !==
      manifest.native_kv.provenance_sha256 ||
    await fileDigest(`${root}/${manifest.native_kv.inputs_manifest}`) !==
      manifest.native_kv.inputs_sha256 ||
    await Deno.readTextFile(await physical(`${root}/bunfig.toml`)) !== BUNFIG
  ) fail();
  const permissions = record(
    JSON.parse(
      await Deno.readTextFile(
        await physical(`${root}/.uos-permissions/manifest.json`),
      ),
    ),
  );
  if (
    permissions.path !== "linux-arm64.node" ||
    permissions.architecture !== "arm64" ||
    typeof permissions.sha256 !== "string" ||
    !DIGEST.test(permissions.sha256) ||
    await fileDigest(`${root}/.uos-permissions/linux-arm64.node`) !==
      permissions.sha256
  ) fail();
  await physical(`${root}/src/runtime/permissions-linux.ts`);
  return {
    kind: "bun",
    binding,
    manifest,
    bootstrapDigest: digest(BUN_READER_BOOTSTRAP),
    preflightDigest: digest(BUN_READER_PREFLIGHT),
  };
}

/** Two calls make independent exact-source copies; generated graph stays read-only mounted. */
export async function materializeBunReaderSnapshot(
  reader: PreparedBunReaderV1,
  destination: string,
): Promise<void> {
  const root = reader.binding.artifact.root;
  const copy = async (
    source: string,
    target: string,
    top = false,
  ): Promise<void> => {
    const info = await Deno.lstat(source);
    if (info.isSymlink) {
      await Deno.symlink(await Deno.readLink(source), target);
    } else if (info.isDirectory) {
      await Deno.mkdir(target, { mode: info.mode! & 0o777 });
      for await (const entry of Deno.readDir(source)) {
        if (top && GENERATED.has(entry.name)) continue;
        await copy(`${source}/${entry.name}`, `${target}/${entry.name}`);
      }
      await Deno.chmod(target, info.mode! & 0o777);
    } else if (info.isFile) {
      await Deno.copyFile(source, target);
      await Deno.chmod(target, info.mode! & 0o777);
    } else fail();
  };
  await copy(root, destination, true);
  if (
    await gatewayReleaseTreeDigest(destination) !==
      reader.manifest.source_tree_sha256
  ) fail();
  for (const name of ["node_modules", ".uos-permissions", ".native"]) {
    await Deno.mkdir(`${destination}/${name}`);
  }
  await Deno.writeTextFile(
    `${destination}/${BUN_READER_BOOTSTRAP_PATH}`,
    BUN_READER_BOOTSTRAP,
    { createNew: true, mode: 0o400 },
  );
  await Deno.writeTextFile(
    `${destination}/${BUN_READER_PREFLIGHT_PATH}`,
    BUN_READER_PREFLIGHT,
    { createNew: true, mode: 0o400 },
  );
}

/** Recheck the fixed bootstrap without treating intentional fixture additions as source tamper. */
export async function verifyBunReaderBootstrap(
  snapshot: string,
  reader: PreparedBunReaderV1,
  preflight = false,
): Promise<void> {
  const path = preflight
    ? BUN_READER_PREFLIGHT_PATH
    : BUN_READER_BOOTSTRAP_PATH;
  if (
    await fileDigest(`${snapshot}/${path}`) !==
      (preflight ? reader.preflightDigest : reader.bootstrapDigest)
  ) fail();
  // The helper executes before confinement. Authenticate its entire frozen source
  // graph and startup configuration on the actual snapshot, not just on the seed.
  for (const name of ["node_modules", ".uos-permissions", ".native"]) {
    await physical(`${snapshot}/${name}`, true);
  }
  try {
    await Deno.lstat(`${snapshot}/.bunfig.toml`);
    fail();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await physical(`${snapshot}/src/runtime/permissions-linux.ts`);
  const excluded = new Set([
    ...GENERATED,
    BUN_READER_BOOTSTRAP_PATH,
    BUN_READER_PREFLIGHT_PATH,
  ]);
  const ignoredDirectories = new Set<string>();
  const added = [".env"];
  try {
    const metadataPath = await physical(
      `${snapshot}/${SENTINEL_REPLAY_INPUT_PATH}`,
    );
    if (
      (await Deno.lstat(metadataPath)).size > MAX_SENTINEL_REPLAY_INPUT_BYTES
    ) fail();
    const bytes = await Deno.readFile(metadataPath);
    const value = record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      Object.keys(value).sort().join(",") !==
        "requestPath,testIds,upstreamPath,version" ||
      value.version !== "v1" ||
      typeof value.requestPath !== "string" ||
      !/^tests\/fixtures\/gateway-replay\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/request\.json$/
        .test(value.requestPath) ||
      value.upstreamPath !==
        value.requestPath.replace(/request\.json$/, "upstream.json") ||
      !Array.isArray(value.testIds)
    ) fail();
    const canonical = buildSentinelReplayInputMetadata(
      value.requestPath,
      value.upstreamPath as string,
      value.testIds as string[],
    );
    if (canonical === null || !bytesEqual(canonical, bytes)) fail();
    await physical(`${snapshot}/${value.requestPath}`);
    await physical(`${snapshot}/${value.upstreamPath}`);
    added.push(
      SENTINEL_REPLAY_INPUT_PATH,
      value.requestPath,
      value.upstreamPath as string,
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    // Only the public preflight is allowed before the dispatcher exists.
    if (!preflight) fail();
  }
  for (const local of added) {
    try {
      await Deno.lstat(`${reader.binding.artifact.root}/${local}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      excluded.add(local);
    }
    const parts = local.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      try {
        await Deno.lstat(`${reader.binding.artifact.root}/${parent}`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await physical(`${snapshot}/${parent}`, true);
        ignoredDirectories.add(parent);
      }
    }
  }
  if (
    await gatewayReleaseTreeDigest(snapshot, excluded, ignoredDirectories) !==
      reader.manifest.source_tree_sha256
  ) fail();
}
