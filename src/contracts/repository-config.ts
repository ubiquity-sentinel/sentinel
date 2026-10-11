import { asCommandId } from "./brands.ts";
import type { CommandId } from "./brands.ts";
import { parseCommandRegistryV1 } from "./command-registry.ts";
import type { CommandRegistryV1 } from "./command-registry.ts";
import { expectRestrictedRef, parseRepositoryIdentity } from "./shared.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import {
  expectArray,
  expectCommandId,
  expectEnum,
  expectExactKeys,
  expectNonEmptyString,
  expectNullable,
  expectPattern,
  expectRecord,
  expectStringArray,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";
import {
  parseLiveStartLimits,
  parseRetentionPolicy,
  parseSessionBound,
  parseStabilityPolicy,
} from "./repository-policy.ts";
import type {
  AcceptanceIdentityV1,
  LiveStartLimitsV1,
  RetentionPolicyV1,
  SessionBoundV1,
  StabilityPolicyV1,
} from "./repository-policy.ts";

/**
 * RepositoryConfigV1: per-repository configuration. No field may carry a
 * secret literal; credential-bearing inputs are injected by the trusted host
 * outside this record. Commands are referenced by trusted command IDs only —
 * the config never holds shell argv, and model-supplied commands are outside
 * the contract by construction.
 */

export type AdapterKindV1 = "gateway" | "github";
/** Discriminated adapter variant: a GitHub host names no gateway base URL. */
export type RepositoryAdapterV1 =
  | { kind: "gateway"; baseUrl: string }
  | { kind: "github" };

export interface BuildIdentifiersV1 {
  /** Deno Deploy project id; null when the repository is not deployed. */
  projectId: string | null;
  /** Health/identity identifiers used by release acceptance; null when not deployed. */
  acceptance: AcceptanceIdentityV1 | null;
}

export interface RepositoryConfigV1 {
  version: "v1";
  kind: "repository_config";
  repository: RepositoryIdentityV1;
  baseBranch: string;
  adapter: RepositoryAdapterV1;
  /** Trusted credential-free command IDs resolved by the trusted host. */
  commands: { replay: CommandId; test: CommandId };
  /** Concrete resolved command registry (file/injected config, never env/flag). */
  commandRegistry: CommandRegistryV1;
  protectedPaths: string[];
  build: BuildIdentifiersV1;
  /** Restricted storage reference to injected credentials; never a literal URL. */
  secretRef: string | null;
  /** Explicit nullable caps; null means inference is not enabled. */
  liveStartLimits: LiveStartLimitsV1 | null;
  sessionBound: SessionBoundV1 | null;
  retention: RetentionPolicyV1 | null;
  stabilityPolicy: StabilityPolicyV1 | null;
}

const REQUIREMENT_KEYS = [
  "version",
  "kind",
  "repository",
  "baseBranch",
  "adapter",
  "commands",
  "commandRegistry",
  "protectedPaths",
  "build",
  "secretRef",
  "liveStartLimits",
  "sessionBound",
  "retention",
  "stabilityPolicy",
] as const;
const COMMANDS_KEYS = ["replay", "test"] as const;
const GATEWAY_ADAPTER_KEYS = ["kind", "baseUrl"] as const;
const GITHUB_ADAPTER_KEYS = ["kind"] as const;
const BUILD_KEYS = ["projectId", "acceptance"] as const;
const ACCEPTANCE_KEYS = [
  "healthPath",
  "metricsPath",
  "managedBodyMarker",
  "managedHeaders",
  "domain",
] as const;
const HEADER_KEYS = ["name", "value"] as const;

export function parseRepositoryConfigV1(input: unknown): RepositoryConfigV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, REQUIREMENT_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["repository_config"], "$.kind");

  const repository = parseRepositoryIdentity(obj.repository, "$.repository");

  const baseBranch = expectPattern(
    obj.baseBranch,
    "$.baseBranch",
    /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,255})$/,
    "invalid_pattern",
    "expected branch name (letters/digits/._/-)",
    MaxText.branch,
  );

  const adapter = parseRepositoryAdapter(obj.adapter, "$.adapter");
  // Scope 0 is reserved for the explicit no-App local owner credential used by
  // the github adapter; a gateway configuration still needs a real App
  // installation.
  if (adapter.kind === "gateway" && repository.installationId < 1) {
    fail(
      "$.repository.installationId",
      "invalid_count",
      "gateway adapter requires a positive GitHub App installation id; 0 is reserved for the no-App local owner scope",
    );
  }

  const commandsObj = expectRecord(obj.commands, "$.commands");
  expectExactKeys(commandsObj, COMMANDS_KEYS, "$.commands");
  const replay = asCommandId(
    expectCommandId(commandsObj.replay, "$.commands.replay"),
  );
  const test = asCommandId(
    expectCommandId(commandsObj.test, "$.commands.test"),
  );

  const commandRegistry = parseCommandRegistryV1(obj.commandRegistry);
  // Own-property lookup only: a configured id like "constructor" or
  // "toString" with an empty registry must never resolve to an inherited
  // Object.prototype member and silently pass for a missing command.
  if (!Object.hasOwn(commandRegistry.commands, replay)) {
    fail(
      "$.commandRegistry",
      "invalid_lifecycle",
      "configured replay command is missing from the registry",
    );
  }
  if (!Object.hasOwn(commandRegistry.commands, test)) {
    fail(
      "$.commandRegistry",
      "invalid_lifecycle",
      "configured test command is missing from the registry",
    );
  }

  const protectedPaths = expectStringArray(
    obj.protectedPaths,
    "$.protectedPaths",
    MaxItems.protectedPaths,
    MaxText.path,
  );

  const buildObj = expectRecord(obj.build, "$.build");
  expectExactKeys(buildObj, BUILD_KEYS, "$.build");
  const projectId = expectNullableNonEmptyString(
    buildObj.projectId,
    "$.build.projectId",
    MaxText.token,
  );
  const acceptance = expectNullable(
    buildObj.acceptance,
    "$.build.acceptance",
    parseAcceptance,
  );

  const secretRef = expectNullable(
    obj.secretRef,
    "$.secretRef",
    expectRestrictedRef,
  );

  const liveStartLimits = expectNullable(
    obj.liveStartLimits,
    "$.liveStartLimits",
    parseLiveStartLimits,
  );
  const sessionBound = expectNullable(
    obj.sessionBound,
    "$.sessionBound",
    parseSessionBound,
  );
  const retention = expectNullable(
    obj.retention,
    "$.retention",
    parseRetentionPolicy,
  );
  const stabilityPolicy = expectNullable(
    obj.stabilityPolicy,
    "$.stabilityPolicy",
    parseStabilityPolicy,
  );

  if (
    liveStartLimits !== null &&
    liveStartLimits.perHour !== null &&
    liveStartLimits.perSevenDays !== null &&
    liveStartLimits.perHour > liveStartLimits.perSevenDays
  ) {
    fail(
      "$.liveStartLimits",
      "invalid_lifecycle",
      "perHour cap cannot exceed perSevenDays cap",
    );
  }

  return {
    version: "v1",
    kind: "repository_config",
    repository,
    baseBranch,
    adapter,
    commands: { replay, test },
    commandRegistry,
    protectedPaths,
    build: { projectId, acceptance },
    secretRef,
    liveStartLimits,
    sessionBound,
    retention,
    stabilityPolicy,
  };
}

/**
 * The adapter variant is discriminated and exact: the GitHub variant names no
 * gateway base address — an extra key is an unknown key, never ignored — and
 * an unknown kind falls through to the existing gateway validation, which
 * refuses it.
 */
function parseRepositoryAdapter(
  input: unknown,
  path: string,
): RepositoryAdapterV1 {
  const obj = expectRecord(input, path);
  if (obj.kind === "github") {
    expectExactKeys(obj, GITHUB_ADAPTER_KEYS, path);
    return { kind: "github" };
  }
  // Existing gateway validation order is preserved: exact keys, then kind,
  // then the base URL pattern.
  expectExactKeys(obj, GATEWAY_ADAPTER_KEYS, path);
  expectEnum(obj.kind, ["gateway"], `${path}.kind`);
  const baseUrl = expectPattern(
    obj.baseUrl,
    `${path}.baseUrl`,
    /^https?:\/\/[^ /]+(?::\d+)?(?:\/[^ ]*)?$/,
    "invalid_pattern",
    "expected http(s) base URL",
    MaxText.url,
  );
  return { kind: "gateway", baseUrl };
}

function parseAcceptance(input: unknown, path: string): AcceptanceIdentityV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ACCEPTANCE_KEYS, path);
  const healthPath = expectPattern(
    obj.healthPath,
    `${path}.healthPath`,
    /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,254})?$/,
    "invalid_pattern",
    "expected absolute health path",
    MaxText.path,
  );
  const metricsPath = expectPattern(
    obj.metricsPath,
    `${path}.metricsPath`,
    /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,254})?$/,
    "invalid_pattern",
    "expected absolute metrics path",
    MaxText.path,
  );
  const managedBodyMarker = expectNonEmptyString(
    obj.managedBodyMarker,
    `${path}.managedBodyMarker`,
    MaxText.message,
  );
  const managedHeaders = expectArray(
    obj.managedHeaders,
    `${path}.managedHeaders`,
    MaxItems.managedHeaders,
    (item, itemPath) => {
      const header = expectRecord(item, itemPath);
      expectExactKeys(header, HEADER_KEYS, itemPath);
      return {
        name: expectNonEmptyString(
          header.name,
          `${itemPath}.name`,
          MaxText.headerName,
        ),
        value: expectNonEmptyString(
          header.value,
          `${itemPath}.value`,
          MaxText.headerValue,
        ),
      };
    },
  );
  const domain = expectNullableNonEmptyString(
    obj.domain,
    `${path}.domain`,
    MaxText.url,
  );
  return { healthPath, metricsPath, managedBodyMarker, managedHeaders, domain };
}

function expectNullableNonEmptyString(
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  return expectNullable(
    value,
    path,
    (v, p) => expectNonEmptyString(v, p, maxLength),
  );
}

export { resolveGlobalLiveStartLimits } from "./repository-policy.ts";

export type {
  AcceptanceIdentityV1,
  GlobalLiveStartLimitsV1,
  LiveStartLimitsV1,
  RetentionPolicyV1,
  SessionBoundV1,
  StabilityMetricV1,
  StabilityPolicyV1,
  StabilityThresholdV1,
} from "./repository-policy.ts";
