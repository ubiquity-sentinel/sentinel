/** Future rollout data is separate from the frozen code profile that reads it. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import source from "./hosted-runtime-rollout.json" with { type: "json" };

export interface HostedRuntimeRolloutInstall {
  readonly fromRevision: GitSha;
  readonly fromGeneration: number;
  readonly toRevision: GitSha;
  readonly toGeneration: number;
  readonly rollbackToPrior: boolean;
}

export interface HostedRuntimeRolloutActivation {
  readonly revision: GitSha;
  readonly activatedNotBefore: number;
}

export interface HostedRuntimeRollout {
  readonly version: 1;
  readonly installs: readonly HostedRuntimeRolloutInstall[];
  readonly ciCorrection: readonly GitSha[];
  readonly refreshRearm: readonly HostedRuntimeRolloutActivation[];
  readonly conflictResolution: readonly HostedRuntimeRolloutActivation[];
  readonly ciFirst: readonly GitSha[];
  readonly ciFirstFix: readonly GitSha[];
}

const INVALID = "invalid hosted runtime rollout";
const MAX_ITEMS = 1024;

/** Parsing never authenticates source or authorizes an install on its own. */
export function parseHostedRuntimeRollout(
  value: unknown,
): HostedRuntimeRollout {
  try {
    const row = object(value, [
      "version",
      "installs",
      "ciCorrection",
      "refreshRearm",
      "conflictResolution",
      "ciFirst",
      "ciFirstFix",
    ]);
    if (row.version !== 1) throw new Error(INVALID);
    const installs = array(row.installs).map(install);
    const sources = installs.map((i) =>
      `${i.fromRevision}:${i.fromGeneration}`
    );
    const targets = installs.map((i) => `${i.toRevision}:${i.toGeneration}`);
    const restored = installs.map((i) =>
      `${i.fromRevision}:${i.toGeneration + 1}`
    );
    if (
      new Set(sources).size !== installs.length ||
      new Set(targets).size !== installs.length ||
      new Set(restored).size !== restored.length ||
      restored.some((key) => sources.includes(key) || targets.includes(key))
    ) throw new Error(INVALID);
    const refreshRearm = activations(row.refreshRearm);
    const conflictResolution = activations(row.conflictResolution);
    const times = new Map<GitSha, number>();
    for (const pin of [...refreshRearm, ...conflictResolution]) {
      const prior = times.get(pin.revision);
      if (prior !== undefined && prior !== pin.activatedNotBefore) {
        throw new Error(INVALID);
      }
      times.set(pin.revision, pin.activatedNotBefore);
    }
    return Object.freeze({
      version: 1,
      installs: Object.freeze(installs),
      ciCorrection: revisions(row.ciCorrection),
      refreshRearm,
      conflictResolution,
      ciFirst: revisions(row.ciFirst),
      ciFirstFix: revisions(row.ciFirstFix),
    });
  } catch {
    throw new Error(INVALID);
  }
}

/** All future extensions are dormant until reviewed launcher data names them. */
export const HOSTED_RUNTIME_ROLLOUT = parseHostedRuntimeRollout(source);

function object(value: unknown, keys: readonly string[]) {
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
    (_, i) => dataValue(value, String(i)),
  );
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function install(value: unknown): HostedRuntimeRolloutInstall {
  const row = object(value, [
    "fromRevision",
    "fromGeneration",
    "toRevision",
    "toGeneration",
    "rollbackToPrior",
  ]);
  if (
    !isGitSha(row.fromRevision) || !isGitSha(row.toRevision) ||
    row.fromRevision === row.toRevision ||
    !positive(row.fromGeneration) || !positive(row.toGeneration) ||
    row.toGeneration !== row.fromGeneration + 1 ||
    typeof row.rollbackToPrior !== "boolean" ||
    !Number.isSafeInteger(row.toGeneration + 1)
  ) throw new Error(INVALID);
  return Object.freeze({
    fromRevision: row.fromRevision,
    fromGeneration: row.fromGeneration,
    toRevision: row.toRevision,
    toGeneration: row.toGeneration,
    rollbackToPrior: row.rollbackToPrior,
  });
}

function revisions(value: unknown): readonly GitSha[] {
  const rows = array(value);
  if (!rows.every(isGitSha) || new Set(rows).size !== rows.length) {
    throw new Error(INVALID);
  }
  return Object.freeze(rows);
}

function activations(
  value: unknown,
): readonly HostedRuntimeRolloutActivation[] {
  const rows = array(value).map((value) => {
    const row = object(value, ["revision", "activatedNotBefore"]);
    if (!isGitSha(row.revision) || !positive(row.activatedNotBefore)) {
      throw new Error(INVALID);
    }
    return Object.freeze({
      revision: row.revision,
      activatedNotBefore: row.activatedNotBefore,
    });
  });
  if (new Set(rows.map((row) => row.revision)).size !== rows.length) {
    throw new Error(INVALID);
  }
  return Object.freeze(rows);
}
