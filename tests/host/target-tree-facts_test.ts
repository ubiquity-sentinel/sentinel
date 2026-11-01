import assert from "node:assert/strict";
import type { HttpRequestV1, HttpTransportV1 } from "../../src/github/http.ts";
import {
  createTargetTreeFactsResolver,
  TargetTreeFactsRefusedV1,
} from "../../src/host/target-tree-facts.ts";
import {
  createGitHubTargetResolvers,
  loadTargetConfigsV1,
} from "../../src/host/targets.ts";
import { createLocalRepositoryConfig } from "../../src/host/local.ts";

const FIRST_SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const TARGET = { owner: "example", name: "generic", slug: "example/generic" };

let fixtureId = 0;

function fixture() {
  const token = `test-token-${fixtureId++}`;
  const state = {
    sha: FIRST_SHA,
    headUnavailable: false,
    rootUnavailable: false,
    protectedText: undefined as string | undefined,
    workflows: ["on: pull_request\n"],
  };
  const requests: HttpRequestV1[] = [];
  const http: HttpTransportV1 = (request) => {
    requests.push(request);
    const url = new URL(request.url);
    const path = url.pathname;
    const reply = (status: number, body: unknown) =>
      Promise.resolve({
        status,
        headers: new Headers(),
        bodyText: JSON.stringify(body),
      });
    const text = (content: string) =>
      reply(200, { encoding: "base64", content: btoa(content) });
    const file = (name: string) => ({ type: "file", name, path: name });
    if (path.includes("/commits/")) {
      return state.headUnavailable
        ? reply(503, {})
        : reply(200, { sha: state.sha });
    }
    if (path.endsWith("/contents")) {
      return state.rootUnavailable ? reply(503, {}) : reply(200, [
        file("package.json"),
        ...(state.protectedText === undefined
          ? []
          : [file("sentinel.protected")]),
      ]);
    }
    if (path.endsWith("/package.json")) {
      const script = url.searchParams.get("ref") === NEXT_SHA
        ? "check"
        : "test";
      return text(JSON.stringify({ scripts: { [script]: "echo verify" } }));
    }
    if (path.endsWith("/sentinel.protected")) {
      return text(state.protectedText!);
    }
    if (path.endsWith("/.github/workflows")) {
      return reply(
        200,
        state.workflows.map((_, index) => {
          const name = `${String(index).padStart(2, "0")}.yml`;
          return { ...file(name), path: `.github/workflows/${name}` };
        }),
      );
    }
    const workflow = /\/workflows\/(\d+)\.yml$/.exec(path);
    if (workflow !== null) return text(state.workflows[Number(workflow[1])]!);
    return reply(404, {});
  };
  const contentsReads = () =>
    requests.filter((request) => request.url.includes("/contents"));
  const workflowReads = () =>
    requests.filter((request) => /\/workflows\/\d+\.yml\?/.test(request.url));
  return { state, requests, http, token, contentsReads, workflowReads };
}

Deno.test("tree facts: cache by target SHA across concurrent calls and recreated transports", async () => {
  const api = fixture();
  const resolve = createTargetTreeFactsResolver({
    http: api.http,
    token: api.token,
  });
  const results = await Promise.all([
    resolve(TARGET, "release/next"),
    resolve(TARGET, "release/next"),
    resolve(TARGET, "release/next"),
  ]);
  assert.equal(results[0]?.hasCiWorkflow, true);
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.equal(api.contentsReads().length, 4);
  const again = createTargetTreeFactsResolver({
    http: (request) => api.http(request),
    token: api.token,
  });
  assert.deepEqual(await again(TARGET, "release/next"), results[0]);
  assert.equal(api.contentsReads().length, 4);
  assert.equal(
    api.requests.length,
    8,
    "only fresh head reads survive cache hits",
  );
  assert.ok(api.requests[0]!.url.endsWith("/commits/release%2Fnext"));
  assert.ok(
    api.contentsReads().every((request) =>
      new URL(request.url).searchParams.get("ref") === FIRST_SHA
    ),
  );
});

Deno.test("tree facts: a changed SHA reloads pinned manifests and workflows", async () => {
  const api = fixture();
  const resolve = createTargetTreeFactsResolver({
    http: api.http,
    token: api.token,
  });
  assert.deepEqual((await resolve(TARGET, "main"))?.manifestScripts, {
    package: ["test"],
  });
  api.state.sha = NEXT_SHA;
  api.state.workflows = ["on: push\n"];
  const changed = await resolve(TARGET, "main");
  assert.deepEqual(changed?.manifestScripts, { package: ["check"] });
  assert.equal(changed?.hasCiWorkflow, false);
  assert.equal(api.contentsReads().length, 8);
  assert.ok(
    api.contentsReads().slice(4).every((request) =>
      new URL(request.url).searchParams.get("ref") === NEXT_SHA
    ),
  );
  await resolve(TARGET, "main");
  assert.equal(api.contentsReads().length, 8);
});

Deno.test("tree facts: cache isolates repositories, credentials and API bases", async () => {
  const api = fixture();
  const resolve = createTargetTreeFactsResolver({
    http: api.http,
    token: api.token,
  });
  await resolve(TARGET, "main");
  await resolve({ owner: "other", name: "generic" }, "main");
  await resolve({ owner: "example", name: "other" }, "main");
  await createTargetTreeFactsResolver({ http: api.http, token: "other" })(
    TARGET,
    "main",
  );
  await createTargetTreeFactsResolver({
    http: api.http,
    token: api.token,
    apiBaseUrl: "https://github.example/api/v3",
  })(TARGET, "main");
  assert.equal(api.contentsReads().length, 20);
  const otherCredential = fixture();
  await createTargetTreeFactsResolver({
    http: otherCredential.http,
    token: otherCredential.token,
  })(
    TARGET,
    "main",
  );
  assert.equal(otherCredential.contentsReads().length, 4);
});

Deno.test("tree facts: unavailable or invalid heads never reuse stale facts", async () => {
  const api = fixture();
  const resolve = createTargetTreeFactsResolver({
    http: api.http,
    token: api.token,
  });
  assert.notEqual(await resolve(TARGET, "main"), null);
  api.state.headUnavailable = true;
  assert.equal(await resolve(TARGET, "main"), null);
  api.state.headUnavailable = false;
  api.state.sha = "not-a-commit";
  assert.equal(await resolve(TARGET, "main"), null);
  api.state.sha = FIRST_SHA;
  assert.notEqual(await resolve(TARGET, "main"), null);
  assert.equal(api.contentsReads().length, 4);
});

Deno.test("tree facts: failed reads and refused protections are retried at the same SHA", async () => {
  const api = fixture();
  const resolve = createTargetTreeFactsResolver({
    http: api.http,
    token: api.token,
  });
  api.state.rootUnavailable = true;
  assert.equal(await resolve(TARGET, "main"), null);
  api.state.rootUnavailable = false;
  api.state.protectedText = "../escape\n";
  await assert.rejects(() => resolve(TARGET, "main"), TargetTreeFactsRefusedV1);
  api.state.protectedText = "deploy/\n";
  assert.deepEqual((await resolve(TARGET, "main"))?.sentinelProtected, [
    "deploy",
  ]);
  assert.equal(api.contentsReads().length, 9);
});

Deno.test("tree facts: workflow reads are capped and an incomplete negative is unavailable", async () => {
  const api = fixture();
  api.state.workflows = Array.from({ length: 30 }, () => "on: push\n");
  api.state.workflows[10] = "on: pull_request\n";
  const resolve = createTargetTreeFactsResolver({
    http: api.http,
    token: api.token,
  });
  assert.equal(await resolve(TARGET, "main"), null);
  assert.equal(api.workflowReads().length, 10);
  api.state.workflows[0] = "on: pull_request\n";
  assert.equal((await resolve(TARGET, "main"))?.hasCiWorkflow, true);
  assert.equal(
    api.workflowReads().length,
    11,
    "positive proof stops the scan early",
  );
});

Deno.test("tree facts: a complete bounded scan can prove no PR workflow", async () => {
  const api = fixture();
  api.state.workflows = Array.from({ length: 10 }, () => "on: push\n");
  const resolve = createTargetTreeFactsResolver({
    http: api.http,
    token: api.token,
  });
  assert.equal((await resolve(TARGET, "main"))?.hasCiWorkflow, false);
  assert.equal(api.workflowReads().length, 10);
  await resolve(TARGET, "main");
  assert.equal(api.workflowReads().length, 10);
});

Deno.test("tree facts: repeated gated config resolvers share the run cache without bypassing the gate", async () => {
  const api = fixture();
  let gated = 0;
  const create = () =>
    createGitHubTargetResolvers({
      http: api.http,
      token: api.token,
      readGate: {
        beforeRequest: () => {
          gated += 1;
          return Promise.resolve({ ok: true as const, value: undefined });
        },
      },
    });
  const first = await create().resolveTreeFacts(TARGET, "main");
  assert.equal(first?.hasCiWorkflow, true);
  assert.deepEqual(await create().resolveTreeFacts(TARGET, "main"), first);
  assert.equal(api.contentsReads().length, 4);
  assert.equal(gated, 6, "the second lookup still gates its fresh SHA read");
});

Deno.test("tree facts: 27-target config reload lifecycle reuses facts and refuses stale heads", async () => {
  const api = fixture();
  const template = createLocalRepositoryConfig();
  const setting = JSON.stringify(
    Array.from({ length: 27 }, (_, index) => `example/generic-${index}`),
  );
  const load = () =>
    loadTargetConfigsV1({
      template,
      readFile: () => Promise.resolve(setting),
      // Default hosted loads recreate transports as well as their resolvers.
      ...createGitHubTargetResolvers({
        http: (request) => api.http(request),
        token: api.token,
        resolveDefaultBranch: () => Promise.resolve("main"),
      }),
    });
  const first = await load();
  assert.equal(first.configs.length, 27);
  assert.equal(api.contentsReads().length, 108);
  assert.deepEqual(await load(), first);
  assert.equal(
    api.contentsReads().length,
    108,
    "unchanged trees cost no contents reads",
  );

  api.state.sha = NEXT_SHA;
  const changed = await load();
  assert.equal(changed.configs.length, 27);
  assert.equal(
    api.contentsReads().length,
    216,
    "new heads get fresh pinned facts",
  );
  assert.ok(
    api.contentsReads().slice(108).every((request) =>
      new URL(request.url).searchParams.get("ref") === NEXT_SHA
    ),
  );

  api.state.headUnavailable = true;
  const unavailable = await load();
  assert.equal(unavailable.configs.length, 0);
  assert.equal(unavailable.factsUnavailable.length, 27);
  assert.equal(api.contentsReads().length, 216);
  api.state.headUnavailable = false;
  assert.deepEqual(await load(), changed);
  assert.equal(
    api.contentsReads().length,
    216,
    "recovery reuses the verified revision",
  );
});
