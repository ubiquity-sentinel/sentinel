/**
 * The committed target reads' transient classification
 * (src/host/target-read-observer.ts): which failures a pass whose every
 * target read failed may defer on, that the observer keeps only the last
 * read per repository, and that a load with the observer is the same load,
 * request for request, including a partial failure.
 */
import assert from "node:assert/strict";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import { createLocalRepositoryConfig } from "../../src/host/local.ts";
import {
  createTargetReadObserverV1,
  transientTargetReadV1,
} from "../../src/host/target-read-observer.ts";
import {
  createGitHubTargetResolvers,
  loadTargetConfigsV1,
  unavailableTargetCountsV1,
} from "../../src/host/targets.ts";

const NOW = Date.UTC(2026, 10, 16);
const API = "https://api.github.com";
const SHA = "e".repeat(40);

function answer(
  status: number,
  headers: Record<string, string> = {},
  body = "{}",
): HttpResponseV1 {
  return { status, headers: new Headers(headers), bodyText: body };
}

Deno.test("target reads: only a throw, a 5xx, a 429 or a 403 with rate-limit evidence is transient", async () => {
  const cases: [HttpResponseV1, boolean][] = [
    [answer(500), true],
    [answer(502), true],
    [answer(503), true],
    [answer(599), true],
    [answer(429), true],
    [answer(403, { "retry-after": "60" }), true],
    [answer(403, { "x-ratelimit-remaining": "0" }), true],
    [
      answer(403, {}, '{"message":"You have exceeded a secondary rate limit"}'),
      true,
    ],
    [
      answer(403, {}, '{"message":"triggered an abuse detection mechanism"}'),
      true,
    ],
    [answer(200, {}, '{"default_branch":""}'), false],
    [answer(301), false],
    [answer(401, {}, '{"message":"Bad credentials"}'), false],
    [answer(404), false],
    [answer(408), false],
    [answer(403, {}, '{"message":"Resource not accessible"}'), false],
    [answer(403, { "x-ratelimit-remaining": "12" }), false],
    [answer(403, { "retry-after": " " }), false],
    [answer(600), false],
  ];
  for (const [response, transient] of cases) {
    assert.equal(
      await transientTargetReadV1(response, NOW),
      transient,
      `${response.status} ${JSON.stringify([...response.headers])}`,
    );
  }
});

Deno.test("target reads: the observer keeps each repository's last read and never changes one", async () => {
  const observer = createTargetReadObserverV1({ now: () => NOW });
  const ok = answer(200, {}, '{"default_branch":"main","private":false}');
  const failure = new TypeError("connection reset");
  const script = new Map<string, HttpResponseV1 | Error>([
    [`${API}/repos/o/a`, ok],
    [`${API}/repos/o/a/commits/main`, answer(503)],
    [`${API}/repos/o/b/commits/main`, answer(503)],
    [`${API}/repos/o/b/contents?ref=${SHA}`, answer(401)],
    [`${API}/repos/o/c`, failure],
    [`${API}/graphql`, answer(503)],
  ]);
  const http = observer.observe((request) => {
    const next = script.get(request.url)!;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const get = (url: string) =>
    http({ method: "GET", url, headers: new Map(), body: null });
  // The very response object and the very error pass through.
  assert.equal(await get(`${API}/repos/o/a`), ok);
  assert.equal(observer.transient({ owner: "o", name: "a" }), false);
  await get(`${API}/repos/o/a/commits/main`);
  assert.equal(observer.transient({ owner: "o", name: "a" }), true);
  await get(`${API}/repos/o/b/commits/main`);
  await get(`${API}/repos/o/b/contents?ref=${SHA}`);
  assert.equal(observer.transient({ owner: "o", name: "b" }), false);
  await assert.rejects(() => get(`${API}/repos/o/c`), (error) => {
    assert.equal(error, failure);
    return true;
  });
  assert.equal(observer.transient({ owner: "o", name: "c" }), true);
  // A read that names no repository is not a target read.
  await get(`${API}/graphql`);
  assert.equal(observer.transient({ owner: "o", name: "never" }), false);
});

/** One scripted GitHub: two configured targets beside three that fail. */
function partialGitHub(requests: string[]) {
  const file = (text: string) =>
    answer(
      200,
      {},
      JSON.stringify({ encoding: "base64", content: btoa(text) }),
    );
  const routes = new Map<string, () => Promise<HttpResponseV1>>([
    [
      "/repos/ubiquity-sentinel/sentinel",
      () =>
        Promise.resolve(
          answer(200, {}, '{"default_branch":"development","private":false}'),
        ),
    ],
    [
      "/repos/ubiquity/prospector",
      () =>
        Promise.resolve(
          answer(200, {}, '{"default_branch":"main","private":false}'),
        ),
    ],
    [
      "/repos/ubiquity/prospector/commits/main",
      () => Promise.resolve(answer(200, {}, JSON.stringify({ sha: SHA }))),
    ],
    [
      "/repos/ubiquity/prospector/contents",
      () =>
        Promise.resolve(answer(
          200,
          {},
          JSON.stringify([{ type: "file", name: "package.json" }]),
        )),
    ],
    [
      "/repos/ubiquity/prospector/contents/package.json",
      () => Promise.resolve(file('{"scripts":{"test":"node --test"}}')),
    ],
    [
      "/repos/ubiquity/prospector/contents/.github/workflows",
      () => Promise.resolve(answer(404)),
    ],
    ["/repos/ubiquity/broken", () => Promise.resolve(answer(401))],
    [
      "/repos/ubiquity/flaky",
      () =>
        Promise.resolve(
          answer(200, {}, '{"default_branch":"main","private":false}'),
        ),
    ],
    ["/repos/ubiquity/flaky/commits/main", () => Promise.resolve(answer(503))],
    [
      "/repos/ubiquity/offline",
      () => Promise.reject(new TypeError("connection reset")),
    ],
  ]);
  return (request: HttpRequestV1): Promise<HttpResponseV1> => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const route = routes.get(url.pathname);
    return route === undefined ? Promise.resolve(answer(404)) : route();
  };
}

const PARTIAL = JSON.stringify([
  "ubiquity-sentinel/sentinel",
  "ubiquity/prospector",
  "ubiquity/broken",
  "ubiquity/flaky",
  "ubiquity/offline",
]);

Deno.test("target reads: a partially failed load with the observer is the same load", async () => {
  const load = async (token: string, observed: boolean) => {
    const requests: string[] = [];
    const readObserver = createTargetReadObserverV1({ now: () => NOW });
    const result = await loadTargetConfigsV1({
      template: createLocalRepositoryConfig(),
      readFile: () => Promise.resolve(PARTIAL),
      ...createGitHubTargetResolvers({
        http: partialGitHub(requests),
        // Distinct credentials keep the run-scoped facts cache apart.
        token,
        readGate: { beforeRequest: () => Promise.resolve(portOk(undefined)) },
        installationId: 7,
        ...(observed ? { readObserver } : {}),
      }),
    });
    return { result, requests, readObserver };
  };
  const plain = await load("observer-test-plain", false);
  const observed = await load("observer-test-observed", true);
  assert.deepEqual(observed.result, plain.result);
  assert.deepEqual(observed.requests, plain.requests);
  assert.deepEqual(
    plain.result.configs.map((config) => config.repository.name),
    ["sentinel", "prospector"],
  );
  assert.deepEqual(plain.result.skipped, [
    "ubiquity/broken",
    "ubiquity/flaky",
    "ubiquity/offline",
  ]);
  assert.deepEqual(plain.result.factsUnavailable, ["ubiquity/flaky"]);
  // A configured target means no unavailability, observed or not.
  assert.equal(
    unavailableTargetCountsV1(observed.result, observed.readObserver),
    null,
  );
  const transient = observed.result.targets.filter((target) =>
    observed.readObserver.transient(target)
  ).map((target) => target.slug);
  assert.deepEqual(transient, ["ubiquity/flaky", "ubiquity/offline"]);
});

Deno.test("target reads: an all-unavailable load counts its transient failures; a refused cooldown read is one", async () => {
  const requests: string[] = [];
  const readObserver = createTargetReadObserverV1({ now: () => NOW });
  const result = await loadTargetConfigsV1({
    template: createLocalRepositoryConfig(),
    readFile: () =>
      Promise.resolve(JSON.stringify([
        "ubiquity/broken",
        "ubiquity/flaky",
        "ubiquity/offline",
        "ubiquity/prospector",
      ])),
    ...createGitHubTargetResolvers({
      http: partialGitHub(requests),
      token: "observer-test-cooldown",
      // The durable cooldown refuses every tree-facts read before any
      // request: the default branches read, their facts never do.
      readGate: {
        beforeRequest: () =>
          Promise.resolve(portError("rate_limited", "cooling down")),
      },
      installationId: 7,
      readObserver,
    }),
  });
  assert.deepEqual(requests, [
    "GET /repos/ubiquity/broken",
    "GET /repos/ubiquity/flaky",
    "GET /repos/ubiquity/offline",
    "GET /repos/ubiquity/prospector",
  ]);
  assert.deepEqual(unavailableTargetCountsV1(result, readObserver), {
    listed: 4,
    branchUnavailable: 2,
    factsUnavailable: 2,
    transient: 3,
  });
  // Without the observer nothing is known to be transient.
  assert.deepEqual(unavailableTargetCountsV1(result), {
    listed: 4,
    branchUnavailable: 2,
    factsUnavailable: 2,
    transient: 0,
  });
});
