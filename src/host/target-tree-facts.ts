/**
 * Trusted target-tree fact reads (owner directive 2026-11-01: repair every
 * ubiquity repository). Bounded, revision-pinned contents reads prove toolchain
 * markers, per-manifest script/task names and whether the target's own CI runs
 * on pull requests. A read that cannot prove its answer returns `null`, and the
 * loader skips that generic target exactly like an unreadable default branch: a
 * policy is never rebuilt from an assumed tree. An owner-declared
 * `sentinel.protected` boundary that cannot be proven refuses the target
 * outright. Only named policies (Sentinel, Passport, Gateway) skip these reads.
 */
import type { HttpTransportV1 } from "../github/http.ts";
import { workflowHasPullRequestTriggerV1 } from "./target-workflow-scan.ts";
import {
  parseSentinelProtectedListV1,
  SENTINEL_PROTECTED_LIST_FILE,
  type TargetTreeFactsV1,
} from "./target-policy-generic.ts";

/**
 * A target whose declared protection cannot be read must be skipped, never
 * rebuilt without it: an owner-declared boundary is not optional.
 */
export class TargetTreeFactsRefusedV1 extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TargetTreeFactsRefusedV1";
  }
}

/** The exact repository coordinates a contents read needs. */
export interface TargetCoordinatesV1 {
  readonly owner: string;
  readonly name: string;
}

/** One top-level entry of a GitHub contents listing. */
interface ContentsEntryV1 {
  readonly type: string;
  readonly name: string;
  readonly path: string;
}

/** One bounded contents read: status plus the parsed JSON value. */
interface ContentsAnswerV1 {
  readonly status: number;
  readonly body: unknown;
}

/** At most this many workflow files are read to find a pull_request trigger. */
const MAX_WORKFLOW_FILES = 10;

interface CachedTreeFactsV1 {
  readonly sha: string;
  readonly facts: Promise<TargetTreeFactsV1 | null>;
}

// Hosted config loads recreate both transports and resolvers within a run.
// Share facts for this process only, keeping the latest SHA per API, credential
// and target. Every lookup must still prove the current head with that credential.
const treeFactsByRun = new Map<string, CachedTreeFactsV1>();

function treeFactsHeaders(token: string): ReadonlyMap<string, string> {
  return new Map([
    ["authorization", `Bearer ${token}`],
    ["accept", "application/vnd.github+json"],
    ["x-github-api-version", "2022-11-28"],
  ]);
}

async function readContents(
  http: HttpTransportV1,
  token: string,
  url: string,
): Promise<ContentsAnswerV1 | null> {
  let response;
  try {
    response = await http({
      method: "GET",
      url,
      headers: treeFactsHeaders(token),
      body: null,
    });
  } catch {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(response.bodyText);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function contentsEntries(value: unknown): ContentsEntryV1[] | null {
  if (!Array.isArray(value)) return null;
  const entries: ContentsEntryV1[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.type !== "string" || typeof entry.name !== "string") {
      return null;
    }
    entries.push({
      type: entry.type,
      name: entry.name,
      path: typeof entry.path === "string" ? entry.path : entry.name,
    });
  }
  return entries;
}

/** Decode one base64 contents entry; null means the facts are unreadable. */
async function readContentsText(
  http: HttpTransportV1,
  token: string,
  url: string,
): Promise<string | null> {
  const answer = await readContents(http, token, url);
  if (answer === null || answer.status !== 200) return null;
  if (typeof answer.body !== "object" || answer.body === null) return null;
  const file = answer.body as Record<string, unknown>;
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    return null;
  }
  try {
    const binary = atob(file.content.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Normalize JSONC outside strings: drop comments and trailing commas so Deno's
 * own config dialect (`deno.json` and `deno.jsonc` both allow both) parses.
 */
function stripJsoncExtras(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      index += 2;
      while (
        index < text.length && !(text[index] === "*" && text[index + 1] === "/")
      ) index += 1;
      index += 1;
    } else if (ch === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead]!)) {
        lookahead += 1;
      }
      // A comma before `}` or `]` is a trailing comma, not a separator.
      if (text[lookahead] !== "}" && text[lookahead] !== "]") out += ch;
    } else out += ch;
  }
  return out;
}

/** Manifest fields; malformed text carries no declarations. */
function parseManifest(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncExtras(text.replace(/^\uFEFF/, "")));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  return parsed as Record<string, unknown>;
}

/** Task/script names of one manifest. */
function manifestNames(
  manifest: Record<string, unknown>,
  field: "scripts" | "tasks",
): string[] {
  const entries = manifest[field];
  if (typeof entries !== "object" || entries === null) return [];
  return Object.keys(entries);
}

/**
 * Resolve one target's tree facts from its exact default-branch SHA through the
 * trusted GitHub read port. Successful facts are shared within this run; every
 * lookup rechecks the branch head. Any read that cannot prove an answer returns
 * `null` and the loader skips the target; it never defaults a policy from a
 * missing checkout. A declared `sentinel.protected` list that is unreadable or
 * malformed throws `TargetTreeFactsRefusedV1` so its protections are never
 * silently dropped.
 */
export function createTargetTreeFactsResolver(options: {
  readonly http: HttpTransportV1;
  readonly token: string;
  readonly apiBaseUrl?: string;
}): (
  target: TargetCoordinatesV1,
  defaultBranch: string,
) => Promise<TargetTreeFactsV1 | null> {
  const base = options.apiBaseUrl ?? "https://api.github.com";
  const contentsUrl = (
    target: TargetCoordinatesV1,
    branch: string,
    path: string,
  ) =>
    `${base}/repos/${target.owner}/${target.name}/contents${
      path === "" ? "" : `/${path}`
    }?ref=${encodeURIComponent(branch)}`;

  async function detectCiWorkflow(
    target: TargetCoordinatesV1,
    branch: string,
  ): Promise<boolean | null> {
    const listing = await readContents(
      options.http,
      options.token,
      contentsUrl(target, branch, ".github/workflows"),
    );
    // A missing directory is the explicit no-CI answer.
    if (listing === null) return null;
    if (listing.status === 404) return false;
    if (listing.status !== 200) return null;
    const entries = contentsEntries(listing.body);
    if (entries === null) return null;
    const workflows = entries
      .filter((entry) => entry.type === "file" && /\.ya?ml$/i.test(entry.name));
    for (const workflow of workflows.slice(0, MAX_WORKFLOW_FILES)) {
      const text = await readContentsText(
        options.http,
        options.token,
        contentsUrl(target, branch, workflow.path),
      );
      if (text === null) return null;
      if (workflowHasPullRequestTriggerV1(text) === true) return true;
    }
    // Exhausting the read budget is not proof that the remaining files have
    // no PR trigger. Skip this target rather than defaulting its CI policy.
    return workflows.length > MAX_WORKFLOW_FILES ? null : false;
  }

  async function resolveFacts(
    target: TargetCoordinatesV1,
    revision: string,
  ): Promise<TargetTreeFactsV1 | null> {
    const root = await readContents(
      options.http,
      options.token,
      contentsUrl(target, revision, ""),
    );
    if (root === null || root.status !== 200) return null;
    const entries = contentsEntries(root.body);
    if (entries === null) return null;
    const files = entries.filter((entry) => entry.type === "file").map((
      entry,
    ) => entry.name);
    const roots = new Set(files);
    // Keep each manifest's names separate: verify must run only a name the
    // detected toolchain's own manifest declares.
    const manifestScripts: { package?: string[]; deno?: string[] } = {};
    let packageManager: string | undefined;
    if (roots.has("package.json")) {
      const text = await readContentsText(
        options.http,
        options.token,
        contentsUrl(target, revision, "package.json"),
      );
      if (text === null) return null;
      const manifest = parseManifest(text);
      manifestScripts.package = manifestNames(manifest, "scripts");
      if (typeof manifest.packageManager === "string") {
        packageManager = manifest.packageManager;
      }
    }
    const denoTasks = new Set<string>();
    for (const manifest of ["deno.json", "deno.jsonc"]) {
      if (!roots.has(manifest)) continue;
      const text = await readContentsText(
        options.http,
        options.token,
        contentsUrl(target, revision, manifest),
      );
      if (text === null) return null;
      for (const name of manifestNames(parseManifest(text), "tasks")) {
        denoTasks.add(name);
      }
    }
    if (roots.has("deno.json") || roots.has("deno.jsonc")) {
      manifestScripts.deno = [...denoTasks];
    }
    let sentinelProtected: readonly string[] | undefined;
    if (roots.has(SENTINEL_PROTECTED_LIST_FILE)) {
      const text = await readContentsText(
        options.http,
        options.token,
        contentsUrl(target, revision, SENTINEL_PROTECTED_LIST_FILE),
      );
      if (text === null) {
        throw new TargetTreeFactsRefusedV1(
          `${SENTINEL_PROTECTED_LIST_FILE} is unreadable`,
        );
      }
      try {
        sentinelProtected = parseSentinelProtectedListV1(text);
      } catch {
        // An unusable protected list cannot be widened away: skip the target.
        throw new TargetTreeFactsRefusedV1(
          `${SENTINEL_PROTECTED_LIST_FILE} is malformed`,
        );
      }
    }
    const hasCiWorkflow = await detectCiWorkflow(target, revision);
    if (hasCiWorkflow === null) return null;
    return {
      files,
      hasCiWorkflow,
      manifestScripts,
      ...(packageManager === undefined ? {} : { packageManager }),
      ...(sentinelProtected === undefined ? {} : { sentinelProtected }),
    };
  }

  return async (target, defaultBranch) => {
    const head = await readContents(
      options.http,
      options.token,
      `${base}/repos/${target.owner}/${target.name}/commits/${
        encodeURIComponent(defaultBranch)
      }`,
    );
    if (head === null || head.status !== 200) return null;
    if (typeof head.body !== "object" || head.body === null) return null;
    const sha = (head.body as Record<string, unknown>).sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return null;

    const key = JSON.stringify([
      base,
      options.token,
      target.owner,
      target.name,
    ]);
    const cached = treeFactsByRun.get(key);
    if (cached?.sha === sha) return cached.facts;
    const entry = { sha, facts: resolveFacts(target, sha) };
    treeFactsByRun.set(key, entry);
    try {
      const facts = await entry.facts;
      if (facts === null && treeFactsByRun.get(key) === entry) {
        treeFactsByRun.delete(key);
      }
      return facts;
    } catch (error) {
      if (treeFactsByRun.get(key) === entry) treeFactsByRun.delete(key);
      throw error;
    }
  };
}
