/**
 * Generic target policy (owner directive 2026-11-01: repair every ubiquity
 * repository): one host-authored policy per target, derived only from facts a
 * trusted caller reads from the checked-out target tree. Slugs, issue text and
 * model output are never policy inputs.
 *
 * The no-test-evidence state is carried by the trusted, host-authored test
 * command id (`NO_TEST_EVIDENCE_COMMAND_ID`), so the CI-first gate can refuse a
 * review-only merge from the loaded repository configuration alone.
 */
import { asCommandId } from "../contracts/brands.ts";
import { parseCommandRegistryV1 } from "../contracts/command-registry.ts";
import type { CommandSpecV1 } from "../contracts/command-registry.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import { touchesProtected } from "../repair/loop-records.ts";

/** Toolchain families a target tree can declare. */
export type TargetToolchainV1 =
  | "deno"
  | "bun"
  | "npm"
  | "yarn"
  | "pnpm"
  | "forge"
  | "none";

/** Exact blocker for a record whose target offers no test evidence at all. */
export const NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER = "no_ci_and_no_local_verify";

/** Trusted test command id that marks a target with no test evidence. */
export const NO_TEST_EVIDENCE_COMMAND_ID = NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER;

/** Precise owner-facing park detail; the blocker id stays the exact prefix. */
export const NO_CI_AND_NO_LOCAL_VERIFY_DETAIL =
  `${NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER}: target has no pull_request CI workflow and no runnable local verify command; owner action required`;

/** Optional list a target's own root may carry with extra protected prefixes. */
export const SENTINEL_PROTECTED_LIST_FILE = "sentinel.protected";

/**
 * Script/task names per manifest. Verify reads only the selected manifest of
 * the detected toolchain, never a union across manifests.
 */
export interface TargetManifestScriptsV1 {
  /** Task names of `deno.json`/`deno.jsonc`. */
  readonly deno?: readonly string[];
  /** Script names of `package.json`. */
  readonly package?: readonly string[];
}

/**
 * Facts from the checked-out target tree. Detection reads only top-level
 * markers and the root package manifest. `manifestScripts` keeps names separate
 * so verify never charges a script the repository lacks in that toolchain.
 */
export interface TargetTreeFactsV1 {
  readonly files: readonly string[];
  /** True when `.github/workflows/` holds a workflow with a pull_request trigger. */
  readonly hasCiWorkflow: boolean;
  /** The root `package.json` declaration, ahead of lockfile/config markers. */
  readonly packageManager?: string;
  /**
   * Names of one manifest, for hand-built facts only. A loader must supply
   * `manifestScripts`; when it does, this field is ignored.
   */
  readonly scripts?: readonly string[];
  /** Script/task names per manifest; verify selects the detected toolchain's. */
  readonly manifestScripts?: TargetManifestScriptsV1;
  /** Parsed entries of the optional `sentinel.protected` list. */
  readonly sentinelProtected?: readonly string[];
}

/**
 * Credential, dispatch and history boundaries every generic target keeps.
 * `.env*` needs the family rule in `isGenericTargetProtectedPathV1`.
 */
export const GENERIC_TARGET_PROTECTED_PATHS: readonly string[] = Object.freeze([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".git/",
  ".github/workflows/",
  ".npmrc",
  ".secrets",
  ".actrc",
  ".vars",
  ".input",
  SENTINEL_PROTECTED_LIST_FILE,
]);

/** Verify bounds shared with the Gateway gate: 30 minutes, 4 MiB. */
const VERIFY_LIMITS = Object.freeze({
  maxDurationMs: 1_800_000,
  maxOutputBytes: 4_194_304,
});

/** Preferred script/task names, most complete first. */
const SCRIPT_PREFERENCE = [
  "verify",
  "test",
  "typecheck",
  "lint",
  "check",
] as const;

/** Fail-closed stand-in: a policy with no local verify never pretends to pass. */
const NO_LOCAL_VERIFY_COMMAND: CommandSpecV1 = Object.freeze({
  executable: "false",
  args: [],
  ...VERIFY_LIMITS,
});

const ROOT_MARKERS:
  readonly (readonly [TargetToolchainV1, readonly string[]])[] = Object.freeze([
    ["bun", ["bun.lockb", "bun.lock"]],
    ["npm", ["package-lock.json"]],
    ["yarn", ["yarn.lock"]],
    ["pnpm", ["pnpm-lock.yaml"]],
    ["deno", ["deno.json", "deno.jsonc"]],
    ["forge", ["foundry.toml"]],
  ]);

/** Prefer the root packageManager, then package lockfiles, then other markers. */
export function detectTargetToolchainV1(
  files: readonly string[],
  packageManager?: string,
): TargetToolchainV1 {
  const roots = new Set<string>();
  for (const file of files) {
    const name = topLevelName(file);
    if (name !== null) roots.add(name);
  }
  const declared = roots.has("package.json")
    ? packageManager?.match(/^(bun|npm|yarn|pnpm)@\S+$/)?.[1]
    : undefined;
  if (
    declared === "bun" || declared === "npm" || declared === "yarn" ||
    declared === "pnpm"
  ) return declared;
  for (const [toolchain, markers] of ROOT_MARKERS) {
    if (markers.some((marker) => roots.has(marker))) return toolchain;
  }
  return "none";
}

function topLevelName(path: string): string | null {
  const normalized = normalizePath(path);
  if (normalized === "" || normalized.includes("/")) return null;
  return normalized;
}

function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

/**
 * Parse the optional `sentinel.protected` file: a JSON string array or one
 * prefix per line (`#` comments allowed). A malformed or unsafe entry
 * (`/`, `..`, control characters) is refused rather than silently ignored.
 */
export function parseSentinelProtectedListV1(text: string): string[] {
  const invalid = new TypeError(
    `${SENTINEL_PROTECTED_LIST_FILE} contains an invalid path`,
  );
  const trimmed = text.trim();
  const raw: unknown[] = [];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw invalid;
    }
    if (!Array.isArray(parsed)) throw invalid;
    raw.push(...parsed);
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const entry = line.replace(/#.*$/, "").trim();
      if (entry !== "") raw.push(entry);
    }
  }
  const entries: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") throw invalid;
    const normalized = normalizeProtectedEntry(value);
    if (normalized === null) throw invalid;
    if (!entries.includes(normalized)) entries.push(normalized);
  }
  return entries;
}

function normalizeProtectedEntry(value: string): string | null {
  const normalized = normalizePath(value.trim());
  if (
    normalized === "" || normalized.startsWith("/") ||
    normalized === ".." || normalized.startsWith("../") ||
    normalized.includes("/../") || normalized.endsWith("/..")
  ) return null;
  for (const ch of normalized) {
    const codePoint = ch.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      return null;
    }
  }
  if (normalized.split("/").some((segment) => segment === "..")) return null;
  return normalized;
}

/** The generic boundary plus the target's own `sentinel.protected` entries. */
export function genericTargetProtectedPathsV1(
  extra: readonly string[] = [],
): string[] {
  const paths = [...GENERIC_TARGET_PROTECTED_PATHS];
  // A target-supplied list is data, not authority: an unsafe entry is dropped
  // (never widened to `/`) and the fixed boundary still applies.
  for (const value of extra) {
    const normalized = normalizeProtectedEntry(value);
    if (normalized !== null && !paths.includes(normalized)) {
      paths.push(normalized);
    }
  }
  return paths;
}

/** Whether a repository-relative candidate path hits the generic boundary. */
export function isGenericTargetProtectedPathV1(
  path: string,
  extra: readonly string[] = [],
): boolean {
  const normalized = normalizePath(path);
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (base.startsWith(".env")) return true;
  return touchesProtected(genericTargetProtectedPathsV1(extra), normalized);
}

/**
 * How one target supplies merge test evidence. Merge evidence is CI, always:
 * a local-only verify run is a separate future decision, so a target without a
 * pull_request workflow has no merge evidence even when its verify command is
 * runnable. Such a target parks with `no_ci_and_no_local_verify`.
 */
export type GenericTargetMergeEvidenceV1 =
  | "target_ci"
  | "none";

/** Generic policy plus the facts a caller needs to park or proceed. */
export interface GenericTargetPolicyV1 {
  readonly adapter: RepositoryConfigV1["adapter"];
  readonly commands: RepositoryConfigV1["commands"];
  readonly commandRegistry: RepositoryConfigV1["commandRegistry"];
  readonly protectedPaths: string[];
  readonly toolchain: TargetToolchainV1;
  /** A runnable local verify command exists (reported, never merge evidence). */
  readonly localVerify: boolean;
  /** The target's own pull-request CI is the only merge evidence. */
  readonly mergeEvidence: GenericTargetMergeEvidenceV1;
  /** `NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER` when a review-only merge is refused. */
  readonly blocker: string | null;
}

/**
 * Build the generic policy for one target. A target without a pull_request CI
 * workflow has no merge test evidence: the record must park with the
 * `no_ci_and_no_local_verify` blocker instead of merging on review alone, even
 * when a local verify command exists. Nothing runs that command as merge
 * evidence today, so claiming it here (or admitting the review with zero checks)
 * would be a false green. Local-only verify is a separate future decision; any
 * future executor must run the toolchain's frozen install inside the cell first.
 */
export function createGenericTargetPolicyV1(
  facts: TargetTreeFactsV1,
): GenericTargetPolicyV1 {
  const toolchain = detectTargetToolchainV1(facts.files, facts.packageManager);
  const verify = verifyCommandFor(toolchain, facts);
  const localVerify = verify !== null;
  const mergeEvidence: GenericTargetMergeEvidenceV1 = facts.hasCiWorkflow
    ? "target_ci"
    : "none";
  // The id carries the evidence state: the CI-first gate reads it from the
  // loaded configuration and parks exactly the no-evidence target.
  const commandId = asCommandId(
    mergeEvidence === "none"
      ? NO_TEST_EVIDENCE_COMMAND_ID
      : localVerify
      ? "generic_verify"
      : "no_local_verify",
  );
  const commandRegistry = parseCommandRegistryV1({
    version: "v1",
    commands: { [commandId]: verify ?? NO_LOCAL_VERIFY_COMMAND },
  });
  // `.env*` is a family, not one literal: every env file the checkout shows is
  // added by its exact relative path so array-only consumers protect it too.
  const envFiles = facts.files.filter((file) => {
    const normalized = normalizePath(file);
    return normalized.slice(normalized.lastIndexOf("/") + 1).startsWith(".env");
  });
  return {
    adapter: { kind: "github" },
    commands: { test: commandId, replay: commandId },
    commandRegistry,
    protectedPaths: genericTargetProtectedPathsV1([
      ...(facts.sentinelProtected ?? []),
      ...envFiles,
    ]),
    toolchain,
    localVerify,
    mergeEvidence,
    blocker: mergeEvidence === "none"
      ? NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER
      : null,
  };
}

/** Whether a loaded target configuration has no test evidence at all. */
export function isNoTestEvidenceTargetV1(
  config: Pick<RepositoryConfigV1, "commands">,
): boolean {
  return config.commands.test === NO_TEST_EVIDENCE_COMMAND_ID;
}

/**
 * Command ids this module emits. They identify a configuration that carries the
 * generic policy, so the enforcement boundary below can be family-aware only
 * for generic targets and leave every named policy byte-identical.
 */
const GENERIC_TEST_COMMAND_IDS: readonly string[] = Object.freeze([
  NO_TEST_EVIDENCE_COMMAND_ID,
  "generic_verify",
  "no_local_verify",
]);

/** Whether one loaded configuration carries the generic target policy. */
export function isGenericTargetConfigV1(
  config: Pick<RepositoryConfigV1, "commands">,
): boolean {
  return GENERIC_TEST_COMMAND_IDS.includes(config.commands.test);
}

/**
 * The production enforcement boundary for one loaded target. Generic targets
 * use the family-aware predicate (nested `.env*` included); every other target
 * keeps the unchanged literal `touchesProtected` predicate.
 */
export function targetTouchesProtectedV1(
  config: Pick<RepositoryConfigV1, "commands" | "protectedPaths">,
  path: string,
): boolean {
  if (isGenericTargetConfigV1(config)) {
    return isGenericTargetProtectedPathV1(path, config.protectedPaths);
  }
  return touchesProtected(config.protectedPaths, path);
}

/**
 * Only the detected toolchain's own manifest may supply the verify name: a
 * `deno.json` target never runs a `package.json` script as `deno task`, and a
 * package-manager target never runs a Deno task as `npm run`.
 */
function manifestScriptNames(
  toolchain: TargetToolchainV1,
  facts: TargetTreeFactsV1,
): readonly string[] {
  if (facts.manifestScripts === undefined) return facts.scripts ?? [];
  return (toolchain === "deno"
    ? facts.manifestScripts.deno
    : facts.manifestScripts.package) ?? [];
}

function verifyCommandFor(
  toolchain: TargetToolchainV1,
  facts: TargetTreeFactsV1,
): CommandSpecV1 | null {
  if (toolchain === "none") return null;
  if (toolchain === "forge") {
    return { executable: "forge", args: ["test"], ...VERIFY_LIMITS };
  }
  const scripts = manifestScriptNames(toolchain, facts);
  const script = SCRIPT_PREFERENCE.find((name) => scripts.includes(name));
  if (script === undefined) return null;
  switch (toolchain) {
    case "deno":
      return { executable: "deno", args: ["task", script], ...VERIFY_LIMITS };
    case "bun":
      return {
        executable: "bun",
        args: ["--no-env-file", "run", script],
        ...VERIFY_LIMITS,
      };
    case "npm":
    case "yarn":
    case "pnpm":
      return { executable: toolchain, args: ["run", script], ...VERIFY_LIMITS };
  }
}
