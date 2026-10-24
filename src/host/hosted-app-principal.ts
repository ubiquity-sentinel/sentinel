/** Hosted App authority is private to the actual same-credential REST/Git factory. */
import { isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  TakeoverPrincipalAuthority,
  TakeoverPrincipalBinding,
} from "../contracts/existing-pr-takeover.ts";
import {
  type Clock,
  type GitHubCooldownGateV1,
  type GitHubPort,
  portError,
  portOk,
  type PortResultV1,
  type RepairStateWriter,
  type StateReadView,
} from "../contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import { composeLocalGitHub, type LocalGitHubInputV1 } from "./local-github.ts";
import {
  type HostedAppMintGrant,
  parseHostedAppMintGrant,
  SENTINEL_APP_INSTALLATION_ID,
} from "./hosted-app-grant.ts";
import { parseAppTokenNotAfterV1 } from "./hosted-app-token-window.ts";
import {
  readHostedAppNativeJob,
  readHostedAppRepositoryScope,
} from "./hosted-app-principal-native.ts";
import {
  type HostedAppSourceEvidence,
  type HostedAppSourceInput,
  readHostedAppSourceEvidence,
} from "./hosted-app-principal-source.ts";
import {
  type HostedCustodyCapability,
  parseHostedCustodyCapability,
} from "./hosted-custody-capability.ts";
import { revalidateHostedRuntimeCompatibility } from "./hosted-runtime-compatibility-authority.ts";
import { parseHostedRuntimeRollout } from "./hosted-runtime-rollout.ts";

export interface HostedAppPrincipalContext {
  readonly kind: "hosted_app_principal_context";
}
export interface HostedAppPrincipalHandoffInput {
  source: HostedAppSourceInput;
  state: Pick<StateReadView, "readRelease">;
  clock: Clock;
  gate: GitHubCooldownGateV1;
  http: HttpTransportV1;
  nativeToken: string;
  appToken: string | undefined;
  mintGrant: string | undefined;
  expectedInstallationId?: number;
  appTokenNotAfter: string | undefined;
  deadline: number;
}
export interface HostedAppPrincipalHostInput
  extends HostedAppPrincipalHandoffInput {
  state: StateReadView & RepairStateWriter;
}

interface PrincipalPrivate<
  T extends HostedAppPrincipalHandoffInput = HostedAppPrincipalHostInput,
> {
  host: T & { appToken: string };
  source: HostedAppSourceEvidence;
  capability: HostedCustodyCapability;
  grant: HostedAppMintGrant;
  notAfter: number;
  profiles: unknown;
}
const contexts = new WeakMap<HostedAppPrincipalContext, PrincipalPrivate>();
const refused = (): PortResultV1<never> =>
  portError("unavailable", "hosted App principal unavailable");
const sameRepository = (
  left: RepositoryIdentityV1,
  right: RepositoryIdentityV1,
) =>
  left.owner === right.owner && left.name === right.name &&
  left.installationId === right.installationId;
function live(
  value: PrincipalPrivate<HostedAppPrincipalHandoffInput>,
  deadline: number,
): boolean {
  const now = value.host.clock.now();
  return Number.isSafeInteger(now) && now >= 0 &&
    Number.isSafeInteger(deadline) && now < deadline && now < value.notAfter &&
    now < value.host.deadline;
}

function boundedSource(
  source: HostedAppSourceInput,
  clock: Clock,
  deadline: number,
): HostedAppSourceInput {
  const process = source.process;
  return {
    ...source,
    process: {
      run: (command) => {
        const remaining = deadline - clock.now();
        if (!Number.isSafeInteger(remaining) || remaining <= 0) {
          return Promise
            .reject(new Error("hosted App source deadline expired"));
        }
        return process.run({
          ...command,
          maxDurationMs: Math.min(command.maxDurationMs, remaining),
        });
      },
    },
  };
}

async function freshSourceAndRuntime(
  value: PrincipalPrivate<HostedAppPrincipalHandoffInput>,
  deadline: number,
): Promise<boolean> {
  if (!live(value, deadline)) return false;
  const { host } = value;
  const source = await readHostedAppSourceEvidence(
    boundedSource(
      host.source,
      host.clock,
      Math.min(deadline, value.notAfter, host.deadline),
    ),
    value.profiles,
  );
  if (
    source === null ||
    canonicalStringify(source) !== canonicalStringify(value.source)
  ) return false;
  const compatible = await revalidateHostedRuntimeCompatibility(
    {
      state: host.state,
      identity: host.source.identity,
      execution: host.source.execution,
      controllerSha: host.source.execution.revision,
      clock: host.clock,
      deadline: Math.min(deadline, value.notAfter, host.deadline),
    },
    value.capability.queue,
    value.capability.existingPr,
  );
  return compatible.ok && live(value, deadline);
}

async function freshHost(
  value: PrincipalPrivate<HostedAppPrincipalHandoffInput>,
  deadline: number,
): Promise<boolean> {
  if (!await freshSourceAndRuntime(value, deadline)) return false;
  const { host } = value;
  const native = await readHostedAppNativeJob({
    http: host.http,
    token: host.nativeToken,
    clock: host.clock,
    gate: host.gate,
    deadline: Math.min(deadline, value.notAfter, host.deadline),
    identity: host.source.identity,
    execution: host.source.execution,
    steps: value.source.steps,
  });
  // Native reads can yield while the source or saved health changes. Neither
  // the parent's boolean nor the child's private context may retain that grant.
  return native.ok && await freshSourceAndRuntime(value, deadline);
}

/**
 * Called only by the trusted hosted composition after saved-execution validation.
 * The final argument is a trusted fixture seam; production uses reviewed source.
 * Environment JSON, a login, and an App-shaped token never register a context.
 */
export async function createHostedAppPrincipalContext(
  input: HostedAppPrincipalHostInput,
  sourceProfiles?: unknown,
): Promise<HostedAppPrincipalContext | null> {
  const value = await readHandoff(input, sourceProfiles);
  if (value === null) return null;
  const context: HostedAppPrincipalContext = Object.freeze({
    kind: "hosted_app_principal_context",
  });
  contexts.set(context, value);
  return context;
}

/** Optional context construction for one already-bound App token and grant. */
export async function createOptionalHostedAppPrincipalContext(
  input: HostedAppPrincipalHostInput,
  appToken: string | undefined,
  mintGrant: string | undefined,
  sourceProfiles?: unknown,
): Promise<HostedAppPrincipalContext | null> {
  if (appToken === undefined || mintGrant === undefined) return null;
  return await createHostedAppPrincipalContext({
    ...input,
    appToken,
    mintGrant,
  }, sourceProfiles);
}

/** Parent-side read-only check. No context, principal or credential is returned. */
/**
 * Bounded classes of a refused parent handoff (#193), so a withheld grant
 * names why: credentials, a grant for another installation, an otherwise
 * invalid grant, an unreadable token window, an expired window, unproven
 * source, an unfresh host check, or an unexpected error.
 */
export type HostedAppHandoffRefusalV1 =
  | "credentials"
  | "grant_installation"
  | "grant"
  | "token_window"
  | "expired"
  | "source"
  | "host"
  | "error";

export async function verifyHostedAppPrincipalHandoff(
  input: HostedAppPrincipalHandoffInput,
  sourceProfiles?: unknown,
  onRefusal?: (reason: HostedAppHandoffRefusalV1) => void,
): Promise<boolean> {
  return await readHandoff(input, sourceProfiles, onRefusal) !== null;
}

/** True when the grant parses far enough to name a different installation. */
function grantNamesOtherInstallation(
  text: string | undefined,
  expected: number,
): boolean {
  try {
    const value: unknown = JSON.parse(text ?? "");
    const id = typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).installationId
      : undefined;
    return typeof id === "number" && id !== expected;
  } catch {
    return false;
  }
}

async function readHandoff<T extends HostedAppPrincipalHandoffInput>(
  input: T,
  sourceProfiles?: unknown,
  onRefusal?: (reason: HostedAppHandoffRefusalV1) => void,
): Promise<PrincipalPrivate<T> | null> {
  const refuse = (reason: HostedAppHandoffRefusalV1): null => {
    try {
      onRefusal?.(reason);
    } catch {
      // The refusal class is advisory; it never changes the refusal.
    }
    return null;
  };
  try {
    const now = input.clock.now();
    if (
      typeof input.appToken !== "string" || input.appToken.trim() === "" ||
      input.nativeToken.trim() === "" || input.appToken === input.nativeToken ||
      !Number.isSafeInteger(input.deadline) || input.deadline <= now
    ) return refuse("credentials");
    const grant = parseHostedAppMintGrant(
      input.mintGrant,
      now,
      input.expectedInstallationId,
    );
    if (grant === null) {
      return refuse(
        grantNamesOtherInstallation(
            input.mintGrant,
            input.expectedInstallationId ?? SENTINEL_APP_INSTALLATION_ID,
          )
          ? "grant_installation"
          : "grant",
      );
    }
    const conservative = parseAppTokenNotAfterV1(input.appTokenNotAfter);
    if (conservative === undefined) return refuse("token_window");
    const notAfter = Math.min(grant.expiresAt, conservative);
    if (!Number.isSafeInteger(notAfter) || notAfter <= now) {
      return refuse("expired");
    }
    // Capture scalar credentials and identity; retaining a mutable caller object
    // would let the principal and the later REST authorization closure diverge.
    const host = Object.freeze({
      ...input,
      appToken: input.appToken,
      source: Object.freeze({
        ...boundedSource(
          input.source,
          input.clock,
          Math.min(input.deadline, notAfter),
        ),
        identity: Object.freeze({ ...input.source.identity }),
        execution: Object.freeze(structuredClone(input.source.execution)),
      }),
    });
    const copiedProfiles = sourceProfiles === undefined
      ? undefined
      : structuredClone(sourceProfiles);
    const source = await readHostedAppSourceEvidence(
      host.source,
      copiedProfiles,
    );
    if (source === null) return refuse("source");
    const capability = parseHostedCustodyCapability(
      JSON.parse(source.capabilityText),
    );
    // The only code-profile exclusions are authenticated, strictly typed data.
    // The launcher consumes these rollout rows; they never grant a principal.
    parseHostedRuntimeRollout(JSON.parse(source.rolloutText));
    const value: PrincipalPrivate<T> = {
      host,
      source,
      capability,
      grant,
      notAfter,
      profiles: copiedProfiles,
    };
    if (!await freshHost(value, input.deadline)) return refuse("host");
    return value;
  } catch {
    return refuse("error");
  }
}

async function exactTask(
  value: PrincipalPrivate,
  binding: TakeoverPrincipalBinding,
): Promise<boolean> {
  const result = await value.host.state.readRepair();
  if (
    !result.ok || result.value.status !== "found" ||
    result.value.head !== binding.expectedStateHead
  ) return false;
  const snapshot = parseRepairStateSnapshotV1(result.value.snapshot);
  const records = snapshot.work.filter((record) =>
    record.id === binding.taskId
  );
  // Native preservation also calls before adoption. The shared custody resolver
  // alone owns phase-specific target/intent/producer matching.
  return records.length === 1 &&
    sameRepository(records[0].repository, binding.repository);
}

function principalFor(
  value: PrincipalPrivate,
  repository: RepositoryIdentityV1,
): TakeoverPrincipalAuthority {
  return Object.freeze({
    revalidate: async (
      request: TakeoverPrincipalBinding,
    ): Promise<PortResultV1<void>> => {
      try {
        const binding = structuredClone(request);
        if (
          !sameRepository(repository, binding.repository) ||
          !isGitSha(binding.expectedStateHead) || !isGitSha(binding.head) ||
          !isGitSha(binding.base) ||
          (binding.nextHead !== null && !isGitSha(binding.nextHead)) ||
          !Number.isSafeInteger(binding.pullRequest) ||
          binding.pullRequest < 1 || typeof binding.taskId !== "string" ||
          binding.taskId.length === 0 || typeof binding.branch !== "string" ||
          binding.branch.length === 0 || binding.branch.length > 1024 ||
          ![
            "correct",
            "publish",
            "review",
            "refresh",
            "merge",
            "enqueue",
            "native_preserve",
            "preserve_successor",
          ].includes(binding.operation) ||
          !["native", "current", "prepare", "preserve", "publish"].includes(
            binding.phase,
          ) || !live(value, binding.deadline) ||
          !await exactTask(value, binding) ||
          !await freshHost(value, binding.deadline)
        ) return refused();
        const scope = await readHostedAppRepositoryScope({
          http: value.host.http,
          token: value.host.appToken,
          clock: value.host.clock,
          gate: value.host.gate,
          deadline: Math.min(
            binding.deadline,
            value.notAfter,
            value.host.deadline,
          ),
          repository,
          grant: value.grant,
        });
        if (
          !scope.ok || !live(value, binding.deadline) ||
          !await exactTask(value, binding)
        ) return refused();
        // Scope requests are awaited native observations. Source, current job
        // and installed execution must still match after their final response.
        return await freshHost(value, binding.deadline) &&
            live(value, binding.deadline) &&
            await exactTask(value, binding)
          ? portOk(undefined)
          : refused();
      } catch {
        return refused();
      }
    },
  });
}

export type HostedAppGitHubInput =
  & Omit<
    LocalGitHubInputV1,
    | "token"
    | "login"
    | "state"
    | "clock"
    | "gate"
    | "http"
    | "takeoverAuthority"
    | "installationId"
    | "repository"
  >
  & { repository: RepositoryIdentityV1 };
export type HostedAppProducedCandidateVerifier = NonNullable<
  LocalGitHubInputV1["takeoverAuthority"]
>["verifyProducedCandidate"];

/** The only issuer creates principal and actual REST/Git transport together. */
export function composeHostedAppGitHub(
  context: HostedAppPrincipalContext,
  input: HostedAppGitHubInput,
  verifyProducedCandidate?: HostedAppProducedCandidateVerifier,
): GitHubPort {
  const value = contexts.get(context);
  if (value === undefined) {
    throw new Error("hosted App principal context unavailable");
  }
  const repository = Object.freeze({ ...input.repository });
  const selfController = repository.installationId === 0 &&
    repository.owner === "ubiquity-sentinel" &&
    repository.name === "sentinel";
  if (
    !selfController &&
    (repository.owner !== "ubiquity" ||
      !value.source.targets.includes(
        `${repository.owner}/${repository.name}`,
      ) ||
      // `repository.installationId` is the durable logical foreign scope;
      // `value.grant.installationId` is the live credential installation the
      // parse already bound to the expected one (the native path proves the
      // repository's membership in that credential scope).
      repository.installationId !== SENTINEL_APP_INSTALLATION_ID)
  ) throw new Error("hosted App principal target unavailable");
  const { host } = value;
  // Explicit final assignments defeat even a JavaScript caller that bypasses
  // TypeScript's omitted fields. Both transports capture this private token.
  const local = Object.freeze({
    ...input,
    repository,
    installationId: repository.installationId,
    token: host.appToken,
    login: "ubiquity-sentinel[bot]",
    state: host.state,
    clock: host.clock,
    gate: host.gate,
    http: host.http,
    takeoverAuthority: Object.freeze({
      runtimeCapabilityAccepted: () =>
        live(value, host.deadline) &&
        value.capability.existingPr.custodyActivated,
      contentsWriteAllowed: () =>
        live(value, host.deadline) &&
        value.grant.permissions.contents === "write",
      principal: principalFor(value, repository),
      verifyProducedCandidate,
    }),
  });
  // Admission is independent of the runtime custody floor. Only the verified
  // native launcher's distinct source policy can activate these effect paths.
  return composeLocalGitHub(local, undefined, value.capability.takeover);
}
