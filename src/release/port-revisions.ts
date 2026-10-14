// Exact candidate membership and stable current-deployment verification.
import type {
  BuildLookupV1,
  DenoDeploymentV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  DENO_MAX_RESPONSE_BYTES,
  DENO_REVISION_TRAVERSAL_MAX_PAGES,
  DENO_REVISIONS_PAGE_LIMIT,
} from "./config.ts";
import { denoRestCall } from "./http.ts";
import {
  type DenoReleasePortOptions,
  ReleasePortContext,
} from "./port-context.ts";
import type { DenoReleaseHealthClient } from "./port-health.ts";
import {
  DENO_REVISION_ID_RE,
  GIT_SHA_RE,
  immutableManagedBaseUrl,
  sameIdentity,
} from "./port-identity.ts";
import {
  parseNextLinkCursor,
  parseRevisionListItem,
  parseRevisionResource,
  type RevisionListItemV1,
  type RevisionResourceV1,
} from "./port-revision-shapes.ts";

const DENO_REVISION_TRAVERSAL_MAX_ENTRIES = DENO_REVISIONS_PAGE_LIMIT *
  DENO_REVISION_TRAVERSAL_MAX_PAGES;

export class DenoReleaseRevisionClient extends ReleasePortContext {
  constructor(
    options: DenoReleasePortOptions,
    private readonly health: DenoReleaseHealthClient,
  ) {
    super(options);
  }

  async findBuiltCandidate(
    projectId: string,
    revision: GitSha,
    buildTransactionId: string,
    revisionId: string,
  ): Promise<PortResultV1<BuildLookupV1>> {
    if (projectId !== this.config.projectId) {
      return portError(
        "invalid",
        "candidate project does not match the configured target",
      );
    }
    if (!GIT_SHA_RE.test(revision)) {
      return portError("invalid", "candidate revision is not a valid Git SHA");
    }
    if (!DENO_REVISION_ID_RE.test(revisionId)) {
      return portError(
        "invalid",
        "candidate revision id cannot form an immutable hostname",
      );
    }
    const items = await this.listSucceededRevisions(projectId);
    if (!items.ok) return items;

    // The receipt selects the EXACT revision id. A different build for the
    // same SHA is irrelevant; a duplicate exact id is never "found"; the
    // transaction id is receipt provenance only (not a platform label).
    const matches = items.value.filter((item) => item.id === revisionId);
    if (matches.length > 1) {
      return portOk({ status: "ambiguous" as const });
    }
    if (matches.length === 0) {
      // The exact receipt revision is not a succeeded build of the configured
      // app: not built (or not visible) yet. Never an order/time substitution.
      return portOk({ status: "none" as const });
    }
    const item = matches[0];
    const resource = await this.readRevision(item.id);
    if (!resource.ok) return resource;
    if (
      resource.value.id !== item.id ||
      resource.value.status !== "succeeded"
    ) {
      return portOk({ status: "ambiguous" as const });
    }

    // The immutable deployment host is derived from the trusted managed base
    // URL (never from any platform-supplied URL) and must serve the exact
    // receipt identity in both body and headers with an available status.
    const immutableBase = immutableManagedBaseUrl(
      this.config.managedBaseUrl,
      revisionId,
    );
    if (immutableBase === null) {
      return portError(
        "invalid",
        "managed host cannot form an immutable health URL",
      );
    }
    const health = await this.health.sampleHealth({
      baseUrl: immutableBase,
      healthPath: this.config.acceptance.healthPath,
      managedBodyMarker: this.config.acceptance.managedBodyMarker,
      managedHeaders: [
        ...this.config.acceptance.managedHeaders,
        { name: this.config.identityHeaders.gitSha, value: revision },
        {
          name: this.config.identityHeaders.revisionId,
          value: revisionId,
        },
      ],
      domain: null,
    });
    if (
      !health.ok ||
      health.value.httpStatus !== 200 ||
      health.value.status !== "healthy" ||
      health.value.identity === null ||
      health.value.identity.gitSha !== revision ||
      health.value.identity.revisionId !== revisionId
    ) {
      // Missing/failed/wrong immutable identity must never yield "found".
      return portOk({ status: "ambiguous" as const });
    }
    return portOk({
      status: "found",
      build: {
        projectId,
        buildTransactionId,
        identity: { gitSha: revision, revisionId: item.id },
        status: "succeeded",
        createdAt: item.createdAt ?? 0,
      },
    });
  }

  async readCurrentDeployment(
    projectId: string,
  ): Promise<PortResultV1<DenoDeploymentV1>> {
    if (projectId !== this.config.projectId) {
      return portError(
        "invalid",
        "deployment project does not match the configured target",
      );
    }
    const domain = this.config.acceptance.domain ??
      new URL(this.config.managedBaseUrl).host;
    const healthConfig = this.health.managedHealthConfig(null);
    const observed = await this.health.sampleHealth(healthConfig);
    if (
      !observed.ok ||
      observed.value.httpStatus !== 200 ||
      observed.value.status !== "healthy" ||
      observed.value.identity === null
    ) {
      // Unknown or unavailable health is never claimed healthy or as a
      // positive not-deployed result; no identity is inferred from it.
      return portOk({
        projectId,
        identity: null,
        domain,
        status: "unknown",
        updatedAt: null,
      });
    }
    const identity = observed.value.identity;

    const items = await this.listSucceededRevisions(projectId);
    if (!items.ok) return items;
    const matches = items.value.filter(
      (item) => item.id === identity.revisionId,
    );
    if (matches.length !== 1) {
      // Absent or duplicated exact membership: the platform cannot
      // corroborate the observed deployment. Never select by position/order.
      return portOk({
        projectId,
        identity: null,
        domain,
        status: "unknown",
        updatedAt: null,
      });
    }
    const item = matches[0];
    const resource = await this.readRevision(item.id);
    if (!resource.ok) return resource;
    if (
      resource.value.id !== item.id ||
      resource.value.status !== "succeeded"
    ) {
      return portOk({
        projectId,
        identity: null,
        domain,
        status: "unknown",
        updatedAt: null,
      });
    }

    // Stable recheck: the identity must be unchanged across the verification
    // steps, otherwise the deployment moved and no live claim is made.
    const recheck = await this.health.sampleHealth(healthConfig);
    if (
      !recheck.ok ||
      recheck.value.httpStatus !== 200 ||
      recheck.value.status !== "healthy" ||
      recheck.value.identity === null ||
      !sameIdentity(recheck.value.identity, identity)
    ) {
      return portOk({
        projectId,
        identity: null,
        domain,
        status: "unknown",
        updatedAt: null,
      });
    }
    return portOk({
      projectId,
      identity,
      domain,
      status: "live",
      updatedAt: item.createdAt,
    });
  }

  private async listSucceededRevisions(
    projectId: string,
  ): Promise<PortResultV1<RevisionListItemV1[]>> {
    const items: RevisionListItemV1[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      pages++;
      if (pages > DENO_REVISION_TRAVERSAL_MAX_PAGES) {
        return portError(
          "invalid",
          "revision listing exceeded the page bound",
        );
      }
      const page = await this.readRevisionPage(projectId, cursor);
      if (!page.ok) return page;
      for (const item of page.value.items) {
        if (seenIds.has(item.id)) {
          // A repeated exact id across pages makes the listing inconsistent:
          // no single entry can be bound.
          return portError(
            "invalid",
            "revision listing contains a duplicate exact id",
          );
        }
        seenIds.add(item.id);
        items.push(item);
        if (items.length > DENO_REVISION_TRAVERSAL_MAX_ENTRIES) {
          return portError(
            "invalid",
            "revision listing exceeded the entry bound",
          );
        }
      }
      if (page.value.nextCursor === null) {
        if (page.value.items.length >= DENO_REVISIONS_PAGE_LIMIT) {
          // A full page with no usable continuation is inconclusive: the
          // exact membership proof is incomplete and fails closed.
          return portError(
            "invalid",
            "revision listing is inconclusive at the page bound",
          );
        }
        // A normal final shorter page without a continuation is exhausted.
        return portOk(items);
      }
      if (seenCursors.has(page.value.nextCursor)) {
        return portError(
          "invalid",
          "revision listing repeated a pagination cursor",
        );
      }
      seenCursors.add(page.value.nextCursor);
      cursor = page.value.nextCursor;
    }
  }

  private async readRevisionPage(
    projectId: string,
    cursor: string | null,
  ): Promise<
    PortResultV1<{ items: RevisionListItemV1[]; nextCursor: string | null }>
  > {
    const params = new URLSearchParams({
      status: "succeeded",
      limit: String(DENO_REVISIONS_PAGE_LIMIT),
    });
    if (cursor !== null) params.set("cursor", cursor);
    const call = await denoRestCall(
      {
        baseUrl: this.config.apiBaseUrl,
        path: `/v2/apps/${encodeURIComponent(projectId)}/revisions`,
        query: params,
        method: "GET",
        responseByteCap: DENO_MAX_RESPONSE_BYTES,
      },
      this.transport,
      this.auth,
    );
    if (!call.ok) return call;
    if (call.value.status !== 200) {
      return portError("unavailable", "revision listing is unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(call.value.body));
    } catch {
      return portError("invalid", "revision listing is not valid JSON");
    }
    if (!Array.isArray(parsed)) {
      return portError("invalid", "revision listing has an unexpected shape");
    }
    const items: RevisionListItemV1[] = [];
    for (const raw of parsed) {
      const item = parseRevisionListItem(raw);
      if (item === null) {
        return portError("invalid", "revision listing has a malformed entry");
      }
      items.push(item);
    }
    const headers = new Headers();
    for (const [name, value] of call.value.headers) {
      headers.set(name, value);
    }
    const parsedLink = parseNextLinkCursor(
      headers.get("link") ?? null,
      projectId,
      this.config.apiBaseUrl,
    );
    if (!parsedLink.ok) return parsedLink;
    return portOk({ items, nextCursor: parsedLink.value });
  }

  private async readRevision(
    revisionId: string,
  ): Promise<PortResultV1<RevisionResourceV1>> {
    const call = await denoRestCall(
      {
        baseUrl: this.config.apiBaseUrl,
        path: `/v2/revisions/${encodeURIComponent(revisionId)}`,
        method: "GET",
        responseByteCap: DENO_MAX_RESPONSE_BYTES,
      },
      this.transport,
      this.auth,
    );
    if (!call.ok) return call;
    if (call.value.status !== 200) {
      return portError("unavailable", "revision resource is unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(call.value.body));
    } catch {
      return portError("invalid", "revision resource is not valid JSON");
    }
    const item = parseRevisionResource(parsed);
    if (item === null) {
      return portError("invalid", "revision resource has a malformed shape");
    }
    return portOk(item);
  }
}
