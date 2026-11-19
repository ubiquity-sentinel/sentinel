import assert from "node:assert/strict";
import { startTraceProxy } from "../../ops/agent-jobs-trace-proxy.ts";

Deno.test("agent jobs trace proxy forwards streams and records how they end", async () => {
  const encoder = new TextEncoder();
  let seenAuthorization = "";
  let seenPath = "";
  const upstream = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      const url = new URL(request.url);
      seenPath = url.pathname + url.search;
      seenAuthorization = request.headers.get("authorization") ?? "";
      const broken = url.pathname.endsWith("/broken");
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
    },
  );
  const port = (upstream.addr as Deno.NetAddr).port;
  const proxy = startTraceProxy(`http://127.0.0.1:${port}/v1`);
  try {
    const ok = await fetch(`${proxy.baseFor("job-a")}/responses?x=1`, {
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

    const broken = await fetch(`${proxy.baseFor("job-a")}/broken`, {
      method: "POST",
      body: "{}",
    });
    await assert.rejects(broken.text());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const summary = proxy.summary("job-a");
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
    assert.equal(proxy.summary("other").requests, 0);
  } finally {
    await proxy.close();
    await upstream.shutdown();
  }
});
