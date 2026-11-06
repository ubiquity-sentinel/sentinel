/**
 * Shared per-record validation for one state tree tier: exact schema, exact
 * canonical bytes (with the documented legacy-identity exception) and the
 * digest filename. The hot snapshot reader and the cold repair-tier reader use
 * this one implementation so the two tiers can never validate differently.
 */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { OpContext } from "./state-git.ts";
import type { ValidatedMemoRecord } from "./state-repair-history-cache.ts";
import {
  legacyIdentityRecordId,
  legacyIdentityRecordMatches,
} from "./state-legacy-identity.ts";
import { recordIdentity, sha256Hex } from "./state-records.ts";
import type {
  RecordCollection,
  RecordIdentitySource,
} from "./state-records.ts";

export interface ParsedRecordFilesV1 {
  records: Record<string, { id: string; value: unknown }[]>;
  memoRecords: Record<string, ValidatedMemoRecord>;
}

/**
 * Validates every `<directory>/<sha256(id)>.json` text in `byDirectory`.
 * `prefix` is the tier path prefix (empty for the hot tier) used only for the
 * memo key, so a hot and a cold file of one record never share a memo slot.
 */
export async function parseRecordFiles(
  op: OpContext,
  collections: readonly RecordCollection[],
  byDirectory: Record<string, Record<string, string>>,
  prefix = "",
): Promise<PortResultV1<ParsedRecordFilesV1>> {
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
      const path = `${prefix}${collection.directory}/${fileName}`;
      const remembered = op.treeMemo?.record(path, text);
      if (remembered) {
        memoRecords[path] = remembered;
        records[collection.directory].push({
          id: remembered.id,
          value: remembered.value,
        });
        continue;
      }
      let raw: unknown;
      let record: RecordIdentitySource;
      try {
        raw = JSON.parse(text);
        record = collection.parse(raw);
      } catch {
        return portError(
          "invalid",
          `state record in ${collection.directory} failed validation`,
        );
      }
      // Exact canonical bytes, exactly as this store writes them. Duplicate
      // JSON keys re-parse to one last-wins value, so their original bytes
      // never match the canonical form of the parsed record and are
      // rejected instead of silently accepted. The one exception is the
      // documented pre-migration controller identity: its raw canonical bytes
      // are accepted only when every difference from the parsed record is that
      // retired identity, and consumers still receive the current identity.
      if (`${canonicalStringify(record)}\n` !== text) {
        if (
          `${canonicalStringify(raw)}\n` !== text ||
          !legacyIdentityRecordMatches(collection.directory, raw, record)
        ) {
          return portError(
            "invalid",
            `state record in ${collection.directory} is not canonical JSON`,
          );
        }
      }
      // The digest filename must equal sha256 of the record's storage
      // identity. The retired runtime id retains its pre-migration file name;
      // the normalized record still exposes the current runtime id.
      const identity = recordIdentity(record);
      const actualHex = await sha256Hex(identity);
      if (actualHex !== expectedHex) {
        const legacyId = legacyIdentityRecordId(collection.directory, raw);
        if (legacyId === null || await sha256Hex(legacyId) !== expectedHex) {
          return portError(
            "invalid",
            "state record file name does not match the record id",
          );
        }
      }
      records[collection.directory].push({ id: identity, value: record });
      memoRecords[path] = { text, id: identity, value: record };
    }
  }
  return portOk({ records, memoRecords });
}
