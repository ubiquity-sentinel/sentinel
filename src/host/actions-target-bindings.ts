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
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  postProgressComments,
  progressChanges,
  type ProgressCommentsReportV1,
} from "./progress-comments.ts";

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
  /**
   * Plain-language progress comments for one target's cycle (#183), posted on
   * that target's own token through the shared cooldown gate.
   */
  progressComments(
    config: RepositoryConfigV1,
    before: readonly WorkRecordV1[],
    after: readonly WorkRecordV1[],
  ): Promise<ProgressCommentsReportV1>;
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
  const tokenFor = (config: RepositoryConfigV1): string =>
    isSelfTarget(config) ? input.selfWriteToken : input.targetToken;
  return {
    isSelfTarget,
    tokenFor,
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
    progressComments: (config, before, after) =>
      postProgressComments(
        {
          http: input.auth.http,
          clock: input.auth.clock,
          gate: input.auth.gate,
          token: tokenFor(config),
          deadline: input.auth.deadline,
        },
        config,
        progressChanges(before, after, config.repository),
      ),
  };
}
