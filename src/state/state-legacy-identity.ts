/**
 * Pre-migration state bytes carry the retired `ubiquity/sentinel` identity.
 * The state reader accepts only that exact legacy identity as a byte-level
 * alternative to the current canonical form; the parsed record still exposes
 * the current identity to every consumer.
 */
import {
  HOSTED_RUNTIME_ID,
  RETIRED_HOSTED_RUNTIME_ID,
  RETIRED_HOSTED_SUPERVISOR_REPOSITORY,
} from "../contracts/hosted-supervisor-types.ts";

const CURRENT_OWNER = "ubiquity-sentinel";
const RETIRED_OWNER = "ubiquity";
const REPOSITORY_NAME = "sentinel";
const CURRENT_REPOSITORY = "ubiquity-sentinel/sentinel";

export function legacyIdentityRecordMatches(
  collection: string,
  raw: unknown,
  normalized: unknown,
): boolean {
  return sameRecord(raw, normalized, "$", collection, 0);
}

export function legacyIdentityRecordId(
  collection: string,
  raw: unknown,
): string | null {
  return collection === "hostedRuntimes" &&
      isRecord(raw) &&
      raw.id === RETIRED_HOSTED_RUNTIME_ID
    ? RETIRED_HOSTED_RUNTIME_ID
    : null;
}

function sameRecord(
  raw: unknown,
  normalized: unknown,
  path: string,
  collection: string,
  depth: number,
): boolean {
  if (raw === normalized) return true;
  if (depth > 32) return false;
  if (typeof raw === "string" && typeof normalized === "string") {
    return path.endsWith(".repository") &&
        raw === RETIRED_HOSTED_SUPERVISOR_REPOSITORY &&
        normalized === CURRENT_REPOSITORY ||
      collection === "hostedRuntimes" && path === "$.id" &&
        raw === RETIRED_HOSTED_RUNTIME_ID && normalized === HOSTED_RUNTIME_ID;
  }
  if (Array.isArray(raw) || Array.isArray(normalized)) {
    if (!Array.isArray(raw) || !Array.isArray(normalized)) return false;
    return raw.length === normalized.length &&
      raw.every((value, index) =>
        sameRecord(
          value,
          normalized[index],
          `${path}[${index}]`,
          collection,
          depth + 1,
        )
      );
  }
  if (!isRecord(raw) || !isRecord(normalized)) return false;
  if (
    path.endsWith(".repository") && isRepository(raw) &&
    isRepository(normalized)
  ) {
    return raw.owner === RETIRED_OWNER &&
      normalized.owner === CURRENT_OWNER &&
      raw.name === REPOSITORY_NAME &&
      normalized.name === REPOSITORY_NAME &&
      raw.installationId === 0 &&
      normalized.installationId === 0;
  }
  const rawKeys = Object.keys(raw).sort();
  const normalizedKeys = Object.keys(normalized).sort();
  if (rawKeys.length !== normalizedKeys.length) return false;
  return rawKeys.every((key, index) =>
    key === normalizedKeys[index] &&
    sameRecord(
      raw[key],
      normalized[key],
      `${path}.${key}`,
      collection,
      depth + 1,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRepository(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  owner: string;
  name: string;
  installationId: number;
} {
  return typeof value.owner === "string" &&
    typeof value.name === "string" &&
    Number.isSafeInteger(value.installationId);
}
