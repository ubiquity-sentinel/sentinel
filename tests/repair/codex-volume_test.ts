/** Real subprocess volume regressions; no model/network/credential or host /tmp access. */
import assert from "node:assert/strict";
import { CodexSubprocessSession } from "../../src/repair/codex-transport.ts";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const SERVER = String.raw`
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const writer = Deno.stdout.writable.getWriter();
const send = async (frame) => await writer.write(encoder.encode(JSON.stringify(frame) + "\n"));
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk);
  let cut;
  while ((cut = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (request.method === "volume") {
      const count = request.params.single ? 1 : 144;
      const text = "x".repeat(request.params.single ? 4 * 1024 * 1024 + 1024 : 256 * 1024);
      for (let i = 0; i < count; i++) await send({method: "item/completed", params: {threadId: "thread", turnId: "turn", item: {type: "agentMessage", id: "message-" + i, text}}});
      await send({method: "turn/completed", params: {threadId: "thread", turn: {id: "turn", status: "completed"}}});
    }
    await send({id: request.id, result: {done: true}});
  }
}
`;

for (const single of [false, true]) {
  Deno.test(`transport volume: ${single ? "one valid >4MiB output frame" : ">32MiB immediately consumed notifications"} reaches completion`, async () => {
    const session = new CodexSubprocessSession({
      command: [Deno.execPath(), "eval", SERVER],
      cwd: ROOT,
      env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
      operationDeadlineMs: 30_000,
    });
    let messages = 0;
    let observed = 0;
    let terminal = false;
    session.onNotification((event) => {
      if (event.method === "item/completed") {
        messages++;
        observed += event.outputVolume?.observedParamsChars ?? 0;
        assert.deepEqual(event.outputVolume?.truncatedOutputPaths, [
          "item.text",
        ]);
        assert.ok(
          (event.params as { item: { text: string } }).item.text.length <=
            65536,
        );
      }
      if (event.method === "turn/completed") terminal = true;
    });
    session.open();
    try {
      assert.deepEqual(await session.send("volume", { single }), {
        done: true,
      });
      assert.equal(messages, single ? 1 : 144);
      assert.equal(terminal, true);
      assert.ok(observed > (single ? 4 : 32) * 1024 * 1024);
      assert.equal(session.getFailure(), null);
    } finally {
      await session.close();
    }
    assert.equal(session.isSettled(), true);
  });
}
Deno.test("transport volume: async consumer provides serial bounded backpressure", async () => {
  const session = new CodexSubprocessSession({
    command: [Deno.execPath(), "eval", SERVER],
    cwd: ROOT,
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    operationDeadlineMs: 30_000,
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first!: () => void;
  const arrived = new Promise<void>((resolve) => {
    first = resolve;
  });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  session.onNotification(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    calls++;
    if (calls === 1) {
      first();
      await blocked;
    }
    active--;
  });
  session.open();
  try {
    const completed = session.send("volume", { single: false });
    await arrived;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    assert.equal(Reflect.get(session, "pendingNotifications").length, 0);
    release();
    await completed;
    assert.equal(calls, 145);
    assert.equal(maxActive, 1);
    assert.equal(session.getFailure(), null);
  } finally {
    release();
    await session.close();
  }
});
Deno.test("transport volume: stderr drains beyond its retained tail without interrupting", async () => {
  const stderrServer = String.raw`
  const stderrWriter=Deno.stderr.writable.getWriter();
  for(let i=0;i<128;i++) await stderrWriter.write(new Uint8Array(65536).fill(120));
  ${SERVER}
  `;
  const session = new CodexSubprocessSession({
    command: [Deno.execPath(), "eval", stderrServer],
    cwd: ROOT,
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    operationDeadlineMs: 30_000,
  });
  session.open();
  try {
    assert.deepEqual(await session.send("barrier", {}), { done: true });
    assert.equal(Reflect.get(session, "stderrTail").length, 65536);
    assert.equal(session.getFailure(), null);
  } finally {
    await session.close();
  }
});

for (const malformed of [false, true]) {
  Deno.test(`transport close: drain buffered ${malformed ? "malformed frame" : "reroute"} after async terminal delivery`, async () => {
    const source = String.raw`
  const encoder=new TextEncoder();
  for await(const chunk of Deno.stdin.readable) {
    const request=JSON.parse(new TextDecoder().decode(chunk));
    const terminal={method:"turn/completed",params:{threadId:"t",turn:{id:"u",status:"completed"}}};
    const reroute={method:"model/rerouted",params:{threadId:"t",turnId:"u",fromModel:"a",toModel:"b"}};
    await Deno.stdout.write(encoder.encode(JSON.stringify(terminal)+"\n"+${
      malformed
        ? JSON.stringify("{bad}\n")
        : 'JSON.stringify(reroute)+"\\n"+JSON.stringify({id:request.id,result:{done:true}})+"\\n"'
    }));
  }`;
    const session = new CodexSubprocessSession({
      command: [Deno.execPath(), "eval", source],
      cwd: ROOT,
      env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
      operationDeadlineMs: 3000,
    });
    let observed!: () => void;
    const terminal = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let rerouted = false;
    session.onNotification(async (event) => {
      if (event.method === "turn/completed") {
        observed();
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      if (event.method === "model/rerouted") rerouted = true;
    });
    session.open();
    const request = session.send("go", {}).catch(() => {});
    await terminal;
    await session.close();
    await request;
    if (malformed) assert.equal(session.getFailure()?.detail, "malformed_line");
    else {
      assert.equal(rerouted, true);
      assert.equal(session.getFailure(), null);
    }
  });
}
Deno.test("transport close: an undrained async consumer makes close unavailable within its bound", async () => {
  const session = new CodexSubprocessSession({
    command: [Deno.execPath(), "eval", SERVER],
    cwd: ROOT,
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    operationDeadlineMs: 3000,
    closeStreamSettleMs: 20,
  });
  let arrived!: () => void;
  const first = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  session.onNotification(async () => {
    arrived();
    await blocked;
  });
  session.open();
  const request = session.send("volume", { single: true }).catch(() => {});
  await first;
  const started = Date.now();
  await session.close();
  assert.ok(Date.now() - started < 1000);
  assert.match(session.getFailure()?.message ?? "", /did not drain/);
  release();
  await request;
  await new Promise((resolve) => setTimeout(resolve, 10));
});
