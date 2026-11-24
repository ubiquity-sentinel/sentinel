import { canonicalStringify } from "../src/contracts/canonical.ts";
import { portOk } from "../src/contracts/ports.ts";
import {
  type GatewayAuthProviderV1,
  gatewayRead,
  type GatewayTransportV1,
} from "../src/adapters/gateway/http.ts";

const ORIGIN = "https://ai.ubq.fi";
const WINDOW_MS = 48 * 60 * 60 * 1000;
const PER_REQUEST_MS = 8_000;
const TOTAL_MS = 60_000;
const RESPONSE_BYTE_CAP = 2 * 1024 * 1024;
const ERROR_LIMIT = 500;
const INCIDENT_LIMIT = 100;
const MAX_INCIDENT_PAGES = 20;
const MIN_REPEAT = 2;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const INCIDENT_ID =
  /^provider-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURSOR = /^[A-Za-z0-9_-]+={0,2}$/;
const UNAVAILABLE = "Daily gateway failure scan unavailable.";

export const DAILY_GATEWAY_ROUTES = [
  "responses",
  "chat.completions",
  "decisions",
  "systemone",
  "images.generations",
  "images.edits",
  "embeddings",
  "embeddings.jobs.create",
  "embeddings.jobs.get",
] as const;
export const DAILY_GATEWAY_KINDS = [
  "gateway_5xx",
  "unexpected_upstream_stream_end",
] as const;
export const DAILY_GATEWAY_COUNT_KEYS = [
  "observed_requests",
  "http_4xx",
  "client_quota",
  "cancellations",
  "auth_security",
  "provider_failures",
  "other_failures",
  "prior_release",
  "singleton_clusters",
  "active_incident_groups",
  ...DAILY_GATEWAY_KINDS,
] as const;

type Route = typeof DAILY_GATEWAY_ROUTES[number];
type Kind = typeof DAILY_GATEWAY_KINDS[number];
type Count = typeof DAILY_GATEWAY_COUNT_KEYS[number];
interface Finding {
  kind: Kind;
  route: Route;
  count: number;
  release_sha: string;
}
export interface DailyGatewayScanReport {
  version: 1;
  window: { start_ms: number; end_ms: number };
  release_sha: string;
  coverage: "complete" | "partial";
  counts: Record<Count, number>;
  findings: Finding[];
}

function insist(condition: unknown): asserts condition {
  if (!condition) throw new Error(UNAVAILABLE);
}

function record(value: unknown): Record<string, unknown> {
  insist(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: readonly string[]) {
  insist(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
  );
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) {
  insist(
    typeof value === "number" && Number.isSafeInteger(value) &&
      value >= min && value <= max,
  );
  return value;
}

function text(value: unknown, max = 256) {
  insist(typeof value === "string" && value.length > 0 && value.length <= max);
  return value;
}

export function parseDailyGatewayScanReport(
  value: unknown,
): DailyGatewayScanReport {
  const report = record(value);
  closed(report, [
    "version",
    "window",
    "release_sha",
    "coverage",
    "counts",
    "findings",
  ]);
  insist(
    report.version === 1 && SHA.test(text(report.release_sha, 40)) &&
      (report.coverage === "complete" || report.coverage === "partial"),
  );
  const window = record(report.window);
  closed(window, ["start_ms", "end_ms"]);
  insist(
    integer(window.end_ms, WINDOW_MS) - integer(window.start_ms, 0) ===
      WINDOW_MS,
  );
  const counts = record(report.counts);
  closed(counts, DAILY_GATEWAY_COUNT_KEYS);
  const observed = integer(counts.observed_requests, 0, ERROR_LIMIT);
  for (const key of DAILY_GATEWAY_COUNT_KEYS) {
    integer(
      counts[key],
      0,
      key === "active_incident_groups"
        ? MAX_INCIDENT_PAGES * INCIDENT_LIMIT
        : observed,
    );
  }
  insist(
    Array.isArray(report.findings) &&
      report.findings.length <=
        DAILY_GATEWAY_ROUTES.length * DAILY_GATEWAY_KINDS.length,
  );
  const seen = new Set<string>();
  const totals = { gateway_5xx: 0, unexpected_upstream_stream_end: 0 };
  for (const item of report.findings) {
    const finding = record(item);
    closed(finding, ["kind", "route", "count", "release_sha"]);
    const kind = DAILY_GATEWAY_KINDS.find((value) => value === finding.kind);
    const route = DAILY_GATEWAY_ROUTES.find((value) => value === finding.route);
    insist(kind && route && finding.release_sha === report.release_sha);
    const key = kind + "/" + route;
    insist(!seen.has(key));
    seen.add(key);
    totals[kind] += integer(finding.count, MIN_REPEAT, observed);
  }
  for (const kind of DAILY_GATEWAY_KINDS) {
    insist(totals[kind] <= integer(counts[kind], 0, observed));
  }
  return value as DailyGatewayScanReport;
}

const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "cf-access-client-id",
  "cf-access-client-secret",
  "user-agent",
]);

function adminAuth(raw: string): GatewayAuthProviderV1 {
  insist(raw.length > 0 && raw.length <= 16 * 1024);
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error(UNAVAILABLE);
  }
  const parsed = record(input);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const key = name.toLowerCase();
    insist(AUTH_HEADER_NAMES.has(key) && !Object.hasOwn(headers, key));
    const header = text(value, 8192);
    insist(!/\p{Cc}/u.test(header));
    headers[key] = header;
  }
  insist(/^Bearer \S+$/.test(headers.authorization ?? ""));
  insist(
    Object.hasOwn(headers, "cf-access-client-id") ===
      Object.hasOwn(headers, "cf-access-client-secret"),
  );
  return { headers: () => Promise.resolve(portOk(headers)) };
}

const PUBLIC_AUTH: GatewayAuthProviderV1 = {
  headers: () => Promise.resolve(portOk({})),
};
const PROVIDERS = new Set([
  "chatgpt_codex",
  "surplus",
  "metered",
  "claude_code",
  "cerebras",
  "deepseek",
  "gemini",
  "lithos",
  "openrouter",
]);
const STREAM_ENDS = new Set([
  "premature_eof",
  "missing_sse_terminal",
  "stream_eof_without_completion",
]);
const STREAM_TERMINALS = new Set(["error", "eof", "response.failed"]);
const AUTH_FAILURES = new Set([
  "invalid_api_key",
  "invalid_token",
  "unauthorized",
  "forbidden",
  "permission_denied",
  "content_filter",
  "safety_violation",
]);
const TRANSPORT_ENDS = new Set([
  "cancelled",
  "request_cancelled",
  "downstream_delivery_interrupted",
]);
const CLIENT_QUOTA = new Set([
  "api_key_quota_exceeded",
  "rate_limit_exceeded",
  "quota_exhausted",
  "too_many_requests",
  "http_429",
]);

interface ErrorRow {
  id: string;
  at: number;
  status: number;
  provider: string;
  route: Route | undefined;
  release: string | null;
  stream: boolean | null;
  terminal: string;
  failure: string;
  delivery: string;
}

function errorRow(value: unknown): ErrorRow {
  const row = record(value);
  insist(row.version === 1);
  insist(row.git_sha === null || SHA.test(text(row.git_sha, 40)));
  insist(row.stream === null || typeof row.stream === "boolean");
  insist(
    row.delivery_outcome === "delivered" ||
      row.delivery_outcome === "interrupted" ||
      row.delivery_outcome === "unobserved",
  );
  const route = text(row.route);
  return {
    id: text(row.request_id),
    at: integer(row.created_at_ms, 0),
    status: integer(row.status, 100, 599),
    provider: text(row.provider),
    route: DAILY_GATEWAY_ROUTES.find((value) => value === route),
    release: row.git_sha as string | null,
    stream: row.stream,
    terminal: text(row.terminal_type),
    failure: text(row.failure_kind),
    delivery: row.delivery_outcome,
  };
}

function eligible(row: ErrorRow): Kind | undefined {
  if (!row.route || row.delivery !== "delivered") return;
  if (
    row.provider === "gateway" && row.status === 500 &&
    (row.terminal === "http.error" || row.terminal === "error") &&
    (row.failure === "http_500" || row.failure === "internal_error")
  ) return "gateway_5xx";
  if (
    (row.status === 200 || row.status === 502) && row.stream === true &&
    (PROVIDERS.has(row.provider) || row.provider === "gateway") &&
    STREAM_ENDS.has(row.failure) && STREAM_TERMINALS.has(row.terminal)
  ) return "unexpected_upstream_stream_end";
}

function summarizeRows(
  data: unknown[],
  window: DailyGatewayScanReport["window"],
  release: string,
  counts: Record<Count, number>,
): Finding[] {
  const seen = new Set<string>();
  const clusters = new Map<string, Finding>();
  let previous = Number.MAX_SAFE_INTEGER;
  for (const value of data) {
    const row = errorRow(value);
    insist(row.at <= previous);
    previous = row.at;
    if (
      row.at < window.start_ms || row.at >= window.end_ms || seen.has(row.id)
    ) continue;
    seen.add(row.id);
    counts.observed_requests++;
    if (row.status >= 400 && row.status < 500) counts.http_4xx++;
    if (row.release !== release) counts.prior_release++;

    if (
      row.status === 499 || TRANSPORT_ENDS.has(row.terminal) ||
      TRANSPORT_ENDS.has(row.failure)
    ) {
      counts.cancellations++;
    } else if (
      row.status === 401 || row.status === 403 || AUTH_FAILURES.has(row.failure)
    ) {
      counts.auth_security++;
    } else if (
      row.provider === "gateway" &&
      (row.status === 429 || CLIENT_QUOTA.has(row.failure))
    ) {
      counts.client_quota++;
    } else {
      const kind = row.release === release ? eligible(row) : undefined;
      if (kind && row.route) {
        counts[kind]++;
        // A failure for each of two different upstreams is not one repeat.
        const key = [kind, row.route, row.provider].join("/");
        const current = clusters.get(key);
        if (current) current.count++;
        else {clusters.set(key, {
            kind,
            route: row.route,
            count: 1,
            release_sha: release,
          });}
      } else if (
        PROVIDERS.has(row.provider) && (row.status === 429 || row.status >= 500)
      ) {
        counts.provider_failures++;
      } else if (row.status < 400 || row.status >= 500) {
        counts.other_failures++;
      }
    }
  }
  const findings = new Map<string, Finding>();
  for (const finding of clusters.values()) {
    if (finding.count < MIN_REPEAT) {
      counts.singleton_clusters++;
      continue;
    }
    const key = finding.kind + "/" + finding.route;
    const current = findings.get(key);
    if (current) current.count += finding.count;
    else findings.set(key, finding);
  }
  return [...findings.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  ).map(([, finding]) => finding);
}

type ReadStage = "health" | "errors" | "incidents";
type ScanStage = ReadStage | "auth" | "output";
type ScanReason =
  | "auth_failed"
  | "invalid_data"
  | "http_status"
  | "rate_limited"
  | "deadline"
  | "transport_unavailable"
  | "pagination_incomplete"
  | "pagination_bound"
  | "output_unavailable";

class ScanFailure extends Error {
  constructor(stage: ScanStage, reason: ScanReason, status?: number) {
    super(
      `${UNAVAILABLE} Stage ${stage}.${
        status === undefined ? "" : ` HTTP ${status}.`
      } Reason ${reason}.`,
    );
  }
}

const READ_PATHS: Record<ReadStage, string> = {
  health: "/health",
  errors: "/admin/errors",
  incidents: "/admin/sentinel/incidents",
};

export async function scanDailyGateway(
  authJson: string,
  options: {
    now?: number;
    transport?: GatewayTransportV1;
    requestTimeoutMs?: number;
  } = {},
): Promise<DailyGatewayScanReport> {
  let stage: ScanStage = "auth";
  let status: number | undefined;
  try {
    const auth = adminAuth(authJson);
    const transport = options.transport ?? fetch;
    const end = integer(options.now ?? Date.now(), WINDOW_MS);
    const window = { start_ms: end - WINDOW_MS, end_ms: end };
    const deadline = performance.now() + TOTAL_MS;
    const requestTimeoutMs = integer(
      options.requestTimeoutMs ?? PER_REQUEST_MS,
      1,
      PER_REQUEST_MS,
    );
    let healthHeader: string | null = null;
    const read = async (reading: ReadStage, query: URLSearchParams) => {
      stage = reading;
      for (let attempt = 0;; attempt++) {
        status = undefined;
        let receivedStatus: number | undefined;
        let receivedSha: string | null = null;
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) throw new ScanFailure(reading, "deadline");
        const result = await gatewayRead(
          {
            baseUrl: ORIGIN,
            path: READ_PATHS[reading],
            query,
            responseByteCap: RESPONSE_BYTE_CAP,
            requestTimeoutMs: Math.min(requestTimeoutMs, remaining),
          },
          async (input, init) => {
            const response = await transport(input, init);
            if (
              Number.isInteger(response.status) && response.status >= 100 &&
              response.status <= 599
            ) {
              receivedStatus = response.status;
            }
            if (reading === "health") {
              receivedSha = response.headers.get("x-uos-git-sha");
            }
            return response;
          },
          reading === "health" ? PUBLIC_AUTH : auth,
        );
        status = receivedStatus;
        if (reading === "health") healthHeader = receivedSha;
        if (result.ok && result.value.status === 200) {
          return record(result.value.body);
        }
        const error = result.ok ? undefined : result.error;
        // One extra attempt for transient faults, including a stalled or lost
        // body. gatewayRead bounds the entire response and cancels failed reads.
        const transient = error?.kind === "unavailable" &&
          (status === undefined || status === 200 || status === 502 ||
            status === 503 || status === 504);
        if (attempt === 0 && transient && performance.now() < deadline) {
          continue;
        }
        let reason: ScanReason = "http_status";
        if (error?.kind === "auth_failed") reason = "auth_failed";
        else if (error?.kind === "rate_limited") reason = "rate_limited";
        else if (error?.detail === "gateway request exceeded the time bound") {
          reason = "deadline";
        } else if (error?.kind === "invalid" && status === 200) {
          reason = "invalid_data";
        } else if (status === undefined || status === 200) {
          reason = "transport_unavailable";
        }
        throw new ScanFailure(reading, reason, status);
      }
    };
    const health = await read("health", new URLSearchParams());
    const release = text(record(health.release).git_sha, 40);
    insist(
      health.status === "available" && SHA.test(release) &&
        healthHeader === release,
    );
    const errors = await read(
      "errors",
      new URLSearchParams({ limit: String(ERROR_LIMIT) }),
    );
    insist(
      errors.object === "list" && Array.isArray(errors.data) &&
        errors.data.length <= ERROR_LIMIT,
    );
    const counts = Object.fromEntries(
      DAILY_GATEWAY_COUNT_KEYS.map((key) => [key, 0]),
    ) as Record<Count, number>;
    const findings = summarizeRows(errors.data, window, release, counts);
    const capped = errors.data.length === ERROR_LIMIT &&
      errorRow(errors.data[ERROR_LIMIT - 1]).at >= window.start_ms;

    const fingerprints = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_INCIDENT_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(INCIDENT_LIMIT) });
      if (cursor !== null) query.set("cursor", cursor);
      const incidents = await read("incidents", query);
      if (record(incidents.coverage).status !== "complete") {
        throw new ScanFailure("incidents", "pagination_incomplete", status);
      }
      insist(
        Array.isArray(incidents.data) &&
          incidents.data.length <= INCIDENT_LIMIT,
      );
      for (const value of incidents.data) {
        const row = record(value);
        insist(INCIDENT_ID.test(text(row.incident_id, 64)));
        const fingerprint = text(row.fingerprint, 64);
        insist(DIGEST.test(fingerprint) && !fingerprints.has(fingerprint));
        fingerprints.add(fingerprint);
        integer(row.count, 1);
        const first = integer(row.first_seen_at_ms, 0);
        const last = integer(row.last_seen_at_ms, first);
        if (last >= window.start_ms && last < window.end_ms) {
          counts.active_incident_groups++;
        }
      }
      if (incidents.cursor === null) {
        return parseDailyGatewayScanReport({
          version: 1,
          window,
          release_sha: release,
          coverage: capped ? "partial" : "complete",
          counts,
          findings,
        });
      }
      cursor = text(incidents.cursor, 2048);
      insist(
        CURSOR.test(cursor) && !cursors.has(cursor) &&
          incidents.data.length > 0,
      );
      cursors.add(cursor);
    }
    throw new ScanFailure("incidents", "pagination_bound", status);
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure(
      stage,
      stage === "auth" ? "auth_failed" : "invalid_data",
      status,
    );
  }
}

export function dailyGatewayStepSummary(
  report: DailyGatewayScanReport,
): string {
  const window = `${new Date(report.window.start_ms).toISOString()} to ${
    new Date(report.window.end_ms).toISOString()
  }`;
  const coverage = report.coverage === "partial"
    ? "Partial error history. The latest 500 rows do not reach the start of the window."
    : "Complete within the two gateway inventory endpoints.";
  return [
    "## Daily gateway failure scan",
    "",
    `Gateway release \`${report.release_sha}\``,
    `Window ${window}`,
    coverage,
    "",
    "| Measure | Count |",
    "| --- | ---: |",
    ...DAILY_GATEWAY_COUNT_KEYS.map((key) =>
      `| ${key} | ${report.counts[key]} |`
    ),
    "",
    `Qualifying groups observed ${report.findings.length}`,
    "",
    ...(report.findings.length === 0 ? [] : [
      report.coverage === "partial"
        ? "### Qualifying repeats observed within partial coverage"
        : "### Qualifying repeats",
      "",
      "| Kind | Route | Observed count |",
      "| --- | --- | ---: |",
      ...report.findings.map(({ kind, route, count }) =>
        `| ${kind} | ${route} | ${count} |`
      ),
      "",
    ]),
  ].join("\n");
}

if (import.meta.main) {
  let summaryPath: string | undefined;
  try {
    insist(Deno.args.length === 0);
    summaryPath = Deno.env.get("GITHUB_STEP_SUMMARY");
    const outputPath = Deno.env.get("GITHUB_OUTPUT");
    insist(summaryPath && outputPath);
    const report = await scanDailyGateway(
      Deno.env.get("SENTINEL_GATEWAY_AUTH_JSON") ?? "",
    );
    await Deno.writeTextFile(summaryPath, dailyGatewayStepSummary(report), {
      append: true,
    });
    const qualifies = report.findings.length > 0;
    await Deno.writeTextFile(
      outputPath,
      `findings_json=${canonicalStringify(report)}\nqualifies=${qualifies}\n`,
      { append: true },
    );
  } catch (error) {
    const message = error instanceof ScanFailure
      ? error.message
      : new ScanFailure("output", "output_unavailable").message;
    if (summaryPath) {
      try {
        await Deno.writeTextFile(summaryPath, `${message}\n`, {
          append: true,
        });
      } catch {
        // Keep the failure diagnostic fixed even when summary output is unavailable.
      }
    }
    console.error(message);
    Deno.exitCode = 1;
  }
}
