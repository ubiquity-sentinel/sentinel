import type { ReplayFixtureEntryV1 } from "./fixture.ts";

/**
 * Materialize the trusted bundle at its fixed safe paths, plus the optional
 * gateway dispatch metadata OUTSIDE the digested bundle.
 *
 * ALL destinations (dispatch metadata and every bundle entry) are
 * preflighted BEFORE anything is written; missing entries are written only.
 * A safe existing target is accepted ONLY when its bytes are
 * byte-identical to the trusted attested bytes — an actual candidate that
 * already contains the permanent regression, the recorded fixture and the
 * fixed dispatch metadata must replay without rewriting them. Different
 * bytes, directories, symlinks and unsafe (symlink/non-directory)
 * ancestors are rejected before any target command runs and before any
 * other destination is written.
 */
export async function materializeBundle(
  checkoutDir: string,
  entries: readonly ReplayFixtureEntryV1[],
  dispatchEntry: ReplayFixtureEntryV1 | null = null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const sorted = [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  // The dispatch metadata is planned first but never enters the bundle
  // digest, the scope/protected-path checks or the request fixture digest.
  const planned = dispatchEntry === null ? sorted : [dispatchEntry, ...sorted];
  const missing: string[] = [];
  for (const entry of planned) {
    const conflict = await bundleTargetConflict(
      checkoutDir,
      entry.path,
      entry.bytes,
    );
    if (conflict !== null) return { ok: false, reason: conflict };
    if (!(await targetExists(`${checkoutDir}/${entry.path}`))) {
      missing.push(entry.path);
    }
  }
  // Materialize ONLY the missing safe entries; already-present entries are
  // byte-identical (verified above) and are deliberately NOT rewritten.
  // Every missing destination is created EXCLUSIVELY (createNew): a raced
  // symlink or foreign file makes the create fail instead of being
  // followed or overwritten.
  for (const entry of planned) {
    if (!missing.includes(entry.path)) continue;
    const target = `${checkoutDir}/${entry.path}`;
    const parent = target.slice(0, target.lastIndexOf("/"));
    await Deno.mkdir(parent, { recursive: true });
    await Deno.writeFile(target, entry.bytes, { createNew: true });
  }
  return { ok: true };
}

async function bundleTargetConflict(
  checkoutRoot: string,
  relativePath: string,
  expectedBytes: Uint8Array,
): Promise<string | null> {
  const segments = relativePath.split("/");
  let current = checkoutRoot;
  for (let i = 0; i < segments.length; i++) {
    const candidate = `${current}/${segments[i]}`;
    let info: Deno.FileInfo | null = null;
    try {
      info = await Deno.lstat(candidate);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      return `could not inspect bundle target path: ${relativePath}`;
    }
    if (info.isSymlink) {
      return `bundle target resolves through a symlink: ${relativePath}`;
    }
    if (i === segments.length - 1) {
      if (info.isFile) {
        const existing = await Deno.readFile(candidate);
        if (!bytesEqual(existing, expectedBytes)) {
          return `bundle target exists with different bytes and will not be ` +
            `rewritten: ${relativePath}`;
        }
        return null;
      }
      if (info.isDirectory) {
        return `bundle target is a directory: ${relativePath}`;
      }
      return `bundle target is not a regular file: ${relativePath}`;
    }
    if (!info.isDirectory) {
      return `bundle target path component is not a directory: ${relativePath}`;
    }
    current = candidate;
  }
  return null;
}

async function targetExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
