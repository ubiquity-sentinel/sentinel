/**
 * DenoReleasePort implementation over the documented Deno REST API plus the
 * managed/custom domain health endpoints.
 *
 * Endpoints and resource identity fields (no invented API):
 * - GET  /v2/apps/{app}/revisions?status=succeeded&limit=N[&cursor=...]
 *   → RevisionListItem[] (id, status, labels, created_at); pagination
 *   continuation is the rel=next Link response header, whose cursor is
 *   extracted and replayed on the configured API origin
 * - GET  /v2/revisions/{revision}                            → Revision
 * - POST /v2/revisions/{revision}/promote                    → 204 No Content
 * - GET  /v2/apps/{app}/logs?start&end&revision_id&limit&cursor
 *   → { logs:[{timestamp,level,message,revision_id}], next_cursor }
 *
 * Identity is always the pair {gitSha, revisionId}; a revision id alone, a
 * timestamp or the latest list item is never a substitute. The candidate
 * lookup takes the EXACT revision id from the authenticated build-receipt
 * resolver and proves its membership in the configured app by bounded page
 * traversal (never time/list-order selection) plus the exact revision
 * resource. Two same-SHA builds never bind the wrong receipt: the revision id
 * is the unique platform selector and the build transaction id remains
 * resolver-provided provenance that this module never infers or labels.
 *
 * The client is constructed with trusted config (project id, identity header
 * names, log classification, bounds) plus injected transports, auth and
 * clock; no environment variable or CLI surface exists.
 */
import {
  type BuildLookupV1,
  DENO_PROMOTION_REQUIRED_STATUS,
  type DenoDeploymentV1,
  type DenoPromotionOutcomeV1,
  type DenoPromotionRequestV1,
  type DenoReleasePort,
  type HealthSampleConfigV1,
  type HealthSampleV1,
  type MetricsSampleConfigV1,
  type MetricsSampleV1,
  type PortResultV1,
} from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import type { GitSha } from "../contracts/brands.ts";
import { DENO_MAX_RESPONSE_BYTES } from "./config.ts";
import { denoRestCall } from "./http.ts";
import {
  type DenoReleasePortOptions,
  ReleasePortContext,
} from "./port-context.ts";
import { DenoReleaseHealthClient } from "./port-health.ts";
import { DenoReleaseRevisionClient } from "./port-revisions.ts";
import { DenoReleaseMetricsClient } from "./port-metrics.ts";
export type { DenoReleasePortOptions } from "./port-context.ts";

export class DenoReleaseRESTClient extends ReleasePortContext
  implements DenoReleasePort {
  private readonly health: DenoReleaseHealthClient;
  private readonly revisions: DenoReleaseRevisionClient;
  private readonly metrics: DenoReleaseMetricsClient;

  constructor(options: DenoReleasePortOptions) {
    super(options);
    this.health = new DenoReleaseHealthClient(options);
    this.revisions = new DenoReleaseRevisionClient(options, this.health);
    this.metrics = new DenoReleaseMetricsClient(options);
  }

  findBuiltCandidate(
    projectId: string,
    revision: GitSha,
    buildTransactionId: string,
    revisionId: string,
  ): Promise<PortResultV1<BuildLookupV1>> {
    return this.revisions.findBuiltCandidate(
      projectId,
      revision,
      buildTransactionId,
      revisionId,
    );
  }

  readCurrentDeployment(
    projectId: string,
  ): Promise<PortResultV1<DenoDeploymentV1>> {
    return this.revisions.readCurrentDeployment(projectId);
  }

  async promote(
    request: DenoPromotionRequestV1,
  ): Promise<PortResultV1<DenoPromotionOutcomeV1>> {
    const path = `/v2/revisions/${
      encodeURIComponent(request.identity.revisionId)
    }/promote`;
    const call = await denoRestCall(
      {
        baseUrl: this.config.apiBaseUrl,
        path,
        method: "POST",
        responseByteCap: DENO_MAX_RESPONSE_BYTES,
      },
      this.transport,
      this.auth,
    );
    if (!call.ok) {
      if (call.error.kind === "auth_failed") return call;
      // Transport/timeout/byte-bound failure: the effect may or may not have
      // been applied. Reconciliation observes the deployment; it never
      // blindly repeats the POST.
      return portOk({
        outcome: "ambiguous",
        statusCode: null,
        detail: "promotion outcome is unknown",
      });
    }
    const statusCode = call.value.status;
    if (statusCode !== DENO_PROMOTION_REQUIRED_STATUS) {
      return portOk({
        outcome: "rejected",
        statusCode,
        detail: "promotion did not return 204",
      });
    }
    // A 204 has no content; the post-effect identity proof is the controller's
    // managed-domain observation, never the response body itself.
    if (call.value.body.byteLength > 0) {
      return portOk({
        outcome: "ambiguous",
        statusCode,
        detail: "promotion returned 204 with an unexpected body",
      });
    }
    return portOk({
      outcome: "promoted",
      statusCode: DENO_PROMOTION_REQUIRED_STATUS,
      observedIdentity: null,
    });
  }

  sampleHealth(
    config: HealthSampleConfigV1,
  ): Promise<PortResultV1<HealthSampleV1>> {
    return this.health.sampleHealth(config);
  }

  sampleMetrics(
    config: MetricsSampleConfigV1,
  ): Promise<PortResultV1<MetricsSampleV1>> {
    return this.metrics.sampleMetrics(config);
  }
}
