import type { AttemptMemoryRecordV1 } from "../contracts/attempt-memory.ts";
import type { MemoryLessonsRecordV1 } from "../contracts/memory-lessons.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitHubCooldownV1 } from "../contracts/github-cooldown.ts";
import type {
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  IncidentEvidenceV1,
  IncidentSummaryV1,
} from "../contracts/incident.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type {
  ReleaseRecordV1,
  ReleaseRequestV1,
} from "../contracts/release.ts";
import type { ReplayResultV1 } from "../contracts/replay-result.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { VpsReleaseRecordV1 } from "../contracts/vps-release.ts";
import type { OpContext, StateGitOps } from "./state-git.ts";
import type { ValidatedMemoRecord } from "./state-repair-history-cache.ts";
import { parseBlobBatch } from "./state-batch.ts";
import {
  collectionDirectory,
  orderRecords,
  parseStateManifest,
  RECORD_COLLECTIONS,
  recordIdentity,
  sha256Hex,
} from "./state-records.ts";
import type {
  RecordIdentitySource,
  StateKind,
  StateManifestV1,
} from "./state-records.ts";

export function recordFiles(
  next: RepairStateSnapshotV1 | ReleaseStateSnapshotV1,
  kind: StateKind,
): Promise<{ path: string; text: string }[]> {
  const records: { id: string; directory: string; value: unknown }[] = [];
  if (kind === "repair") {
    const repair = next as RepairStateSnapshotV1;
    const add = (recordKind: string, rows: readonly unknown[]) => {
      // The directory is resolved through the same collection mapping the
      // read loop validates, so the written layout cannot drift from it.
      const directory = collectionDirectory(kind, recordKind);
      for (const value of rows) {
        records.push({
          id: recordIdentity(value as RecordIdentitySource),
          directory,
          value,
        });
      }
    };
    add("incident_summary", repair.incidents);
    add("incident_evidence", repair.evidence);
    add("work", repair.work);
    add("budget_reservation", repair.reservations);
    add("review_receipt", repair.reviews);
    add("owner_successor_review", repair.ownerSuccessorReviews ?? []);
    add("replay_result", repair.replays);
    add("release_request", repair.releaseRequests);
    // Durable cooldowns are serialized explicitly: the fragment is
    // deliberately a kind-less data record, so its collection directory and
    // storage identity (sha256 of String(installationId)) are fixed by the
    // collection mapping here, never inferred from the record content.
    add("github_cooldown", repair.githubCooldowns);
    add("attempt_memory", repair.attemptMemory);
    add("memory_lessons", repair.lessons);
  } else {
    const release = next as ReleaseStateSnapshotV1;
    const add = (recordKind: string, rows: readonly unknown[]) => {
      const directory = collectionDirectory(kind, recordKind);
      for (const value of rows) {
        records.push({
          id: recordIdentity(value as RecordIdentitySource),
          directory,
          value,
        });
      }
    };
    add("release_record", release.releases);
    add("vps_release_record", release.vpsReleases ?? []);
    add("hosted_runtime", release.hostedRuntimes);
    add("hosted_release", release.hostedReleases);
    add("hosted_installation", release.hostedInstallations ?? []);
    // Release-role cooldowns use the same kind-less fragment convention as
    // the repair role; both are addressed by installation id.
    add("github_cooldown", release.githubCooldowns);
  }
  return Promise.all(
    records.map(async (record) => ({
      path: `${record.directory}/${await sha256Hex(record.id)}.json`,
      text: `${canonicalStringify(record.value)}\n`,
    })),
  );
}

/**
 * Parses and validates the full record tree at one commit: manifest schema,
 * exact collection layout, exact keys/schema per record, digest filenames,
 * unique ids, and manifest stateHead against the actual commit parent.
 */
export async function readCommitTree(
  io: StateGitOps,
  op: OpContext,
  commitSha: string,
  kind: StateKind,
): Promise<PortResultV1<RepairStateSnapshotV1 | ReleaseStateSnapshotV1>> {
  const [parentRead, treeRead] = await Promise.allSettled([
    io.git(op, ["rev-list", "--parents", "-n", "1", commitSha]),
    io.git(op, ["ls-tree", "-r", commitSha]),
  ]);
  if (parentRead.status === "rejected") {
    return portError("unavailable", "state parent read failed");
  }
  const parents = parentRead.value;
  if (!parents.ok) return io.gitFailure("unavailable", "rev-list", parents);
  const parentTokens = parents.stdout.trim().split(/\s+/).filter(Boolean);
  const parentsOfCommit = parentTokens.slice(1);

  if (treeRead.status === "rejected") {
    return portError("unavailable", "state tree read failed");
  }
  const tree = treeRead.value;
  if (!tree.ok) return io.gitFailure("unavailable", "ls-tree", tree);

  interface Entry {
    mode: string;
    type: string;
    sha: string;
    path: string;
  }
  const entries: Entry[] = [];
  for (const line of tree.stdout.split("\n")) {
    if (line.length === 0) continue;
    const match = /^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/.exec(
      line,
    );
    if (match === null) {
      return portError("invalid", "state tree has a malformed entry");
    }
    entries.push({
      mode: match[1],
      type: match[2],
      sha: match[3],
      path: match[4],
    });
    if (match[2] !== "blob") {
      return portError("invalid", "state tree contains a non-blob entry");
    }
    // State files are full regular blobs only: an executable or a symlink
    // (for the manifest or any record) is tampered state, never storage.
    if (match[1] !== "100644") {
      return portError(
        "invalid",
        "state tree contains a non-regular state file",
      );
    }
  }

  const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
  if (manifestEntry === undefined) {
    return portError("invalid", "state tree is missing manifest.json");
  }
  if (
    entries.filter((entry) => entry.path === "manifest.json").length !== 1
  ) {
    return portError("invalid", "state tree has duplicate manifest entries");
  }
  const requested = entries.map((entry) => entry.sha);
  const batch = await io.git(op, ["cat-file", "--batch"], {
    stdin: new TextEncoder().encode(`${requested.join("\n")}\n`),
    rawOutput: true,
  });
  if (!batch.ok) {
    return io.gitFailure("unavailable", "cat-file", batch);
  }
  if (!(batch.stdoutBytes instanceof Uint8Array)) {
    return portError("invalid", "state blob batch has no raw output");
  }
  const proof = {
    parents: parents.stdout,
    tree: tree.stdout,
    bytes: batch.stdoutBytes,
  };
  const memoKey = `${kind}:${commitSha}`;
  const memo = op.treeMemo?.read(memoKey, proof);
  if (memo?.status === "mismatch") {
    return portError("invalid", "validated state tree bytes changed");
  }
  if (memo?.status === "hit") return portOk(memo.snapshot);
  const blobs = parseBlobBatch(batch.stdoutBytes, requested);
  if (!blobs.ok) return blobs;
  const manifestText = blobs.value[entries.indexOf(manifestEntry)];
  let manifest: StateManifestV1;
  try {
    manifest = parseStateManifest(
      JSON.parse(manifestText),
      "$.manifest",
      kind,
    );
  } catch {
    return portError("invalid", "state manifest failed validation");
  }
  // The manifest must be exactly the canonical JSON bytes this store writes
  // (canonicalStringify + newline). Any reordered keys, duplicate JSON keys
  // — which parse to one silent last-wins value — or formatting drift is a
  // mismatch and invalid rather than a best-effort reparse.
  if (`${canonicalStringify(manifest)}\n` !== manifestText) {
    return portError("invalid", "state manifest is not canonical JSON");
  }

  // Validate the embedded stateHead against the actual commit parent.
  if (manifest.stateHead === null) {
    if (parentsOfCommit.length !== 0) {
      return portError(
        "invalid",
        "manifest stateHead is null but the commit has a parent",
      );
    }
  } else {
    if (
      parentsOfCommit.length !== 1 ||
      parentsOfCommit[0] !== manifest.stateHead
    ) {
      return portError(
        "invalid",
        "manifest stateHead does not match the commit parent",
      );
    }
  }

  const collections = RECORD_COLLECTIONS[kind];
  const directories = new Set(collections.map((c) => c.directory));
  const byDirectory: Record<string, Record<string, string>> = {};
  for (const collection of collections) {
    byDirectory[collection.directory] = {};
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.path === "manifest.json") continue;
    const slash = entry.path.indexOf("/");
    if (slash === -1) {
      return portError("invalid", "state tree has an unexpected root file");
    }
    const directory = entry.path.slice(0, slash);
    const fileName = entry.path.slice(slash + 1);
    if (!directories.has(directory)) {
      return portError("invalid", "state tree has an unexpected collection");
    }
    if (!/^[0-9a-f]{64}\.json$/.test(fileName)) {
      return portError(
        "invalid",
        "state record file name is not digest-encoded",
      );
    }
    byDirectory[directory][fileName] = blobs.value[index];
  }

  // Parse and validate every record file; the filename must be the SHA-256
  // of the record id, preventing duplication or misplacement.
  const records: Record<string, { id: string; value: unknown }[]> = {};
  const memoRecords: Record<string, ValidatedMemoRecord> = {};
  for (const collection of collections) records[collection.directory] = [];
  for (const collection of collections) {
    for (
      const [fileName, text] of Object.entries(
        byDirectory[collection.directory],
      )
    ) {
      const expectedHex = fileName.slice(0, 64);
      const path = `${collection.directory}/${fileName}`;
      const remembered = op.treeMemo?.record(path, text);
      if (remembered) {
        memoRecords[path] = remembered;
        records[collection.directory].push({
          id: remembered.id,
          value: remembered.value,
        });
        continue;
      }
      let record: RecordIdentitySource;
      try {
        record = collection.parse(JSON.parse(text));
      } catch {
        return portError(
          "invalid",
          `state record in ${collection.directory} failed validation`,
        );
      }
      // Exact canonical bytes, exactly as this store writes them. Duplicate
      // JSON keys re-parse to one last-wins value, so their original bytes
      // never match the canonical form of the parsed record and are
      // rejected instead of silently accepted.
      if (`${canonicalStringify(record)}\n` !== text) {
        return portError(
          "invalid",
          `state record in ${collection.directory} is not canonical JSON`,
        );
      }
      // The digest filename must equal sha256 of the record's storage
      // identity: the record id for existing records, the positive
      // installation id string for kind-less GitHub cooldowns.
      const identity = recordIdentity(record);
      const actualHex = await sha256Hex(identity);
      if (actualHex !== expectedHex) {
        return portError(
          "invalid",
          "state record file name does not match the record id",
        );
      }
      records[collection.directory].push({ id: identity, value: record });
      memoRecords[path] = { text, id: identity, value: record };
    }
  }

  // Deterministic order by id, then full snapshot validation (exact keys,
  // schema, duplicate ids) via the frozen snapshot parsers.
  let snapshot: RepairStateSnapshotV1 | ReleaseStateSnapshotV1;
  try {
    if (kind === "repair") {
      const repair = {
        version: "v1",
        kind: "repair_state_snapshot",
        stateHead: manifest.stateHead,
        sequence: manifest.sequence,
        updatedAt: manifest.updatedAt,
        incidents: orderRecords(records.incidents) as IncidentSummaryV1[],
        evidence: orderRecords(records.evidence) as IncidentEvidenceV1[],
        work: orderRecords(records.work) as WorkRecordV1[],
        reservations: orderRecords(
          records.reservations,
        ) as BudgetReservationV1[],
        reviews: orderRecords(records.reviews) as ReviewReceiptV1[],
        ...(records.ownerSuccessorReviews.length === 0 ? {} : {
          ownerSuccessorReviews: orderRecords(records.ownerSuccessorReviews),
        }),
        replays: orderRecords(records.replays) as ReplayResultV1[],
        releaseRequests: orderRecords(
          records.releaseRequests,
        ) as ReleaseRequestV1[],
        githubCooldowns: orderRecords(
          records.githubCooldowns,
        ) as GitHubCooldownV1[],
        attemptMemory: orderRecords(
          records.attemptMemory,
        ) as AttemptMemoryRecordV1[],
        lessons: orderRecords(
          records.lessons,
        ) as MemoryLessonsRecordV1[],
      };
      snapshot = parseRepairStateSnapshotV1(repair);
    } else {
      const release = {
        version: "v1",
        kind: "release_state_snapshot",
        stateHead: manifest.stateHead,
        sequence: manifest.sequence,
        updatedAt: manifest.updatedAt,
        releases: orderRecords(records.releases) as ReleaseRecordV1[],
        ...(records.vpsReleases.length === 0 ? {} : {
          vpsReleases: orderRecords(
            records.vpsReleases,
          ) as VpsReleaseRecordV1[],
        }),
        hostedRuntimes: orderRecords(
          records.hostedRuntimes,
        ) as HostedRuntimeRecordV1[],
        ...(records.hostedInstallations.length === 0
          ? {}
          : { hostedInstallations: orderRecords(records.hostedInstallations) }),
        hostedReleases: orderRecords(
          records.hostedReleases,
        ) as HostedReleaseRecordV1[],
        githubCooldowns: orderRecords(
          records.githubCooldowns,
        ) as GitHubCooldownV1[],
      };
      snapshot = parseReleaseStateSnapshotV1(release);
    }
  } catch {
    return portError("invalid", "state snapshot failed validation");
  }
  op.treeMemo?.put(memoKey, proof, snapshot, memoRecords);
  return portOk(snapshot);
}
