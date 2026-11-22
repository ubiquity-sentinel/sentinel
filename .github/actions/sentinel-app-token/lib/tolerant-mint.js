// @ts-check

/**
 * Sentinel adaptation, selected only by the explicit
 * `tolerate-inaccessible-repositories: "true"` input of a repository mint.
 *
 * The exact upstream request pair runs first, so a list whose every name is
 * reachable mints byte-identically with no extra request. Only GitHub's own
 * refusal of the list (HTTP 422 "...not accessible to the parent
 * installation", or a first-name installation lookup that is missing or
 * belongs to another account) starts a bounded bisection by probe mints for
 * subsets of the same list with the same permissions, against the requested
 * owner's own installation. Each probe is narrower than the list, is never
 * output and is revoked at once. The final token covers exactly the reachable
 * names; the scope is never widened and permissions are unchanged.
 *
 * Fail closed, as before: no reachable name, more dropped names than
 * `maxDroppedRepositories(list)`, a spent probe bound, an installation of any
 * other account, or a token naming a repository outside the request.
 *
 * `known-unavailable` (an earlier job's `unavailable-repositories`) may only
 * remove listed names before the first request; it counts toward the bound.
 */

/** Probe mints one tolerant mint may spend before it fails. */
export const MAX_PROBE_MINTS = 64;
/** At most this many listed names may be dropped, and never over a quarter. */
export const MAX_DROPPED_REPOSITORIES = 3;

const inaccessibleMessage = "not accessible to the parent installation";

/**
 * One rename, transfer, deletion or uninstall costs one name. More than three,
 * or more than a quarter of a short list, is an installation-wide change or a
 * partial GitHub view: the mint fails instead of silently shrinking the fleet.
 *
 * @param {number} listed
 */
export function maxDroppedRepositories(listed) {
  return Math.min(MAX_DROPPED_REPOSITORIES, Math.floor(listed / 4));
}

/** @param {unknown} error */
export function isInaccessibleRepositoryError(error) {
  if (typeof error !== "object" || error === null) return false;
  const value = /** @type {Record<string, any>} */ (error);
  const message = value.response?.data?.message;
  return value.status === 422 && typeof message === "string" &&
    message.includes(inaccessibleMessage);
}

/**
 * True only for an installation record of exactly the requested account.
 *
 * @param {unknown} data
 * @param {string} owner
 */
function ownedInstallation(data, owner) {
  if (typeof data !== "object" || data === null) return false;
  const value = /** @type {Record<string, any>} */ (data);
  const login = value.account?.login;
  return Number.isSafeInteger(value.id) && value.id > 0 &&
    typeof login === "string" && login.toLowerCase() === owner.toLowerCase();
}

/** @param {string} name */
const key = (name) => name.toLowerCase();

/**
 * Names of `hint` (`owner/name` or `name`, comma or newline separated) that
 * are in `names` under `owner`; anything else is ignored.
 *
 * @param {string} hint
 * @param {string} owner
 * @param {string[]} names
 * @returns {Set<string>}
 */
export function hintedUnavailable(hint, owner, names) {
  const listed = new Set(names.map(key));
  /** @type {Set<string>} */
  const hinted = new Set();
  for (const item of hint.split(/[\n,]+/).map((part) => part.trim())) {
    const parts = item.split("/");
    const name = parts.length === 2 && key(parts[0]) === key(owner)
      ? parts[1]
      : parts.length === 1
      ? parts[0]
      : "";
    if (name !== "" && listed.has(key(name))) hinted.add(key(name));
  }
  return hinted;
}

/**
 * @param {import("@octokit/request").request} request
 * @param {any} auth
 * @param {string} owner
 * @param {string[]} listed
 * @param {undefined | Record<string, string>} permissions
 * @param {(auth: any, installation: any, permissions: any, options?: Record<string, unknown>) => Promise<any>} createResult
 * @param {import("@actions/core")} core
 * @param {string} [hint]
 */
export async function getTolerantTokenFromRepository(
  request,
  auth,
  owner,
  listed,
  permissions,
  createResult,
  core,
  hint = "",
) {
  const bound = maxDroppedRepositories(listed.length);
  const hinted = hintedUnavailable(hint, owner, listed);
  if (hinted.size > bound) throw tooMany();
  const names = listed.filter((name) => !hinted.has(key(name)));
  if (names.length === 0) throw noneReachable();
  /** @type {any} */
  let installation = null;
  try {
    // A transferred repository redirects to its new owner's installation:
    // never follow, and accept only the requested account's installation.
    const response = await request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo: names[0],
      request: { hook: auth.hook, redirect: "manual" },
    });
    if (ownedInstallation(response.data, owner)) installation = response.data;
  } catch (error) {
    if (/** @type {any} */ (error)?.status !== 404) throw error;
  }
  if (installation !== null) {
    try {
      const result = await createResult(auth, installation, permissions, {
        repositoryNames: names,
      });
      return await withinRequest(request, core, result, names, listed);
    } catch (error) {
      if (!isInaccessibleRepositoryError(error)) throw error;
    }
  } else {
    // The first name is unreachable: the owner's own installation lookup.
    const response = await request("GET /users/{username}/installation", {
      username: owner,
      request: { hook: auth.hook, redirect: "manual" },
    });
    if (!ownedInstallation(response.data, owner)) {
      throw new Error("The owner installation belongs to another account");
    }
    installation = response.data;
  }
  const search = { probes: 0, dropped: hinted.size, bound };
  /** @type {string[]} */
  const reachable = [];
  for (const half of split(names)) {
    reachable.push(
      ...await reachableNames(
        request,
        auth,
        installation.id,
        half,
        permissions,
        search,
        core,
      ),
    );
  }
  if (reachable.length === 0) throw noneReachable();
  const result = await createResult(auth, installation, permissions, {
    repositoryNames: reachable,
    refresh: true,
  });
  return await withinRequest(request, core, result, reachable, listed);
}

/**
 * The minted token may name only requested repositories; otherwise it is
 * revoked and the mint fails.
 *
 * @param {import("@octokit/request").request} request
 * @param {import("@actions/core")} core
 * @param {any} result
 * @param {string[]} requested
 * @param {string[]} listed
 */
async function withinRequest(request, core, result, requested, listed) {
  const allowed = new Set(requested.map(key));
  const minted = result.authentication.repositoryNames;
  if (
    minted !== undefined &&
    (!Array.isArray(minted) ||
      !minted.every((name) =>
        typeof name === "string" && allowed.has(key(name))
      ))
  ) {
    await revoke(request, core, result.authentication.token);
    throw new Error("The minted token names a repository outside the request");
  }
  const unavailable = listed.filter((name) => !allowed.has(key(name)));
  return { ...result, unavailable };
}

function tooMany() {
  return new Error("Too many listed repositories are inaccessible");
}

function noneReachable() {
  return new Error("No listed repository is accessible to the installation");
}

/** @param {string[]} names @returns {string[][]} */
function split(names) {
  if (names.length < 2) return [names];
  const middle = Math.ceil(names.length / 2);
  return [names.slice(0, middle), names.slice(middle)];
}

/**
 * @param {import("@octokit/request").request} request
 * @param {import("@actions/core")} core
 * @param {string} token
 */
async function revoke(request, core, token) {
  core.setSecret(token);
  try {
    await request("DELETE /installation/token", {
      headers: { authorization: `token ${token}` },
    });
  } catch {
    core.warning("Probe token revocation failed");
  }
}

/**
 * @param {import("@octokit/request").request} request
 * @param {any} auth
 * @param {number} installationId
 * @param {string[]} names
 * @param {undefined | Record<string, string>} permissions
 * @param {{ probes: number, dropped: number, bound: number }} search
 * @param {import("@actions/core")} core
 * @returns {Promise<string[]>}
 */
async function reachableNames(
  request,
  auth,
  installationId,
  names,
  permissions,
  search,
  core,
) {
  if (search.probes >= MAX_PROBE_MINTS) {
    throw new Error("Inaccessible repository search exceeded its bound");
  }
  search.probes += 1;
  let probe;
  try {
    probe = await auth({
      type: "installation",
      installationId,
      repositoryNames: names,
      permissions,
      refresh: true,
    });
  } catch (error) {
    if (!isInaccessibleRepositoryError(error)) throw error;
    if (names.length === 1) {
      search.dropped += 1;
      if (search.dropped > search.bound) throw tooMany();
      return [];
    }
    /** @type {string[]} */
    const reachable = [];
    for (const half of split(names)) {
      reachable.push(
        ...await reachableNames(
          request,
          auth,
          installationId,
          half,
          permissions,
          search,
          core,
        ),
      );
    }
    return reachable;
  }
  await revoke(request, core, probe.token);
  return names;
}
