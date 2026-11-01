/**
 * Follow guard for an installed runtime's still-unsettled matrix wave.
 *
 * Auto-follow may only move the launcher when no matrix wave of the installed
 * runtime still owns unresolved reservations. The durable maintenance index
 * names each producer's plan membership; the repair state's reservation
 * objects then say whether every cell settled. This is a read-only probe: it
 * never writes, charges or settles anything.
 *
 * A verified absent index (an older state branch) proves no wave. Unreadable
 * index or repair state fails closed so the launcher does not advance on
 * missing evidence.
 */
import {
  MAINTENANCE_INDEX_PATH,
  MAINTENANCE_INDEX_REF,
  parseCurrentMatrixIndexV1,
} from "../contracts/maintenance-index.ts";
import { parseBudgetReservationV1 } from "../contracts/budget-reservation.ts";
import { sha256Hex } from "../state/state-records.ts";
import {
  FollowError,
  type HostedRuntimeFollowApi,
  record,
  sha,
} from "./hosted-runtime-follow-api.ts";

export const FOLLOW_REPAIR_REF = "refs/heads/sentinel-state/repair";

/** A wave younger than this may still be delivering; older waves never hold. */
export const FOLLOW_MATRIX_WAVE_DEADLINE_MS = 6 * 60 * 60_000;

const REPAIR_RESERVATION = /^reservations\/[0-9a-f]{64}\.json$/;

async function readBlob(
  api: HostedRuntimeFollowApi,
  identity: string,
): Promise<unknown> {
  const blob = record(await api.get(`/git/blobs/${identity}`));
  if (
    blob.sha !== identity || blob.encoding !== "base64" ||
    typeof blob.content !== "string" || blob.content.length > 1_500_000
  ) throw new FollowError("invalid_state_record");
  try {
    const bytes = Uint8Array.from(
      atob(blob.content.replace(/\n/g, "")),
      (char) => char.charCodeAt(0),
    );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new FollowError("invalid_state_record");
  }
}

async function treeOf(
  api: HostedRuntimeFollowApi,
  commitSha: string,
): Promise<Record<string, unknown>[]> {
  const commit = record(await api.get(`/git/commits/${commitSha}`));
  if (commit.sha !== commitSha) {
    throw new FollowError("commit_identity_mismatch");
  }
  const treeSha = sha(record(commit.tree).sha);
  const tree = record(
    await api.get(`/git/trees/${treeSha}`, { recursive: "1" }),
  );
  if (
    tree.sha !== treeSha || tree.truncated !== false ||
    !Array.isArray(tree.tree) || tree.tree.length > 10_000
  ) throw new FollowError("incomplete_state_tree");
  return tree.tree.map(record);
}

async function readMaintenanceIndex(api: HostedRuntimeFollowApi) {
  // Matching refs returns a successful empty array for a verified absence;
  // the exact-ref reader cannot distinguish a 404 from another read failure.
  const refs = await api.get(
    `/git/matching-refs/${MAINTENANCE_INDEX_REF.slice(5)}`,
  );
  if (!Array.isArray(refs)) throw new FollowError("invalid_maintenance_index");
  if (refs.length === 0) return null;
  const matches = refs.map(record).filter((ref) =>
    ref.ref === MAINTENANCE_INDEX_REF
  );
  if (matches.length !== 1) throw new FollowError("ref_identity_mismatch");
  const object = record(matches[0].object);
  if (object.type !== "commit") throw new FollowError("ref_identity_mismatch");
  const entries = await treeOf(api, sha(object.sha));
  const manifest = entries.find((entry) =>
    entry.path === MAINTENANCE_INDEX_PATH
  );
  if (
    manifest === undefined || manifest.type !== "blob" ||
    manifest.mode !== "100644"
  ) throw new FollowError("invalid_maintenance_index");
  let value: unknown;
  try {
    value = await readBlob(api, sha(manifest.sha));
  } catch {
    throw new FollowError("invalid_maintenance_index");
  }
  try {
    return parseCurrentMatrixIndexV1(value);
  } catch {
    throw new FollowError("invalid_maintenance_index");
  }
}

/**
 * True only when a recent plan of the installed revision still has at least
 * one reservation that has not settled. An older wave never holds the follow.
 */
export async function matrixWaveOpen(
  api: HostedRuntimeFollowApi,
  installedRevision: string,
  now: number,
): Promise<boolean> {
  const index = await readMaintenanceIndex(api);
  if (index === null) return false;
  const plans = index.producers.filter((producer) =>
    producer.plan !== undefined &&
    producer.execution.revision === installedRevision &&
    producer.execution.createdAt + FOLLOW_MATRIX_WAVE_DEADLINE_MS > now
  );
  if (plans.length === 0) return false;
  let repairHead: string;
  try {
    repairHead = await api.ref(FOLLOW_REPAIR_REF);
  } catch {
    throw new FollowError("matrix_wave_unreadable");
  }
  const entries = await treeOf(api, repairHead);
  const byPath = new Map(
    entries.filter((entry) =>
      typeof entry.path === "string" && REPAIR_RESERVATION.test(entry.path)
    ).map((entry) => [entry.path as string, sha(entry.sha)]),
  );
  const blobs: string[] = [];
  for (const plan of plans) {
    for (const reservationId of plan.plan!.reservationIds) {
      const blob = byPath.get(
        `reservations/${await sha256Hex(reservationId)}.json`,
      );
      if (blob !== undefined && !blobs.includes(blob)) blobs.push(blob);
    }
  }
  for (let offset = 0; offset < blobs.length; offset += 16) {
    const rows = await Promise.all(
      blobs.slice(offset, offset + 16).map(async (blob) => {
        try {
          return parseBudgetReservationV1(await readBlob(api, blob));
        } catch {
          throw new FollowError("matrix_wave_unreadable");
        }
      }),
    );
    if (rows.some((row) => row.outcome === "reserved")) return true;
  }
  return false;
}
