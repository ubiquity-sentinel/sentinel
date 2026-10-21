import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
/** Native app-server -> parent custody -> private IPC -> slow trusted consumer. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { ReviewOwnerCustodyBroker } from "../../src/host/review-owner-custody.ts";
import { ReviewOwnerChannelClient } from "../../src/host/review-owner-channel.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("review custody native volume: >32MiB and oversized output settle through one slow consumer", async () => {
  const root = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "custody-native-volume-",
  });
  const server = root + "/server.ts";
  const pidPath = root + "/pid";
  await Deno.writeTextFile(
    server,
    `
await Deno.writeTextFile(Deno.args[0], String(Deno.pid));
const writer = Deno.stdout.writable.getWriter();
const encoder = new TextEncoder();
const emit = async (frame) => await writer.write(encoder.encode(JSON.stringify(frame) + "\\n"));
let text = "";
for await (const part of Deno.stdin.readable) {
  text += new TextDecoder().decode(part);
  let end;
  while ((end = text.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
    if (frame.id === undefined) continue;
    const p = frame.params ?? {};
    const result = frame.method === "thread/start"
      ? { thread: { id: "thread" }, model: "codex-resolved", modelProvider: "uos", reasoningEffort: null }
      : frame.method === "review/start" ? { turn: { id: "turn", status: "inProgress" } }
      : { userAgent: "native-volume-fixture" };
    await emit({ jsonrpc: "2.0", id: frame.id, result });
    if (frame.method === "review/start") {
      for (let index = 0; index < 530; index++) {
        await emit({ jsonrpc: "2.0", method: "item/commandExecution/outputDelta", params: { threadId: "thread", turnId: "turn", itemId: "command", index, delta: "x".repeat(65536) } });
      }
      await emit({ jsonrpc: "2.0", method: "item/commandExecution/outputDelta", params: { threadId: "thread", turnId: "turn", itemId: "command", index: 530, delta: "漢".repeat(6 * 1024 * 1024) } });
      await emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
    }
  }
}
`,
  );
  const owner: HostedExecutionIntentV1 = {
    id: "7:2:repair",
    runId: 7,
    runAttempt: 2,
    launcherSha: "a".repeat(40) as GitSha,
    revision: "b".repeat(40) as GitSha,
    generation: 81,
    purpose: "ordinary",
    releaseId: null,
    createdAt: 1,
  };
  const repository = { owner: "ubiquity", name: "sentinel", installationId: 0 };
  const requestId = "base-review-" + "e".repeat(64);
  const target = {
    type: "custom",
    instructions: "Review exact volume fixture.",
  };
  const targetDigest = await canonicalStringifySha256(target);
  const prepared = {
    ownerRunId: owner.id,
    invocationId: "volume",
    threadId: "thread",
    submittedProvider: "uos",
    model: null,
    reasoning: null,
    nativeReview: { mode: "review/start" as const, targetDigest },
    startMayOccur: true as const,
  };
  const broker = new ReviewOwnerCustodyBroker(owner, [{
    repository,
    provider: "uos",
    model: "ignored-legacy-selector",
    permissionProfile: "sentinel-review",
    session: {
      command: [
        Deno.execPath(),
        "run",
        "--allow-read",
        "--allow-write",
        server,
        pidPath,
      ],
      cwd: root,
      env: {},
      operationDeadlineMs: 60_000,
    },
  }]);
  const descriptor = await broker.start(root);
  const client = new ReviewOwnerChannelClient(descriptor);
  try {
    await client.registerBaseReview({
      repository,
      base: "c".repeat(40) as GitSha,
      taskDigest: "d".repeat(64),
      reservationId: "e".repeat(64),
      requestId,
      ownerRunId: owner.id,
    });
    const session = client.openSession({
      cwd: root,
      requestId,
      invocationId: prepared.invocationId,
      ownerRunId: owner.id,
      nativeReviewTargetDigest: targetDigest,
    });
    let active = 0;
    let peak = 0;
    let chars = 0;
    let projected = false;
    let terminal = false;
    const indexes: number[] = [];
    session.onNotification(async (event) => {
      peak = Math.max(peak, ++active);
      try {
        await delay(2);
        chars += event.outputVolume?.observedParamsChars ??
          JSON.stringify(event.params ?? {}).length;
        if (event.method === "turn/completed") terminal = true;
        else {
          const params = event.params as { index: number; delta: string };
          indexes.push(params.index);
          if (params.index === 530) {
            assert.ok(params.delta.length <= 65536);
            assert.ok(
              event.outputVolume?.truncatedOutputPaths.includes("delta"),
            );
            projected = true;
          }
        }
      } finally {
        active--;
      }
    });
    await session.send("initialize", {});
    await session.send("thread/start", {
      cwd: root,
      permissions: "sentinel-review",
    });
    await client.armBaseReview({ requestId, execution: prepared });
    await session.send("review/start", {
      threadId: "thread",
      delivery: "inline",
      target,
    });
    const deadline = Date.now() + 45_000;
    while (!terminal && Date.now() < deadline) await delay(5);
    assert.ok(
      terminal,
      "the real terminal must survive aggregate and individual output volume",
    );
    await session.close();
    assert.equal(session.isSettled?.(), true);
    assert.equal(peak, 1);
    assert.deepEqual(indexes, Array.from({ length: 531 }, (_, i) => i));
    assert.ok(projected);
    assert.ok(
      chars > 32 * 1024 * 1024,
      "original accounting crosses the old total cap",
    );
    await client.settledBaseReview({ requestId });
    assert.deepEqual(
      await broker.finish({ settled: true, truncated: false }),
      [],
    );
    const pid = Number(await Deno.readTextFile(pidPath));
    assert.throws(
      () => Deno.kill(pid, 0),
      "the parent-owned native process is settled",
    );
  } finally {
    await client.close();
    await broker.dispose();
    await Deno.remove(root, { recursive: true });
  }
});
