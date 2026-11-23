import assert from "node:assert/strict";
import {
  createTraceProxyHandler,
  startTraceProxy,
  type TraceProxy,
} from "../../ops/agent-jobs-trace-proxy.ts";

function traceFixture() {
  const encoder = new TextEncoder();
  let seenAuthorization = "";
  let seenPath = "";
  const upstream = (request: Request) => {
    const url = new URL(request.url);
    seenPath = url.pathname + url.search;
    seenAuthorization = request.headers.get("authorization") ?? "";
    const broken = url.pathname.endsWith("/broken");
    if (url.pathname.endsWith("/errored")) {
      return new Response(
        'event: response.created\ndata: {"type":"response.created"}\n\n' +
          'event: error\ndata: {"type":"error","error":{"type":"server_error","code":"overloaded","message":"try again"}}\n\n',
        {
          headers: {
            "content-type": "text/event-stream",
            "x-uos-request-id": "req-errored",
          },
        },
      );
    }
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode("event: response.created\ndata: {}\n\n"),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (broken) {
          controller.error(new Error("upstream reset"));
          return;
        }
        controller.enqueue(
          encoder.encode("event: response.completed\ndata: {}\n\n"),
        );
        controller.close();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "x-uos-request-id": broken ? "req-broken" : "req-ok",
      },
    });
  };
  const verify = async (
    send: (job: string, path: string, init: RequestInit) => Promise<Response>,
    summaryFor: TraceProxy["summary"],
  ) => {
    const ok = await send("job-a", "/responses?x=1", {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token-value",
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: "hello" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("x-uos-request-id"), "req-ok");
    const text = await ok.text();
    assert.ok(text.includes("response.completed"));
    assert.equal(seenPath, "/v1/responses?x=1");
    assert.equal(seenAuthorization, "Bearer secret-token-value");

    const broken = await send("job-a", "/broken", {
      method: "POST",
      body: "{}",
    });
    await assert.rejects(broken.text());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const errored = await send("job-b", "/errored", {
      method: "POST",
      body: "{}",
    });
    await errored.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const failure = summaryFor("job-b").recent[0];
    assert.equal(failure.end, "complete");
    assert.equal(failure.sawCompleted, false);
    assert.deepEqual(failure.lastEvents, ["response.created", "error"]);
    assert.deepEqual(failure.streamError, {
      type: "server_error",
      code: "overloaded",
      message: "try again",
    });

    const summary = summaryFor("job-a");
    assert.equal(summary.requests, 2);
    assert.equal(summary.byEnd.complete, 1);
    assert.equal(summary.incompleteStreams, 1);
    const [first, second] = summary.recent;
    assert.equal(first.gatewayRequestId, "req-ok");
    assert.equal(first.sawCompleted, true);
    assert.equal(first.end, "complete");
    assert.equal(second.gatewayRequestId, "req-broken");
    assert.equal(second.sawCompleted, false);
    assert.notEqual(second.end, "complete");
    assert.ok(!JSON.stringify(summary).includes("secret-token-value"));
    assert.equal(summaryFor("other").requests, 0);
  };
  return { upstream, verify };
}

Deno.test("agent jobs trace proxy forwards streams and records how they end", async () => {
  const fixture = traceFixture();
  const proxy = createTraceProxyHandler(
    "https://upstream.example.invalid/v1",
    (input, init) =>
      Promise.resolve(fixture.upstream(new Request(input, init))),
  );
  await fixture.verify(
    (job, path, init) =>
      proxy.handle(
        new Request(`http://proxy.example.invalid/j/${job}${path}`, init),
      ),
    proxy.summary,
  );
});

Deno.test({
  name: "agent jobs trace proxy forwards streams through its loopback listener",
  ignore: (await Deno.permissions.query({ name: "net", host: "127.0.0.1" }))
    .state !== "granted",
  async fn() {
    const fixture = traceFixture();
    const upstream = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      fixture.upstream,
    );
    try {
      const port = (upstream.addr as Deno.NetAddr).port;
      const proxy = startTraceProxy(`http://127.0.0.1:${port}/v1`);
      try {
        await fixture.verify(
          (job, path, init) => fetch(`${proxy.baseFor(job)}${path}`, init),
          proxy.summary,
        );
      } finally {
        await proxy.close();
      }
    } finally {
      await upstream.shutdown();
    }
  },
});
