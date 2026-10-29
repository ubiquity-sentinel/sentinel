/** Trusted repository policy; slugs never carry executable configuration. */
import { asCommandId } from "../contracts/brands.ts";
import { parseCommandRegistryV1 } from "../contracts/command-registry.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";

type TargetPolicyV1 = Pick<
  RepositoryConfigV1,
  "adapter" | "commands" | "commandRegistry" | "protectedPaths"
>;

// Gateway AGENTS.md reserves credentials, deployment, capture/replay authority
// and verification tooling to trusted owners. Preserve inherited protections
// as well; choosing a repository must never remove an existing restriction.
// The gateway moved from Deno to Bun (d28cefa): the Deno configuration entries
// stay, and the Bun files that took over their role (scripts, dependencies,
// lockfile, runtime, compiler, formatter and dead-code configuration) carry
// the same protection.
const GATEWAY_PROTECTED_PATHS = [
  ".env",
  ".data/",
  ".release/",
  ".kv-migration/",
  ".github/workflows/",
  "AGENTS.md",
  "docs/DECISIONS.md",
  "deno.json",
  "deno.lock",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "tsconfig.lint.json",
  "knip.json",
  "ops/",
  "tools/lint/",
  ".prettierrc.json",
  ".prettierrc",
  ".prettierignore",
  "file-size-baseline.json",
  "scripts/verify.sh",
  "scripts/_bootstrap.sh",
  "scripts/format.sh",
  "scripts/lint.sh",
  "scripts/knip.sh",
  "scripts/file-size-ratchet.ts",
  "scripts/replay.ts",
  "scripts/replay-chat-stream.ts",
  "tests/helpers/sentinel-recorded-upstream.ts",
  "src/sentinel/",
  "src/config.ts",
  "src/runtime-config.ts",
  "src/kv.ts",
  "src/auth/",
  "src/api-keys.ts",
  "src/api-key-policy.ts",
  "src/codex/auth.ts",
  "src/codex/auth-refresh.ts",
  "src/codex/native-auth.ts",
  "src/codex/native-auth-transport.ts",
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
  "AGENTS.md",
  "docs/DECISIONS.md",
  "docs/CLOUDFLARE.md",
  ".github/workflows/",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "deno.json",
  "deno.lock",
  "tsconfig.json",
  "tsconfig.worker.json",
  "wrangler.jsonc",
  "worker-configuration.d.ts",
  "scripts/",
  "kv-service/",
] as const;

export function isPassportTarget(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
): boolean {
  return repository.owner.toLowerCase() === "ubiquity" &&
    repository.name.toLowerCase() === "passport.ubq.fi";
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
 * Select only a host-authored policy for the exact repository identity. The
 * existing trusted deployment template remains authoritative for Sentinel and
 * other repositories; issue text, the target file and model output are never
 * policy inputs. Installation scope and default branch remain caller-owned.
 */
export function selectTrustedTargetPolicyV1(
  template: RepositoryConfigV1,
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
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
      protectedPaths: [
        ...new Set([...template.protectedPaths, ...PASSPORT_PROTECTED_PATHS]),
      ],
    };
  }
  if (
    repository.owner.toLowerCase() !== "ubiquity" ||
    repository.name.toLowerCase() !== "ai.ubq.fi"
  ) {
    return {
      adapter: template.adapter,
      commands: template.commands,
      commandRegistry: template.commandRegistry,
      protectedPaths: template.protectedPaths,
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
