import { isGitSha } from "../src/contracts/brands.ts";
import type {
  HostedAutonomyHeadPullV1,
  HostedAutonomyPullV1,
} from "./hosted-autonomy-types.ts";

/**
 * Parse one raw `GET /pulls?state=all&head=<owner>:<branch>` page into the
 * exact-branch pull identities. The listing is refused (null) unless it can
 * be proven complete and exact: a full page may hide more pulls, and every
 * item must be a well-formed pull of THIS repository (never a fork) whose
 * head ref is exactly the requested branch. `merged` is derived from GitHub's
 * own `merged_at` instant, which the list endpoint always carries.
 */
export function parseHostedAutonomyHeadPulls(
  raw: unknown,
  scope: string,
  branch: string,
  pageSize: number,
): HostedAutonomyHeadPullV1[] | null {
  if (!Array.isArray(raw) || raw.length >= pageSize) return null;
  const pulls: HostedAutonomyHeadPullV1[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return null;
    const obj = entry as Record<string, unknown>;
    const head = obj["head"] as Record<string, unknown> | null | undefined;
    const base = obj["base"] as Record<string, unknown> | null | undefined;
    const repo = head?.["repo"] as Record<string, unknown> | null | undefined;
    const user = obj["user"] as Record<string, unknown> | null | undefined;
    const number = obj["number"];
    const state = obj["state"];
    const mergedAt = obj["merged_at"];
    const headSha = head?.["sha"];
    const baseRef = base?.["ref"];
    if (
      typeof number !== "number" || !Number.isSafeInteger(number) ||
      number <= 0 || (state !== "open" && state !== "closed") ||
      head?.["ref"] !== branch || repo?.["full_name"] !== scope ||
      typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha) ||
      typeof baseRef !== "string" || baseRef.length === 0 ||
      (mergedAt !== null && typeof mergedAt !== "string")
    ) {
      return null;
    }
    const login = user?.["login"];
    pulls.push({
      number,
      state,
      merged: typeof mergedAt === "string",
      headSha,
      headRef: branch,
      baseRef,
      author: typeof login === "string" ? login : null,
    });
  }
  return pulls;
}

/**
 * Parse one raw `GET /pulls/{number}` response into the remote merge facts the
 * helper needs. GitHub assigns `merge_commit_sha` only once a pull is merged,
 * so an unmerged pull legitimately carries it as null (or omits it); a merged
 * pull must name its merge commit. `parents` and `revisionOnBaseBranch` are
 * resolved afterwards by the live reader from the commit and compare
 * endpoints, so this parse stays pure.
 */
export function parseHostedAutonomyPull(
  raw: unknown,
): HostedAutonomyPullV1 | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const head = obj["head"] as Record<string, unknown> | undefined;
  const base = obj["base"] as Record<string, unknown> | undefined;
  const user = obj["user"] as Record<string, unknown> | undefined;
  const merger = obj["merged_by"] as Record<string, unknown> | undefined;
  const merged = obj["merged"] === true;
  const mergeCommitSha = obj["merge_commit_sha"];
  const headSha = head?.["sha"];
  const baseRef = base?.["ref"];
  const baseSha = base?.["sha"];
  if (typeof headSha !== "string" || typeof baseRef !== "string") return null;
  if (merged && typeof mergeCommitSha !== "string") return null;
  return {
    number: Number(obj["number"]),
    state: String(obj["state"] ?? ""),
    merged,
    mergeCommitSha: typeof mergeCommitSha === "string" ? mergeCommitSha : null,
    headSha,
    baseRef,
    baseSha: typeof baseSha === "string" ? baseSha : null,
    author: typeof user?.["login"] === "string" ? String(user["login"]) : null,
    ...(obj["merged_by"] === undefined ? {} : {
      mergedBy: typeof merger?.["login"] === "string" ? merger["login"] : null,
    }),
    parents: [],
    revisionOnBaseBranch: false,
    baseAncestorOfRevision: false,
    // GitHub computes `mergeable` lazily: null until it is known. A response
    // without the field (never a live pull read) leaves it absent.
    ...(obj["mergeable"] === undefined ? {} : {
      mergeable: typeof obj["mergeable"] === "boolean"
        ? obj["mergeable"]
        : null,
    }),
  };
}
/**
 * True only when the exact revision is integrated into the base branch, with
 * the SAME evidence the runtime's own release verifier reads from
 * `compare/{revision}...{baseBranch}`: the base commit and merge base of that
 * comparison must be the revision itself, and the status must be `ahead`
 * (base branch contains it and moved on) or `identical` (it is the tip).
 * `behind`/`diverged` and any malformed shape are definitive negatives.
 */
export function revisionIntegratedIntoBase(
  compare: unknown,
  revision: string,
): boolean {
  if (compare === null || typeof compare !== "object") return false;
  const obj = compare as Record<string, unknown>;
  const status = obj["status"];
  if (status !== "ahead" && status !== "identical") return false;
  const baseCommit = obj["base_commit"];
  const mergeBase = obj["merge_base_commit"];
  if (
    baseCommit === null || typeof baseCommit !== "object" ||
    mergeBase === null || typeof mergeBase !== "object"
  ) {
    return false;
  }
  return (baseCommit as Record<string, unknown>)["sha"] === revision &&
    (mergeBase as Record<string, unknown>)["sha"] === revision;
}

/** Largest file `readFileAt` reads whole (the cap's sources are tens of KB). */
export const READ_FILE_AT_MAX_BYTES = 256 * 1024;

/** A plain repository path: safe segments, none of them `.` or `..`. */
const PLAIN_PATH =
  /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** Git's object id of a blob holding exactly `bytes`. */
async function blobId(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", object));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The surface member `readFileAt` for one repository (see its contract in
 * `HostedAutonomyGitHubV1`): the contents API at exactly `revision`, read as
 * JSON, so the answer names its own type, path, size and blob id. Only a
 * regular file at exactly `path`, at most `READ_FILE_AT_MAX_BYTES`, whose
 * decoded bytes have that size and hash to that blob id and decode as UTF-8,
 * is returned; anything else is null.
 */
export function createReadFileAt(
  request: (
    method: string,
    path: string,
    body?: Record<string, unknown>,
    maxBytes?: number,
  ) => Promise<unknown | null>,
  scope: string,
): (path: string, revision: string) => Promise<string | null> {
  return async (path, revision) => {
    if (!isGitSha(revision) || !PLAIN_PATH.test(path)) return null;
    const raw = await request(
      "GET",
      `/repos/${scope}/contents/${path}?ref=${revision}`,
    );
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const file = raw as Record<string, unknown>;
    const size = file["size"];
    const content = file["content"];
    const sha = file["sha"];
    if (
      file["type"] !== "file" || file["path"] !== path ||
      file["encoding"] !== "base64" || typeof content !== "string" ||
      typeof sha !== "string" || !isGitSha(sha) ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
      size > READ_FILE_AT_MAX_BYTES
    ) return null;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(
        atob(content.replace(/\s/g, "")),
        (char) => char.charCodeAt(0),
      );
    } catch {
      return null;
    }
    if (bytes.length !== size || await blobId(bytes) !== sha) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };
}
