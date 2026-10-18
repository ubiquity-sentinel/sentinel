/** Nonsecret same-mint metadata. Parsing this output never grants authority. */
const permissionNames = Object.freeze([
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
const maxRepositories = 1000;
const maxOutputBytes = 16_384;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

/** @param {unknown} value @returns {value is number} */
function positiveId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** @param {unknown} value @returns {value is string} */
function expiry(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() ===
      (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

/**
 * Select fields explicitly; never serialize or spread the authentication object.
 * Missing, malformed or oversized optional metadata returns null. Token output
 * and post-action cleanup remain the upstream main's responsibility.
 *
 * @param {unknown} authentication
 * @param {unknown} installationId
 * @param {unknown} appSlug
 * @param {unknown} appId
 * @returns {string | null}
 */
export function serializeMintGrant(
  authentication,
  installationId,
  appSlug,
  appId,
) {
  try {
    if (
      !record(authentication) || authentication.type !== "token" ||
      authentication.tokenType !== "installation" ||
      !positiveId(installationId) || !positiveId(appId) ||
      authentication.installationId !== installationId ||
      typeof appSlug !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(appSlug) ||
      !expiry(authentication.expiresAt) ||
      !record(authentication.permissions)
    ) return null;
    /** @type {Record<string, string>} */
    const permissions = {};
    for (const name of permissionNames) {
      if (!Object.hasOwn(authentication.permissions, name)) continue;
      const value = authentication.permissions[name];
      if (value === undefined) continue;
      if (value !== "read" && value !== "write") return null;
      if (name === "metadata" && value !== "read") return null;
      if (name === "workflows" && value !== "write") return null;
      permissions[name] = value;
    }
    if (permissions.contents === undefined) return null;
    /** @type {Record<string, unknown>} */
    const grant = {
      version: 1,
      appId,
      installationId,
      appSlug,
      expiresAt: authentication.expiresAt,
      permissions,
    };
    const ids = authentication.repositoryIds;
    const names = authentication.repositoryNames;
    if (ids !== undefined) {
      if (
        !Array.isArray(ids) || ids.length < 1 || ids.length > maxRepositories ||
        !ids.every(positiveId) || new Set(ids).size !== ids.length
      ) return null;
      grant.repositoryIds = ids.slice();
    }
    if (names !== undefined) {
      if (
        !Array.isArray(names) || names.length < 1 ||
        names.length > maxRepositories ||
        !names.every((name) =>
          typeof name === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(name)
        ) || new Set(names.map((name) =>
            name.toLowerCase()
          )).size !== names.length
      ) return null;
      grant.repositoryNames = names.slice();
    }
    if (
      Array.isArray(ids) && Array.isArray(names) && ids.length !== names.length
    ) {
      return null;
    }
    const output = JSON.stringify(grant);
    return new TextEncoder().encode(output).length <= maxOutputBytes
      ? output
      : null;
  } catch {
    // Optional metadata cannot prevent ordinary token cleanup or expose input.
    return null;
  }
}
