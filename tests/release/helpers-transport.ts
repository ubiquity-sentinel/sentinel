// Stateful scripted Deno transport; registers no tests.
import type { DeploymentIdentityV1 } from "../../src/contracts/shared.ts";
import type { ReleaseTargetConfigV1 } from "../../src/release/config.ts";
import {
  DEP_0,
  GIT_SHA_HEADER,
  HEALTH_HEADERS,
  REVISION_HEADER,
  targetConfig,
} from "./helpers-config.ts";

export interface RouteCallV1 {
  method: string;
  host: string;
  pathname: string;
  search: string;
  authorization: string | null;
}

export type RouteResponseV1 =
  | {
    kind: "response";
    status: number;
    headers?: Record<string, string>;
    body?: string;
  }
  | { kind: "reject" };

export interface RouteV1 {
  method: string;
  /** Exact pathname, or a RegExp.source string starting with "^". */
  pathname: string;
  respond: (url: URL) => RouteResponseV1 | Promise<RouteResponseV1>;
}

/**
 * Stateful scripted transport: routes by method + pathname; queries and the
 * mutable deployed state are visible to route handlers. Every call is
 * recorded (method/path/query/authz) so tests can prove exactly which effects
 * were attempted and how often.
 */
export class ScriptedTransport {
  readonly calls: RouteCallV1[] = [];
  /** Exact identity currently served by the managed/custom domains. */
  deployed: DeploymentIdentityV1 = DEP_0;
  /** Mutable per-test behavior. */
  customStatus: number = 200;
  /**
   * When true, a 403 custom response carries the full identified Cloudflare
   * challenge header set (server: cloudflare, cf-mitigated: challenge,
   * cf-ray); when false it is a bare origin 403.
   */
  customCloudflare: boolean = false;
  /** Custom-domain transport failure (the probe is unobservable). */
  customReject: boolean = false;
  /** Managed health 200 with valid identity headers but a missing body marker. */
  managedBodyMissing: boolean = false;
  /**
   * Per-call managed STABLE health identities: when non-empty each probe
   * serves the next entry (the last one repeats), so a moving deployment can
   * be scripted deterministically.
   */
  managedIdentitySequence: DeploymentIdentityV1[] = [];
  private managedSequenceCursor = 0;
  /**
   * Exact identity served by the immutable managed host for one revision id.
   * Lookup order: this map first, then the revisions installed by
   * `installREST` (which are registered there).
   */
  immutableIdentities: Map<string, DeploymentIdentityV1> = new Map();
  /**
   * Per-request override for one immutable health probe. Receives the looked
   * up identity (null when unknown) and returns a raw response or null to use
   * the default identity body/headers. Enables body/header discrepancy and
   * wrong-identity scripting.
   */
  immutableHealth:
    | ((identity: DeploymentIdentityV1 | null) => RouteResponseV1 | null)
    | null = null;
  /**
   * Per-request override for one managed STABLE health probe. Receives the
   * identity that would be served and returns a raw response or null to use
   * the default body/headers. Enables body/header discrepancy and malformed
   * identity scripting on the stable host.
   */
  managedHealth:
    | ((identity: DeploymentIdentityV1) => RouteResponseV1 | null)
    | null = null;
  identityOverride: DeploymentIdentityV1 | null = null;
  customIdentityOverride: DeploymentIdentityV1 | null = null;
  /** When true, the logs endpoint rejects (transport failure). */
  logsReject: boolean = false;
  /** Known succeeded revisions (set by installREST); used by promote routes. */
  revisions: DeploymentIdentityV1[] = [];
  private routes: RouteV1[] = [];

  constructor(readonly config: ReleaseTargetConfigV1 = targetConfig()) {}

  route(entry: RouteV1): this {
    this.routes.push(entry);
    return this;
  }

  any(method: string, pattern: RegExp, respond: RouteV1["respond"]): this {
    this.routes.push({ method, pathname: pattern.source, respond });
    return this;
  }

  private identity(): DeploymentIdentityV1 {
    return this.identityOverride ?? this.deployed;
  }

  /** Managed-domain health: 200 + exact body marker + identity headers. */
  health(path = "/health"): this {
    const managedBase = new URL(this.config.managedBaseUrl);
    const customBase = this.config.customBaseUrl === null
      ? null
      : new URL(this.config.customBaseUrl);
    if (customBase !== null) {
      this.any(
        "GET",
        new RegExp(
          `^${escapeRegExp(customBase.href.slice(0, -1))}${
            escapeRegExp(path)
          }$`,
        ),
        () => this.customHealthResponse(),
      );
    }
    this.any(
      "GET",
      new RegExp(
        `^${escapeRegExp(managedBase.href.slice(0, -1))}${escapeRegExp(path)}$`,
      ),
      () => {
        const sequence = this.managedIdentitySequence.length > 0
          ? this.managedIdentitySequence[
            Math.min(
              this.managedSequenceCursor,
              this.managedIdentitySequence.length - 1,
            )
          ]
          : null;
        this.managedSequenceCursor++;
        const effective = sequence ?? this.identity();
        const override = this.managedHealth?.(effective);
        if (override !== null && override !== undefined) return override;
        return this.identityHealthResponse(200, effective);
      },
    );
    // Immutable managed hostname for one exact revision:
    // <first-label>-<revisionId> + the REST of the configured managed hostname
    // (the actual two-label shape keeps the `<organization>.deno.net` suffix).
    // The looked-up identity is the immutableIdentities map entry or the
    // installed revision. The suffix is derived from the configured trusted
    // host, never hardcoded to a single-label form.
    const managedHostName = managedBase.hostname;
    const firstLabel = managedHostName.slice(
      0,
      managedHostName.indexOf("."),
    );
    const managedSuffix = managedHostName.slice(firstLabel.length);
    this.any(
      "GET",
      new RegExp(
        `^https://${escapeRegExp(firstLabel)}-[A-Za-z0-9_-]+${
          escapeRegExp(managedSuffix)
        }${escapeRegExp(path)}$`,
      ),
      (url) => {
        const hostname = url.hostname;
        const revisionId = hostname.slice(
          firstLabel.length + 1,
          hostname.length - managedSuffix.length,
        );
        const identity = this.immutableIdentities.get(revisionId) ??
          this.revisions.find((entry) => entry.revisionId === revisionId) ??
          null;
        const override = this.immutableHealth?.(identity);
        if (override !== null && override !== undefined) return override;
        if (identity === null) return { kind: "reject" };
        return this.identityHealthResponse(200, identity);
      },
    );
    return this;
  }

  private customHealthResponse(): RouteResponseV1 {
    if (this.customReject) return { kind: "reject" };
    if (this.customStatus !== 200) {
      return {
        kind: "response",
        status: this.customStatus,
        headers: this.customStatus === 403 && this.customCloudflare
          ? {
            server: "cloudflare",
            "cf-mitigated": "challenge",
            "cf-ray": "abc123",
          }
          : {},
        body: "Forbidden",
      };
    }
    return this.identityHealthResponse(
      200,
      this.customIdentityOverride ?? this.identity(),
    );
  }

  private identityHealthResponse(
    status: number,
    forced: DeploymentIdentityV1 | null = null,
  ): RouteResponseV1 {
    const identity = forced ?? this.identity();
    return {
      kind: "response",
      status,
      headers: {
        ...HEALTH_HEADERS,
        [GIT_SHA_HEADER]: identity.gitSha,
        [REVISION_HEADER]: identity.revisionId,
      },
      body: this.managedBodyMissing
        ? `{"status":"maintenance","release":{"git_sha":"${identity.gitSha}","deployment_id":"${identity.revisionId}"}}`
        : `{"status":"available","release":{"git_sha":"${identity.gitSha}","deployment_id":"${identity.revisionId}"}}`,
    };
  }

  /** Raw body override for a single pathname (e.g. malformed responses). */
  raw(pathname: string, method: string, respond: RouteV1["respond"]): this {
    this.routes.push({ method, pathname, respond });
    return this;
  }

  /** Reject (transport failure) for one method+pathname. */
  reject(method: string, pattern: RegExp): this {
    this.routes.push({
      method,
      pathname: pattern.source,
      respond: () => ({ kind: "reject" }),
    });
    return this;
  }

  private resolveRoute(method: string, pathname: string): RouteV1 | null {
    // Last registration wins: an override route replaces an earlier one.
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const route = this.routes[i];
      if (route.method !== method) continue;
      if (route.pathname.startsWith("^")) {
        if (new RegExp(route.pathname).test(pathname)) return route;
      } else if (route.pathname === pathname) {
        return route;
      }
    }
    return null;
  }

  callCount(method: string, pathnameRegex: RegExp): number {
    return this.calls.filter((call) =>
      call.method === method && pathnameRegex.test(call.pathname)
    ).length;
  }

  async fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers ?? {});
    this.calls.push({
      method,
      host: url.host,
      pathname: url.pathname,
      search: url.search,
      authorization: headers.get("authorization"),
    });
    const route = this.resolveRoute(method, url.pathname) ??
      this.resolveRoute(method, url.href);
    if (route === null) {
      throw new Error(`unexpected transport call: ${method} ${url.pathname}`);
    }
    const outcome = await route.respond(url);
    if (outcome.kind === "reject") {
      throw new Error("synthetic transport failure");
    }
    return new Response(outcome.body ?? null, {
      status: outcome.status,
      headers: outcome.headers ?? {},
    });
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
