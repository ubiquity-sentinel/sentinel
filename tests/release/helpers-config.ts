// Shared synthetic deployment configuration and controllable clock; registers no tests.
import type { GitSha } from "../../src/contracts/brands.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import type { DeploymentIdentityV1 } from "../../src/contracts/shared.ts";
import type { StabilityPolicyV1 } from "../../src/contracts/repository-config.ts";
import type { ReleaseTargetConfigV1 } from "../../src/release/config.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";

export const DEP_0: DeploymentIdentityV1 = {
  gitSha: SHA2,
  revisionId: "dep-0000",
};
export const DEP_1: DeploymentIdentityV1 = {
  gitSha: SHA1,
  revisionId: "dep-0001",
};
export const DEP_X: DeploymentIdentityV1 = {
  gitSha: "1111111111111111111111111111111111111111" as GitSha,
  revisionId: "dep-0009",
};

/**
 * Public synthetic Deno managed host used by every fixture: the actual
 * two-label shape `<project>.<organization>.deno.net`, so the trusted
 * immutable hostname form (`<first-label>-<revisionId>` plus the rest of the
 * configured hostname) is exercised exactly as production derives it. No
 * generic-host fallback exists in the port.
 */
export const MANAGED_URL = "https://ai-ubq-fi.ubiquity-dao.deno.net";
export const CUSTOM_URL = "https://ai.ubq.fi";
export const API_URL = "https://api.deno.com";
export const PROJECT_ID = "project-ubq";
export const HEALTH_HEADERS = {
  "cache-control": "no-store",
} as const;
export const BODY_MARKER = '"status":"available"';
export const GIT_SHA_HEADER = "x-uos-git-sha";
export const REVISION_HEADER = "x-uos-deployment-id";

/** Immutable managed base URL for one exact revision (test-side mirror). */
export function immutableUrl(revisionId: string): string {
  const managed = new URL(MANAGED_URL);
  const hostname = managed.hostname;
  const firstLabel = hostname.slice(0, hostname.indexOf("."));
  return `https://${firstLabel}-${revisionId}${
    hostname.slice(firstLabel.length)
  }`;
}

export function targetConfig(
  overrides: Partial<ReleaseTargetConfigV1> = {},
): ReleaseTargetConfigV1 {
  return {
    projectId: PROJECT_ID,
    apiBaseUrl: API_URL,
    managedBaseUrl: MANAGED_URL,
    customBaseUrl: CUSTOM_URL,
    acceptance: {
      healthPath: "/health",
      metricsPath: "/health",
      managedBodyMarker: BODY_MARKER,
      managedHeaders: [],
      domain: "ai.ubq.fi",
    },
    identityHeaders: {
      gitSha: GIT_SHA_HEADER,
      revisionId: REVISION_HEADER,
    },
    timeoutFailureKinds: ["upstream_timeout"],
    upstreamWideFailureKinds: ["upstream_error", "empty_upstream_completion"],
    logsLagMs: 5_000,
    ...overrides,
  };
}

export function stabilityPolicy(
  overrides: Partial<StabilityPolicyV1> = {},
): StabilityPolicyV1 {
  return {
    windowMs: 30 * 60 * 1000,
    sampleIntervalMs: 30 * 1000,
    minSamples: 60,
    minRequests: 50,
    baselineWindowMs: 30 * 60 * 1000,
    baselineMinSamples: 60,
    thresholds: [
      {
        metric: "five_xx_rate",
        maxRate: 0.02,
        maxIncrease: 0.01,
      },
      {
        metric: "timeout_rate",
        maxRate: 0.01,
        maxIncrease: 0.01,
      },
      {
        metric: "stream_failure_rate",
        maxRate: 0.01,
        maxIncrease: 0.01,
      },
    ],
    ...overrides,
  };
}

/** Deterministic test clock; the controller only advances by explicit ticks. */
export class TestClock implements Clock {
  private current = T0;

  constructor(start = T0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  at(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

// ---------------------------------------------------------------------------
// Scripted transport.
// ---------------------------------------------------------------------------
