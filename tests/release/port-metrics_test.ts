// Scripted Deno release-port cases; original names and assertions are retained.
import assert from "node:assert/strict";
import {
  acceptedEvent,
  DEP_1,
  logRoute,
  MANAGED_URL,
  ScriptedTransport,
  T0,
  terminalEvent,
  TestClock,
} from "./helpers.ts";
import { client } from "./port-helpers.ts";

Deno.test("port: log sampling produces exact-window Cohort counts with complete coverage", async () => {
  const transport = new ScriptedTransport();
  logRoute(transport, {
    accept: 100,
    fails: { fiveXx: 2, timeout: 1, stream: 1 },
  });
  const clock = new TestClock(T0 + 35_001);
  const port = client(transport, clock);
  const sample = await port.sampleMetrics({
    baseUrl: MANAGED_URL,
    metricsPath: "/health",
    identity: DEP_1,
    windowStart: T0,
    windowEnd: T0 + 30_000,
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.requestCount, 100);
  assert.equal(sample.value.fiveXxCount, 2);
  assert.equal(sample.value.timeoutCount, 1);
  assert.equal(sample.value.streamFailureCount, 1);
  assert.equal(sample.value.upstreamWideFault, false);
  assert.deepEqual(sample.value.coverage, { status: "complete" });
});

Deno.test(
  "port: correlates a request cohort across adjacent telemetry windows",
  async () => {
    const transport = new ScriptedTransport();
    transport.any(
      "GET",
      new RegExp("^/v2/apps/[^/]+/logs$"),
      (url) => {
        const start = Date.parse(url.searchParams.get("start") ?? "0");
        const messages = start === T0
          ? [
            acceptedEvent({
              requestId: "boundary-request",
              identity: DEP_1,
              timestamp: T0 + 29_999,
            }),
          ]
          : start === T0 + 30_000
          ? [
            terminalEvent({
              requestId: "boundary-request",
              identity: DEP_1,
              timestamp: T0 + 30_001,
            }),
          ]
          : [];
        return {
          kind: "response",
          status: 200,
          body: JSON.stringify({
            logs: messages.map((message, index) => ({
              timestamp: new Date(start + index).toISOString(),
              level: "info",
              message,
              revision_id: DEP_1.revisionId,
            })),
            next_cursor: null,
          }),
        };
      },
    );
    const clock = new TestClock(T0 + 35_001);
    const port = client(transport, clock);

    const early = await port.sampleMetrics({
      baseUrl: MANAGED_URL,
      metricsPath: "/health",
      identity: DEP_1,
      windowStart: T0,
      windowEnd: T0 + 30_000,
      domain: "ai.ubq.fi",
    });
    assert.ok(early.ok);
    if (!early.ok) return;
    assert.equal(early.value.requestCount, 1);
    assert.equal(early.value.coverage.status, "incomplete");

    clock.at(T0 + 65_001);

    const first = await port.sampleMetrics({
      baseUrl: MANAGED_URL,
      metricsPath: "/health",
      identity: DEP_1,
      windowStart: T0,
      windowEnd: T0 + 30_000,
      domain: "ai.ubq.fi",
    });
    const second = await port.sampleMetrics({
      baseUrl: MANAGED_URL,
      metricsPath: "/health",
      identity: DEP_1,
      windowStart: T0 + 30_000,
      windowEnd: T0 + 60_000,
      domain: "ai.ubq.fi",
    });

    assert.ok(first.ok);
    assert.ok(second.ok);
    if (!first.ok || !second.ok) return;
    assert.equal(first.value.requestCount, 1);
    assert.deepEqual(first.value.coverage, { status: "complete" });
    assert.equal(second.value.requestCount, 0);
    assert.deepEqual(second.value.coverage, { status: "complete" });
  },
);

Deno.test(
  "port: adjacent terminals outside the bounded cohort do not poison coverage",
  async () => {
    const slotLength = 30_000;
    const transport = new ScriptedTransport();
    transport.any(
      "GET",
      new RegExp("^/v2/apps/[^/]+/logs$"),
      (url) => {
        const start = Date.parse(url.searchParams.get("start") ?? "0");
        const slot = (start - T0) / slotLength;
        const messages: string[] = [];
        if (slot >= 0 && slot <= 4 && Number.isInteger(slot)) {
          if (slot > 0) {
            messages.push(
              terminalEvent({
                requestId: `boundary-${slot - 1}`,
                identity: DEP_1,
                timestamp: T0 + slot * slotLength + 1,
              }),
            );
          }
          if (slot < 4) {
            messages.push(
              acceptedEvent({
                requestId: `boundary-${slot}`,
                identity: DEP_1,
                timestamp: T0 + (slot + 1) * slotLength - 1,
              }),
            );
          }
        }
        return {
          kind: "response",
          status: 200,
          body: JSON.stringify({
            logs: messages.map((message, index) => ({
              timestamp: new Date(start + index).toISOString(),
              level: "info",
              message,
              revision_id: DEP_1.revisionId,
            })),
            next_cursor: null,
          }),
        };
      },
    );
    const port = client(transport, new TestClock(T0 + 125_001));
    const sample = await port.sampleMetrics({
      baseUrl: MANAGED_URL,
      metricsPath: "/health",
      identity: DEP_1,
      windowStart: T0 + 2 * slotLength,
      windowEnd: T0 + 3 * slotLength,
      domain: "ai.ubq.fi",
    });

    assert.ok(sample.ok);
    if (!sample.ok) return;
    assert.equal(sample.value.requestCount, 1);
    assert.deepEqual(sample.value.coverage, { status: "complete" });
  },
);

Deno.test("port: log sampling before the trusted lag is missing, never zero", async () => {
  const transport = new ScriptedTransport();
  logRoute(transport, { accept: 100 });
  const clock = new TestClock(T0 + 30_001); // ended but inside the 5s lag window
  const port = client(transport, clock);
  const sample = await port.sampleMetrics({
    baseUrl: MANAGED_URL,
    metricsPath: "/health",
    identity: DEP_1,
    windowStart: T0,
    windowEnd: T0 + 30_000,
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.requestCount, null);
  assert.equal(sample.value.fiveXxCount, null);
  assert.equal(sample.value.coverage.status, "incomplete");
});

Deno.test(
  "port: malformed or empty next cursors are typed failures, never completion",
  async () => {
    for (const nextCursor of ["", 7, {}] as unknown[]) {
      const transport = new ScriptedTransport();
      transport.route({
        method: "GET",
        pathname: `/v2/apps/${transport.config.projectId}/logs`,
        respond: () => ({
          kind: "response",
          status: 200,
          body: JSON.stringify({ logs: [], next_cursor: nextCursor }),
        }),
      });
      const port = client(transport, new TestClock(T0 + 35_001));
      const sample = await port.sampleMetrics({
        baseUrl: MANAGED_URL,
        metricsPath: "/health",
        identity: DEP_1,
        windowStart: T0,
        windowEnd: T0 + 30_000,
        domain: "ai.ubq.fi",
      });
      assert.ok(!sample.ok);
      if (!sample.ok) {
        assert.equal(sample.error.kind, "invalid");
        assert.equal(
          sample.error.detail,
          "log response has a malformed next cursor",
        );
      }
    }
  },
);

Deno.test(
  "port: malformed continuation cursor preserves partial logs as incomplete",
  async () => {
    const transport = new ScriptedTransport();
    transport.route({
      method: "GET",
      pathname: `/v2/apps/${transport.config.projectId}/logs`,
      respond: (url) => {
        if (url.searchParams.get("cursor") === null) {
          const accepted = acceptedEvent({
            requestId: "cursor-accepted",
            identity: DEP_1,
            timestamp: T0,
          });
          const terminal = terminalEvent({
            requestId: "cursor-accepted",
            identity: DEP_1,
            timestamp: T0,
            status: 200,
          });
          return {
            kind: "response",
            status: 200,
            body: JSON.stringify({
              logs: [
                {
                  timestamp: new Date(T0).toISOString(),
                  level: "info",
                  message: accepted,
                  revision_id: DEP_1.revisionId,
                },
                {
                  timestamp: new Date(T0 + 1).toISOString(),
                  level: "info",
                  message: terminal,
                  revision_id: DEP_1.revisionId,
                },
              ],
              next_cursor: "page-2",
            }),
          };
        }
        return {
          kind: "response",
          status: 200,
          body: JSON.stringify({ logs: [], next_cursor: "" }),
        };
      },
    });
    const port = client(transport, new TestClock(T0 + 35_001));
    const sample = await port.sampleMetrics({
      baseUrl: MANAGED_URL,
      metricsPath: "/health",
      identity: DEP_1,
      windowStart: T0,
      windowEnd: T0 + 30_000,
      domain: "ai.ubq.fi",
    });
    assert.ok(sample.ok);
    if (!sample.ok) return;
    assert.equal(sample.value.requestCount, 1);
    assert.equal(sample.value.fiveXxCount, 0);
    assert.deepEqual(sample.value.coverage, {
      status: "incomplete",
      reason: "log pagination was interrupted",
      nextCursor: null,
    });
  },
);

Deno.test("port: unreadable log entries make coverage incomplete but preserve counts", async () => {
  const transport = new ScriptedTransport();
  logRoute(transport, { accept: 50, unreadable: 1 });
  const clock = new TestClock(T0 + 35_001);
  const port = client(transport, clock);
  const sample = await port.sampleMetrics({
    baseUrl: MANAGED_URL,
    metricsPath: "/health",
    identity: DEP_1,
    windowStart: T0,
    windowEnd: T0 + 30_000,
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.requestCount, 50);
  assert.equal(sample.value.coverage.status, "incomplete");
});

Deno.test("port: terminals outside the window cohort mark an explicit evidence gap", async () => {
  const transport = new ScriptedTransport();
  logRoute(transport, {
    accept: 100,
    fails: { fiveXx: 1 },
    orphanTerminals: 3,
  });
  const clock = new TestClock(T0 + 35_001);
  const port = client(transport, clock);
  const sample = await port.sampleMetrics({
    baseUrl: MANAGED_URL,
    metricsPath: "/health",
    identity: DEP_1,
    windowStart: T0,
    windowEnd: T0 + 30_000,
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  // The failing request `acc-0` belongs to the accepted cohort; the three
  // orphan terminals (accepted event outside the window) are excluded from
  // BOTH the denominator and the failure counts. Their outcomes are retained
  // as an explicit incomplete-coverage reason, so a cross-window failure
  // cannot disappear into an apparently healthy sample.
  assert.equal(sample.value.requestCount, 100);
  assert.equal(sample.value.fiveXxCount, 1);
  assert.equal(sample.value.timeoutCount, 0);
  assert.equal(sample.value.streamFailureCount, 0);
  assert.equal(sample.value.upstreamWideFault, false);
  assert.deepEqual(sample.value.coverage, {
    status: "incomplete",
    reason: "log scan contained unresolved request outcomes",
    nextCursor: null,
  });
});
