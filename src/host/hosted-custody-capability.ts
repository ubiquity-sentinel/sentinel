/** Parse data separately from the immutable code profile that authenticates it. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type { ExistingPrRuntimeCapability } from "./existing-pr-runtime-capability.ts";
import type {
  QueueRuntimeCapability,
  QueueRuntimeMigration,
} from "./queue-runtime-capability.ts";
import source from "./hosted-custody-capability.json" with { type: "json" };

export interface HostedCustodyCapability {
  readonly version: 1;
  readonly takeover: { readonly activated: boolean };
  readonly queue: QueueRuntimeCapability;
  readonly existingPr: ExistingPrRuntimeCapability;
}

const MAX_ITEMS = 1024;
const INVALID = "invalid hosted custody capability";

/** Validation grants no authority: callers must authenticate the source bytes. */
export function parseHostedCustodyCapability(
  value: unknown,
): HostedCustodyCapability {
  try {
    const root = object(value, ["version", "takeover", "queue", "existingPr"]);
    if (root.version !== 1) throw new Error(INVALID);
    const takeover = object(root.takeover, ["activated"]);
    const queue = object(root.queue, [
      "proofActivated",
      "revisions",
      "ownerInstallMigrations",
    ]);
    const existingPr = object(root.existingPr, [
      "custodyActivated",
      "revisions",
      "ownerInstallMigrations",
    ]);
    if (
      typeof takeover.activated !== "boolean" ||
      typeof queue.proofActivated !== "boolean" ||
      typeof existingPr.custodyActivated !== "boolean"
    ) throw new Error(INVALID);
    return Object.freeze({
      version: 1,
      takeover: Object.freeze({ activated: takeover.activated }),
      queue: Object.freeze({
        proofActivated: queue.proofActivated,
        revisions: revisions(queue.revisions),
        ownerInstallMigrations: migrations(queue.ownerInstallMigrations),
      }),
      existingPr: Object.freeze({
        custodyActivated: existingPr.custodyActivated,
        revisions: revisions(existingPr.revisions),
        ownerInstallMigrations: migrations(existingPr.ownerInstallMigrations),
      }),
    });
  } catch {
    // Never echo candidate data or errors from arbitrary unknown inputs.
    throw new Error(INVALID);
  }
}

/** Only reviewed local source data supplies production defaults, never env JSON. */
export const HOSTED_CUSTODY_CAPABILITY = parseHostedCustodyCapability(source);

function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(INVALID);
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) throw new Error(INVALID);
  return Object.fromEntries(keys.map((key) => [key, dataValue(value, key)]));
}

function dataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error(INVALID);
  return descriptor.value;
}

function array(value: unknown): unknown[] {
  if (
    !Array.isArray(value) || value.length > MAX_ITEMS ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) throw new Error(INVALID);
  return Array.from(
    { length: value.length },
    (_, index) => dataValue(value, String(index)),
  );
}

function revisions(value: unknown): readonly GitSha[] {
  const values = array(value);
  if (!values.every(isGitSha) || new Set(values).size !== values.length) {
    throw new Error(INVALID);
  }
  return Object.freeze(values);
}

function migrations(value: unknown): readonly QueueRuntimeMigration[] {
  const rows = array(value).map((item): QueueRuntimeMigration => {
    const row = object(item, [
      "fromRevision",
      "fromGeneration",
      "toRevision",
      "toGeneration",
    ]);
    if (
      !isGitSha(row.fromRevision) || !isGitSha(row.toRevision) ||
      row.fromRevision === row.toRevision ||
      typeof row.fromGeneration !== "number" ||
      !Number.isSafeInteger(row.fromGeneration) || row.fromGeneration < 1 ||
      typeof row.toGeneration !== "number" ||
      !Number.isSafeInteger(row.toGeneration) ||
      row.toGeneration !== row.fromGeneration + 1
    ) throw new Error(INVALID);
    return Object.freeze({
      fromRevision: row.fromRevision,
      fromGeneration: row.fromGeneration,
      toRevision: row.toRevision,
      toGeneration: row.toGeneration,
    });
  });
  if (new Set(rows.map((row) => JSON.stringify(row))).size !== rows.length) {
    throw new Error(INVALID);
  }
  return Object.freeze(rows);
}
