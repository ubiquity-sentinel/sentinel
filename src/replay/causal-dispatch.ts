import { canonicalStringify } from "../contracts/canonical.ts";
import { isSafeBundlePath } from "./fixture.ts";
import { encode, validTestIds } from "./causal-verifier-protocol.ts";

/**
 * The ONLY consumer path bound to the fixed trusted-consumer command
 * identity (`CAUSAL_CONSUMER_COMMAND_ID`): an interchangeable arbitrary
 * consumerPath is rejected at construction. The consumer is the committed
 * script the trusted replay task runs, executed directly with the fixed
 * protocol (never `deno task`).
 */
export const CAUSAL_CONSUMER_PATH = "scripts/replay.ts";

/** Installed macOS sandbox-exec binary (proven by the host receipts). */
export const CAUSAL_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * Fixed root-relative dispatch metadata path. The committed consumer reads
 * this ONE record at the snapshot/checkout root and then only the two
 * relative paths it names; it never scans fixtures or picks an entry by
 * order. The file is public protocol data (fixed paths plus public test ids)
 * and is written into both verifier snapshots and the candidate checkout.
 */
export const SENTINEL_REPLAY_INPUT_PATH = ".sentinel-replay-input.json";

/** Fixed byte bound for the dispatch metadata record (consumer-enforced). */
export const MAX_SENTINEL_REPLAY_INPUT_BYTES = 16 * 1024;

/**
 * Exact canonical dispatch metadata record:
 * `{version:'v1',requestPath,upstreamPath,testIds}`. `requestPath` and
 * `upstreamPath` are already validated fixed consumer paths and `testIds` is
 * the ordered validated trusted id list; the record carries no private bytes.
 */
export interface SentinelReplayInputV1 {
  version: "v1";
  requestPath: string;
  upstreamPath: string;
  testIds: string[];
}

/**
 * Canonical dispatch metadata bytes for already validated trusted inputs:
 * canonical JSON (`canonicalStringify` key order), two distinct safe
 * root-relative paths and 1..64 ordered valid test ids, bounded to 16 KiB.
 * Returns null (never a partial record) when any bound is violated.
 */
export function buildSentinelReplayInputMetadata(
  requestPath: string,
  upstreamPath: string,
  testIds: readonly string[],
): Uint8Array | null {
  if (!isSafeBundlePath(requestPath) || !isSafeBundlePath(upstreamPath)) {
    return null;
  }
  if (requestPath === upstreamPath) return null;
  if (!validTestIds(testIds)) return null;
  const record: SentinelReplayInputV1 = {
    version: "v1",
    requestPath,
    upstreamPath,
    testIds: [...testIds],
  };
  const bytes = encode(canonicalStringify(record));
  if (bytes.byteLength > MAX_SENTINEL_REPLAY_INPUT_BYTES) return null;
  return bytes;
}
