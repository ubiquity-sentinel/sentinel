/** Per-target token and optional App-principal selection for the Actions host. */
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  createOptionalHostedAppPrincipalContext,
  type HostedAppPrincipalContext,
  type HostedAppPrincipalHostInput,
} from "./hosted-app-principal.ts";
import {
  dispatchPremergeCi,
  type PremergeCiReportV1,
} from "./actions-premerge-ci.ts";
import { SENTINEL_APP_INSTALLATION_ID } from "./hosted-app-grant.ts";

export interface ActionsTargetBindingsInputV1 {
  selfRepository: RepositoryIdentityV1;
  selfToken: string | undefined;
  selfWriteToken: string;
  targetToken: string;
  targetLogin: string;
  actionsLogin: string;
  appLogin: string;
  auth: Omit<HostedAppPrincipalHostInput, "appToken" | "mintGrant">;
  targetMintGrant: string | undefined;
  selfMintGrant: string | undefined;
  targetInstallationId?: number;
  selfInstallationId?: number;
  contextsAllowed: boolean;
  sourceProfiles: unknown;
}

export interface ActionsTargetBindingsV1 {
  isSelfTarget(config: RepositoryConfigV1): boolean;
  tokenFor(config: RepositoryConfigV1): string;
  loginFor(config: RepositoryConfigV1): string;
  targetContext: HostedAppPrincipalContext | null;
  selfContext: HostedAppPrincipalContext | null;
  /**
   * One bounded pre-merge CI dispatch for a target whose CI never runs on a
   * Sentinel pull request itself, on the target token and its mint grant.
   */
  premergeCi(config: RepositoryConfigV1): Promise<PremergeCiReportV1>;
}

export async function createActionsTargetBindings(
  input: ActionsTargetBindingsInputV1,
): Promise<ActionsTargetBindingsV1> {
  const isSelfTarget = (config: RepositoryConfigV1): boolean =>
    config.repository.owner === input.selfRepository.owner &&
    config.repository.name === input.selfRepository.name;
  const context = (
    token: string | undefined,
    mintGrant: string | undefined,
    expectedInstallationId: number | undefined,
  ): Promise<HostedAppPrincipalContext | null> =>
    input.contextsAllowed
      ? createOptionalHostedAppPrincipalContext(
        {
          ...input.auth,
          appToken: token,
          mintGrant,
          expectedInstallationId,
        },
        token,
        mintGrant,
        input.sourceProfiles,
      )
      : Promise.resolve(null);
  return {
    isSelfTarget,
    tokenFor: (config) =>
      isSelfTarget(config) ? input.selfWriteToken : input.targetToken,
    loginFor: (config) =>
      isSelfTarget(config)
        ? (input.selfToken === undefined ? input.actionsLogin : input.appLogin)
        : input.targetLogin,
    targetContext: await context(
      input.targetToken,
      input.targetMintGrant,
      input.targetInstallationId,
    ),
    selfContext: await context(
      input.selfToken,
      input.selfMintGrant,
      input.selfInstallationId,
    ),
    premergeCi: (config) =>
      dispatchPremergeCi({
        http: input.auth.http,
        clock: input.auth.clock,
        state: input.auth.state,
        gate: input.auth.gate,
        token: input.targetToken,
        mintGrant: input.targetMintGrant,
        installationId: input.targetInstallationId ??
          SENTINEL_APP_INSTALLATION_ID,
        trustedAuthor: input.targetLogin,
        deadline: input.auth.deadline,
      }, config),
  };
}
