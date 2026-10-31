import assert from "node:assert/strict";
import {
  ReviewOwnerChannelClient,
  writeReviewChannelFile,
} from "../../src/host/review-owner-channel.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const CHANNEL = new URL(
  "../../src/host/review-owner-channel.ts",
  import.meta.url,
).href;

Deno.test("review channel: an early custody refusal stays observed until request publication settles", async () => {
  const directory = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-channel-call-",
  });
  const script = directory + "/early-refusal.ts";
  try {
    // A child makes an unhandled rejection a real process failure rather than
    // suppressing the runtime's event or cancelling unrelated parent cases.
    await Deno.writeTextFile(
      script,
      `import assert from "node:assert/strict";
import { ReviewOwnerChannelClient, writeReviewChannelFile } from ${
        JSON.stringify(CHANNEL)
      };
const directory = ${JSON.stringify(directory)};
const rename = Deno.rename, remove = Deno.remove;
let publish, release, consumed;
const published = new Promise(resolve => { publish = resolve; });
const pendingWrite = new Promise(resolve => { release = resolve; });
const responseConsumed = new Promise(resolve => { consumed = resolve; });
let responsePath;
Deno.rename = async (from, to) => {
  await rename(from, to);
  const match = /^request-([0-9a-f-]{36})\\.json$/.exec(String(to).split("/").at(-1));
  if (String(to).startsWith(directory + "/") && match) {
    publish(match[1]);
    await pendingWrite;
  }
};
Deno.remove = async (path, options) => {
  await remove(path, options);
  if (String(path) === responsePath) consumed();
};
const client = new ReviewOwnerChannelClient({ version: "v1", directory, ownerRunId: "owned-run" });
try {
  const observed = client.call("refused", {}).then(
    value => ({ value }),
    error => ({ error }),
  );
  const id = await published;
  responsePath = directory + "/response-" + id + ".json";
  await writeReviewChannelFile(responsePath, { id, error: true });
  await responseConsumed;
  // Response removal happens immediately before the production client rejects
  // its pending RPC. Cross an event-loop boundary with publication still held.
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  const result = await observed;
  assert(result.error, "custody refusal must still reject the caller");
  assert.equal(result.error.name, "CodexProtocolError");
  assert.equal(result.error.message, "review custody request refused");
  assert.equal(result.error.detail, "server_error");
  console.log("original custody refusal observed after publication settled");
} finally {
  release();
  Deno.rename = rename;
  Deno.remove = remove;
  await client.close();
}
`,
    );
    const child = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        `--allow-read=${ROOT}`,
        `--allow-write=${directory}`,
        script,
      ],
      cwd: ROOT,
      clearEnv: true,
      env: {},
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    assert.equal(child.code, 0, stderr);
    assert.match(stdout, /original custody refusal observed/);
    assert.equal(stderr, "");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function withClient(
  run: (client: ReviewOwnerChannelClient, directory: string) => Promise<void>,
) {
  const directory = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-channel-outcome-",
  });
  const client = new ReviewOwnerChannelClient({
    version: "v1",
    directory,
    ownerRunId: "owned-run",
  });
  try {
    await run(client, directory);
  } finally {
    await client.close();
    await Deno.remove(directory, { recursive: true });
  }
}

for (const malformed of [false, true]) {
  Deno.test(`review channel: a ${malformed ? "malformed" : "valid"} response retains its original outcome`, async () => {
    await withClient(async (client, directory) => {
      const rename = Deno.rename;
      Deno.rename = async (from, to) => {
        await rename(from, to);
        const match = /^request-([0-9a-f-]{36})\.json$/.exec(
          String(to).split("/").at(-1)!,
        );
        if (String(to).startsWith(directory + "/") && match) {
          const responsePath = directory + "/response-" + match[1] + ".json";
          if (malformed) await Deno.writeTextFile(responsePath, "{");
          else {
            await writeReviewChannelFile(responsePath, {
              id: match[1],
              result: { bound: "original response" },
            });
          }
        }
      };
      try {
        if (malformed) {
          await assert.rejects(
            client.call("malformed", {}),
            /review custody channel unavailable/,
          );
        } else {
          assert.deepEqual(await client.call("valid", {}), {
            bound: "original response",
          });
        }
      } finally {
        Deno.rename = rename;
      }
    });
  });
}

Deno.test("review channel: publication failure preserves the original write error", async () => {
  await withClient(async (client, directory) => {
    const rename = Deno.rename;
    const writeError = new Error("synthetic request publication failure");
    Deno.rename = (from, to) => {
      if (
        String(to).startsWith(directory + "/request-") &&
        String(to).endsWith(".json")
      ) return Promise.reject(writeError);
      return rename(from, to);
    };
    try {
      await assert.rejects(
        client.call("unpublished", {}),
        (error) => error === writeError,
      );
    } finally {
      Deno.rename = rename;
    }
  });
});

Deno.test("review channel: an unanswered request keeps its configured deadline", async () => {
  await withClient(async (client) => {
    await assert.rejects(
      client.call("unanswered", {}),
      /review custody channel deadline reached/,
    );
  });
});
