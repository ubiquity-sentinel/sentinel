/**
 * Hot/cold tier layout of the repair state ref.
 *
 * One commit on `sentinel-state/repair` holds both tiers, written by the same
 * trusted repair writer:
 *
 *   manifest.json, <collection>/<sha256(id)>.json   hot tier (live records)
 *   repair-archive/<collection>/<sha256(id)>.json   cold tier (terminal records)
 *
 * The hot snapshot reader never lists, fetches from the object store or parses
 * the cold subtree. Cold rows keep the exact blob bytes and file name they had
 * in the hot tier: a tier transition is a tree move, never a re-serialization,
 * so accounting, reservations and provenance are preserved byte-for-byte.
 * Only the collections a demotion may move exist in the cold tier. Cold rows
 * are terminal, except a release-deferred family (Sentinel #325): an open
 * release request and a `delivery` record waiting only on it, moved cold
 * together while the release path is disabled.
 */

import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { OpContext, StateGitOps } from "./state-git.ts";
import { parseBlobBatch } from "./state-batch.ts";
import { parseRecordFiles } from "./state-record-parse.ts";
import { orderRecords, RECORD_COLLECTIONS } from "./state-records.ts";
import type { StateKind } from "./state-records.ts";

/** Root directory of the cold repair tier on the repair state ref. */
export const REPAIR_COLD_PREFIX = "repair-archive";

/**
 * Layout marker of the cold tier, present exactly while the tier holds a
 * record. A runtime from before this layout refuses the whole repair tree
 * ("unexpected collection"); this marker names the layout so that refusal is
 * diagnosable, and a later layout version is refused here explicitly. Before
 * rolling the runtime back past the tier revision, run one promote-all tier
 * transition: it empties the tier and removes the marker and the subtree.
 */
export const REPAIR_COLD_LAYOUT_PATH = "repair-archive/LAYOUT";
export const REPAIR_COLD_LAYOUT_TEXT = "sentinel-repair-tiers v1\n";

/** The only collections a trusted demotion may move into the cold tier. */
export const REPAIR_COLD_DIRECTORIES = [
  "work",
  "reservations",
  "reservationArchive",
  "reviews",
  "releaseRequests",
] as const;
export type RepairColdDirectoryV1 = typeof REPAIR_COLD_DIRECTORIES[number];

/** Validated cold-tier records, each collection ordered by id. */
export interface RepairColdTierV1 {
  work: WorkRecordV1[];
  reservations: BudgetReservationV1[];
  reservationArchive: BudgetReservationV1[];
  reviews: ReviewReceiptV1[];
  releaseRequests: ReleaseRequestV1[];
}

/** One regular state blob listed in a tree. */
export interface StateTreeEntryV1 {
  path: string;
  sha: string;
}

/**
 * Names (and blob ids) of the cold tier only; listing it reads no blob.
 * `tree` is the cold subtree id, null when the tier does not exist.
 */
export interface RepairColdCatalogV1 {
  tree: string | null;
  entries: StateTreeEntryV1[];
}

export function emptyColdTierV1(): RepairColdTierV1 {
  return {
    work: [],
    reservations: [],
    reservationArchive: [],
    reviews: [],
    releaseRequests: [],
  };
}

const COLD_SET: ReadonlySet<string> = new Set(REPAIR_COLD_DIRECTORIES);
const COLD_COLLECTIONS = RECORD_COLLECTIONS.repair.filter((collection) =>
  COLD_SET.has(collection.directory)
);
const COLD_PATH = new RegExp(
  `^${REPAIR_COLD_PREFIX}/(${
    REPAIR_COLD_DIRECTORIES.join("|")
  })/([0-9a-f]{64}\\.json)$`,
);
const TREE_LINE = /^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/;

/** Splits a cold path into its collection directory and file name. */
export function coldPathParts(
  path: string,
): { directory: RepairColdDirectoryV1; fileName: string } | null {
  const match = COLD_PATH.exec(path);
  return match === null
    ? null
    : { directory: match[1] as RepairColdDirectoryV1, fileName: match[2] };
}

/**
 * Non-recursive root validation: the root holds only the manifest blob, known
 * collection trees and, on the repair ref, the cold tier tree. Messages match
 * the recursive reader's existing refusals.
 */
export function validateStateRoot(
  stdout: string,
  kind: StateKind,
): string | null {
  const directories = new Set(
    RECORD_COLLECTIONS[kind].map((collection) => collection.directory),
  );
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const match = TREE_LINE.exec(line);
    if (match === null) return "state tree has a malformed entry";
    const [, mode, type, , path] = match;
    if (type === "commit") return "state tree contains a non-blob entry";
    if (type === "blob") {
      if (mode !== "100644") {
        return "state tree contains a non-regular state file";
      }
      if (path !== "manifest.json") {
        return "state tree has an unexpected root file";
      }
      continue;
    }
    if (directories.has(path)) continue;
    if (kind === "repair" && path === REPAIR_COLD_PREFIX) continue;
    return "state tree has an unexpected collection";
  }
  return null;
}

/** Strict `ls-tree -r` parsing: regular blobs only. */
export function parseStateTreeListing(
  stdout: string,
): PortResultV1<StateTreeEntryV1[]> {
  const entries: StateTreeEntryV1[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const match = TREE_LINE.exec(line);
    if (match === null) {
      return portError("invalid", "state tree has a malformed entry");
    }
    if (match[2] !== "blob") {
      return portError("invalid", "state tree contains a non-blob entry");
    }
    if (match[1] !== "100644") {
      return portError(
        "invalid",
        "state tree contains a non-regular state file",
      );
    }
    entries.push({ path: match[4], sha: match[3] });
  }
  return portOk(entries);
}

/** Lists the cold tier's file names and blob ids; reads no blob. */
export async function readColdCatalog(
  io: StateGitOps,
  op: OpContext,
  commit: string,
): Promise<PortResultV1<RepairColdCatalogV1>> {
  // One root lookup first: a ref without a cold tier costs a single call.
  const rootRead = await io.git(op, [
    "ls-tree",
    commit,
    "--",
    REPAIR_COLD_PREFIX,
  ]);
  if (!rootRead.ok) return io.gitFailure("unavailable", "ls-tree", rootRead);
  const root = rootRead.stdout.split("\n").filter(Boolean);
  if (root.length === 0) return portOk({ tree: null, entries: [] });
  const rootMatch = root.length === 1
    ? /^040000 tree ([0-9a-f]{40})\t(.+)$/.exec(root[0])
    : null;
  if (rootMatch === null || rootMatch[2] !== REPAIR_COLD_PREFIX) {
    return portError("invalid", "cold repair tier root is malformed");
  }
  const listRead = await io.git(op, [
    "ls-tree",
    "-r",
    commit,
    "--",
    REPAIR_COLD_PREFIX,
  ]);
  if (!listRead.ok) return io.gitFailure("unavailable", "ls-tree", listRead);
  const listed = parseStateTreeListing(listRead.stdout);
  if (!listed.ok) return listed;
  const entries: StateTreeEntryV1[] = [];
  let marker: string | null = null;
  for (const entry of listed.value) {
    if (entry.path === REPAIR_COLD_LAYOUT_PATH) {
      marker = entry.sha;
      continue;
    }
    if (coldPathParts(entry.path) === null) {
      return portError("invalid", "cold repair tier has an unexpected entry");
    }
    entries.push(entry);
  }
  // The layout marker is checked by blob id alone (no blob read): any other
  // or missing marker is a layout this runtime does not implement.
  if (marker !== await repairColdLayoutBlobId()) {
    return portError("invalid", "unsupported cold repair tier layout");
  }
  if (entries.length === 0) {
    return portError("invalid", "cold repair tier is empty");
  }
  return portOk({ tree: rootMatch[1], entries });
}

/** Git blob id of the exact layout marker text. */
export async function repairColdLayoutBlobId(): Promise<string> {
  const body = new TextEncoder().encode(REPAIR_COLD_LAYOUT_TEXT);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Reads and validates every cold record (explicit full-ledger readers only).
 * `partial` reads a subset of the catalog: per-row checks apply, cross-row
 * family bindings (which need the whole tier) do not.
 */
export async function readColdTier(
  io: StateGitOps,
  op: OpContext,
  catalog: RepairColdCatalogV1,
  options: { partial?: boolean } = {},
): Promise<PortResultV1<RepairColdTierV1>> {
  if (catalog.entries.length === 0) return portOk(emptyColdTierV1());
  const requested = catalog.entries.map((entry) => entry.sha);
  const batch = await io.git(op, ["cat-file", "--batch"], {
    stdin: new TextEncoder().encode(`${requested.join("\n")}\n`),
    rawOutput: true,
  });
  if (!batch.ok) return io.gitFailure("unavailable", "cat-file", batch);
  if (!(batch.stdoutBytes instanceof Uint8Array)) {
    return portError("invalid", "state blob batch has no raw output");
  }
  const blobs = parseBlobBatch(batch.stdoutBytes, requested);
  if (!blobs.ok) return blobs;
  const byDirectory: Record<string, Record<string, string>> = {};
  for (const directory of REPAIR_COLD_DIRECTORIES) byDirectory[directory] = {};
  for (const [index, entry] of catalog.entries.entries()) {
    const parts = coldPathParts(entry.path)!;
    byDirectory[parts.directory][parts.fileName] = blobs.value[index];
  }
  const parsed = await parseRecordFiles(
    op,
    COLD_COLLECTIONS,
    byDirectory,
    `${REPAIR_COLD_PREFIX}/`,
  );
  if (!parsed.ok) return parsed;
  const records = parsed.value.records;
  const cold: RepairColdTierV1 = {
    work: orderRecords(records.work),
    reservations: orderRecords(records.reservations),
    reservationArchive: orderRecords(records.reservationArchive),
    reviews: orderRecords(records.reviews),
    releaseRequests: orderRecords(records.releaseRequests),
  };
  const message = validateColdTier(cold, options.partial === true);
  return message === null ? portOk(cold) : portError("invalid", message);
}

/**
 * Cold rows are terminal: a demotion never moves a row that can still change,
 * except a release-deferred family, whose open request and waiting `delivery`
 * record are bound to each other through a cold reservation.
 */
export function validateColdTier(
  cold: RepairColdTierV1,
  partial = false,
): string | null {
  for (const row of cold.work) {
    if (
      row.nextStep !== "done" && row.nextStep !== "blocked" &&
      row.nextStep !== "delivery"
    ) {
      return "a cold work record must be done, blocked or release-deferred";
    }
    if (row.intent !== null) {
      return "a cold work record cannot carry an incomplete operation";
    }
  }
  for (const row of [...cold.reservations, ...cold.reservationArchive]) {
    if (
      row.settledAt === null ||
      (row.outcome !== "submitted" && row.outcome !== "confirmed_not_submitted")
    ) {
      return "a cold reservation must be terminally settled";
    }
  }
  if (cold.reviews.some((row) => row.outcome !== "completed")) {
    return "a cold review receipt must be completed";
  }
  if (!partial) {
    const binding = releaseDeferredBindingMessage(cold);
    if (binding !== null) return binding;
  }
  const reservationIds = new Set<string>();
  for (const row of [...cold.reservations, ...cold.reservationArchive]) {
    if (reservationIds.has(row.id)) return "duplicate cold reservation id";
    reservationIds.add(row.id);
  }
  for (const rows of [cold.work, cold.reviews, cold.releaseRequests]) {
    const ids = new Set<string>();
    for (const row of rows) {
      if (ids.has(row.id)) return "duplicate cold record id";
      ids.add(row.id);
    }
  }
  return null;
}

/**
 * Every cold open release request binds a cold reservation of a cold work
 * record, and every cold `delivery` record holds such an open request.
 */
function releaseDeferredBindingMessage(cold: RepairColdTierV1): string | null {
  const taskOf = new Map<string, string>();
  for (const row of [...cold.reservations, ...cold.reservationArchive]) {
    taskOf.set(row.id, String(row.taskId));
  }
  const coldWork = new Set<string>(cold.work.map((row) => row.id));
  const deferred = new Set<string>();
  for (const request of cold.releaseRequests) {
    if (request.status !== "open") continue;
    const workId = taskOf.get(request.source.reviewRequestId);
    if (workId === undefined || !coldWork.has(workId)) {
      return "a cold open release request must belong to a cold family";
    }
    deferred.add(workId);
  }
  for (const row of cold.work) {
    if (row.nextStep === "delivery" && !deferred.has(row.id)) {
      return "a cold delivery record must wait on a cold open release request";
    }
  }
  return null;
}

/** One record id lives in exactly one tier (reservations share one id space). */
export function validateTierDisjoint(
  hot: RepairStateSnapshotV1,
  cold: RepairColdTierV1,
): string | null {
  const overlaps = (
    left: readonly { id: string }[],
    right: readonly { id: string }[],
  ) => {
    const ids = new Set(left.map((row) => row.id));
    return right.some((row) => ids.has(row.id));
  };
  if (
    overlaps(hot.work, cold.work) ||
    overlaps([...hot.reservations, ...(hot.reservationArchive ?? [])], [
      ...cold.reservations,
      ...cold.reservationArchive,
    ]) ||
    overlaps(hot.reviews, cold.reviews) ||
    overlaps(hot.releaseRequests, cold.releaseRequests)
  ) {
    return "a repair record cannot be both hot and cold";
  }
  return null;
}
