/** Inert bounded mint metadata; only the hosted factory can issue authority. */
import { deriveAppTokenNotAfterV1 } from "./hosted-app-token-window.ts";

export const HOSTED_APP_MINT_GRANT_ENV = "SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT";
export const SENTINEL_APP_ID = 4682172;
export const SENTINEL_APP_INSTALLATION_ID = 155687488;
export const SENTINEL_APP_SLUG = "ubiquity-sentinel";
export const HOSTED_APP_GRANT_MAX_BYTES = 16_384;

const permissions = new Set([
  "contents",
  "metadata",
  "actions",
  "checks",
  "issues",
  "pull_requests",
  "statuses",
  "merge_queues",
  "workflows",
]);
const fields = new Set([
  "version",
  "appId",
  "installationId",
  "appSlug",
  "expiresAt",
  "permissions",
  "repositoryIds",
  "repositoryNames",
]);

export interface HostedAppMintGrant {
  readonly appId: typeof SENTINEL_APP_ID;
  readonly installationId: typeof SENTINEL_APP_INSTALLATION_ID;
  readonly appSlug: typeof SENTINEL_APP_SLUG;
  readonly expiresAt: number;
  readonly permissions: Readonly<Record<string, "read" | "write">>;
  readonly repositoryIds?: readonly number[];
  readonly repositoryNames?: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function ids(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 1000 &&
    value.every((id) => Number.isSafeInteger(id) && id > 0) &&
    new Set(value).size === value.length;
}

function names(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 1000 &&
    value.every((name) =>
      typeof name === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(name)
    ) && new Set(value.map((name) => name.toLowerCase())).size === value.length;
}

/** Parsing never verifies a token, execution, native job or concrete port. */
export function parseHostedAppMintGrant(
  text: string | undefined,
  now: number,
): HostedAppMintGrant | null {
  try {
    if (
      typeof text !== "string" || text.length > HOSTED_APP_GRANT_MAX_BYTES ||
      new TextEncoder().encode(text).length > HOSTED_APP_GRANT_MAX_BYTES ||
      !Number.isSafeInteger(now) || now < 0
    ) return null;
    const value: unknown = JSON.parse(text);
    if (
      !record(value) || Object.keys(value).some((key) => !fields.has(key)) ||
      value.version !== 1 || value.appId !== SENTINEL_APP_ID ||
      value.installationId !== SENTINEL_APP_INSTALLATION_ID ||
      value.appSlug !== SENTINEL_APP_SLUG ||
      typeof value.expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
        value.expiresAt,
      ) ||
      !record(value.permissions) || value.permissions.contents !== "write"
    ) return null;
    const expiresAt = Date.parse(value.expiresAt);
    if (
      !Number.isSafeInteger(expiresAt) || expiresAt <= now ||
      new Date(expiresAt).toISOString() !==
        (value.expiresAt.includes(".")
          ? value.expiresAt
          : value.expiresAt.replace("Z", ".000Z"))
    ) return null;
    const selected: Record<string, "read" | "write"> = {};
    for (const [name, level] of Object.entries(value.permissions)) {
      if (
        !permissions.has(name) || (level !== "read" && level !== "write") ||
        (name === "metadata" && level !== "read") ||
        (name === "workflows" && level !== "write")
      ) return null;
      selected[name] = level;
    }
    if (value.repositoryIds !== undefined && !ids(value.repositoryIds)) {
      return null;
    }
    if (value.repositoryNames !== undefined && !names(value.repositoryNames)) {
      return null;
    }
    const repositoryIds = value.repositoryIds as number[] | undefined;
    const repositoryNames = value.repositoryNames as string[] | undefined;
    if (
      repositoryIds && repositoryNames &&
      repositoryIds.length !== repositoryNames.length
    ) return null;
    return Object.freeze({
      appId: SENTINEL_APP_ID,
      installationId: SENTINEL_APP_INSTALLATION_ID,
      appSlug: SENTINEL_APP_SLUG,
      expiresAt,
      permissions: Object.freeze(selected),
      ...(repositoryIds === undefined
        ? {}
        : { repositoryIds: Object.freeze(repositoryIds.slice()) }),
      ...(repositoryNames === undefined
        ? {}
        : { repositoryNames: Object.freeze(repositoryNames.slice()) }),
    });
  } catch {
    return null;
  }
}

/** The actual expiry may only lower the existing conservative one-token window. */
export function hostedAppPrincipalNotAfter(
  grant: HostedAppMintGrant,
  mintedNotBefore: string | undefined,
  now: number,
): number | null {
  try {
    const conservative = deriveAppTokenNotAfterV1(mintedNotBefore, now);
    if (conservative === undefined) return null;
    const bound = Math.min(grant.expiresAt, conservative);
    return Number.isSafeInteger(bound) && bound > now ? bound : null;
  } catch {
    return null;
  }
}

export const SELF_TOKEN_ENV = "SENTINEL_SELF_TOKEN";
export const SELF_MINT_GRANT_ENV = "SENTINEL_SELF_TOKEN_MINT_GRANT";
