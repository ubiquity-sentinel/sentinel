import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { HOSTED_AUTHORITY_PROTECTED_PATHS } from "./hosted-authority-protected-paths.ts";
import {
  parseRepositoryConfigV1,
  type RepositoryConfigV1,
} from "../contracts/repository-config.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import {
  DEFAULT_IMPLEMENTATION_MODEL,
  LOCAL_BASE_BRANCH,
  LOCAL_REPOSITORY,
  MAX_MODEL_CHARS,
  STATIC_INVALID_CONTROLLER,
  STATIC_INVALID_OPTIONS,
  STATIC_ORPHAN,
  STATIC_UNSETTLED,
} from "./local-policy.ts";

/** Caller-supplied trusted inputs for one bounded local run. */
export interface LocalRepairHostOptionsV1 {
  stateRoot: string;
  sourceDir: string;
  controllerSha: GitSha;
  githubToken: string;
  modelToken: string;
  codexExecutable: string;
  denoExecutable: string;
  trustedPath: string;
  /**
   * Route-selected implementation model id for this run. Omitted callers keep
   * the frozen gateway default (`gpt-reserve`); the exact configured value is
   * what the implementation port submits and what the status envelope reports.
   */
  modelId?: string;
  /**
   * Retained structured-review configuration field. Native Codex review mode
   * owns reviewer selection; a model alias alone does not establish invocation
   * mode or authorize substituting a normal model turn. Existing field
   * validation and historical consumers remain unchanged.
   */
  reviewModelId?: string;
}

/** Outcome of one startup attempt. Busy is an explicit refusal, not a wait. */
export type LocalRepairHostRunV1 =
  | { status: "busy" }
  | { status: "ran"; outcome: RepairCycleOutcomeV1; statusPath: string };

/** A prior marker proves a possible orphaned writer; never reclaimed here. */
export class LocalHostOrphanError extends Error {
  constructor() {
    super(STATIC_ORPHAN);
    this.name = "LocalHostOrphanError";
  }
}

/** Owned sessions did not settle; the marker and lock are retained. */
export class LocalHostSettlementError extends Error {
  constructor() {
    super(STATIC_UNSETTLED);
    this.name = "LocalHostSettlementError";
  }
}

// ---------------------------------------------------------------------------
// Fixed configuration (pure; no I/O)
// ---------------------------------------------------------------------------

/** The one fixed local repository configuration, through the frozen parser. */
export function createLocalRepositoryConfig(): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: { ...LOCAL_REPOSITORY },
    baseBranch: LOCAL_BASE_BRANCH,
    adapter: { kind: "github" },
    commands: { replay: "replay_capture", test: "test_ci" },
    commandRegistry: {
      version: "v1",
      commands: {
        test_ci: {
          executable: "deno",
          args: ["task", "test:local"],
          maxDurationMs: 1_800_000,
          maxOutputBytes: 4_194_304,
        },
        replay_capture: {
          executable: "deno",
          args: ["task", "replay:capture"],
          maxDurationMs: 600_000,
          maxOutputBytes: 1_048_576,
        },
      },
    },
    protectedPaths: [
      ...HOSTED_AUTHORITY_PROTECTED_PATHS,
      // Every workflow stays owner-authored: a model candidate must never
      // publish or merge a workflow change on any target.
      ".github/workflows/",
      // The unchanged `touchesProtected` predicate itself: a candidate edit
      // could make the whole boundary return false after merge.
      "src/repair/loop-records.ts",
      // This file decides the protected set itself.
      "src/host/local-config.ts",
      // The trusted supervisor's exact-revision promotion boundary: the
      // pointer writer (`active-runtime.json`, compare-and-set under the
      // supervisor lock), the callers that decide promotion and the receipt
      // parser they rely on.
      "src/host/local-release.ts",
      "src/host/local-supervisor-release.ts",
      "src/host/actions-supervisor-installation.ts",
      "src/host/local-supervisor.ts",
      "src/host/actions-supervisor-source.ts",
      "src/host/actions-supervisor-controller.ts",
      "src/host/actions-supervisor-install-api.ts",
      "src/contracts/local-release.ts",
    ],
    build: { projectId: null, acceptance: null },
    secretRef: "secret://host/injected/sentinel-local-owner",
    // Owner update, 2026-10-02: all artificial throughput caps are lifted.
    // Both rolling caps are explicitly null (uncapped), never a fake huge
    // number; durable reservation accounting and unique admission remain.
    liveStartLimits: { perHour: null, perSevenDays: null },
    // 30 minutes, matching this same template's own `test_ci` command
    // allowance (1_800_000). A 20-minute bound cut three of four ai.ubq.fi
    // sessions off at exactly 1_200_000 ms while a larger codebase's session
    // needs longer; the completion that DID finish used 1_187_000 ms, which is
    // 13 s of headroom and therefore not a real bound but a coin flip. The
    // 110-minute run deadline still fits two such sessions plus the reserved
    // validation and publication margin.
    // Streamed volume never ends a newly planned session. Keep the existing
    // positive safe-integer wire field so R80 can parse plans and receipts;
    // this value cannot be reached during the unchanged 30-minute deadline.
    // The model port retains only bounded evidence, independent of this total.
    sessionBound: {
      maxDurationMs: 1_800_000,
      maxOutputChars: Number.MAX_SAFE_INTEGER,
    },
    retention: null,
    stabilityPolicy: null,
  });
}

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

export function readLocalHostOptions(
  options: LocalRepairHostOptionsV1,
): LocalRepairHostOptionsV1 & { modelId: string; reviewModelId: string } {
  let record: Record<string, unknown>;
  try {
    record = options as unknown as Record<string, unknown>;
  } catch {
    throw new TypeError(STATIC_INVALID_OPTIONS);
  }
  const controllerSha = record?.controllerSha;
  if (!isGitSha(controllerSha)) throw new TypeError(STATIC_INVALID_CONTROLLER);
  return {
    stateRoot: requirePath(record.stateRoot, "stateRoot"),
    sourceDir: requirePath(record.sourceDir, "sourceDir"),
    controllerSha,
    githubToken: requirePath(record.githubToken, "githubToken"),
    modelToken: requirePath(record.modelToken, "modelToken"),
    codexExecutable: requirePath(record.codexExecutable, "codexExecutable"),
    denoExecutable: requirePath(record.denoExecutable, "denoExecutable"),
    trustedPath: requirePath(record.trustedPath, "trustedPath"),
    modelId: requireModelId(record.modelId),
    reviewModelId: requireReviewModelId(record.reviewModelId),
  };
}

/**
 * Route-selected implementation model id. An absent value keeps the frozen
 * gateway default; a present but malformed value is refused outright (it is
 * never silently replaced, so the recorded model always equals the requested
 * one).
 */
function requireModelId(value: unknown): string {
  if (value === undefined) return DEFAULT_IMPLEMENTATION_MODEL;
  if (!isBoundedModelId(value)) throw new TypeError(STATIC_INVALID_OPTIONS);
  return value;
}

/**
 * Dedicated structured-review model id. An absent or malformed value yields
 * the invalid empty sentinel (never the frozen default and never the
 * implementation model): the reviewer refuses at prepare before any session
 * opens.
 */
function requireReviewModelId(value: unknown): string {
  if (!isBoundedModelId(value)) return "";
  return value;
}

/** A bounded model id: nonempty, exactly trimmed, no control characters. */
function isBoundedModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_MODEL_CHARS) return false;
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function requirePath(value: unknown, _field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(STATIC_INVALID_OPTIONS);
  }
  return value;
}
