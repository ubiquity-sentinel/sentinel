/** Read-only parent verification controls only optional mint-metadata forwarding. */
import { type GitHubCooldownGateV1, portError } from "../contracts/ports.ts";
import { parseGitHubRateLimitV1 } from "../contracts/github-cooldown.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { createDeadline, fetchHttpTransport } from "../github/http.ts";
import {
  HOSTED_APP_MINT_GRANT_ENV,
  SENTINEL_APP_INSTALLATION_ID,
  TARGET_INSTALLATION_ID_ENV,
} from "./hosted-app-grant.ts";
import { verifyHostedAppPrincipalHandoff } from "./hosted-app-principal.ts";
import { APP_TOKEN_NOT_AFTER_ENV } from "./hosted-app-token-window.ts";
import { HostedSupervisorCooldownGate } from "./hosted-cooldown.ts";
import type {
  HostedRuntimeIdentityV1,
  HostedRuntimeLauncherInputV1,
} from "./hosted-runtime-identity.ts";

const HANDOFF_TIMEOUT_MS = 30_000;
const refused = () =>
  portError("unavailable", "hosted App parent verification unavailable");

/** No writer is retained, even when the caller's object also implements one. */
function readOnlyNativeGate(
  input: Pick<HostedRuntimeLauncherInputV1, "state" | "clock">,
): GitHubCooldownGateV1 {
  let stopped = false;
  const gate = new HostedSupervisorCooldownGate({
    state: {
      readRelease: input.state.readRelease.bind(input.state),
      readRepair: input.state.readRepair.bind(input.state),
      writeRelease: () => Promise.resolve(refused()),
    },
    clock: input.clock,
    mode: "enforce",
  });
  return {
    beforeRequest: async (scope) => {
      if (stopped) return refused();
      const result = await gate.beforeRequest(scope);
      return stopped ? refused() : result;
    },
    recordRateLimit: (scope, rateLimit) => {
      // The parent has no persistence authority. Stop this optional handoff;
      // never claim a durable observation or issue a later native request.
      stopped = true;
      try {
        if (scope !== 0) return Promise.resolve(refused());
        parseGitHubRateLimitV1(rateLimit);
      } catch {
        return Promise.resolve(refused());
      }
      return Promise.resolve(refused());
    },
  };
}

/**
 * The live credential installation the child binds this grant to, read by
 * the child's own rule (`SENTINEL_TARGET_INSTALLATION_ID`; an absent value
 * keeps the durable default). The grant must name that installation exactly;
 * a malformed value refuses the grant instead of guessing.
 */
function expectedInstallationId(
  childEnv: Record<string, string>,
): number | null {
  const value = childEnv[TARGET_INSTALLATION_ID_ENV];
  if (value === undefined) return SENTINEL_APP_INSTALLATION_ID;
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Runs only after the launcher has proved exact source and saved execution.
 * A refusal strips this optional grant, leaving ordinary credentials intact.
 * The child independently authenticates the same facts before issuing a port.
 */
export async function retainVerifiedHostedAppGrant(
  input: HostedRuntimeLauncherInputV1,
  source: {
    launcher: string;
    runtime: string;
    identity: HostedRuntimeIdentityV1;
    execution: HostedExecutionIntentV1;
  },
  childEnv: Record<string, string>,
): Promise<void> {
  const mintGrant = childEnv[HOSTED_APP_MINT_GRANT_ENV];
  delete childEnv[HOSTED_APP_MINT_GRANT_ENV];
  if (source.identity.job === "matrix_cell" || mintGrant === undefined) return;
  const installationId = expectedInstallationId(childEnv);
  if (installationId === null) return;
  const timeout = createDeadline(HANDOFF_TIMEOUT_MS);
  try {
    const deadline = input.clock.now() + HANDOFF_TIMEOUT_MS;
    const fixture = input.principalHandoffFixture;
    const verified = await timeout.race(verifyHostedAppPrincipalHandoff({
      source: {
        launcherDir: source.launcher,
        runtimeDir: source.runtime,
        identity: source.identity,
        execution: source.execution,
        process: input.process,
      },
      state: { readRelease: input.state.readRelease.bind(input.state) },
      clock: input.clock,
      gate: readOnlyNativeGate(input),
      http: fixture?.http ?? fetchHttpTransport(),
      nativeToken: childEnv.GITHUB_TOKEN,
      appToken: childEnv.SENTINEL_SUPERVISOR_TOKEN,
      mintGrant,
      expectedInstallationId: installationId,
      appTokenNotAfter: childEnv[APP_TOKEN_NOT_AFTER_ENV],
      deadline,
    }, fixture?.sourceProfiles));
    if (verified && !timeout.fired() && input.clock.now() < deadline) {
      childEnv[HOSTED_APP_MINT_GRANT_ENV] = mintGrant;
    }
  } catch {
    // Missing/unavailable optional authority cannot disable ordinary work.
  } finally {
    timeout.dispose();
  }
}
