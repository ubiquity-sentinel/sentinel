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
import {
  type HostedAppHandoffRefusalV1,
  verifyHostedAppPrincipalHandoff,
} from "./hosted-app-principal.ts";
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

/** What the parent handoff did with the optional mint grant (#193). */
export type HostedAppGrantHandoffOutcomeV1 =
  | "retained"
  | "absent"
  | "not_applicable"
  | "installation_invalid"
  | "refused"
  | "timeout"
  | "error";

/**
 * One bounded advisory line per launch naming whether the grant reached the
 * child and, when it was withheld, the refusal class. It carries no token,
 * grant text or environment value and grants no authority.
 */
export interface HostedAppGrantHandoffDiagnosticV1 {
  version: "v1";
  kind: "sentinel_app_grant_handoff";
  job: string;
  outcome: HostedAppGrantHandoffOutcomeV1;
  refusal: HostedAppHandoffRefusalV1 | null;
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
): Promise<HostedAppGrantHandoffDiagnosticV1> {
  let refusal: HostedAppHandoffRefusalV1 | null = null;
  const report = (
    outcome: HostedAppGrantHandoffOutcomeV1,
  ): HostedAppGrantHandoffDiagnosticV1 => {
    const line: HostedAppGrantHandoffDiagnosticV1 = {
      version: "v1",
      kind: "sentinel_app_grant_handoff",
      job: source.identity.job,
      outcome,
      refusal: outcome === "refused" ? refusal : null,
    };
    try {
      console.log(JSON.stringify(line));
    } catch {
      // Advisory printing never changes the handoff.
    }
    return line;
  };
  const mintGrant = childEnv[HOSTED_APP_MINT_GRANT_ENV];
  delete childEnv[HOSTED_APP_MINT_GRANT_ENV];
  if (source.identity.job === "matrix_cell") return report("not_applicable");
  if (mintGrant === undefined) return report("absent");
  const installationId = expectedInstallationId(childEnv);
  if (installationId === null) return report("installation_invalid");
  const timeout = createDeadline(HANDOFF_TIMEOUT_MS);
  try {
    const deadline = input.clock.now() + HANDOFF_TIMEOUT_MS;
    const fixture = input.principalHandoffFixture;
    const verified = await timeout.race(verifyHostedAppPrincipalHandoff(
      {
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
      },
      fixture?.sourceProfiles,
      (reason) => {
        refusal = reason;
      },
    ));
    if (verified && !timeout.fired() && input.clock.now() < deadline) {
      childEnv[HOSTED_APP_MINT_GRANT_ENV] = mintGrant;
      return report("retained");
    }
    return report(
      timeout.fired() || input.clock.now() >= deadline ? "timeout" : "refused",
    );
  } catch {
    // Missing/unavailable optional authority cannot disable ordinary work.
    return report(timeout.fired() ? "timeout" : "error");
  } finally {
    timeout.dispose();
  }
}
