/**
 * The launcher's private-target gate (owner decision 2026-11-18, "no private
 * repos"; `src/repair/target-visibility.ts` holds the one predicate).
 *
 * The maintenance passes walk repair-state records, not the target setting,
 * so the runtime's target-load exclusion does not reach them. This gate does,
 * at the two things every pass reads through:
 *
 * - State (`wrapState`): a read returns the snapshot without any row of a
 *   repository the predicate does not accept, in every collection that names
 *   a repository (`REPOSITORY_COLLECTIONS`, enumerated from the repair
 *   snapshot contract). A write through the view gets those rows back
 *   byte-identical (the exact objects of the snapshot at the expected head),
 *   each after exactly as many visible rows as preceded it, so a pass that
 *   keeps its visible rows in place leaves every hidden row at its index. A
 *   write that names a hidden repository in any row, or that would make the
 *   store compact a ledger holding hidden reservations, is refused with a
 *   closed reason and nothing is written.
 * - GitHub (`githubFor`): a repository whose visibility is not proven public
 *   this run has no surface (null: the documented "unreadable surface, skip
 *   the record, change nothing").
 *
 * Visibility is one repository read per distinct repository the state names,
 * per run, cached for the run, on the launcher's own surface (which shares
 * that answer with its default-branch read). Unknown or unreadable is not
 * public: the repository is hidden for the run. Sentinel's own repository is
 * never read or hidden: it is the public repository the launcher runs in, so
 * a transient read failure can never stop self-follow, self-observation or
 * the owner-merge flow.
 */
import {
  portError,
  type PortResultV1,
  type RepairStateWriter,
  type StateReadView,
} from "../src/contracts/ports.ts";
import type { StateReadResultV1 } from "../src/contracts/ports-state.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { MaxItems } from "../src/contracts/validation.ts";
import {
  PRIVATE_TARGET_REASON,
  sentinelWorksRepositoryV1,
  type TargetVisibilityV1,
} from "../src/repair/target-visibility.ts";
import { HOSTED_AUTONOMY_SELF_SCOPE } from "./hosted-autonomy-policy.ts";

type Row = Record<string, unknown>;

function nameKey(repository: unknown): string | null {
  if (typeof repository !== "object" || repository === null) return null;
  const { owner, name } = repository as Row;
  return typeof owner === "string" && typeof name === "string"
    ? `${owner}/${name}`.toLowerCase()
    : null;
}

const CAPABILITY_ID = /^target_capability:[0-9]+\/([^/]+)\/([^/]+)$/;

/**
 * Every repair-snapshot collection whose rows name a repository, with how a
 * row names it. The contract's other collections (`githubCooldowns`, keyed by
 * installation, and `tierScans`) name none (`REPOSITORY_FREE_COLLECTIONS`).
 */
export const REPOSITORY_COLLECTIONS: Readonly<
  Record<string, (row: Row) => string | null>
> = Object.freeze({
  incidents: (row) => nameKey(row.repository),
  evidence: (row) => nameKey(row.repository),
  work: (row) => nameKey(row.repository),
  reservations: (row) => nameKey(row.repository),
  reservationArchive: (row) => nameKey(row.repository),
  reviews: (row) => nameKey(row.repository),
  ownerSuccessorReviews: (row) =>
    nameKey((row.reservation as Row | undefined)?.repository),
  replays: (row) => nameKey(row.repository),
  releaseRequests: (row) =>
    nameKey((row.target as Row | undefined)?.repository),
  attemptMemory: (row) => nameKey(row.repository),
  lessons: (row) => nameKey(row.repository),
  targetCapabilities: (row) => {
    const named = nameKey(row.repository);
    if (named !== null) return named;
    const match = typeof row.id === "string"
      ? CAPABILITY_ID.exec(row.id)
      : null;
    return match === null ? null : `${match[1]}/${match[2]}`.toLowerCase();
  },
});

export const REPOSITORY_FREE_COLLECTIONS: readonly string[] = Object.freeze([
  "githubCooldowns",
  "tierScans",
]);

/**
 * Every field of the repair snapshot contract, classified. Typed over
 * `keyof RepairStateSnapshotV1`, so a collection the contract adds does not
 * compile until it is classified here (and, naming a repository, given a
 * `REPOSITORY_COLLECTIONS` reader).
 */
export const SNAPSHOT_FIELDS: Readonly<
  Record<keyof RepairStateSnapshotV1, "repository" | "free" | "scalar">
> = Object.freeze({
  version: "scalar",
  kind: "scalar",
  stateHead: "scalar",
  sequence: "scalar",
  updatedAt: "scalar",
  incidents: "repository",
  evidence: "repository",
  work: "repository",
  reservations: "repository",
  reservationArchive: "repository",
  reviews: "repository",
  ownerSuccessorReviews: "repository",
  replays: "repository",
  releaseRequests: "repository",
  githubCooldowns: "free",
  attemptMemory: "repository",
  lessons: "repository",
  targetCapabilities: "repository",
  tierScans: "free",
});
for (const [field, kind] of Object.entries(SNAPSHOT_FIELDS)) {
  if (
    (kind === "repository") !== Object.hasOwn(REPOSITORY_COLLECTIONS, field) ||
    (kind === "free") !== REPOSITORY_FREE_COLLECTIONS.includes(field)
  ) throw new Error(`private target gate: unclassified field ${field}`);
}

const SELF = nameKey(HOSTED_AUTONOMY_SELF_SCOPE)!;

/** Closed reasons a write through the view is refused for. */
export type PrivateTargetRefusalV1 =
  | "private_repository_row"
  | "private_repository_compaction";

function rows(snapshot: RepairStateSnapshotV1, collection: string): unknown[] {
  const value = (snapshot as unknown as Row)[collection];
  return Array.isArray(value) ? value : [];
}

function isHidden(
  collection: string,
  row: unknown,
  hidden: ReadonlySet<string>,
): boolean {
  if (typeof row !== "object" || row === null) return false;
  const key = REPOSITORY_COLLECTIONS[collection](row as Row);
  return key !== null && hidden.has(key);
}

/** Every repository the snapshot names, by lower-case `owner/name`. */
export function namedRepositoriesV1(
  snapshot: RepairStateSnapshotV1,
): Map<string, RepositoryIdentityV1 | null> {
  const named = new Map<string, RepositoryIdentityV1 | null>();
  for (const [collection, keyOf] of Object.entries(REPOSITORY_COLLECTIONS)) {
    for (const row of rows(snapshot, collection)) {
      if (typeof row !== "object" || row === null) continue;
      const key = keyOf(row as Row);
      if (key === null) continue;
      const identity = (row as Row).repository ??
        ((row as Row).target as Row | undefined)?.repository ??
        ((row as Row).reservation as Row | undefined)?.repository;
      if (!named.has(key) || named.get(key) === null) {
        named.set(
          key,
          nameKey(identity) === key ? identity as RepositoryIdentityV1 : null,
        );
      }
    }
  }
  return named;
}

/** The snapshot without any row of a hidden repository, and how many went. */
export function hidePrivateRowsV1(
  snapshot: RepairStateSnapshotV1,
  hidden: ReadonlySet<string>,
): { view: RepairStateSnapshotV1; hiddenRows: number } {
  const view = { ...snapshot } as unknown as Row;
  let hiddenRows = 0;
  for (const collection of Object.keys(REPOSITORY_COLLECTIONS)) {
    const list = (snapshot as unknown as Row)[collection];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((row) => !isHidden(collection, row, hidden));
    hiddenRows += list.length - kept.length;
    if (kept.length !== list.length) view[collection] = kept;
  }
  return { view: view as unknown as RepairStateSnapshotV1, hiddenRows };
}

/**
 * The write a pass made on the view, with every hidden row of `before` put
 * back: the exact row object, after exactly as many visible rows as preceded
 * it in `before`. Refused when the pass's snapshot names a hidden repository
 * in any row, or when the result would exceed a reservation bound while a
 * hidden reservation is in the ledger (the store would compact it).
 */
export function restorePrivateRowsV1(
  next: RepairStateSnapshotV1,
  before: RepairStateSnapshotV1,
  hidden: ReadonlySet<string>,
): { ok: true; snapshot: RepairStateSnapshotV1 } | {
  ok: false;
  reason: PrivateTargetRefusalV1;
  /** The contract collection the refusal is about (closed vocabulary). */
  collection: string;
} {
  const merged = { ...next } as unknown as Row;
  for (const collection of Object.keys(REPOSITORY_COLLECTIONS)) {
    const incoming = rows(next, collection);
    if (incoming.some((row) => isHidden(collection, row, hidden))) {
      return { ok: false, reason: "private_repository_row", collection };
    }
    const prior = rows(before, collection);
    if (!prior.some((row) => isHidden(collection, row, hidden))) continue;
    const out: unknown[] = [];
    let visible = 0;
    for (const row of prior) {
      if (isHidden(collection, row, hidden)) out.push(row);
      else if (visible < incoming.length) out.push(incoming[visible++]);
    }
    while (visible < incoming.length) out.push(incoming[visible++]);
    merged[collection] = out;
  }
  const snapshot = merged as unknown as RepairStateSnapshotV1;
  const ledgerHidden =
    [...rows(snapshot, "reservations")].some((row) =>
      isHidden("reservations", row, hidden)
    ) || rows(snapshot, "reservationArchive").some((row) =>
      isHidden("reservationArchive", row, hidden)
    );
  if (
    ledgerHidden &&
    (snapshot.reservations.length > MaxItems.snapshotRecords ||
      (snapshot.reservationArchive?.length ?? 0) >
        MaxItems.reservationArchiveRecords)
  ) {
    return {
      ok: false,
      reason: "private_repository_compaction",
      collection: "reservations",
    };
  }
  return { ok: true, snapshot };
}

/** The gate's one text-free line: the closed reason and counts. */
export interface PrivateTargetsHiddenLineV1 {
  kind: "sentinel_private_targets_hidden";
  reason: typeof PRIVATE_TARGET_REASON;
  repositories: number;
  rows: number;
  refusedWrites: number;
}

export interface PrivateTargetGateV1 {
  /** The state every pass reads and writes through (see the module). */
  wrapState<T extends StateReadView & RepairStateWriter>(state: T): T;
  /** No surface for a repository not proven public this run. */
  githubFor<S>(
    inner: (repository: RepositoryIdentityV1) => S | null,
  ): (repository: RepositoryIdentityV1) => S | null;
  /** Resolve (once per run) whether the launcher may work a repository. */
  workable(repository: RepositoryIdentityV1): Promise<boolean>;
  /** Work and reservation ids of the hidden rows last read. */
  hiddenIds(): { workIds: Set<string>; reservationIds: Set<string> };
  /** The line for this run, or null when nothing was hidden or refused. */
  line(): PrivateTargetsHiddenLineV1 | null;
}

/**
 * The launcher deps every pass of `runHostedAutonomy` uses, read and written
 * through the gate: the repair state (and the historical quarantine's), the
 * repository surfaces, and the repair tiers' open-issue listing (a hidden
 * repository is never listed, so no tier move ever selects its rows). The
 * queue coordinator, closed-matrix recovery and uncertainty maintenance take
 * the gated state from the runner or from the production composition.
 */
export function gateHostedAutonomyDepsV1(
  deps: import("./hosted-autonomy-types.ts").HostedAutonomyDepsV1,
): import("./hosted-autonomy-types.ts").HostedAutonomyDepsV1 {
  const gate = deps.privateTargets;
  if (gate === undefined) return deps;
  const tiers = deps.repairTiers;
  return {
    ...deps,
    state: gate.wrapState(deps.state),
    githubFor: gate.githubFor((repository) => deps.githubFor(repository)),
    ...(deps.historicalMatrix === undefined ? {} : {
      historicalMatrix: {
        ...deps.historicalMatrix,
        state: gate.wrapState(deps.historicalMatrix.state),
      },
    }),
    ...(tiers === undefined ? {} : {
      repairTiers: {
        ...tiers,
        listOpenIssueNumbers: async (repository) =>
          await gate.workable(repository)
            ? await tiers.listOpenIssueNumbers(repository)
            : portError("unavailable", PRIVATE_TARGET_REASON),
      },
    }),
  };
}

export function createPrivateTargetGateV1(input: {
  readVisibility(repository: RepositoryIdentityV1): Promise<TargetVisibilityV1>;
}): PrivateTargetGateV1 {
  const pending = new Map<string, Promise<boolean>>();
  const settled = new Map<string, boolean>();
  const raws = new Map<string, RepairStateSnapshotV1>();
  let lastHidden:
    | { snapshot: RepairStateSnapshotV1; hidden: Set<string> }
    | null = null;
  let refusedWrites = 0;
  let hiddenRows = 0;
  const wrapped = new WeakSet<object>();

  const resolveKey = (
    key: string,
    repository: RepositoryIdentityV1 | null,
  ): Promise<boolean> => {
    if (key === SELF) return Promise.resolve(true);
    let known = pending.get(key);
    if (known === undefined) {
      known = (async () => {
        let visibility: TargetVisibilityV1 = "unknown";
        try {
          if (repository !== null) {
            visibility = await input.readVisibility(repository);
          }
        } catch {
          visibility = "unknown";
        }
        const works = sentinelWorksRepositoryV1(visibility);
        settled.set(key, works);
        return works;
      })();
      pending.set(key, known);
    }
    return known;
  };

  const hiddenOf = async (
    snapshot: RepairStateSnapshotV1,
  ): Promise<Set<string>> => {
    const hidden = new Set<string>();
    for (const [key, repository] of namedRepositoriesV1(snapshot)) {
      if (!await resolveKey(key, repository)) hidden.add(key);
    }
    return hidden;
  };

  const view = async (
    read: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>,
  ): Promise<PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>> => {
    if (!read.ok || read.value.status !== "found") return read;
    const hidden = await hiddenOf(read.value.snapshot);
    if (hidden.size === 0) return read;
    raws.set(read.value.head, read.value.snapshot);
    const hiddenView = hidePrivateRowsV1(read.value.snapshot, hidden);
    lastHidden = { snapshot: read.value.snapshot, hidden };
    hiddenRows = hiddenView.hiddenRows;
    return {
      ok: true,
      value: { ...read.value, snapshot: hiddenView.view },
    };
  };

  return {
    wrapState<T extends StateReadView & RepairStateWriter>(state: T): T {
      // Wrapping a gated state again is the same gate: a second view would
      // restore hidden rows into a write the first view then refuses.
      if (wrapped.has(state)) return state;
      const gated = new Proxy(state, {
        get(target, property) {
          // A full hot+cold ledger read would show hidden rows: through the
          // gate a ledger reader falls back to the hidden hot view.
          if (property === "readRepairTiered") return undefined;
          if (property === "readRepair") {
            return async () => await view(await target.readRepair());
          }
          if (property === "readRepairAt") {
            const readAt = target.readRepairAt;
            if (typeof readAt !== "function") return readAt;
            return async (at: Parameters<typeof readAt>[0]) =>
              await view(await readAt.call(target, at));
          }
          if (property === "writeRepair") {
            return async (
              next: RepairStateSnapshotV1,
              expectedHead: GitSha | null,
            ) => {
              if (expectedHead === null) {
                return await target.writeRepair(next, expectedHead);
              }
              let before = raws.get(expectedHead);
              if (before === undefined) {
                const read = await target.readRepair();
                if (!read.ok) return read;
                if (
                  read.value.status !== "found" ||
                  read.value.head !== expectedHead
                ) {
                  return portError(
                    "unavailable",
                    "private target gate: state changed",
                  );
                }
                before = read.value.snapshot;
              }
              const hidden = new Set([
                ...await hiddenOf(before),
                ...await hiddenOf(next),
              ]);
              if (hidden.size === 0) {
                return await target.writeRepair(next, expectedHead);
              }
              const restored = restorePrivateRowsV1(next, before, hidden);
              if (!restored.ok) {
                refusedWrites++;
                return portError(
                  "unavailable",
                  `${PRIVATE_TARGET_REASON}: ${restored.reason}:${restored.collection}`,
                );
              }
              return await target.writeRepair(restored.snapshot, expectedHead);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      wrapped.add(gated);
      return gated;
    },
    githubFor<S>(inner: (repository: RepositoryIdentityV1) => S | null) {
      return (repository: RepositoryIdentityV1): S | null => {
        const key = nameKey(repository);
        if (key === null) return null;
        if (key !== SELF && settled.get(key) !== true) return null;
        return inner(repository);
      };
    },
    workable(repository: RepositoryIdentityV1): Promise<boolean> {
      const key = nameKey(repository);
      return key === null
        ? Promise.resolve(false)
        : resolveKey(key, repository);
    },
    hiddenIds() {
      const workIds = new Set<string>();
      const reservationIds = new Set<string>();
      const last = lastHidden as
        | { snapshot: RepairStateSnapshotV1; hidden: Set<string> }
        | null;
      if (last !== null) {
        for (const row of last.snapshot.work) {
          if (isHidden("work", row, last.hidden)) workIds.add(row.id);
        }
        for (
          const row of [
            ...last.snapshot.reservations,
            ...(last.snapshot.reservationArchive ?? []),
          ]
        ) {
          if (isHidden("reservations", row, last.hidden)) {
            reservationIds.add(row.id);
          }
        }
      }
      return { workIds, reservationIds };
    },
    line() {
      const repositories = [...settled.values()].filter((works) => !works)
        .length;
      if (repositories === 0 && refusedWrites === 0) return null;
      return {
        kind: "sentinel_private_targets_hidden",
        reason: PRIVATE_TARGET_REASON,
        repositories,
        rows: hiddenRows,
        refusedWrites,
      };
    },
  };
}
