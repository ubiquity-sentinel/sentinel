/** Bounded, regular-file-only graph handling for the trusted self dependency seed. */
import { createHash } from "node:crypto";

export interface DependencyFileV1 {
  path: string;
  size: number;
  sha256: string;
}
export const SELF_ACTION = ".github/actions/sentinel-app-token";
export const SELF_ACTION_FILES = [
  ".gitignore",
  "LICENSE",
  "UPSTREAM.md",
  "action.yml",
  "lib/get-permissions-from-inputs.js",
  "lib/main.js",
  "lib/mint-grant.js",
  "lib/post.js",
  "lib/request.js",
  "main.js",
  "package-lock.json",
  "package.json",
  "post.js",
];
export const MAX_DEPENDENCY_FILES = 2048;
export const MAX_DEPENDENCY_BYTES = 32 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_NODE_BYTES = 256 * 1024 * 1024;
export const DEPENDENCY_REFUSAL = "self checkout dependencies unavailable";
export function refuse(): never {
  throw new Error(DEPENDENCY_REFUSAL);
}
export function safeRelative(path: string): boolean {
  return path.length > 0 && path.length <= 512 &&
    path.split("/").length <= 20 &&
    path.split("/").every((part) =>
      /^[a-zA-Z0-9@_.+-]+$/.test(part) && part !== "." && part !== ".." &&
      ![".env", ".npmrc", ".git", "auth.json", "credentials"].includes(part)
    );
}
/** Check every ancestor: a real final directory is insufficient if a parent is a link. */
export async function realDirectory(path: string): Promise<void> {
  if (!path.startsWith("/") || path.includes("//") || path.endsWith("/")) {
    refuse();
  }
  if (path.split("/").some((part) => part === "." || part === "..")) refuse();
  // Canonical equality rejects links in any ancestor without requesting read
  // grants on unrelated ancestor directories outside the task's own tree.
  if (await Deno.realPath(path) !== path) refuse();
  const stat = await Deno.lstat(path);
  if (!stat.isDirectory || stat.isSymlink) refuse();
}
export async function fileDigest(
  path: string,
  maximum = MAX_FILE_BYTES,
): Promise<{
  size: number;
  sha256: string;
}> {
  await realDirectory(path.slice(0, path.lastIndexOf("/")));
  const before = await Deno.lstat(path);
  if (
    !before.isFile || before.isSymlink || before.nlink !== 1 ||
    before.size > maximum
  ) refuse();
  const file = await Deno.open(path, { read: true });
  const hash = createHash("sha256");
  let size = 0;
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) refuse();
    const buffer = new Uint8Array(64 * 1024);
    for (;;) {
      const length = await file.read(buffer);
      if (length === null) break;
      size += length;
      if (size > maximum) refuse();
      hash.update(buffer.subarray(0, length));
    }
    const after = await Deno.lstat(path);
    if (
      after.dev !== before.dev || after.ino !== before.ino ||
      after.nlink !== 1 ||
      after.size !== before.size || size !== before.size || after.isSymlink
    ) refuse();
  } finally {
    file.close();
  }
  return { size, sha256: hash.digest("hex") };
}
export function textDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export async function sourceFiles(root: string): Promise<DependencyFileV1[]> {
  const files: DependencyFileV1[] = [];
  for (const path of SELF_ACTION_FILES) {
    files.push({ path, ...await fileDigest(`${root}/${SELF_ACTION}/${path}`) });
  }
  return files;
}
export async function dependencyFiles(
  root: string,
): Promise<DependencyFileV1[]> {
  await realDirectory(root);
  const files: DependencyFileV1[] = [];
  let entries = 0;
  let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    for await (
      const item of Deno.readDir(`${root}${relative ? `/${relative}` : ""}`)
    ) {
      if (++entries > MAX_DEPENDENCY_FILES * 2) refuse();
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (!safeRelative(path) || item.isSymlink) refuse();
      if (item.isDirectory) await visit(path);
      else if (item.isFile) {
        const entry = { path, ...await fileDigest(`${root}/${path}`) };
        bytes += entry.size;
        if (
          files.length >= MAX_DEPENDENCY_FILES || bytes > MAX_DEPENDENCY_BYTES
        ) refuse();
        files.push(entry);
      } else refuse();
    }
  };
  await visit("");
  if (files.length === 0) refuse();
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function sameGraph(
  a: DependencyFileV1[],
  b: DependencyFileV1[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Never overwrite an existing dependency tree; re-use requires exact verification. */
export async function copyDependencies(input: {
  source: string;
  action: string;
  files: DependencyFileV1[];
}): Promise<void> {
  await realDirectory(input.action);
  const destination = `${input.action}/node_modules`;
  try {
    await Deno.lstat(destination);
    if (!sameGraph(await dependencyFiles(destination), input.files)) refuse();
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const stage = await Deno.makeTempDir({
    dir: input.action,
    prefix: ".sentinel-dependencies-",
  });
  try {
    for (const expected of input.files) {
      const source = `${input.source}/${expected.path}`;
      if (
        JSON.stringify(await fileDigest(source)) !==
          JSON.stringify({ size: expected.size, sha256: expected.sha256 })
      ) refuse();
      const target = `${stage}/${expected.path}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
        mode: 0o700,
      });
      // Only verified regular source bytes cross; no metadata, links, or configuration.
      const file = await Deno.open(source, { read: true });
      const buffer = new Uint8Array(expected.size + 1);
      let length = 0;
      try {
        for (;;) {
          const read = await file.read(buffer.subarray(length));
          if (read === null) break;
          length += read;
          if (length > expected.size) refuse();
        }
      } finally {
        file.close();
      }
      const bytes = buffer.subarray(0, length);
      if (
        bytes.length !== expected.size ||
        createHash("sha256").update(bytes).digest("hex") !== expected.sha256
      ) refuse();
      await Deno.writeFile(target, bytes, { createNew: true, mode: 0o600 });
    }
    if (!sameGraph(await dependencyFiles(stage), input.files)) refuse();
    await realDirectory(input.action);
    let absent = false;
    try {
      await Deno.lstat(destination);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) absent = true;
      else throw error;
    }
    if (!absent) refuse();
    await Deno.rename(stage, destination);
    if (!sameGraph(await dependencyFiles(destination), input.files)) refuse();
  } finally {
    await Deno.remove(stage, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}
