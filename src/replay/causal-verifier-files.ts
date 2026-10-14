import type { ReplayFixtureEntryV1 } from "./fixture.ts";
import { bytesEqual } from "./causal-verifier-protocol.ts";

/**
 * Whole-snapshot preflight over ALL planned destinations BEFORE any write:
 * every component of every path is lstat-checked — a symlink anywhere
 * (ancestor or final component), a non-directory ancestor, a directory or any
 * other non-regular final component rejects the snapshot — and an existing
 * regular final file is accepted ONLY when its bytes are IDENTICAL to the
 * exact planned bytes (external fixture/input collision, including the
 * dispatch metadata). Nothing is placed by this function, and every planned
 * destination is checked even when an earlier one is clean.
 */
export async function preflightDestinations(
  checkoutRoot: string,
  planned: readonly ReplayFixtureEntryV1[],
): Promise<boolean> {
  for (const item of planned) {
    if (!(await canPlacePath(checkoutRoot, item.path, item.bytes))) {
      return false;
    }
  }
  return true;
}

export async function canPlacePath(
  checkoutRoot: string,
  relativePath: string,
  expectedBytes: Uint8Array,
): Promise<boolean> {
  const segments = relativePath.split("/");
  let current = checkoutRoot;
  for (let i = 0; i < segments.length; i += 1) {
    const candidate = `${current}/${segments[i]}`;
    let info: Deno.FileInfo | null = null;
    try {
      info = await Deno.lstat(candidate);
    } catch (error) {
      // The chain from here on is absent: the destination can be created
      // fresh (no symlink is followed, the write is exclusive).
      if (error instanceof Deno.errors.NotFound) return true;
      return false;
    }
    if (info.isSymlink) return false;
    if (i === segments.length - 1) {
      // The final component must be missing (exclusive create) or an
      // already-regular file whose bytes are IDENTICAL (accepted untouched).
      // Directories, other non-regular entries and foreign bytes reject.
      if (!info.isFile) return false;
      let existing: Uint8Array;
      try {
        existing = await Deno.readFile(candidate);
      } catch {
        return false;
      }
      return bytesEqual(existing, expectedBytes);
    }
    if (!info.isDirectory) return false;
    current = candidate;
  }
  return true;
}

/** True when the trusted consumer exists at the path as a regular file. */
export async function regularFileAt(
  checkoutRoot: string,
  relativePath: string,
): Promise<boolean> {
  const segments = relativePath.split("/");
  let current = checkoutRoot;
  for (let i = 0; i < segments.length; i += 1) {
    const candidate = `${current}/${segments[i]}`;
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(candidate);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      return false;
    }
    if (info.isSymlink) return false;
    if (i === segments.length - 1) return info.isFile;
    if (!info.isDirectory) return false;
    current = candidate;
  }
  return false;
}

/**
 * Place one input without ever following a symlink: an existing final
 * component must be a regular file whose bytes are IDENTICAL (never
 * rewritten); a missing final component is created EXCLUSIVELY (createNew —
 * a raced symlink makes the create fail rather than be followed).
 */
export async function writeInput(
  checkoutRoot: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = `${checkoutRoot}/${relativePath}`;
  let info: Deno.FileInfo | null = null;
  try {
    info = await Deno.lstat(target);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // Absent: exclusive create below.
    } else {
      throw error;
    }
  }
  if (info !== null) {
    if (info.isSymlink || !info.isFile) {
      throw new Error("verifier input target is not a regular file");
    }
    const existing = await Deno.readFile(target);
    if (!bytesEqual(existing, bytes)) {
      throw new Error("verifier input target already exists with other bytes");
    }
    return;
  }
  const parent = target.slice(0, target.lastIndexOf("/"));
  await Deno.mkdir(parent, { recursive: true });
  await Deno.writeFile(target, bytes, { createNew: true });
}

/** Remove the restricted task directory and VERIFY the removal; false means
 * the private original cannot be proved gone (never claim otherwise). */
export async function removeVerified(taskDir: string): Promise<boolean> {
  try {
    await Deno.remove(taskDir, { recursive: true });
  } catch {
    return false;
  }
  try {
    await Deno.lstat(taskDir);
    return false;
  } catch (error) {
    return error instanceof Deno.errors.NotFound;
  }
}

/** Regular-file stat (no symlink follow); null when absent or non-regular. */
export async function statRegular(path: string): Promise<Deno.FileInfo | null> {
  try {
    const info = await Deno.lstat(path);
    return info.isFile && !info.isSymlink ? info : null;
  } catch {
    return null;
  }
}
