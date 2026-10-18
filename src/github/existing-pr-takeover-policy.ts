/** Source-owned activation only; repository variables cannot raise this boundary. */
export const EXISTING_PR_TAKEOVER_ACTIVATED = false;

/**
 * This flag alone is insufficient: the trusted launcher must also prove the
 * exact installed runtime capability and exclude R80/R81 execution/fallback.
 * Discovery may suppress duplicate creation while activation is false, but
 * no native-head preservation, adoption or delegated effect is authorized.
 */
export interface ExistingPrTakeoverPolicy {
  readonly activated: boolean;
}

export const EXISTING_PR_TAKEOVER_POLICY: ExistingPrTakeoverPolicy = Object
  .freeze({
    activated: EXISTING_PR_TAKEOVER_ACTIVATED,
  });
