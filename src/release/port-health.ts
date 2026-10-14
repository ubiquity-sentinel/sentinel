// Bounded health probes with exact body/header identity and Cloudflare proof.
import type {
  HealthSampleConfigV1,
  HealthSampleV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { DeploymentIdentityV1 } from "../contracts/shared.ts";
import type { GitSha } from "../contracts/brands.ts";
import { DENO_MAX_RESPONSE_BYTES } from "./config.ts";
import { ReleasePortContext } from "./port-context.ts";
import {
  GIT_SHA_RE,
  headerEquals,
  isVerifiedCloudflareChallenge,
} from "./port-identity.ts";

const DENO_HEALTH_TIMEOUT_MS = 5_000;

export class DenoReleaseHealthClient extends ReleasePortContext {
  async sampleHealth(
    config: HealthSampleConfigV1,
  ): Promise<PortResultV1<HealthSampleV1>> {
    const response = await this.unauthenticatedGet(
      config.baseUrl,
      config.healthPath,
    );
    if (!response.ok) {
      return portOk({
        at: this.clock.now(),
        status: "unreachable",
        httpStatus: null,
        bodyMarkerPresent: null,
        headersMatch: null,
        identity: null,
        domain: config.domain,
      });
    }
    const status = response.value.status;
    const bodyText = new TextDecoder().decode(response.value.body);
    const headers = new Headers();
    for (const [name, value] of response.value.headers) {
      headers.set(name, value);
    }
    if (status !== 200) {
      const verifiedCloudflare = status === 403
        ? isVerifiedCloudflareChallenge(headers)
        : false;
      return portOk({
        at: this.clock.now(),
        status: "degraded",
        httpStatus: status,
        bodyMarkerPresent: null,
        // For a 403 this reports whether the response is the target's
        // identified Cloudflare Bot Fight Mode challenge (server: cloudflare,
        // cf-mitigated: challenge, cf-ray present). Any other non-200 keeps
        // the null sentinel (no header verification was possible).
        headersMatch: status === 403 ? verifiedCloudflare : null,
        identity: null,
        domain: config.domain,
      });
    }
    const bodyMarkerPresent = bodyText.includes(
      config.managedBodyMarker,
    );
    const headersMatch = config.managedHeaders.every((entry) =>
      headerEquals(headers, entry.name, entry.value)
    );
    // The verified identity requires BOTH the validated identity headers and
    // the parsed body `release.git_sha`/`release.deployment_id` to present
    // the same exact identity with an available status. Any missing,
    // malformed or contradictory body/header identity is degraded with no
    // verified identity; it is never healthy and never an inference.
    const verifiedIdentity = this.verifiedBodyIdentity(bodyText, headers);
    const healthy = bodyMarkerPresent && headersMatch &&
      verifiedIdentity !== null;
    return portOk({
      at: this.clock.now(),
      status: healthy ? "healthy" : "degraded",
      httpStatus: status,
      bodyMarkerPresent,
      headersMatch,
      identity: healthy ? verifiedIdentity : null,
      domain: config.domain,
    });
  }

  managedHealthConfig(domain: string | null): HealthSampleConfigV1 {
    return {
      baseUrl: this.config.managedBaseUrl,
      healthPath: this.config.acceptance.healthPath,
      managedBodyMarker: this.config.acceptance.managedBodyMarker,
      managedHeaders: [...this.config.acceptance.managedHeaders],
      domain,
    };
  }

  private identityFromHeaders(headers: Headers): DeploymentIdentityV1 | null {
    const gitSha = headers.get(this.config.identityHeaders.gitSha) ?? null;
    const revisionId = headers.get(this.config.identityHeaders.revisionId) ??
      null;
    if (gitSha === null || revisionId === null) return null;
    if (!/^[0-9a-f]{40}$/.test(gitSha)) return null;
    if (revisionId.length === 0 || revisionId.length > 256) return null;
    return { gitSha: gitSha as GitSha, revisionId };
  }

  private verifiedBodyIdentity(
    bodyText: string,
    headers: Headers,
  ): DeploymentIdentityV1 | null {
    const headerIdentity = this.identityFromHeaders(headers);
    if (headerIdentity === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.status !== "available") return null;
    const release = obj.release;
    if (
      typeof release !== "object" || release === null || Array.isArray(release)
    ) {
      return null;
    }
    const releaseObj = release as Record<string, unknown>;
    const gitSha = releaseObj.git_sha;
    const revisionId = releaseObj.deployment_id;
    if (
      typeof gitSha !== "string" || typeof revisionId !== "string" ||
      !GIT_SHA_RE.test(gitSha) ||
      revisionId.length === 0 ||
      revisionId.length > 256
    ) {
      return null;
    }
    const bodyIdentity: DeploymentIdentityV1 = {
      gitSha: gitSha as GitSha,
      revisionId,
    };
    if (
      bodyIdentity.gitSha !== headerIdentity.gitSha ||
      bodyIdentity.revisionId !== headerIdentity.revisionId
    ) {
      return null;
    }
    return bodyIdentity;
  }

  private async unauthenticatedGet(
    baseUrl: string,
    path: string,
  ): Promise<
    PortResultV1<
      { status: number; body: Uint8Array; headers: [string, string][] }
    >
  > {
    // Finite whole-operation deadline plus a streaming byte cap: the health
    // probe cannot hang the release loop on a stuck peer.
    const controller = new AbortController();
    let expired = false;
    let resolveHappened: () => void = () => {};
    const happened = new Promise<void>((resolve) => {
      resolveHappened = resolve;
    });
    const timer = setTimeout(() => {
      expired = true;
      try {
        controller.abort();
      } catch {
        // Best-effort teardown.
      }
      resolveHappened();
    }, DENO_HEALTH_TIMEOUT_MS);
    try {
      const response = await Promise.race([
        this.transport(`${baseUrl}${path}`, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
        }),
        happened.then((): never => {
          throw new Error("health deadline");
        }),
      ]);
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => headers.push([name, value]));
      if (response.body === null) {
        return portOk({
          status: response.status,
          body: new Uint8Array(),
          headers,
        });
      }
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const outcome = await Promise.race([
          reader.read().then(
            (result) => ({ kind: "chunk" as const, result }),
            (): { kind: "failed" } => ({ kind: "failed" as const }),
          ),
          happened.then((): { kind: "expired" } => ({
            kind: "expired" as const,
          })),
        ]);
        if (expired || outcome.kind === "expired") {
          return portError(
            "unavailable",
            "health endpoint exceeded the time bound",
          );
        }
        if (outcome.kind === "failed") {
          return portError(
            "unavailable",
            "health response body could not be read",
          );
        }
        if (outcome.result.done) break;
        if (outcome.result.value.byteLength > DENO_MAX_RESPONSE_BYTES - total) {
          return portError("invalid", "health response exceeds the byte bound");
        }
        total += outcome.result.value.byteLength;
        parts.push(new Uint8Array(outcome.result.value));
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        body.set(part, offset);
        offset += part.byteLength;
      }
      return portOk({ status: response.status, body, headers });
    } catch {
      return portError("unavailable", "health endpoint is unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
