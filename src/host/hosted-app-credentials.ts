/** Reads one run's App credentials and live installation identities. */
import { optionalEnv } from "./actions-host-io.ts";
import { HOSTED_CONTROLLER_SELF_INSTALLATION_ID } from "../contracts/hosted-controller-deployment.ts";

/** Static refusal: the self installation is not the committed one. */
export const HOSTED_SELF_INSTALLATION_REFUSED =
  "hosted self installation is not the committed one";
import {
  DEFAULT_APP_INSTALLATION_ID,
  parseAppInstallationId,
} from "./actions-target-cycles.ts";
import {
  SELF_INSTALLATION_ID_ENV,
  SELF_MINT_GRANT_ENV,
  SELF_TOKEN_ENV,
  TARGET_INSTALLATION_ID_ENV,
} from "./hosted-app-grant.ts";

export interface HostedAppCredentialsV1 {
  readonly appToken: string | undefined;
  readonly selfToken: string | undefined;
  readonly selfGrant: string | undefined;
  readonly targetInstallationId: number;
  readonly selfInstallationId: number;
}

/**
 * Missing live ids retain the pre-migration single-installation behavior.
 * The tokens never cross owners: an absent self token leaves the self
 * repository on the native token (its caller's fallback) rather than on the
 * `ubiquity` installation token, which cannot reach `ubiquity-sentinel`.
 */
export function readHostedAppCredentials(
  readEnv: (name: string) => string | undefined,
): HostedAppCredentialsV1 {
  const appToken = optionalEnv(readEnv, "SENTINEL_SUPERVISOR_TOKEN");
  const selfToken = optionalEnv(readEnv, SELF_TOKEN_ENV);
  const selfGrant = selfToken === undefined
    ? undefined
    : optionalEnv(readEnv, SELF_MINT_GRANT_ENV);
  const targetEnv = optionalEnv(readEnv, TARGET_INSTALLATION_ID_ENV);
  const targetInstallationId = targetEnv === undefined
    ? DEFAULT_APP_INSTALLATION_ID
    : parseAppInstallationId(targetEnv);
  const selfEnv = optionalEnv(readEnv, SELF_INSTALLATION_ID_ENV);
  const selfInstallationId = selfEnv === undefined
    ? targetInstallationId
    : parseAppInstallationId(selfEnv);
  // A deployment that commits its self installation runs only on it, so a
  // self token minted for any other organization never reaches its state.
  if (
    HOSTED_CONTROLLER_SELF_INSTALLATION_ID !== null &&
    selfInstallationId !== HOSTED_CONTROLLER_SELF_INSTALLATION_ID
  ) throw new Error(HOSTED_SELF_INSTALLATION_REFUSED);
  return {
    appToken,
    selfToken,
    selfGrant,
    targetInstallationId,
    selfInstallationId,
  };
}
