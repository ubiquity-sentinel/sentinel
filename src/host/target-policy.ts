/** Trusted repository policy; slugs never carry executable configuration. */
import { asCommandId } from "../contracts/brands.ts";
import { parseCommandRegistryV1 } from "../contracts/command-registry.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { isPassportWorkTrial } from "../repair/passport-work-trial.ts";
import {
  createGenericTargetPolicyV1,
  type TargetTreeFactsV1,
} from "./target-policy-generic.ts";

type TargetPolicyV1 = Pick<
  RepositoryConfigV1,
  "adapter" | "commands" | "commandRegistry" | "protectedPaths"
>;

// Gateway AGENTS.md reserves credentials, deployment, capture/replay authority
// and verification tooling to trusted owners. Preserve inherited protections
// as well; choosing a repository must never remove an existing restriction.
// Owner directive 2026-11-05: the gateway's source, auth, operations scripts
// and tooling configuration are ordinary work that Sentinel merges on its own
// after native review and green current-head CI. Only secrets and state
// directories, the workflows CI executes, the owner documents, the replay
// consumer and the Sentinel recording/integration code stay protected.
const GATEWAY_PROTECTED_PATHS = [
  ".env",
  ".data/",
  ".release/",
  ".kv-migration/",
  ".github/workflows/",
  "AGENTS.md",
  "docs/DECISIONS.md",
  "scripts/replay.ts",
  "scripts/replay-chat-stream.ts",
  "tests/helpers/sentinel-recorded-upstream.ts",
  "src/sentinel/",
  "src/codex/supervisor-secret.ts",
] as const;

const PASSPORT_PROTECTED_PATHS = [
  ".env",
  // act configuration files the backup CI leg must never read from the
  // target tree (docs/backup-ci-spec.md §13, A1).
  ".actrc",
  ".secrets",
  ".vars",
  ".input",
  ".npmrc",
  ".git/",
  ".github/workflows/",
] as const;

export function isPassportTarget(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
): boolean {
  return isPassportWorkTrial(repository);
}

/** How a target's own CI workflow is asked to test a Sentinel pull request. */
export interface PremergeCiPolicyV1 {
  /** Workflow file name under `.github/workflows/` of the target. */
  readonly workflowFile: string;
  /** `workflow_dispatch` input naming the base branch of the change scope. */
  readonly baseRefInput: string;
  /** Input carrying the Sentinel App login that selects the complete set. */
  readonly authorInput: string;
  /** Input carrying the exact base SHA the change scope is computed from. */
  readonly scopeBaseInput: string;
}

/**
 * Only the gateway needs a pre-merge dispatch: its `Gateway CI`
 * (`deno-deploy.yml`) runs on closed pull requests and manual dispatch alone
 * (2026-10-21 quota decision) and exposes exactly these inputs for a Sentinel
 * App pull request. Every other target's CI runs on its pull requests itself.
 */
export function premergeCiPolicyV1(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
): PremergeCiPolicyV1 | null {
  if (
    repository.owner.toLowerCase() !== "ubiquity" ||
    repository.name.toLowerCase() !== "ai.ubq.fi"
  ) return null;
  return {
    workflowFile: "deno-deploy.yml",
    baseRefInput: "base_ref",
    authorInput: "sentinel_pr_author",
    scopeBaseInput: "scope_base",
  };
}

/**
 * Whether this exact identity takes the generic target policy. Only the
 * Sentinel repository itself, Passport and the Gateway have named policies;
 * a foreign identity that merely reuses one of their names stays generic.
 */
export function isGenericTargetRepositoryV1(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
): boolean {
  if (isPassportTarget(repository)) return false;
  const owner = repository.owner.toLowerCase();
  const name = repository.name.toLowerCase();
  if (owner === "ubiquity" && name === "ai.ubq.fi") return false;
  if (owner === "ubiquity-sentinel" && name === "sentinel") return false;
  return true;
}

/**
 * Facts for a trusted caller without a target checkout: no toolchain marker, no
 * local verify, and the target's own pull-request CI expected as merge
 * evidence. It never claims a green result; it keeps the generic credential
 * boundary and the family predicate in place.
 */
const FACTS_LESS_GENERIC_TARGET_V1: TargetTreeFactsV1 = Object.freeze({
  files: Object.freeze([]),
  hasCiWorkflow: true,
});

/**
 * Select only a host-authored policy for the exact repository identity.
 * Passport and the Gateway keep their named policies, and the Sentinel
 * repository itself keeps the named template. Every other repository is
 * generic: with target-tree facts the policy is derived from the checkout, and
 * without facts it still gets the generic protected paths and family predicate
 * with no local verify and CI-only merge evidence. The template is never the
 * fallback for a generic repository. Issue text, the target file and model
 * output are never policy inputs. Installation scope and default branch remain
 * caller-owned.
 */
export function selectTrustedTargetPolicyV1(
  template: RepositoryConfigV1,
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
  facts?: TargetTreeFactsV1,
): TargetPolicyV1 {
  if (isPassportTarget(repository)) {
    // The named native gate includes isolated Deno fixtures, Bun and Worker
    // tests. Generated types and both deployment dry-runs remain required CI
    // gates. Passport is issue-only: this does not enable gateway captures.
    const verify = asCommandId("passport_verify");
    return {
      adapter: { kind: "github" },
      commands: { test: verify, replay: verify },
      commandRegistry: parseCommandRegistryV1({
        version: "v1",
        commands: {
          passport_verify: {
            executable: "bun",
            args: ["--no-env-file", "run", "check"],
            maxDurationMs: 1_800_000,
            maxOutputBytes: 4_194_304,
          },
        },
      }),
      // The trial permits ordinary product files, including inherited bans.
      protectedPaths: [...PASSPORT_PROTECTED_PATHS],
    };
  }
  const isGateway = repository.owner.toLowerCase() === "ubiquity" &&
    repository.name.toLowerCase() === "ai.ubq.fi";
  if (!isGateway) {
    // Only the Sentinel repository itself keeps the named template exactly:
    // its commands and protected custody boundary (the protected-path
    // predicate and promotion files) must never be replaced by a target-tree
    // policy.
    if (
      repository.owner.toLowerCase() === "ubiquity-sentinel" &&
      repository.name.toLowerCase() === "sentinel"
    ) {
      return {
        adapter: template.adapter,
        commands: template.commands,
        commandRegistry: template.commandRegistry,
        protectedPaths: template.protectedPaths,
      };
    }
    // Every other repository is generic, even without checkout facts. A
    // facts-less caller keeps the generic credential boundary and the family
    // predicate; it never inherits the Sentinel template's command ids or
    // custody list. With no facts there is no local verify and the target's
    // own CI stays the only expected merge evidence (the CI-first gate still
    // reads the actual check runs, so this can never claim a green result).
    const generic = createGenericTargetPolicyV1(
      facts ?? FACTS_LESS_GENERIC_TARGET_V1,
    );
    return {
      adapter: generic.adapter,
      commands: generic.commands,
      commandRegistry: generic.commandRegistry,
      protectedPaths: generic.protectedPaths,
    };
  }
  // Actual target AGENTS.md requires the full verify gate, which includes all
  // required deterministic CI checks. sentinel:test-local alone is not CI.
  // Cache/sandbox unavailability must refuse, never substitute a partial gate.
  return {
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: {
      test: asCommandId("gateway_verify"),
      replay: asCommandId("gateway_replay"),
    },
    commandRegistry: parseCommandRegistryV1({
      version: "v1",
      commands: {
        gateway_verify: {
          executable: "sh",
          args: ["scripts/verify.sh"],
          maxDurationMs: 1_800_000,
          maxOutputBytes: 4_194_304,
        },
        gateway_replay: {
          executable: "deno",
          // docs/sentinel.md's fixed local replay consumer uses real gateway
          // parsers with recorded transports and no credentials/network.
          args: [
            "run",
            "--no-prompt",
            "--no-config",
            "--no-remote",
            "--allow-read=.",
            "scripts/replay.ts",
          ],
          maxDurationMs: 600_000,
          maxOutputBytes: 1_048_576,
        },
      },
    }),
    protectedPaths: [
      ...new Set([...template.protectedPaths, ...GATEWAY_PROTECTED_PATHS]),
    ],
  };
}
