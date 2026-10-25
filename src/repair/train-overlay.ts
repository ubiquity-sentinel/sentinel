/**
 * Delivery-train overlay proof (redesign 2026-10-25 C12, WP3.2). Pure and
 * deterministic; the launcher (build, landing) and the runtime (handoff)
 * must reach the same disposition from the same facts, so both call this.
 *
 * Each member's reviewed patch R_m is its exact merge-base tree change list
 * (`mergeBaseTreeChanges(B0_m, H_m)`, the launcher's carried-patch proof in
 * `ops/hosted-autonomy-github-trees.ts`): (path, oldMode, oldBlob, newMode,
 * newBlob) tuples with full ids and no rename detection. Members are taken
 * in train order (pr, recordId); input list order never matters.
 */
import {
  type HostedTreeChangeV1,
  sameTreeChanges,
} from "../../ops/hosted-autonomy-github-trees.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  compareDeliveryTrainMembersV1,
  DELIVERY_TRAIN_MAX_MEMBERS,
  type DeliveryTrainManifestV1,
  type DeliveryTrainMemberV1,
  hasDeliveryTrainParentsV1,
  parseDeliveryTrainMemberV1,
} from "../contracts/delivery-train.ts";
import { tryParse } from "../contracts/validation.ts";
import { touchesProtected } from "./loop-records.ts";

/** One changed path of a reviewed patch (null: absent on that side). */
export type TrainTreeChangeV1 = HostedTreeChangeV1;
/** A file, symlink or submodule entry of a tree. */
export interface TrainTreeEntryV1 {
  readonly mode: string;
  readonly sha: string;
}

/** Read access to the tip T's tree; `undefined` means "not known". */
export interface TrainBaseTreeV1 {
  /** T's non-directory entry at exactly `path`, null when it has none. */
  entry(path: string): TrainTreeEntryV1 | null | undefined;
  /** Every non-directory path T holds strictly under directory `dir`. */
  pathsUnder(dir: string): readonly string[] | undefined;
}

export type TrainOverlayDispositionV1 =
  | "included"
  | "ejected:drift"
  | "ejected:protected"
  | "ejected:submodule"
  | "deferred:overlap"
  | "deferred:facts"
  | "deferred:capacity";

export interface TrainOverlayCandidateV1 {
  readonly member: DeliveryTrainMemberV1;
  /** R_m; null when it could not be read whole. */
  readonly changes: readonly TrainTreeChangeV1[] | null;
}

export interface TrainOverlayResultV1 {
  readonly member: DeliveryTrainMemberV1;
  readonly disposition: TrainOverlayDispositionV1;
  /** The first offending path (drift, protected, submodule, overlap). */
  readonly path: string | null;
  /** deferred:overlap: the earlier included member claiming `path`. */
  readonly overlapsPr: number | null;
}

export interface TrainOverlayV1 {
  readonly base: GitSha;
  /** Included members, in train order. */
  readonly members: readonly DeliveryTrainMemberV1[];
  /** The union of the included members' R_m, ordered by path. */
  readonly changes: readonly TrainTreeChangeV1[];
  /** One result per candidate, in train order. */
  readonly results: readonly TrainOverlayResultV1[];
}

const MODES = new Set(["100644", "100755", "120000", "160000"]);
const SUBMODULE = "160000";
const OBJECT_ID = /^[0-9a-f]{40}$/;

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Proper parent directories of a path, outermost first. */
function parentDirs(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function validPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 4096 &&
    !path.includes("\0") &&
    path.split("/").every((part) =>
      part.length > 0 && part !== "." && part !== ".."
    );
}

function validSide(mode: unknown, sha: unknown): boolean {
  if (mode === null || sha === null) return mode === null && sha === null;
  return typeof mode === "string" && MODES.has(mode) &&
    typeof sha === "string" && OBJECT_ID.test(sha);
}

/**
 * A well-formed patch: valid paths strictly ordered, every tuple a real
 * change, and no added path under another added path.
 */
export function wellFormedTrainChangesV1(
  changes: readonly TrainTreeChangeV1[],
): boolean {
  const added = new Set<string>();
  for (const [index, change] of changes.entries()) {
    if (
      !validPath(change.path) || !validSide(change.oldMode, change.oldSha) ||
      !validSide(change.newMode, change.newSha) ||
      (change.oldMode === null && change.newMode === null) ||
      (change.oldMode === change.newMode && change.oldSha === change.newSha)
    ) return false;
    if (index > 0 && byPath(changes[index - 1].path, change.path) >= 0) {
      return false;
    }
    if (change.newMode !== null) added.add(change.path);
  }
  return [...added].every((path) =>
    parentDirs(path).every((dir) => !added.has(dir))
  );
}

/** A {@link TrainBaseTreeV1} over a whole recursive tree read. */
export function trainBaseTreeFromEntries(
  entries: ReadonlyMap<string, TrainTreeEntryV1>,
): TrainBaseTreeV1 {
  const sorted = [...entries.keys()].sort(byPath);
  return {
    entry: (path) => entries.get(path) ?? null,
    pathsUnder: (dir) => {
      const prefix = `${dir}/`;
      let low = 0;
      let high = sorted.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (sorted[mid] < prefix) low = mid + 1;
        else high = mid;
      }
      const under: string[] = [];
      for (
        let i = low;
        i < sorted.length && sorted[i].startsWith(prefix);
        i++
      ) {
        under.push(sorted[i]);
      }
      return under;
    },
  };
}

type Verdict = { path: string } | "unknown" | null;

/**
 * Drift of one patch against T: an old side that is not T's entry, or a
 * result that is not a tree (a T file over an added path, or surviving T
 * files under an added file). "unknown" when T's facts are missing.
 */
export function trainMemberDriftV1(
  base: TrainBaseTreeV1,
  changes: readonly TrainTreeChangeV1[],
): Verdict {
  const deleted = new Set(
    changes.filter((change) => change.newMode === null).map((c) => c.path),
  );
  let unknown = false;
  for (const change of changes) {
    const entry = base.entry(change.path);
    if (entry === undefined) {
      unknown = true;
      continue;
    }
    if (
      (entry?.mode ?? null) !== change.oldMode ||
      (entry?.sha ?? null) !== change.oldSha
    ) return { path: change.path };
  }
  for (const change of changes) {
    if (change.newMode === null) continue;
    for (const dir of parentDirs(change.path)) {
      const entry = base.entry(dir);
      if (entry === undefined) unknown = true;
      else if (entry !== null && !deleted.has(dir)) return { path: dir };
    }
    const under = base.pathsUnder(change.path);
    if (under === undefined) unknown = true;
    else if (under.some((path) => !deleted.has(path))) {
      return { path: change.path };
    }
  }
  return unknown ? "unknown" : null;
}

class Claims {
  readonly #paths = new Map<string, number>();
  readonly #dirs = new Map<string, number>();

  /** The earlier claim a path collides with (same path or a dir prefix). */
  conflict(path: string): number | null {
    const exact = this.#paths.get(path) ?? this.#dirs.get(path);
    if (exact !== undefined) return exact;
    for (const dir of parentDirs(path)) {
      const owner = this.#paths.get(dir);
      if (owner !== undefined) return owner;
    }
    return null;
  }

  claim(path: string, pr: number): void {
    this.#paths.set(path, pr);
    for (const dir of parentDirs(path)) {
      if (!this.#dirs.has(dir)) this.#dirs.set(dir, pr);
    }
  }
}

function result(
  member: DeliveryTrainMemberV1,
  disposition: TrainOverlayDispositionV1,
  path: string | null = null,
  overlapsPr: number | null = null,
): TrainOverlayResultV1 {
  return { member, disposition, path, overlapsPr };
}

/** Final order tie-break among malformed duplicates; never throws. */
function memberKey(member: DeliveryTrainMemberV1): string {
  try {
    return canonicalStringify(member);
  } catch {
    return "";
  }
}

/** Candidates whose identity collides with another candidate's. */
function duplicates(
  candidates: readonly TrainOverlayCandidateV1[],
  base: GitSha,
): Set<TrainOverlayCandidateV1> {
  const out = new Set<TrainOverlayCandidateV1>();
  const fields = ["pr", "recordId", "head", "issueNumber"] as const;
  for (const field of fields) {
    const seen = new Map<unknown, TrainOverlayCandidateV1[]>();
    for (const candidate of candidates) {
      const key = candidate.member[field];
      seen.set(key, [...(seen.get(key) ?? []), candidate]);
    }
    for (const group of seen.values()) {
      if (group.length > 1) group.forEach((candidate) => out.add(candidate));
    }
  }
  for (const candidate of candidates) {
    if (candidate.member.head === base) out.add(candidate);
  }
  return out;
}

/**
 * The overlay of candidates onto T. In train order, a member is included
 * when its patch is readable and well formed, touches no protected path and
 * no submodule, has not drifted from T, collides with no path an earlier
 * included member claims (same path or a directory prefix either way), and
 * fewer than 63 members are included. `tree` null means T is unreadable.
 */
export function computeTrainOverlayV1(input: {
  readonly base: GitSha;
  readonly tree: TrainBaseTreeV1 | null;
  readonly protectedPaths: readonly string[];
  readonly candidates: readonly TrainOverlayCandidateV1[];
}): TrainOverlayV1 {
  const ordered = [...input.candidates].sort((a, b) =>
    compareDeliveryTrainMembersV1(a.member, b.member) ||
    byPath(memberKey(a.member), memberKey(b.member))
  );
  const colliding = duplicates(ordered, input.base);
  const claims = new Claims();
  const members: DeliveryTrainMemberV1[] = [];
  const changes: TrainTreeChangeV1[] = [];
  const results = ordered.map((candidate): TrainOverlayResultV1 => {
    const { member } = candidate;
    const patch = candidate.changes;
    if (
      colliding.has(candidate) || patch === null ||
      !tryParse(parseDeliveryTrainMemberV1, member).ok ||
      !wellFormedTrainChangesV1(patch) || input.tree === null
    ) return result(member, "deferred:facts");
    const guarded = patch.find((change) =>
      touchesProtected(input.protectedPaths, change.path)
    );
    if (guarded) return result(member, "ejected:protected", guarded.path);
    const submodule = patch.find((change) =>
      change.oldMode === SUBMODULE || change.newMode === SUBMODULE
    );
    if (submodule) return result(member, "ejected:submodule", submodule.path);
    const drift = trainMemberDriftV1(input.tree, patch);
    if (drift === "unknown") return result(member, "deferred:facts");
    if (drift !== null) return result(member, "ejected:drift", drift.path);
    for (const change of patch) {
      const owner = claims.conflict(change.path);
      if (owner !== null) {
        return result(member, "deferred:overlap", change.path, owner);
      }
    }
    if (members.length >= DELIVERY_TRAIN_MAX_MEMBERS) {
      return result(member, "deferred:capacity");
    }
    for (const change of patch) claims.claim(change.path, member.pr);
    members.push(member);
    changes.push(...patch);
    return result(member, "included");
  });
  changes.sort((a, b) => byPath(a.path, b.path));
  return { base: input.base, members, changes, results };
}

export type TrainLandingTreeVerdictV1 =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly reason: "parents" | "members" | "malformed" | "overlap" | "tree";
  };

/**
 * Landing verification of a built train commit C: its parents are exactly
 * `[T, H_1..H_k]`, every member patch is well formed and path-disjoint from
 * the others, and `treeChanges(T, C)` equals the union of the members' R_m
 * exactly, tuple for tuple. `members` holds R_m in manifest member order.
 */
export function verifyTrainLandingTreeV1(input: {
  readonly manifest: DeliveryTrainManifestV1;
  readonly parents: readonly string[];
  readonly landed: readonly TrainTreeChangeV1[];
  readonly members: readonly (readonly TrainTreeChangeV1[])[];
}): TrainLandingTreeVerdictV1 {
  if (!hasDeliveryTrainParentsV1(input.manifest, input.parents)) {
    return { ok: false, reason: "parents" };
  }
  if (input.members.length !== input.manifest.members.length) {
    return { ok: false, reason: "members" };
  }
  if (
    !input.members.every(wellFormedTrainChangesV1) ||
    !wellFormedTrainChangesV1(input.landed)
  ) return { ok: false, reason: "malformed" };
  const claims = new Claims();
  const union: TrainTreeChangeV1[] = [];
  for (const [index, patch] of input.members.entries()) {
    if (patch.some((change) => claims.conflict(change.path) !== null)) {
      return { ok: false, reason: "overlap" };
    }
    patch.forEach((change) => claims.claim(change.path, index));
    union.push(...patch);
  }
  union.sort((a, b) => byPath(a.path, b.path));
  return sameTreeChanges(input.landed, union)
    ? { ok: true }
    : { ok: false, reason: "tree" };
}
