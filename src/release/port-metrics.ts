// Exact-window request cohort sampling over bounded Deno log pages.
import type {
  MetricsSampleConfigV1,
  MetricsSampleV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  DENO_LOGS_PAGE_LIMIT,
  DENO_MAX_LOG_PAGE_BYTES,
  DENO_MAX_LOG_PAGES,
} from "./config.ts";
import { denoRestCall } from "./http.ts";
import {
  CohortAccumulatorV1,
  type CohortKindsV1,
  type CohortWindowScopeV1,
  parseCohortMessage,
} from "./log-cohort.ts";
import { ReleasePortContext } from "./port-context.ts";

export class DenoReleaseMetricsClient extends ReleasePortContext {
  async sampleMetrics(
    config: MetricsSampleConfigV1,
  ): Promise<PortResultV1<MetricsSampleV1>> {
    if (config.windowStart >= config.windowEnd) {
      return portError("invalid", "metrics window is inverted");
    }
    const now = this.clock.now();
    if (config.windowEnd > now) {
      return portError(
        "invalid",
        "a telemetry window cannot end in the future",
      );
    }
    if (config.windowEnd + this.config.logsLagMs > now) {
      // Trusted explicit coverage policy: a window is only due after the
      // source lag allowance, so missing in-flight telemetry is never read
      // as a complete zero-count sample.
      return portOk(
        this.missingSample(config, "log source lag has not elapsed"),
      );
    }

    const accumulator = new CohortAccumulatorV1();
    const kinds: CohortKindsV1 = {
      timeoutFailureKinds: this.config.timeoutFailureKinds,
      upstreamWideFailureKinds: this.config.upstreamWideFailureKinds,
    };
    const currentScan = await this.scanLogWindow(
      config,
      config.windowStart,
      config.windowEnd,
      accumulator,
      kinds,
      "sample",
    );
    if (!currentScan.ok) return currentScan;
    let reason: string | null = currentScan.value;
    let counts = accumulator.counts();

    // A request cohort may straddle one slot boundary. Query each adjacent
    // exact window only when the sample has an unmatched event, and use those
    // events solely to close the sample's accepted cohort. This keeps the
    // denominator bound to the requested window while allowing the terminal
    // event to be observed on the other side of its boundary.
    if (
      reason === null && counts.unreadableCount === 0 &&
      counts.unresolvedOutcomeCount > 0
    ) {
      const windowLength = config.windowEnd - config.windowStart;
      const adjacentWindows: { start: number; end: number }[] = [];
      if (config.windowStart >= windowLength) {
        adjacentWindows.push({
          start: config.windowStart - windowLength,
          end: config.windowStart,
        });
      }
      adjacentWindows.push({
        start: config.windowEnd,
        end: config.windowEnd + windowLength,
      });

      for (const adjacent of adjacentWindows) {
        // Do not ask the logs source for a complete future window. A sample
        // with an accepted request at this boundary is retryable once that
        // adjacent window's own lag has elapsed; treating the partial scan as
        // a terminal gap would make the controller discard a healthy slot.
        if (
          adjacent.start >= config.windowEnd &&
          adjacent.end + this.config.logsLagMs > now
        ) {
          break;
        }
        const joined = await this.scanLogWindow(
          config,
          adjacent.start,
          adjacent.end,
          accumulator,
          kinds,
          "adjacent",
        );
        if (!joined.ok) {
          reason = "adjacent log pagination was interrupted";
          break;
        }
        if (joined.value !== null) {
          reason = joined.value;
          break;
        }
        counts = accumulator.counts();
        if (counts.unresolvedOutcomeCount === 0) break;
      }
    }

    counts = accumulator.counts();
    if (reason === null && counts.unreadableCount > 0) {
      reason = "log scan contained unreadable entries";
    }
    if (reason === null && counts.unresolvedOutcomeCount > 0) {
      // A terminal whose accepted event is outside this exact window is a
      // request outcome we cannot safely join to this sample. Preserve the
      // gap explicitly; silently dropping it would make a long-running
      // failure disappear from acceptance telemetry.
      reason = "log scan contained unresolved request outcomes";
    }
    if (reason !== null) {
      // The observed aggregates are preserved with the incompleteness made
      // explicit; a partial scan is never a complete zero-count sample and a
      // missing scan is all-null.
      if (counts.acceptedCount === 0) {
        return portOk(this.missingSample(config, reason));
      }
      return portOk({
        identity: config.identity,
        windowStart: config.windowStart,
        windowEnd: config.windowEnd,
        sampledAt: this.clock.now(),
        domain: config.domain,
        requestCount: counts.acceptedCount,
        fiveXxCount: counts.fiveXxCount,
        timeoutCount: counts.timeoutCount,
        streamFailureCount: counts.streamFailureCount,
        upstreamWideFault: counts.upstreamWideCount > 0,
        coverage: { status: "incomplete", reason, nextCursor: null },
      });
    }

    return portOk({
      identity: config.identity,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
      sampledAt: this.clock.now(),
      domain: config.domain,
      requestCount: counts.acceptedCount,
      fiveXxCount: counts.fiveXxCount,
      timeoutCount: counts.timeoutCount,
      streamFailureCount: counts.streamFailureCount,
      upstreamWideFault: counts.upstreamWideCount > 0,
      coverage: { status: "complete" },
    });
  }

  private async scanLogWindow(
    config: MetricsSampleConfigV1,
    windowStart: number,
    windowEnd: number,
    accumulator: CohortAccumulatorV1,
    kinds: CohortKindsV1,
    scope: CohortWindowScopeV1,
  ): Promise<PortResultV1<string | null>> {
    let cursor: string | null = null;
    let pages = 0;
    let reason: string | null = null;
    for (;;) {
      pages++;
      if (pages > DENO_MAX_LOG_PAGES) {
        reason = "log pagination exceeded the page bound";
        break;
      }
      const page = await this.readLogPage(
        config,
        cursor,
        windowStart,
        windowEnd,
      );
      if (!page.ok) {
        if (cursor === null && pages === 1) return page;
        reason = "log pagination was interrupted";
        break;
      }
      const parsed = page.value;
      for (const entry of parsed.entries) {
        accumulator.add(
          parseCohortMessage(entry.message, config.identity),
          kinds,
          scope,
        );
      }
      for (let i = 0; i < parsed.unreadableEntries; i++) {
        accumulator.add({ kind: "unreadable" }, kinds, scope);
      }
      if (parsed.nextCursor === null) break;
      cursor = parsed.nextCursor;
    }
    return portOk(reason);
  }

  private missingSample(
    config: MetricsSampleConfigV1,
    detail: string,
  ): MetricsSampleV1 {
    return {
      identity: config.identity,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
      sampledAt: this.clock.now(),
      domain: config.domain,
      requestCount: null,
      fiveXxCount: null,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
      coverage: { status: "incomplete", reason: detail, nextCursor: null },
    };
  }

  private async readLogPage(
    config: MetricsSampleConfigV1,
    cursor: string | null,
    windowStart = config.windowStart,
    windowEnd = config.windowEnd,
  ): Promise<
    PortResultV1<{
      entries: { message: string }[];
      unreadableEntries: number;
      nextCursor: string | null;
    }>
  > {
    const query = new URLSearchParams({
      start: toRfc3339(windowStart),
      end: toRfc3339(windowEnd),
      revision_id: config.identity.revisionId,
      limit: String(DENO_LOGS_PAGE_LIMIT),
    });
    if (cursor !== null) query.set("cursor", cursor);
    const call = await denoRestCall(
      {
        baseUrl: this.config.apiBaseUrl,
        path: `/v2/apps/${
          encodeURIComponent(
            this.config.projectId,
          )
        }/logs`,
        query,
        method: "GET",
        responseByteCap: DENO_MAX_LOG_PAGE_BYTES,
      },
      this.transport,
      this.auth,
    );
    if (!call.ok) return call;
    if (call.value.status !== 200) {
      return portError("unavailable", "log resource is unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(call.value.body));
    } catch {
      return portError("invalid", "log response is not valid JSON");
    }
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return portError("invalid", "log response has an unexpected shape");
    }
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.logs)) {
      return portError("invalid", "log response is missing the logs array");
    }
    const entries: { message: string }[] = [];
    let unreadableEntries = 0;
    for (const raw of obj.logs) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        unreadableEntries++;
        continue;
      }
      const entry = raw as Record<string, unknown>;
      const revisionId = entry.revision_id;
      const message = entry.message;
      if (
        typeof revisionId !== "string" ||
        revisionId !== config.identity.revisionId ||
        typeof message !== "string"
      ) {
        unreadableEntries++;
        continue;
      }
      entries.push({ message });
    }
    const rawNextCursor = obj.next_cursor;
    if (rawNextCursor === null) {
      return portOk({ entries, unreadableEntries, nextCursor: null });
    }
    if (typeof rawNextCursor !== "string" || rawNextCursor.length === 0) {
      return portError("invalid", "log response has a malformed next cursor");
    }
    const nextCursor = rawNextCursor;
    return portOk({ entries, unreadableEntries, nextCursor });
  }
}

function toRfc3339(ms: number): string {
  return new Date(ms).toISOString();
}
