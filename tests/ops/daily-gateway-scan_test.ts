import assert from "node:assert/strict";
import {
  dailyGatewayStepSummary,
  parseDailyGatewayScanReport,
  scanDailyGateway,
} from "../../ops/daily-gateway-scan.ts";
import type { GatewayTransportV1 } from "../../src/adapters/gateway/http.ts";

const CURRENT = "1".repeat(40);
const OTHER = "2".repeat(40);
const NOW = Date.UTC(2026, 10, 24, 23, 30);
const START = NOW - 48 * 60 * 60 * 1000;
const CREDENTIAL = "synthetic-admin-token";
const AUTH = JSON.stringify({
  Authorization: `Bearer ${CREDENTIAL}`,
  "User-Agent": "synthetic user agent",
});
const PRIVATE = "private-test-marker\nqualifies=true";
const UNAVAILABLE = { message: "Daily gateway failure scan unavailable." };
function diagnostic(stage: string, reason: string, status?: number) {
  return {
    message: `${UNAVAILABLE.message} Stage ${stage}.${
      status === undefined ? "" : ` HTTP ${status}.`
    } Reason ${reason}.`,
  };
}

function row(number: number, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    request_id: `request-${number}-${PRIVATE}`,
    route: "responses",
    status: 500,
    provider: "gateway",
    model: null,
    reasoning: null,
    stream: false,
    terminal_type: "http.error",
    failure_kind: "http_500",
    delivery_outcome: "delivered",
    created_at_ms: NOW - number - 1,
    latency_ms: 158,
    git_sha: CURRENT,
    deno_revision: "vps-" + CURRENT,
    ...overrides,
  };
}

function incident(number: number, latest = NOW - number - 1) {
  return {
    incident_id: `provider-11111111-1111-4111-8111-${
      String(number).padStart(12, "0")
    }`,
    fingerprint: number.toString(16).padStart(64, "0"),
    severity: "P2",
    first_seen_at_ms: START - 3600,
    last_seen_at_ms: latest,
    count: 500_000,
    failing_revision: OTHER,
    error_type: "error",
    context: { message: PRIVATE, location: null, sample: [PRIVATE] },
    provenance: { endpoint: "https://ai.ubq.fi/v1/responses" },
    evidence_ref: { ref: PRIVATE },
    evidence_expires_at_ms: null,
  };
}

interface RequestObservation {
  href: string;
  method: string | undefined;
  redirect: RequestRedirect | undefined;
  authorization: string | null;
}

function fixture(options: {
  rows?: unknown[];
  pages?: unknown[];
  status?: number;
  healthSha?: string;
  healthDeployment?: string;
  healthDeploymentHeader?: string;
} = {}) {
  const calls: RequestObservation[] = [];
  let page = 0;
  const transport: GatewayTransportV1 = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({
      href: url.href,
      method: init?.method,
      redirect: init?.redirect,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url.pathname === "/health") {
      return Promise.resolve(Response.json({
        status: "available",
        release: {
          git_sha: CURRENT,
          deployment_id: options.healthDeployment ?? "vps-" + CURRENT,
        },
      }, {
        headers: {
          "x-uos-git-sha": options.healthSha ?? CURRENT,
          "x-uos-deployment-id": options.healthDeploymentHeader ??
            "vps-" + CURRENT,
        },
      }));
    }
    if (url.pathname === "/admin/errors") {
      return Promise.resolve(Response.json({
        object: "list",
        data: options.rows ?? [],
        five_xx_buckets: [{ bucket_start_at_ms: START, count: 9_000 }],
        retention: { state: "available" },
        log_files: { path: PRIVATE },
      }, { status: options.status ?? 200 }));
    }
    if (url.pathname === "/admin/sentinel/incidents") {
      const result = options.pages?.[page++] ??
        { data: [], cursor: null, coverage: { status: "complete" } };
      return Promise.resolve(Response.json(result));
    }
    throw new Error(PRIVATE);
  };
  return { transport, calls };
}

Deno.test("healthy collector reads only the fixed origin and validates pagination", async () => {
  const { transport, calls } = fixture({
    pages: [
      {
        data: [incident(1, START - 1)],
        cursor: "opaque_cursor==",
        coverage: { status: "complete" },
      },
      { data: [incident(2)], cursor: null, coverage: { status: "complete" } },
    ],
  });
  const report = await scanDailyGateway(AUTH, { now: NOW, transport });
  assert.deepEqual(report.window, { start_ms: START, end_ms: NOW });
  assert.equal(report.release_sha, CURRENT);
  assert.equal(report.coverage, "complete");
  assert.deepEqual(report.findings, []);
  assert.equal(report.counts.observed_requests, 0);
  assert.equal(report.counts.active_incident_groups, 1);
  assert.deepEqual(calls.map((entry) => entry.href), [
    "https://ai.ubq.fi/health",
    "https://ai.ubq.fi/admin/errors?limit=500",
    "https://ai.ubq.fi/admin/sentinel/incidents?limit=100",
    "https://ai.ubq.fi/admin/sentinel/incidents?limit=100&cursor=opaque_cursor%3D%3D",
  ]);
  assert.equal(calls[0]?.authorization, null);
  assert(
    calls.slice(1).every((entry) =>
      entry.authorization === `Bearer ${CREDENTIAL}`
    ),
  );
  assert(
    calls.every((entry) =>
      entry.redirect === "error" && entry.method === "GET"
    ),
  );
  assert(!JSON.stringify(report).includes("opaque_cursor"));
});

Deno.test("collector emits only repeated current-release failures with a closed projection", async () => {
  const stream = {
    status: 200,
    provider: "chatgpt_codex",
    stream: true,
    terminal_type: "error",
    failure_kind: "premature_eof",
  };
  const { transport } = fixture({
    rows: [
      row(1),
      row(2),
      row(3, { request_id: row(2).request_id }),
      row(4, { ...stream, route: "chat.completions" }),
      row(5, { ...stream, route: "chat.completions" }),
      row(6, { ...stream, route: "chat.completions", provider: "surplus" }),
      row(7, { status: 429, failure_kind: "http_429" }),
      row(8, {
        status: 429,
        failure_kind: "http_429",
        provider: "chatgpt_codex",
      }),
      row(9, { status: 401, failure_kind: "invalid_api_key" }),
      row(10, { status: 499, failure_kind: "request_cancelled" }),
      row(11, {
        ...stream,
        terminal_type: "cancelled",
        delivery_outcome: "interrupted",
      }),
      row(12, {
        status: 503,
        provider: "chatgpt_codex",
        failure_kind: "upstream_connection_lost",
      }),
      row(13, { git_sha: OTHER }),
      row(14, {
        route: PRIVATE,
        provider: PRIVATE,
        failure_kind: PRIVATE,
        model: PRIVATE,
        payload: PRIVATE,
      }),
      row(15, { status: 400, failure_kind: "invalid_request_error" }),
      row(16, { status: 500, failure_kind: "content_filter" }),
    ],
    pages: [{
      data: [incident(1)],
      cursor: null,
      coverage: { status: "complete" },
    }],
  });
  const report = await scanDailyGateway(AUTH, { now: NOW, transport });
  assert.deepEqual(report.findings, [
    { kind: "gateway_5xx", route: "responses", count: 2, release_sha: CURRENT },
    {
      kind: "unexpected_upstream_stream_end",
      route: "chat.completions",
      count: 2,
      release_sha: CURRENT,
    },
  ]);
  assert.equal(report.counts.observed_requests, 15);
  assert.equal(report.counts.http_4xx, 5);
  assert.equal(report.counts.client_quota, 1);
  assert.equal(report.counts.cancellations, 2);
  assert.equal(report.counts.provider_failures, 2);
  assert.equal(report.counts.auth_security, 2);
  assert.equal(report.counts.prior_release, 1);
  assert.equal(report.counts.singleton_clusters, 1);
  assert.equal(report.counts.active_incident_groups, 1);
  const encoded = JSON.stringify(report);
  for (
    const secret of [PRIVATE, "request-", "opaque_cursor", CREDENTIAL, "500000"]
  ) {
    assert(!encoded.includes(secret));
  }
  assert.throws(
    () => parseDailyGatewayScanReport({ ...report, payload: PRIVATE }),
    UNAVAILABLE,
  );
  assert.throws(() =>
    parseDailyGatewayScanReport({
      ...report,
      findings: [{ ...report.findings[0], route: PRIVATE }],
    }), UNAVAILABLE);
});

Deno.test("history saturation preserves observed repeats and makes coverage partial", async () => {
  const rows = [
    row(1),
    row(2),
    ...Array.from(
      { length: 498 },
      (_, index) => row(index + 3, { status: 400, failure_kind: "http_400" }),
    ),
  ];
  rows[499] = { ...rows[499], created_at_ms: START };
  const first = await scanDailyGateway(AUTH, {
    now: NOW,
    transport: fixture({ rows }).transport,
  });
  assert.equal(first.coverage, "partial");
  assert.equal(first.findings[0]?.count, 2);
  const partialSummary = dailyGatewayStepSummary(first);
  assert(
    partialSummary.includes(
      "Qualifying repeats observed within partial coverage",
    ),
  );
  assert(partialSummary.includes("| gateway_5xx | responses | 2 |"));
  assert(!partialSummary.includes(PRIVATE));
  rows[499] = { ...rows[499], created_at_ms: START - 1 };
  const second = await scanDailyGateway(AUTH, {
    now: NOW,
    transport: fixture({ rows }).transport,
  });
  assert.equal(second.coverage, "complete");
  assert.equal(second.counts.observed_requests, 499);
});

Deno.test("auth, health, transport, malformed rows and partial pages report fixed diagnostics", async () => {
  const unused = fixture();
  for (
    const secret of [
      PRIVATE,
      JSON.stringify({ authorization: `Bearer ${CREDENTIAL}`, Host: PRIVATE }),
    ]
  ) {
    await assert.rejects(
      scanDailyGateway(secret, { now: NOW, transport: unused.transport }),
      diagnostic("auth", "auth_failed"),
    );
  }
  assert.equal(unused.calls.length, 0);
  for (
    const [status, reason, attempts] of [
      [302, "http_status", 1],
      [401, "auth_failed", 1],
      [429, "rate_limited", 1],
      [503, "http_status", 2],
    ] as const
  ) {
    const { transport, calls } = fixture({ status });
    await assert.rejects(
      scanDailyGateway(AUTH, { now: NOW, transport }),
      diagnostic("errors", reason, status),
    );
    assert.equal(calls.length, 1 + attempts);
  }
  await assert.rejects(
    scanDailyGateway(AUTH, {
      now: NOW,
      transport: () => Promise.reject(new Error(PRIVATE)),
    }),
    diagnostic("health", "transport_unavailable"),
  );
  for (
    const options of [
      { healthSha: OTHER },
      { healthDeployment: "deno-" + CURRENT },
      { healthDeploymentHeader: "vps-" + OTHER },
    ]
  ) {
    const { transport, calls } = fixture(options);
    await assert.rejects(
      scanDailyGateway(AUTH, { now: NOW, transport }),
      diagnostic("health", "invalid_data", 200),
    );
    assert.equal(calls.length, 1);
  }
  for (const rows of [[row(1, { status: PRIVATE })], [row(2), row(1)]]) {
    await assert.rejects(
      scanDailyGateway(AUTH, {
        now: NOW,
        transport: fixture({ rows }).transport,
      }),
      diagnostic("errors", "invalid_data", 200),
    );
  }
  const incomplete = fixture({
    pages: [{ data: [], cursor: null, coverage: { status: "incomplete" } }],
  });
  await assert.rejects(
    scanDailyGateway(AUTH, { now: NOW, transport: incomplete.transport }),
    diagnostic("incidents", "pagination_incomplete", 200),
  );
  const looped = fixture({
    pages: [
      {
        data: [incident(1)],
        cursor: "repeat",
        coverage: { status: "complete" },
      },
      {
        data: [incident(2)],
        cursor: "repeat",
        coverage: { status: "complete" },
      },
    ],
  });
  await assert.rejects(
    scanDailyGateway(AUTH, { now: NOW, transport: looped.transport }),
    diagnostic("incidents", "invalid_data", 200),
  );
});

Deno.test("incident pagination cannot exceed the request ceiling", async () => {
  const pages = Array.from({ length: 20 }, (_, index) => ({
    data: [incident(index + 1)],
    cursor: `page-${index + 1}`,
    coverage: { status: "complete" },
  }));
  const { transport, calls } = fixture({ rows: [row(1), row(2)], pages });
  await assert.rejects(
    scanDailyGateway(AUTH, { now: NOW, transport }),
    diagnostic("incidents", "pagination_bound", 200),
  );
  assert.equal(calls.length, 22);
});

Deno.test("the request deadline bounds a stalled body and the retry may complete", async () => {
  const fallback = fixture();
  let attempts = 0;
  let cancelled = 0;
  const transport: GatewayTransportV1 = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname !== "/admin/errors" || ++attempts !== 1) {
      return fallback.transport(input, init);
    }
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(PRIVATE));
          },
          cancel() {
            cancelled++;
          },
        }),
      ),
    );
  };
  const report = await scanDailyGateway(AUTH, {
    now: NOW,
    transport,
    requestTimeoutMs: 30,
  });
  assert.equal(report.coverage, "complete");
  assert.equal(attempts, 2);
  assert.equal(cancelled, 1);
});

Deno.test("an exhausted body retry reports only stage, status and deadline", async () => {
  const fallback = fixture();
  let attempts = 0;
  let cancelled = 0;
  const transport: GatewayTransportV1 = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname !== "/admin/errors") {
      return fallback.transport(input, init);
    }
    attempts++;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(PRIVATE));
          },
          cancel() {
            cancelled++;
          },
        }),
      ),
    );
  };
  await assert.rejects(
    scanDailyGateway(AUTH, { now: NOW, transport, requestTimeoutMs: 30 }),
    diagnostic("errors", "deadline", 200),
  );
  assert.equal(attempts, 2);
  assert.equal(cancelled, 2);
});

Deno.test("current-release upstream diagnostics remain separate from repair findings", async () => {
  const rateLimit = {
    provider: "chatgpt_codex",
    status: 429,
    failure_kind: "rate_limit_exceeded",
  };
  const inBandFailure = {
    provider: "chatgpt_codex",
    status: 200,
    stream: true,
    terminal_type: "response.failed",
    failure_kind: "upstream_error",
  };
  const rows = [
    ...Array.from({ length: 36 }, (_, index) => row(index + 1, rateLimit)),
    row(37, inBandFailure),
    row(38, {
      provider: "chatgpt_codex",
      status: 503,
      failure_kind: "upstream_error",
    }),
    row(39, { ...rateLimit, git_sha: OTHER }),
    row(40, { ...inBandFailure, git_sha: OTHER }),
    row(41, {
      ...inBandFailure,
      terminal_type: "cancelled",
      failure_kind: "request_cancelled",
    }),
    row(42, {
      ...inBandFailure,
      terminal_type: "response.incomplete",
      failure_kind: "max_output_tokens",
    }),
    row(43, {
      status: 429,
      provider: "gateway",
      failure_kind: "api_key_quota_exceeded",
    }),
  ];
  const report = await scanDailyGateway(AUTH, {
    now: NOW,
    transport: fixture({ rows }).transport,
  });
  assert.equal(report.counts.upstream_429, 36);
  assert.equal(report.counts.upstream_5xx, 1);
  assert.equal(report.counts.upstream_in_band_failures, 1);
  assert.deepEqual(report.findings, []);
  const rendered = dailyGatewayStepSummary(report);
  assert(
    rendered.includes("Request counts describe observed gateway error records"),
  );
  assert(rendered.includes("### Current-release upstream signals"));
  assert(rendered.includes("| Upstream HTTP 429 | 36 |"));
  assert(rendered.includes("| Upstream HTTP 5xx | 1 |"));
  assert(
    rendered.includes("| In-band upstream failure terminals (HTTP 200) | 1 |"),
  );
});
