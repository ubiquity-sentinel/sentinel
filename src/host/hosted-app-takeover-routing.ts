/** Restrictive coordination metadata, independent of App mutation authority. */
import { EXISTING_PR_TAKEOVER_ACTIVATED } from "../github/existing-pr-takeover-policy.ts";
import {
  type HostedAppSourceInput,
  parseHostedAppSourceProfiles,
  readHostedAppSourceEvidence,
} from "./hosted-app-principal-source.ts";
import { parseHostedCustodyCapability } from "./hosted-custody-capability.ts";
import { parseHostedRuntimeRollout } from "./hosted-runtime-rollout.ts";

export interface HostedAppTakeoverRouting {
  readonly status: "inactive" | "required" | "unknown";
}
const inactive: HostedAppTakeoverRouting = Object.freeze({
  status: "inactive",
});
const required: HostedAppTakeoverRouting = Object.freeze({
  status: "required",
});
const unknown: HostedAppTakeoverRouting = Object.freeze({ status: "unknown" });

/**
 * This never authenticates a principal or grants an effect. Required/unknown
 * retain native discovery and the replacement-PR guard when App proof fails.
 * The optional profile argument is the same trusted in-process fixture seam as
 * the principal reader; no environment input selects it.
 */
export async function readHostedAppTakeoverRouting(
  source: HostedAppSourceInput,
  sourceProfiles?: unknown,
): Promise<HostedAppTakeoverRouting> {
  try {
    const accepted = sourceProfiles === undefined
      ? undefined
      : parseHostedAppSourceProfiles(sourceProfiles);
    // Intentional legacy deployment exception: empty runtime-owned profiles and
    // compiled false admission mean unconfigured/inert. This is not evidence
    // about actual L policy. Configured or malformed source cannot use it.
    if (accepted?.length === 0 && !EXISTING_PR_TAKEOVER_ACTIVATED) {
      return inactive;
    }
    const evidence = await readHostedAppSourceEvidence(source, accepted);
    if (evidence === null) return unknown;
    const capability = parseHostedCustodyCapability(
      JSON.parse(evidence.capabilityText),
    );
    parseHostedRuntimeRollout(JSON.parse(evidence.rolloutText));
    return capability.takeover.activated ? required : inactive;
  } catch {
    return unknown;
  }
}
