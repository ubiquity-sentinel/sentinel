/** Read-only App collector. Native capture acceptance remains a separate owner step. */
import { isGitSha } from "../src/contracts/brands.ts";
import { canonicalStringifySha256 } from "../src/contracts/canonical.ts";
import {
  createDeadline,
  type DeadlineV1,
  type HttpResponseV1,
} from "../src/github/http.ts";
import { parseJsonStrict } from "../src/github/journal-json.ts";
import type { GitHubApiClientOptionsV1 } from "../src/github/client-contracts.ts";
import { GitHubQueueDeliveryClient } from "../src/github/client-queue-delivery.ts";
import { sanitizedCanaryArtifact } from "./queue-canary-artifact.ts";
import {
  CANARY_APP_ID,
  CANARY_APP_SLUG,
  CANARY_REF,
  CANARY_REPOSITORY,
} from "./queue-canary-pins.ts";
import type { CanaryHost, CanaryIdentity } from "./queue-canary.ts";
import {
  API_VERSION,
  captureCopy,
  integer,
  type JsonObject,
  keys,
  object,
  parseProjectionCapture,
  ProjectionRefusal,
  requireProjection,
  same,
} from "./queue-rules-projection-input.ts";
import { queueRulesCaptureSha256 } from "./queue-rules-projection.ts";

export interface QueueRulesProjectionTarget {
  branch: "queue-canary" | "development";
  stagedRulesetId: number;
}
interface RawResponse {
  method: "GET";
  path: string;
  status: number;
  headers: Record<string, string>;
  /** Exact UTF-8 body, after safe parsed-content validation; never redacted bytes. */
  bodyBase64: string[];
  bodySha256: string;
}
export type QueueRulesProjectionCollection =
  | { status: "unavailable"; reason: string }
  | {
    status: "collected";
    kind: "sentinel.queue-rules-collection.v1";
    expectationOnly: true;
    source: CanaryHost;
    sourceDigest: string;
    identity: JsonObject;
    /** Installation/actor reads bracket all policy reads; credentials are never retained. */
    identityReads: JsonObject[];
    targets: {
      target: QueueRulesProjectionTarget;
      captures: JsonObject[];
      captureSha256: string[];
    }[];
    rawResponses: RawResponse[];
    retainedHeaderPolicy: "queue-projection-response-headers.v1";
  };

export function validProjectionTargets(
  value: unknown,
): value is readonly QueueRulesProjectionTarget[] {
  try {
    requireProjection(
      Array.isArray(value) && value.length > 0 && value.length <= 2,
      "invalid_targets",
    );
    for (const entry of value) {
      const row = keys(entry, ["branch", "stagedRulesetId"]);
      requireProjection(
        (row.branch === "queue-canary" || row.branch === "development") &&
          integer(row.stagedRulesetId),
        "invalid_targets",
      );
    }
    return new Set(value.map((v) => v.branch)).size === value.length &&
      new Set(value.map((v) => v.stagedRulesetId)).size === value.length;
  } catch {
    return false;
  }
}

const ROOT = "/repos/ubiquity/ai.ubq.fi";
const INSTALLATION = "/installation/repositories?per_page=100&page=1";
const ACTOR = "/users/ubiquity-sentinel%5Bbot%5D";
const INVENTORY = `${ROOT}/rulesets?includes_parents=true&per_page=100&page=1`;
// HTTP response metadata is explicitly selected, not a raw authentication transcript.
const HEADERS = new Set([
  "date",
  "x-github-request-id",
  "x-github-api-version-selected",
  "link",
  "etag",
  "content-type",
  "content-length",
  "last-modified",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-used",
  "x-ratelimit-resource",
]);
/** Retain actual transport bytes while preserving existing auth/cooldown handling. */
class QueueProjectionGitHub extends GitHubQueueDeliveryClient {
  constructor(options: GitHubApiClientOptionsV1) {
    super({
      ...options,
      http: async (request) => {
        const response = await options.http({
          ...request,
          responseType: "bytes",
        });
        if (response.bodyBytes === undefined) {
          throw new Error("raw_bytes_unavailable");
        }
        return {
          ...response,
          bodyText: new TextDecoder("utf-8", { fatal: true }).decode(
            response.bodyBytes,
          ),
        };
      },
    }, null);
  }
  async getProjectionResponse(
    path: string,
    deadline: DeadlineV1,
  ): Promise<HttpResponseV1> {
    requireProjection(
      path === INSTALLATION || path === ACTOR || path === INVENTORY ||
        /^\/repos\/ubiquity\/ai\.ubq\.fi\/rulesets\/[1-9][0-9]*\?includes_parents=true$/
          .test(path) ||
        /^\/repos\/ubiquity\/ai\.ubq\.fi\/rules\/branches\/(queue-canary|development)\?per_page=100&page=1$/
          .test(path),
      "read_scope",
    );
    const raw = await this.sendCore(
      "GET",
      `https://api.github.com${path}`,
      null,
      undefined,
      deadline,
    );
    if (raw.status !== "response") {
      throw new Error("projection_read_unavailable");
    }
    return raw.response;
  }
}
/** Expose only fixed-endpoint GET; inherited client effects stay unreachable. */
export function createQueueProjectionGet(options: GitHubApiClientOptionsV1) {
  requireProjection(
    same(options.repository, CANARY_REPOSITORY) &&
      options.apiBaseUrl === "https://api.github.com",
    "read_scope",
  );
  const reader = new QueueProjectionGitHub(options);
  return (path: string, deadline: DeadlineV1) =>
    reader.getProjectionResponse(path, deadline);
}
function safe(value: unknown): void {
  requireProjection(
    same(value, sanitizedCanaryArtifact(value)),
    "unsafe_capture",
  );
  const pending = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === null || typeof next !== "object") continue;
    for (const [key, child] of Object.entries(next)) {
      requireProjection(
        same(key, sanitizedCanaryArtifact(key)) &&
          !/(?:authorization|cookie|token|secret|password|private.?key)/i.test(
            key,
          ),
        "unsafe_capture",
      );
      pending.push(child);
    }
  }
}
function policy(capture: JsonObject): unknown {
  return {
    identity: capture.identity,
    branch: capture.branch,
    stagedRulesetId: capture.stagedRulesetId,
    inventory: object(capture.inventory).body,
    details: (capture.details as JsonObject[]).map((value) => value.body),
    effective: object(capture.effective).body,
  };
}
async function bytesHash(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function readQueueRulesProjection(input: {
  host: CanaryHost;
  identity: CanaryIdentity;
  targets: readonly QueueRulesProjectionTarget[];
  now: () => number;
  /** Trusted installation-authenticated GET, fixed origin, no redirect or write capability. */
  get: (path: string, deadline: DeadlineV1) => Promise<HttpResponseV1>;
}): Promise<QueueRulesProjectionCollection> {
  const deadline = createDeadline(120_000);
  try {
    // Copy source-owned construction inputs before the first asynchronous read.
    const source = captureCopy(input.host) as CanaryHost;
    const known = captureCopy(input.identity) as CanaryIdentity;
    const targets = captureCopy(input.targets) as QueueRulesProjectionTarget[];
    requireProjection(validProjectionTargets(targets), "invalid_targets");
    requireProjection(
      source.repository === "ubiquity-sentinel/sentinel" &&
        source.ref === CANARY_REF &&
        isGitSha(source.sha) && source.sha === source.workflowSha &&
        source.sha === source.expectedSha &&
        source.event === "workflow_dispatch" &&
        (source.action === "preflight" || source.action === "observe") &&
        integer(source.runId) && integer(source.attempt) &&
        /^[a-f0-9]{64}$/.test(source.bindingDigest) &&
        source.mintedAppSlug === CANARY_APP_SLUG &&
        source.mintedInstallationId === CANARY_REPOSITORY.installationId &&
        known.appId === CANARY_APP_ID && known.appSlug === CANARY_APP_SLUG &&
        known.installationId === CANARY_REPOSITORY.installationId &&
        integer(known.repositoryId) &&
        known.actor.login === `${CANARY_APP_SLUG}[bot]` &&
        known.actor.type === "Bot",
      "identity_unavailable",
    );
    const rawResponses: RawResponse[] = [], requestIds = new Set<string>();
    let bytesRead = 0;
    const read = async (path: string): Promise<JsonObject> => {
      requireProjection(rawResponses.length < 20, "request_bound");
      const response = await deadline.race(input.get(path, deadline));
      requireProjection(
        response.status === 200 && response.bodyBytes !== undefined,
        "response_unavailable",
      );
      const bytes = response.bodyBytes;
      bytesRead += bytes.length;
      requireProjection(
        bytes.length <= 256_000 && bytesRead <= 512_000,
        "response_bound",
      );
      const headers = Object.fromEntries(
        [...response.headers].filter(([name]) =>
          HEADERS.has(name.toLowerCase())
        ),
      );
      const observedAt = input.now(), at = Date.parse(headers.date ?? "");
      requireProjection(headers.link === undefined, "incomplete_pages");
      requireProjection(
        headers["x-github-api-version-selected"] === API_VERSION &&
          typeof headers["x-github-request-id"] === "string" &&
          headers["x-github-request-id"].length > 0 &&
          Number.isFinite(at) && at >= observedAt - 300_000 &&
          at <= observedAt + 999,
        "response_identity_unavailable",
      );
      requireProjection(
        !requestIds.has(headers["x-github-request-id"]),
        "request_replayed",
      );
      requestIds.add(headers["x-github-request-id"]);
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      requireProjection(decoded === response.bodyText, "body_mismatch");
      const body = captureCopy(parseJsonStrict(decoded));
      const captured = { method: "GET", path, status: 200, headers, body };
      safe(captured);
      const encoded = btoa(
        Array.from(bytes, (value) => String.fromCharCode(value)).join(""),
      );
      rawResponses.push({
        method: "GET",
        path,
        status: 200,
        headers,
        bodyBase64: encoded.match(/.{1,2048}/g) ?? [],
        bodySha256: await bytesHash(bytes),
      });
      return captured;
    };
    const identityReads: JsonObject[] = [];
    const observeIdentity = async () => {
      const installation = await read(INSTALLATION), actor = await read(ACTOR);
      const scope = object(installation.body), bot = object(actor.body);
      requireProjection(
        scope.total_count === 1 && Array.isArray(scope.repositories) &&
          scope.repositories.length === 1,
        "installation_scope",
      );
      const repo = object(scope.repositories[0]);
      requireProjection(
        repo.id === known.repositoryId &&
          repo.full_name === "ubiquity/ai.ubq.fi" &&
          bot.node_id === known.actor.nodeId &&
          bot.login === known.actor.login && bot.type === known.actor.type,
        "identity_drift",
      );
      identityReads.push(installation, actor);
    };
    await observeIdentity();
    const identity = {
      repository: { ...CANARY_REPOSITORY, id: known.repositoryId },
      app: { id: known.appId, ...known.actor },
    };
    const groups: Extract<
      QueueRulesProjectionCollection,
      { status: "collected" }
    >["targets"] = [];
    let inventoryPolicy: unknown = null;
    for (const target of targets) {
      const captures: JsonObject[] = [];
      for (let pass = 0; pass < 2; pass++) {
        const inventory = await read(INVENTORY);
        requireProjection(
          Array.isArray(inventory.body) && inventory.body.length > 0 &&
            inventory.body.length <= 2,
          "inventory_unavailable",
        );
        const ids = inventory.body.map((row) => object(row).id);
        requireProjection(
          ids.every(integer) && new Set(ids).size === ids.length &&
            ids.includes(target.stagedRulesetId),
          "inventory_mismatch",
        );
        const details: JsonObject[] = [];
        // Every inventory object is read, including the explicitly selected disabled object.
        for (const id of ids) {
          details.push(
            await read(`${ROOT}/rulesets/${id}?includes_parents=true`),
          );
        }
        const effective = await read(
          `${ROOT}/rules/branches/${target.branch}?per_page=100&page=1`,
        );
        // Receipt time follows the complete pass; never synthesize monotonic timestamps.
        const observedAt = input.now();
        requireProjection(
          integer(observedAt) &&
            (pass === 0 || observedAt > Number(captures[0].observedAt)),
          "clock_not_advanced",
        );
        const capture = {
          domain: "sentinel.queue-rules-capture.v1",
          apiVersion: API_VERSION,
          identity,
          observedAt,
          ...target,
          inventory,
          details,
          effective,
        };
        parseProjectionCapture(capture);
        const currentInventory = {
          inventory: inventory.body,
          details: details.map((response) => response.body),
        };
        if (inventoryPolicy === null) inventoryPolicy = currentInventory;
        requireProjection(
          same(currentInventory, inventoryPolicy),
          "inventory_drift",
        );
        captures.push(capture);
      }
      requireProjection(
        same(policy(captures[0]), policy(captures[1])),
        "policy_drift",
      );
      groups.push({
        target,
        captures,
        captureSha256: await Promise.all(captures.map(queueRulesCaptureSha256)),
      });
    }
    await observeIdentity();
    const result: QueueRulesProjectionCollection = {
      status: "collected",
      kind: "sentinel.queue-rules-collection.v1",
      expectationOnly: true,
      source,
      sourceDigest: await canonicalStringifySha256({
        domain: "sentinel.queue-canary-request.v1",
        ...source,
      }),
      identity,
      identityReads,
      targets: groups,
      rawResponses,
      retainedHeaderPolicy: "queue-projection-response-headers.v1",
    };
    safe(result);
    return result;
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof ProjectionRefusal
        ? error.message
        : "capture_unavailable",
    };
  } finally {
    deadline.dispose();
  }
}
