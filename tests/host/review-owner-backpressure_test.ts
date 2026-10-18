/** Real private-file delivery stays bounded before registration and under slow consumers. */
import assert from "node:assert/strict";
import {
  ReviewOwnerChannelClient,
  writeReviewChannelFile,
} from "../../src/host/review-owner-channel.ts";
import { parseReviewChannelNotification } from "../../src/host/review-owner-channel-event.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const EVENT_COUNT = 530;
const OUTPUT = "x".repeat(64 * 1024);

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), "bounded fixture did not finish");
}

function eventName(index: number): string {
  return `event-${String(index).padStart(10, "0")}-${crypto.randomUUID()}.json`;
}

async function produce(directory: string, count: number): Promise<void> {
  for (let index = 1; index <= count; index++) {
    await writeReviewChannelFile(`${directory}/${eventName(index)}`, {
      requestId: "review-volume",
      type: "notification",
      event: {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "cmd",
          delta: OUTPUT,
          index,
        },
      },
    });
  }
}

function rig(directory: string) {
  const client = new ReviewOwnerChannelClient({
    version: "v1",
    directory,
    ownerRunId: "owner",
  });
  const session = client.openSession({
    cwd: directory,
    requestId: "review-volume",
    invocationId: "invocation",
    ownerRunId: "owner",
  });
  return { client, session };
}

Deno.test("review custody volume: pre-handler >32MiB stays on disk while RPC responses remain live", async () => {
  const directory = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "custody-volume-",
  });
  const { client, session } = rig(directory);
  const originalRead = Deno.readTextFile;
  let eventReads = 0;
  Deno.readTextFile = ((path: string | URL, options?: Deno.ReadFileOptions) => {
    if (String(path).startsWith(`${directory}/event-`)) eventReads++;
    return originalRead(path, options);
  }) as typeof Deno.readTextFile;
  try {
    await produce(directory, EVENT_COUNT);
    await delay(30);
    assert.equal(
      eventReads,
      0,
      "unregistered delivery must not retain event payloads in RAM",
    );
    const response = client.call("probe", {});
    let id: string | undefined;
    await until(() => {
      for (const file of Deno.readDirSync(directory)) {
        const match = /^request-([0-9a-f-]{36})\.json$/.exec(file.name);
        if (match) id = match[1];
      }
      return id !== undefined;
    });
    await writeReviewChannelFile(`${directory}/response-${id}.json`, {
      id,
      result: "live",
    });
    assert.equal(await response, "live");
    const received: number[] = [];
    session.onNotification((event) => {
      const params = event.params as { index: number; delta: string };
      assert.equal(params.delta.length, OUTPUT.length);
      received.push(params.index);
    });
    await until(() => received.length === EVENT_COUNT);
    assert.deepEqual(
      received,
      Array.from({ length: EVENT_COUNT }, (_, i) => i + 1),
    );
    assert.ok(EVENT_COUNT * OUTPUT.length > 32 * 1024 * 1024);
  } finally {
    await client.close();
    Deno.readTextFile = originalRead;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review custody volume: slow >32MiB consumer is awaited once per ordered frame", async () => {
  const directory = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "custody-slow-",
  });
  const { client, session } = rig(directory);
  let active = 0;
  let maximum = 0;
  const received: number[] = [];
  session.onNotification(async (event) => {
    maximum = Math.max(maximum, ++active);
    await delay(2);
    received.push((event.params as { index: number }).index);
    active--;
  });
  try {
    await produce(directory, EVENT_COUNT);
    await until(() => received.length === EVENT_COUNT);
    assert.equal(
      maximum,
      1,
      "async consumers must provide backpressure rather than fan out",
    );
    assert.deepEqual(
      received,
      Array.from({ length: EVENT_COUNT }, (_, i) => i + 1),
    );
  } finally {
    await client.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review custody volume: IPC keeps trusted projection accounting and rejects forged metadata shapes", () => {
  const event = {
    method: "item/completed",
    params: {
      threadId: "thread",
      turnId: "turn",
      item: { id: "result", type: "agentMessage", text: "prefix" },
    },
    outputVolume: {
      observedParamsChars: 8_000_000,
      truncatedOutputPaths: ["item.text"],
    },
  };
  assert.deepEqual(parseReviewChannelNotification(event), event);
  for (
    const outputVolume of [
      { observedParamsChars: -1, truncatedOutputPaths: [] },
      {
        observedParamsChars: Number.MAX_SAFE_INTEGER + 1,
        truncatedOutputPaths: [],
      },
      { observedParamsChars: 8_000_000, truncatedOutputPaths: ["threadId"] },
      {
        observedParamsChars: 8_000_000,
        truncatedOutputPaths: ["item.text", "item.text"],
      },
      {
        observedParamsChars: 8_000_000,
        truncatedOutputPaths: [],
        accepted: true,
      },
    ]
  ) {
    assert.throws(() =>
      parseReviewChannelNotification({ ...event, outputVolume })
    );
  }
});

Deno.test("review custody volume: projected UTF-16 envelope retains non-ASCII bytes through IPC", async () => {
  const directory = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "custody-utf8-",
  });
  const { client, session } = rig(directory);
  const text = "漢".repeat(3 * 1024 * 1024);
  let observed = false;
  session.onNotification((event) => {
    assert.equal((event.params as { metadata: string }).metadata, text);
    observed = true;
  });
  try {
    await writeReviewChannelFile(`${directory}/${eventName(1)}`, {
      requestId: "review-volume",
      type: "notification",
      event: { method: "telemetry", params: { metadata: text } },
    });
    await until(() => observed);
  } finally {
    await client.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review custody close: late reroute and forbidden command are delivered before settled close", async (t) => {
  for (
    const method of [
      "model/rerouted",
      "item/commandExecution/terminalInteraction",
    ]
  ) {
    await t.step(method, async () => {
      const directory = await Deno.makeTempDir({
        dir: ROOT,
        prefix: "custody-close-fence-",
      });
      const { client, session } = rig(directory);
      let release!: () => void;
      const held = new Promise<void>((resolve) => release = resolve);
      let entered = false;
      let unavailable = false;
      let stopped = false;
      const answered = new Set<string>();
      const owner = (async () => {
        while (!stopped) {
          for await (const file of Deno.readDir(directory)) {
            if (
              !/^request-[0-9a-f-]{36}\.json$/.test(file.name) ||
              answered.has(file.name)
            ) {
              continue;
            }
            answered.add(file.name);
            const request = JSON.parse(
              await Deno.readTextFile(`${directory}/${file.name}`),
            );
            await writeReviewChannelFile(
              `${directory}/response-${request.id}.json`,
              {
                id: request.id,
                result: request.method === "close"
                  ? { settled: true, eventThrough: 2, faulted: false }
                  : null,
              },
            );
          }
          await delay(2);
        }
      })();
      session.onNotification(async (event) => {
        if (event.method === method) {
          entered = true;
          await held;
          unavailable = true;
        }
      });
      try {
        await session.send("initialize", {});
        for (const [index, name] of ["turn/completed", method].entries()) {
          await writeReviewChannelFile(`${directory}/${eventName(index + 1)}`, {
            requestId: "review-volume",
            type: "notification",
            event: {
              method: name,
              params: { threadId: "thread", turnId: "turn" },
            },
          });
        }
        await until(() => entered);
        let settled = false;
        const closing = session.close().then(() => {
          settled = true;
        });
        await delay(20);
        assert.equal(
          settled,
          false,
          "owner process settlement alone cannot outrun policy evidence",
        );
        release();
        await closing;
        assert.equal(
          unavailable,
          true,
          "the caller sees the late contradiction before it can accept close",
        );
      } finally {
        release();
        stopped = true;
        await owner;
        await client.close();
        await Deno.remove(directory, { recursive: true });
      }
    });
  }
});

Deno.test("review custody close: native settlement cannot hide owner faults or an invalid event fence", async (t) => {
  for (
    const [name, result] of [
      ["owner fault", { settled: true, eventThrough: 0, faulted: true }],
      ["missing owner proof", { settled: true, eventThrough: 0 }],
      ["negative fence", { settled: true, eventThrough: -1, faulted: false }],
      ["fractional fence", {
        settled: true,
        eventThrough: 0.5,
        faulted: false,
      }],
      ["unsafe fence", {
        settled: true,
        eventThrough: Number.MAX_SAFE_INTEGER + 1,
        faulted: false,
      }],
    ] as const
  ) {
    await t.step(name, async () => {
      const directory = await Deno.makeTempDir({
        dir: ROOT,
        prefix: "custody-close-proof-",
      });
      const { client, session } = rig(directory);
      async function respond(method: string, result: unknown): Promise<void> {
        let request: { id: string } | undefined;
        await until(() => {
          for (const file of Deno.readDirSync(directory)) {
            if (!/^request-[0-9a-f-]{36}\.json$/.test(file.name)) continue;
            const candidate = JSON.parse(
              Deno.readTextFileSync(`${directory}/${file.name}`),
            );
            if (candidate.method === method) request = candidate;
          }
          return request !== undefined;
        });
        await writeReviewChannelFile(
          `${directory}/response-${request!.id}.json`,
          { id: request!.id, result },
        );
      }
      try {
        const opening = session.send("initialize", {});
        await respond("open", null);
        await respond("send", null);
        await opening;
        const closing = session.close();
        const rejected = assert.rejects(closing, /review custody/);
        await respond("close", result);
        await rejected;
        assert.equal(
          session.isSettled?.(),
          true,
          "native settlement remains exact",
        );
      } finally {
        await client.close();
        await Deno.remove(directory, { recursive: true });
      }
    });
  }
});
