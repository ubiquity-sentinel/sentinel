/** Synthetic delivery-train fixtures (no real repository data). */
import {
  asGitSha,
  asWorkItemId,
  type GitSha,
} from "../../src/contracts/brands.ts";
import {
  type DeliveryTrainManifestV1,
  deliveryTrainManifestV1,
  type DeliveryTrainMemberV1,
} from "../../src/contracts/delivery-train.ts";
import type { TrainTreeChangeV1 } from "../../src/repair/train-overlay.ts";

export const REPOSITORY = { owner: "example-org", name: "example.app" };
export const BRANCH = "main";

/** A deterministic 40-hex object id. */
export function sha(n: number): GitSha {
  return asGitSha(n.toString(16).padStart(40, "a"));
}

export const BASE = sha(1);
export const REVIEWED_BASE = sha(2);

export function member(
  pr: number,
  overrides: Partial<DeliveryTrainMemberV1> = {},
): DeliveryTrainMemberV1 {
  return {
    recordId: asWorkItemId(`issue:example-org:example.app:${pr + 100}`),
    pr,
    head: sha(10_000 + pr),
    reviewedBase: REVIEWED_BASE,
    receiptId: `review-receipt:${pr.toString(16).padStart(64, "0")}`,
    issueNumber: pr + 100,
    ...overrides,
  };
}

export function manifest(
  prs: readonly number[],
  base: GitSha = BASE,
): DeliveryTrainManifestV1 {
  return deliveryTrainManifestV1({
    repository: REPOSITORY,
    branch: BRANCH,
    base,
    members: prs.map((pr) => member(pr)),
  });
}

/** One changed path: `[mode, blob]` per side, or null for absent. */
export function change(
  path: string,
  before: readonly [string, number] | null,
  after: readonly [string, number] | null,
): TrainTreeChangeV1 {
  return {
    path,
    oldMode: before?.[0] ?? null,
    oldSha: before === null ? null : sha(before[1]),
    newMode: after?.[0] ?? null,
    newSha: after === null ? null : sha(after[1]),
  };
}

export function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** A deterministic permutation (reverse, then interleave halves). */
export function shuffle<T>(items: readonly T[]): T[] {
  const reversed = [...items].reverse();
  const half = Math.ceil(reversed.length / 2);
  const out: T[] = [];
  for (let i = 0; i < half; i++) {
    out.push(reversed[i]);
    if (i + half < reversed.length) out.push(reversed[i + half]);
  }
  return out;
}
