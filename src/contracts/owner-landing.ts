/**
 * OwnerLandingV1: a published candidate that changes a protected path of its
 * target. Sentinel publishes, tests and reviews it like any candidate but
 * never merges it; the repository owner merges it, and that human merge
 * completes the record through the ordinary human-merge path.
 *
 * Additive and optional on `WorkRecordV1`: absent on every record written
 * before it existed and never defaulted, so legacy bytes round-trip exactly.
 * `paths` are the trusted configured protected prefixes the candidate
 * touches (sorted, unique); `since` is when the flag was first written.
 */
import {
  expectExactKeys,
  expectRecord,
  expectStringArray,
  expectTimestamp,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";

export interface OwnerLandingV1 {
  paths: string[];
  since: number;
}

const OWNER_LANDING_KEYS = ["paths", "since"] as const;

export function parseOwnerLandingV1(
  input: unknown,
  path: string,
): OwnerLandingV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, OWNER_LANDING_KEYS, path);
  const paths = expectStringArray(
    obj.paths,
    `${path}.paths`,
    MaxItems.protectedPaths,
    MaxText.path,
  );
  if (paths.length === 0) {
    fail(`${path}.paths`, "invalid_lifecycle", "owner landing names no path");
  }
  for (let i = 1; i < paths.length; i++) {
    if (!(paths[i - 1]! < paths[i]!)) {
      fail(`${path}.paths`, "invalid_lifecycle", "paths must be sorted unique");
    }
  }
  return { paths, since: expectTimestamp(obj.since, `${path}.since`) };
}
