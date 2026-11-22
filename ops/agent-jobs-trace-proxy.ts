/**
 * A loopback pass-through in front of the model gateway, for telemetry only.
 *
 * The agent's client is pointed at this proxy; every request is forwarded
 * unchanged to the real gateway and its response streamed back unchanged. The
 * proxy records, per request, when it started, the gateway's own request id
 * (`x-uos-request-id`, so a request can be found in the gateway's log), the
 * status, time to first byte, duration, size, and how the stream ended: the
 * gateway finished it, the gateway side broke it, or the client went away.
 * It never records headers it forwards, request bodies or response text.
 */

export interface TracedRequestV1 {
  job: string;
  startedAt: string;
  method: string;
  path: string;
  status: number;
  /** The gateway's request id, when it sent one. */
  gatewayRequestId: string | null;
  providerRequestId: string | null;
  firstByteMs: number | null;
  durationMs: number;
  responseBytes: number;
  /**
   * `complete`: the response body ended normally. `upstream_error`: reading
   * from the gateway failed. `client_cancel`: the agent's client closed first.
   * `connect_error`: the gateway could not be reached.
   */
  end: "complete" | "upstream_error" | "client_cancel" | "connect_error";
  /** For event streams: whether a `response.completed` event went by. */
  sawCompleted: boolean | null;
  /**
   * For an event stream that ended without completing: the kind of its last
   * events and, when the last one was an error, that error's type, code and
   * the start of its message. Never any model output.
   */
  lastEvents: string[] | null;
  streamError: { type: string; code: string; message: string } | null;
  error: string | null;
}

export interface TraceSummaryV1 {
  requests: number;
  modelSeconds: number;
  byEnd: Record<string, number>;
  /** Event streams that ended without `response.completed`. */
  incompleteStreams: number;
  /** The most recent records, newest last. */
  recent: TracedRequestV1[];
}

export interface TraceProxy {
  /** The base URL an agent for this job should use. */
  baseFor(jobId: string): string;
  summary(jobId: string): TraceSummaryV1;
  close(): Promise<void>;
}

const RECENT = 400;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // The proxy's own fetch negotiates an encoding it can decode.
  "accept-encoding",
]);

const redact = (text: string) =>
  text.replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>").slice(0, 200);

export function createTraceProxyHandler(
  upstreamBase: string,
  fetchUpstream: typeof fetch,
) {
  const upstream = new URL(upstreamBase);
  const upstreamPath = upstream.pathname.replace(/\/+$/, "");
  const records = new Map<string, TracedRequestV1[]>();
  const totals = new Map<
    string,
    {
      requests: number;
      ms: number;
      byEnd: Record<string, number>;
      incomplete: number;
    }
  >();
  const note = (record: TracedRequestV1) => {
    const list = records.get(record.job) ?? [];
    list.push(record);
    if (list.length > RECENT) list.shift();
    records.set(record.job, list);
    const total = totals.get(record.job) ??
      { requests: 0, ms: 0, byEnd: {}, incomplete: 0 };
    total.requests += 1;
    total.ms += record.durationMs;
    total.byEnd[record.end] = (total.byEnd[record.end] ?? 0) + 1;
    if (record.sawCompleted === false) total.incomplete += 1;
    totals.set(record.job, total);
  };

  return {
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const match = /^\/j\/([a-z0-9-]{1,64})(\/.*)?$/.exec(url.pathname);
      if (match === null) return new Response("not found", { status: 404 });
      const job = match[1];
      const rest = match[2] ?? "";
      const target = new URL(
        upstream.origin + upstreamPath + rest + url.search,
      );
      const headers = new Headers();
      for (const [name, value] of request.headers) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
      }
      const started = performance.now();
      const record: TracedRequestV1 = {
        job,
        startedAt: new Date().toISOString(),
        method: request.method,
        path: rest.slice(0, 80),
        status: 0,
        gatewayRequestId: null,
        providerRequestId: null,
        firstByteMs: null,
        durationMs: 0,
        responseBytes: 0,
        end: "complete",
        sawCompleted: null,
        lastEvents: null,
        streamError: null,
        error: null,
      };
      const finish = (end: TracedRequestV1["end"], error: unknown = null) => {
        record.end = end;
        record.error = error === null ? null : redact(String(error));
        record.durationMs = Math.round(performance.now() - started);
        note(record);
      };
      let response: Response;
      try {
        const body = request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
        response = await fetchUpstream(target, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
        });
      } catch (error) {
        finish("connect_error", error);
        return new Response("gateway unreachable", { status: 502 });
      }
      record.status = response.status;
      record.gatewayRequestId = response.headers.get("x-uos-request-id");
      record.providerRequestId = response.headers.get(
        "x-uos-provider-request-id",
      );
      const eventStream = (response.headers.get("content-type") ?? "")
        .includes("text/event-stream");
      if (eventStream) record.sawCompleted = false;
      const out = new Headers();
      for (const [name, value] of response.headers) {
        const lower = name.toLowerCase();
        // fetch already decoded the body, so its original framing is gone.
        if (HOP_BY_HOP.has(lower) || lower === "content-encoding") continue;
        out.set(name, value);
      }
      if (response.body === null) {
        finish("complete");
        return new Response(null, { status: response.status, headers: out });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let tail = "";
      let done = false;
      // The end of the stream, kept only to describe a failure afterwards.
      let recentText = "";
      const describeFailure = () => {
        if (!eventStream || record.sawCompleted !== false) return;
        const kinds: string[] = [];
        let last: Record<string, unknown> | null = null;
        for (const line of recentText.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const data = JSON.parse(line.slice(5));
            if (data !== null && typeof data === "object") {
              kinds.push(String(data.type ?? "?").slice(0, 60));
              last = data as Record<string, unknown>;
            }
          } catch {
            // A data line cut by the window; skip it.
          }
        }
        record.lastEvents = kinds.slice(-6);
        if (last === null) return;
        const holder = (last.error ?? (last.response as
          | Record<string, unknown>
          | undefined)?.error ??
          last) as Record<string, unknown>;
        const field = (name: string) =>
          redact(String(holder?.[name] ?? "")).slice(0, 160);
        if (/error|failed|incomplete/.test(String(last.type ?? ""))) {
          record.streamError = {
            type: field("type"),
            code: field("code"),
            message: field("message"),
          };
        }
      };
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              done = true;
              describeFailure();
              finish("complete");
              controller.close();
              return;
            }
            if (record.firstByteMs === null) {
              record.firstByteMs = Math.round(performance.now() - started);
            }
            record.responseBytes += chunk.value.byteLength;
            if (eventStream && record.sawCompleted === false) {
              const piece = decoder.decode(chunk.value, { stream: true });
              const text = tail + piece;
              if (text.includes("response.completed")) {
                record.sawCompleted = true;
                recentText = "";
              } else {
                recentText = (recentText + piece).slice(-4096);
              }
              tail = text.slice(-32);
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            if (!done) {
              done = true;
              describeFailure();
              finish("upstream_error", error);
            }
            controller.error(error);
          }
        },
        async cancel(reason) {
          if (!done) {
            done = true;
            finish("client_cancel", reason);
          }
          await reader.cancel().catch(() => {});
        },
      });
      return new Response(stream, { status: response.status, headers: out });
    },
    summary(jobId: string): TraceSummaryV1 {
      const total = totals.get(jobId) ??
        { requests: 0, ms: 0, byEnd: {}, incomplete: 0 };
      return {
        requests: total.requests,
        modelSeconds: Math.round(total.ms / 1000),
        byEnd: { ...total.byEnd },
        incompleteStreams: total.incomplete,
        recent: [...(records.get(jobId) ?? [])],
      };
    },
  };
}

/** Start the proxy in front of `upstreamBase` (for example `https://host/v1`). */
export function startTraceProxy(upstreamBase: string): TraceProxy {
  const { handle, summary } = createTraceProxyHandler(upstreamBase, fetch);
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
      // A broken stream is recorded on its request; keep it out of the log.
      onError: () => new Response("proxy error", { status: 502 }),
    },
    handle,
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    baseFor: (jobId) => `http://127.0.0.1:${port}/j/${jobId}`,
    summary,
    close: () => server.shutdown(),
  };
}
