/**
 * The committed target-repository setting.
 *
 * `sentinel.targets.json` is the ONLY source of the repositories this
 * deployment may repair. It is a plain array of `owner/name` slugs and nothing
 * else: per-repository conventions (commands, protected paths, session bounds,
 * live-start limits) come from trusted host policy, and the base branch of a
 * target is that repository's own default branch, read from GitHub — never a
 * value in the file and never a hard-coded constant here.
 *
 * The file is a protected path: a model worker may not edit it. If it is
 * absent, empty, malformed, over the bound or duplicated, the deployment has
 * NO targets and repairs nothing. There is no built-in fallback repository, so
 * an unusable setting can never silently restore the previously welded target.
 *
 * This module is pure apart from the two injected capabilities (file read and
 * default-branch resolution), so every rejection is testable without network.
 */

import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import type { GitHubCooldownGateV1 } from "../contracts/ports.ts";
import {
  isGenericTargetRepositoryV1,
  selectTrustedTargetPolicyV1,
} from "./target-policy.ts";
import type { TargetTreeFactsV1 } from "./target-policy-generic.ts";
import {
  createTargetTreeFactsResolver,
  TargetTreeFactsRefusedV1,
} from "./target-tree-facts.ts";
export type { TargetTreeFactsV1 } from "./target-policy-generic.ts";
export {
  createTargetTreeFactsResolver,
  TargetTreeFactsRefusedV1,
} from "./target-tree-facts.ts";

/** Exact committed setting file name, relative to the runtime checkout root. */
export const TARGETS_FILE_NAME = "sentinel.targets.json";

/**
 * Finite configuration/fan-out guard, not a worker-admission limit. Doubling to
 * 64 leaves headroom beyond the 30-target rollout while bounding per-target
 * setup and coordination. More targets do not add authoritative state writers:
 * one coordinator still serializes authoritative operations; only native
 * session settlement overlaps. The shared absolute deadline and existing
 * admission/session safeguards remain unchanged.
 */
export const TARGETS_MAX = 64;

/** Static settings failure shared by every rejection path. */
export const STATIC_TARGETS_INVALID =
  "committed target setting is not a valid repository slug array";

/**
 * The setting authorizes nothing, so the deployment may repair nothing. This is
 * a refusal, never a quiet idle: an absent, empty or unusable setting must be
 * visible instead of looking like "no work today".
 */
export const STATIC_TARGETS_EMPTY =
  "committed target setting lists no repository";

/**
 * The setting does not include the repository this host addresses. The
 * composed GitHub port, candidate restorer and release path each own exactly
 * one repository, so running would act on a repository the setting does not
 * authorize. Refuse instead.
 */
export const STATIC_TARGETS_UNSUPPORTED =
  "committed target setting does not include the repository this host addresses";

const SLUG =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** One validated slug. Always the exact text from the committed file. */
export interface TargetSlugV1 {
  readonly slug: string;
  readonly owner: string;
  readonly name: string;
}

/**
 * Validate the committed array. Throws the static settings error for anything
 * that is not a bounded, duplicate-free array of `owner/name` slugs.
 */
export function parseTargetSlugsV1(input: unknown): TargetSlugV1[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(STATIC_TARGETS_INVALID);
  }
  if (input.length > TARGETS_MAX) throw new TypeError(STATIC_TARGETS_INVALID);
  const seen = new Set<string>();
  const targets: TargetSlugV1[] = [];
  for (const item of input) {
    if (typeof item !== "string" || !SLUG.test(item)) {
      throw new TypeError(STATIC_TARGETS_INVALID);
    }
    const slash = item.indexOf("/");
    const owner = item.slice(0, slash);
    const name = item.slice(slash + 1);
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    if (seen.has(key)) throw new TypeError(STATIC_TARGETS_INVALID);
    seen.add(key);
    targets.push({ slug: item, owner, name });
  }
  return targets;
}

/** Read and validate the committed setting. Any failure yields no targets. */
export async function readTargetSlugsV1(options: {
  readonly root?: string;
  readonly readFile?: (path: string) => Promise<string>;
} = {}): Promise<TargetSlugV1[]> {
  const root = options.root ?? ".";
  const path = `${root}/${TARGETS_FILE_NAME}`;
  const readFile = options.readFile ??
    ((file: string) => Deno.readTextFile(file));
  let text: string;
  try {
    text = await readFile(path);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  try {
    return parseTargetSlugsV1(parsed);
  } catch {
    return [];
  }
}

/**
 * Resolve one repository's default branch through the trusted GitHub API. The
 * caller supplies the authenticated transport; a non-200, unparsable or empty
 * answer is `null` and the target is then skipped rather than guessed.
 */
export function createDefaultBranchResolver(options: {
  readonly http: HttpTransportV1;
  readonly token: string;
  readonly apiBaseUrl?: string;
}): (target: TargetSlugV1) => Promise<string | null> {
  const base = options.apiBaseUrl ?? "https://api.github.com";
  return async (target) => {
    let response;
    try {
      response = await options.http({
        method: "GET",
        url: `${base}/repos/${target.owner}/${target.name}`,
        headers: new Map([
          ["authorization", `Bearer ${options.token}`],
          ["accept", "application/vnd.github+json"],
          ["x-github-api-version", "2022-11-28"],
        ]),
        body: null,
      });
    } catch {
      return null;
    }
    if (response.status !== 200) return null;
    try {
      const parsed = JSON.parse(response.bodyText) as {
        default_branch?: unknown;
      };
      const branch = parsed.default_branch;
      if (typeof branch !== "string" || branch.trim() === "") return null;
      return branch;
    } catch {
      return null;
    }
  };
}

/**
 * Put every target branch/fact read behind the same durable cooldown gate the
 * loader's other GitHub reads use. A refused gate makes the read fail closed
 * (the resolver returns `null` and the target is skipped), never a raw request.
 */
export function createGatedTargetReadTransport(options: {
  readonly http: HttpTransportV1;
  readonly gate: Pick<GitHubCooldownGateV1, "beforeRequest">;
  readonly installationId: number;
}): HttpTransportV1 {
  return async (request) => {
    const allowed = await options.gate.beforeRequest(options.installationId);
    if (!allowed.ok) throw new Error("target read refused by durable cooldown");
    return options.http(request);
  };
}

/** The two trusted GitHub reads one target configuration needs. */
export interface GitHubTargetResolversV1 {
  readonly resolveDefaultBranch: (
    target: TargetSlugV1,
  ) => Promise<string | null>;
  readonly resolveTreeFacts: (
    target: TargetSlugV1,
    defaultBranch: string,
  ) => Promise<TargetTreeFactsV1 | null>;
}

/**
 * Build both trusted resolvers for one credential. An injected resolver wins;
 * every omitted read uses the trusted GitHub transport.
 */
export function createGitHubTargetResolvers(options: {
  readonly http: HttpTransportV1;
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly readGate?: Pick<GitHubCooldownGateV1, "beforeRequest">;
  readonly installationId?: number;
  readonly resolveDefaultBranch?: GitHubTargetResolversV1[
    "resolveDefaultBranch"
  ];
  readonly resolveTreeFacts?: GitHubTargetResolversV1["resolveTreeFacts"];
}): GitHubTargetResolversV1 {
  // Tree-fact reads are the new contents calls this loader adds: put them
  // behind the run's durable cooldown gate. Default-branch reads keep their
  // existing transport.
  const factsHttp = options.readGate === undefined
    ? options.http
    : createGatedTargetReadTransport({
      http: options.http,
      gate: options.readGate,
      installationId: options.installationId ?? 0,
    });
  return {
    resolveDefaultBranch: options.resolveDefaultBranch ??
      createDefaultBranchResolver(options),
    resolveTreeFacts: options.resolveTreeFacts ??
      createTargetTreeFactsResolver({ ...options, http: factsHttp }),
  };
}

/**
 * Build one target from the deployment template and fixed host-authored
 * repository policy. A slug carries only identity: it can never introduce a
 * command, protected-path list or limit of its own.
 */
export function createTargetConfigV1(
  template: RepositoryConfigV1,
  target: TargetSlugV1,
  defaultBranch: string,
  facts?: TargetTreeFactsV1,
): RepositoryConfigV1 {
  const repository: RepositoryIdentityV1 = {
    owner: target.owner,
    name: target.name,
    installationId: template.repository.installationId,
  };
  return {
    ...template,
    ...selectTrustedTargetPolicyV1(template, repository, facts),
    repository,
    baseBranch: defaultBranch,
  };
}

export interface LoadTargetConfigsResultV1 {
  readonly targets: readonly TargetSlugV1[];
  readonly configs: readonly RepositoryConfigV1[];
  /** Slug of every target skipped because its default branch was unavailable. */
  readonly skipped: readonly string[];
  /** Slug of every target skipped because its tree facts were unavailable. */
  readonly factsUnavailable: readonly string[];
}

/**
 * Load the committed target setting into exact configuration objects. A target
 * whose default branch cannot be read is skipped (never defaulted); an empty
 * or invalid setting yields no configs at all.
 *
 * Tree facts are resolved only for generic targets. A caller without a
 * contents read (a restricted facade or maintenance publication) omits the
 * resolver, and a generic target then gets the facts-less generic policy
 * (generic credential boundary and family predicate, no local verify, CI-only
 * merge evidence). With a resolver, an unreadable answer or an unusable
 * `sentinel.protected` list skips the target exactly like an unreadable default
 * branch: it is never rebuilt without evidence it declared. Sentinel, Passport
 * and the Gateway keep their named policies and never spend a facts read.
 */
export async function loadTargetConfigsV1(options: {
  readonly template: RepositoryConfigV1;
  readonly resolveDefaultBranch: (
    target: TargetSlugV1,
  ) => Promise<string | null>;
  /** Exact tree facts for the resolved default branch; omitted means none. */
  readonly resolveTreeFacts?: (
    target: TargetSlugV1,
    defaultBranch: string,
  ) => Promise<TargetTreeFactsV1 | null>;
  readonly root?: string;
  readonly readFile?: (path: string) => Promise<string>;
}): Promise<LoadTargetConfigsResultV1> {
  const targets = await readTargetSlugsV1({
    root: options.root,
    readFile: options.readFile,
  });
  const configs: RepositoryConfigV1[] = [];
  const skipped: string[] = [];
  const factsUnavailable: string[] = [];
  for (const target of targets) {
    const branch = await options.resolveDefaultBranch(target);
    if (branch === null) {
      skipped.push(target.slug);
      continue;
    }
    const repository: RepositoryIdentityV1 = {
      owner: target.owner,
      name: target.name,
      installationId: options.template.repository.installationId,
    };
    let facts: TargetTreeFactsV1 | undefined;
    // Named policies (Sentinel, Passport, Gateway) ignore tree facts: never
    // spend a contents read (or its rate limit) on them. A generic target
    // skips when its facts cannot be read or its declared protection is
    // unusable; a facts-less generic policy is used only when no resolver was
    // supplied at all (a restricted facade without a contents read).
    if (
      isGenericTargetRepositoryV1(repository) &&
      options.resolveTreeFacts !== undefined
    ) {
      try {
        const resolved = await options.resolveTreeFacts(target, branch);
        if (resolved === null) {
          skipped.push(target.slug);
          factsUnavailable.push(target.slug);
          continue;
        }
        facts = resolved;
      } catch (error) {
        if (!(error instanceof TargetTreeFactsRefusedV1)) throw error;
        skipped.push(target.slug);
        factsUnavailable.push(target.slug);
        continue;
      }
    }
    configs.push(
      createTargetConfigV1(options.template, target, branch, facts),
    );
  }
  return { targets, configs, skipped, factsUnavailable };
}
