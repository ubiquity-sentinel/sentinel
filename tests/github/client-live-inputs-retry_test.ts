import assert from "node:assert/strict";
import { portError } from "../../src/contracts/ports.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { buildLiveInputsChunks } from "../../src/github/client-live-inputs.ts";
import type { LiveInputsRequestV1 } from "../../src/contracts/live-inputs.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  httpRespond,
  httpThrow,
  REPO,
  ScriptedHttpTransport,
  type ScriptEntry,
  T0,
} from "./helpers.ts";

const BASE = "aafb7ee0598699bb7fb8a72ea133693ed64462da";
const REQUEST: LiveInputsRequestV1 = {
  repository: REPO,
  issues: Array.from({ length: 105 }, (_, index) => index + 1),
  pulls: [],
  branches: ["development"],
};

function replies() {
  const chunks = buildLiveInputsChunks(REQUEST);
  assert.ok(chunks !== null);
  return chunks.map((chunk) => {
    const repository: Record<string, unknown> = {};
    for (const item of chunk.items) {
      repository[item.alias] = item.kind === "issue"
        ? { number: item.number, state: "OPEN" }
        : { target: { oid: BASE } };
    }
    return httpRespond("POST", "/graphql", 200, { data: { repository } });
  });
}

function makeClient(script: ScriptEntry[]) {
  const transport = new ScriptedHttpTransport(script);
  const cooldownGate = new FakeCooldownGate();
  const client = new GitHubApiClient({
    repository: REPO,
    apiBaseUrl: "https://api.github.com",
    http: transport.fetch.bind(transport),
    auth: new FakeAuthProvider(),
    cooldownGate,
    clock: new FakeClock(T0),
  });
  return { client, transport, cooldownGate };
}

Deno.test("live inputs retry: a transient gateway failure retries only the failed chunk", async () => {
  for (const status of [502, 503, 504]) {
    const [first, second] = replies();
    const { client, transport } = makeClient([
      first,
      httpRespond("POST", "/graphql", status, {}),
      second,
    ]);
    const result = await client.readLiveInputs(REQUEST);
    assert.equal(
      result.ok,
      true,
      `gateway ${status}: ${JSON.stringify(result)}`,
    );
    if (!result.ok) continue;
    assert.equal(result.value.issues.length, 105);
    assert.deepEqual(result.value.branches, [{
      branch: "development",
      tip: BASE,
    }]);
    assert.equal(transport.requests.length, 3);
    assert.equal(transport.requests[1].body, transport.requests[2].body);
    assert.notEqual(transport.requests[0].body, transport.requests[2].body);
  }
});

Deno.test("live inputs retry: persistent gateway failures stay bounded and exhaustive", async () => {
  for (const status of [502, 503, 504]) {
    const { client, transport } = makeClient([
      replies()[0],
      httpRespond("POST", "/graphql", status, {}),
      httpRespond("POST", "/graphql", status, {}),
    ]);
    const result = await client.readLiveInputs(REQUEST);
    assert.equal(
      result.ok,
      false,
      "never return the first chunk as partial success",
    );
    if (!result.ok) assert.equal(result.error.kind, "unavailable");
    assert.equal(transport.requests.length, 3, "only one retry is admitted");
  }
});

Deno.test("live inputs retry: rate limits, permanent errors and malformed data are not retried", async () => {
  for (const status of [401, 403, 404, 422, 429, 500]) {
    const { client, transport } = makeClient([
      httpRespond("POST", "/graphql", status, {}),
    ]);
    assert.equal((await client.readLiveInputs(REQUEST)).ok, false);
    assert.equal(transport.requests.length, 1, `HTTP ${status}`);
  }
  for (
    const body of [
      { data: { repository: {} } },
      { errors: [{ type: "FORBIDDEN", path: ["repository", "i0"] }] },
    ]
  ) {
    const { client, transport } = makeClient([
      httpRespond("POST", "/graphql", 200, body),
    ]);
    assert.equal((await client.readLiveInputs(REQUEST)).ok, false);
    assert.equal(transport.requests.length, 1);
  }
});

Deno.test("live inputs retry: a lost request is not retried", async () => {
  const { client, transport } = makeClient([httpThrow("POST", "/graphql")]);
  const result = await client.readLiveInputs(REQUEST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "unavailable");
  assert.equal(transport.requests.length, 1);
});

Deno.test("live inputs retry: rechecks the cooldown gate before retrying", async () => {
  const { client, transport, cooldownGate } = makeClient([
    httpRespond("POST", "/graphql", 503, {}),
  ]);
  const before = cooldownGate.beforeRequest.bind(cooldownGate);
  cooldownGate.beforeRequest = (installationId) =>
    transport.requests.length === 0
      ? before(installationId)
      : Promise.resolve(portError("rate_limited", "cooling"));
  const result = await client.readLiveInputs(REQUEST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "rate_limited");
  assert.equal(transport.requests.length, 1, "no HTTP after the gate closed");
});

Deno.test("live inputs retry: both attempts share the original chunk deadline", async () => {
  // Advance the real client's deadline timers deterministically. The first
  // attempt uses 60 ms of a 100 ms bound; the retry must not get a fresh bound.
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map<number, { due: number; fire: () => void }>();
  let now = 0;
  let next = 0;
  globalThis.setTimeout = ((handler: () => void, ms = 0) => {
    assert.equal(typeof handler, "function");
    const id = ++next;
    timers.set(id, { due: now + ms, fire: handler });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as typeof clearTimeout;
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.due <= now) {
        timers.delete(id);
        timer.fire();
      }
    }
  };
  let requests = 0;
  try {
    const client = new GitHubApiClient({
      repository: REPO,
      apiBaseUrl: "https://api.github.com",
      auth: new FakeAuthProvider(),
      cooldownGate: new FakeCooldownGate(),
      clock: new FakeClock(T0),
      requestDeadlineMs: 100,
      http: () => {
        requests++;
        advance(requests === 1 ? 60 : 50);
        const response = replies()[0];
        return Promise.resolve({
          status: requests === 1 ? 503 : 200,
          headers: new Headers(),
          bodyText: response.kind === "respond" ? response.body : "",
        });
      },
    });
    const result = await client.readLiveInputs({
      ...REQUEST,
      issues: [1],
      branches: [],
    });
    assert.equal(requests, 2);
    assert.equal(
      result.ok,
      false,
      "retry cannot outlive the original deadline",
    );
    if (!result.ok) assert.equal(result.error.kind, "unavailable");
    assert.equal(timers.size, 0, "all parent and attempt timers are disposed");
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
