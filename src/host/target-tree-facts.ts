/**
 * Trusted target-tree fact reads (owner directive 2026-11-01: repair every
 * ubiquity repository). One bounded GitHub contents read proves the target's
 * toolchain markers, per-manifest script/task names and whether its own CI runs
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
const MAX_WORKFLOW_FILES = 50;

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

/** Task/script names of one manifest; malformed text carries no scripts. */
function manifestNames(text: string, field: "scripts" | "tasks"): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncExtras(text.replace(/^\uFEFF/, "")));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  const entries = record[field];
  if (typeof entries !== "object" || entries === null) return [];
  return Object.keys(entries);
}

/**
 * Resolve one target's tree facts from its exact default branch through the
 * trusted GitHub read port. Any read that cannot prove an answer returns
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
      .filter((entry) => entry.type === "file" && /\.ya?ml$/i.test(entry.name))
      .slice(0, MAX_WORKFLOW_FILES);
    for (const workflow of workflows) {
      const text = await readContentsText(
        options.http,
        options.token,
        contentsUrl(target, branch, workflow.path),
      );
      if (text === null) return null;
      if (workflowHasPullRequestTriggerV1(text) === true) return true;
    }
    return false;
  }

  return async (target, defaultBranch) => {
    const root = await readContents(
      options.http,
      options.token,
      contentsUrl(target, defaultBranch, ""),
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
    if (roots.has("package.json")) {
      const text = await readContentsText(
        options.http,
        options.token,
        contentsUrl(target, defaultBranch, "package.json"),
      );
      if (text === null) return null;
      manifestScripts.package = manifestNames(text, "scripts");
    }
    const denoTasks = new Set<string>();
    for (const manifest of ["deno.json", "deno.jsonc"]) {
      if (!roots.has(manifest)) continue;
      const text = await readContentsText(
        options.http,
        options.token,
        contentsUrl(target, defaultBranch, manifest),
      );
      if (text === null) return null;
      for (const name of manifestNames(text, "tasks")) denoTasks.add(name);
    }
    if (roots.has("deno.json") || roots.has("deno.jsonc")) {
      manifestScripts.deno = [...denoTasks];
    }
    let sentinelProtected: readonly string[] | undefined;
    if (roots.has(SENTINEL_PROTECTED_LIST_FILE)) {
      const text = await readContentsText(
        options.http,
        options.token,
        contentsUrl(target, defaultBranch, SENTINEL_PROTECTED_LIST_FILE),
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
    const hasCiWorkflow = await detectCiWorkflow(target, defaultBranch);
    if (hasCiWorkflow === null) return null;
    return {
      files,
      hasCiWorkflow,
      manifestScripts,
      ...(sentinelProtected === undefined ? {} : { sentinelProtected }),
    };
  };
}
