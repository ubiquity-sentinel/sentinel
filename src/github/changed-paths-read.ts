/**
 * The change-set reader behind the 2026-11-17 gates (the CI rule and the
 * merge executors' never-merge verdict): the local mirror's own tree diff
 * first (`git diff --no-renames --name-only -z base head` through the port's
 * executor: raw, never truncated, no API read), as for every head Sentinel
 * published or fetched in this run's full clone; only a head the mirror
 * lacks pays one exact `base...head` comparison, whose file list GitHub caps
 * at `COMPARE_FILES_MAX` (a list that long is not whole: null).
 */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import { expectArray, expectRecord, fail } from "../contracts/validation.ts";

/** Files one comparison lists at most; a full list may be truncated. */
export const COMPARE_FILES_MAX = 300;

/**
 * The paths one comparison body lists (a rename's previous path included);
 * null when GitHub may not have listed every file. Malformed: throws.
 */
export function comparedPaths(value: unknown): string[] | null {
  const files = expectRecord(value, "$").files;
  if (files === undefined) return [];
  const paths = expectArray(files, "$.files", COMPARE_FILES_MAX, (item, at) => {
    const file = expectRecord(item, at);
    const named = [file.filename, file.previous_filename].filter((name) =>
      name !== undefined && name !== null
    );
    for (const name of named) {
      if (typeof name !== "string" || name.length === 0) {
        fail(`${at}.filename`, "wrong_type", "expected a file path");
      }
    }
    return named as string[];
  });
  return paths.length >= COMPARE_FILES_MAX ? null : paths.flat();
}

/** The local diff when it reads, else the comparison. */
export async function localFirstChangedPaths(
  local:
    | ((base: GitSha, head: GitSha) => Promise<PortResultV1<string[]>>)
    | undefined,
  compare: (base: GitSha, head: GitSha) => Promise<
    PortResultV1<string[] | null>
  >,
  base: GitSha,
  head: GitSha,
): Promise<PortResultV1<string[] | null>> {
  if (!isGitSha(base) || !isGitSha(head)) {
    return portError("invalid", "commit SHA is invalid");
  }
  try {
    const read = await local?.(base, head);
    if (read !== undefined && read.ok) return portOk(read.value);
  } catch {
    // An unreadable mirror proves nothing; the comparison decides.
  }
  return await compare(base, head);
}
