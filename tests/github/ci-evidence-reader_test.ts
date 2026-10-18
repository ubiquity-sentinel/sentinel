/**
 * The trusted, repository-scoped, bounded CI failure evidence reader, over a
 * fake GitHub API and a fake ranged signed-log host. No network.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import {
  DEFAULT_HTTP_MAX_BODY_BYTES,
  fromFetch,
  type HttpRequestV1,
  type HttpResponseV1,
} from "../../src/github/http.ts";
import {
  CI_LOG_CHUNK_BYTES,
  CI_LOG_TAIL_BYTES,
  MAX_CI_EVIDENCE_REQUESTS,
  MAX_CI_LOG_SCAN_BYTES,
} from "../../src/repair/ci-evidence-types.ts";
import { FakeClock, FakeCooldownGate } from "./helpers.ts";
import {
  fixtureBytes,
  REAL_ERROR_LINES,
} from "../repair/ci-evidence-fixtures.ts";

const TARGET = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155_687_488,
};
const HEAD = "4253e659646bda410d1c565e8c0b396c29b4bc76" as GitSha;
const BASE = "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha;
const JOB = 117390030279;
const RUN = 39027871759;
const API = "/repos/ubiquity/ai.ubq.fi";
const LOG_URL =
  "https://productionresultssa3.blob.core.windows.net/actions-results/x/logs/job/job-logs.txt?sv=2025-01-05&se=2026-10-18T00%3A00%3A00Z&sp=r&sig=FAKE";
const WIRE = new URL("../fixtures/ci-evidence/wire/", import.meta.url);

function wire(name: string): Record<string, unknown> {
  return JSON.parse(Deno.readTextFileSync(new URL(name, WIRE)));
}

function json(status: number, body: unknown, headers = {}): HttpResponseV1 {
  return {
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    bodyText: JSON.stringify(body),
  };
}

type Route = (
  request: HttpRequestV1,
) => HttpResponseV1 | Promise<HttpResponseV1>;

class FakeGitHub {
  readonly requests: HttpRequestV1[] = [];
  readonly routes = new Map<string, Route>();
  log: Route = () => json(404, {});
  constructor(log: Uint8Array) {
    const checkRuns = wire("check-runs-1009.json");
    this.routes.set(
      `${API}/commits/${HEAD}/check-runs`,
      () => json(200, checkRuns),
    );
    this.routes.set(`${API}/commits/${HEAD}/statuses`, () => json(200, []));
    this.routes.set(
      `${API}/actions/jobs/${JOB}`,
      () => json(200, wire("job-1009.json")),
    );
    this.routes.set(
      `${API}/actions/runs/${RUN}`,
      () => json(200, wire("run-1009.json")),
    );
    this.routes.set(
      `${API}/check-runs/${JOB}/annotations`,
      () => json(200, wire("annotations-1009.json")),
    );
    this.routes.set(
      `${API}/actions/jobs/${JOB}/logs`,
      () => ({
        status: 302,
        headers: new Headers({ location: LOG_URL }),
        bodyText: "",
      }),
    );
    this.log = ranged(log);
  }
  readonly http = async (request: HttpRequestV1): Promise<HttpResponseV1> => {
    this.requests.push(request);
    const url = new URL(request.url);
    if (url.origin === "https://api.github.com") {
      const route = this.routes.get(url.pathname);
      return route === undefined ? json(404, {}) : await route(request);
    }
    return await this.log(request);
  };
  apiPaths(): string[] {
    return this.requests
      .filter((request) => request.url.startsWith("https://api.github.com/"))
      .map((request) => new URL(request.url).pathname);
  }
  logRequests(): HttpRequestV1[] {
    return this.requests.filter((request) =>
      !request.url.startsWith("https://api.github.com/")
    );
  }
}

/** A blob host that honors explicit `bytes=start-end` ranges (Azure-like). */
function ranged(
  bytes: Uint8Array,
  options: { ignoreRange?: boolean } = {},
): Route {
  return (request) => {
    const range = request.headers.get("range");
    if (options.ignoreRange === true || range === undefined) {
      return {
        status: 200,
        headers: new Headers(),
        bodyText: "",
        bodyBytes: bytes,
      };
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (match === null) return json(416, {});
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    if (start >= bytes.length) return json(416, {});
    return {
      status: 206,
      headers: new Headers({
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
      }),
      bodyText: "",
      bodyBytes: bytes.slice(start, end + 1),
    };
  };
}

function client(fake: FakeGitHub, gate = new FakeCooldownGate()) {
  return new GitHubApiClient({
    repository: TARGET,
    apiBaseUrl: "https://api.github.com",
    http: fake.http,
    clock: new FakeClock(),
    auth: {
      authorizationHeader: () =>
        Promise.resolve({ ok: true, value: "Bearer test-read-token" }),
    },
    cooldownGate: gate,
  });
}

function read(fake: FakeGitHub, deadlineMs = 30_000) {
  return client(fake).readCiFailureEvidence({
    head: HEAD,
    base: BASE,
    deadlineMs,
  });
}

Deno.test("reader: the live 1009 failure yields identity, failing step, annotations and the error lines", async () => {
  const fake = new FakeGitHub(fixtureBytes("real-1009.txt"));
  const evidence = await read(fake);
  assert.equal(evidence.unavailable, null);
  assert.equal(evidence.checks.length, 1, "only the failing check");
  const [check] = evidence.checks;
  assert.equal(check.name, "validate");
  assert.equal(check.app, "github-actions");
  assert.deepEqual(check.workflow, {
    name: "Gateway CI 025239c6643fb3d334d6b5379de6269fa33cc662",
    path: ".github/workflows/deno-deploy.yml",
  });
  assert.deepEqual(check.job, { id: JOB, name: "validate" });
  assert.deepEqual(check.failingSteps, [{
    number: 11,
    name: "Complete Bun gates with the prepared binding",
    conclusion: "failure",
  }]);
  assert.equal(check.classification, "candidate");
  assert.equal(check.annotations.length, 2);
  assert.equal(check.annotations[0].level, "failure", "failures first");
  assert.equal(check.unavailable, null);
  const lines = (check.excerpt ?? "").split("\n");
  for (const expected of REAL_ERROR_LINES["real-1009.txt"]) {
    assert.ok(lines.includes(expected), `lost: ${expected}`);
  }
  assert.ok(
    check.hints.includes("prettier: src/provider/lithos-rate-limits.ts"),
  );
  // Repository-scoped API reads with the credential; the signed log without it.
  for (const path of fake.apiPaths()) {
    assert.ok(path.startsWith(`${API}/`), path);
  }
  for (const request of fake.requests) {
    const isApi = request.url.startsWith("https://api.github.com/");
    assert.equal(request.headers.has("authorization"), isApi, request.url);
    assert.equal(request.method, "GET");
  }
  assert.equal(fake.logRequests().length, 1, "one ranged chunk");
  assert.equal(
    fake.logRequests()[0].headers.get("range"),
    `bytes=0-${CI_LOG_CHUNK_BYTES - 1}`,
  );
  assert.ok(fake.requests.length <= 8, String(fake.requests.length));
});

Deno.test("reader: an untrusted log redirect is refused without fetching it", async () => {
  const fake = new FakeGitHub(fixtureBytes("real-1009.txt"));
  fake.routes.set(`${API}/actions/jobs/${JOB}/logs`, () => ({
    status: 302,
    headers: new Headers({ location: "https://evil.example/log.txt" }),
    bodyText: "",
  }));
  const evidence = await read(fake);
  assert.equal(evidence.checks[0].unavailable, "untrusted_redirect");
  assert.equal(evidence.checks[0].excerpt, null);
  assert.equal(fake.logRequests().length, 0);
});

Deno.test("reader: forbidden, expired, missing and rate-limited reads degrade to reason codes", async () => {
  const forbidden = new FakeGitHub(fixtureBytes("real-1009.txt"));
  forbidden.routes.set(
    `${API}/actions/jobs/${JOB}`,
    () => json(403, { message: "Resource not accessible by integration" }),
  );
  forbidden.routes.set(`${API}/actions/jobs/${JOB}/logs`, () => json(403, {}));
  const denied = await read(forbidden);
  assert.equal(denied.checks[0].unavailable, "forbidden_actions_read");
  assert.equal(
    denied.checks[0].annotations.length,
    2,
    "annotations need only checks:read",
  );
  assert.equal(denied.checks[0].excerpt, null);

  for (
    const [status, reason] of [[410, "expired"], [404, "not_found"]] as const
  ) {
    const fake = new FakeGitHub(fixtureBytes("real-1009.txt"));
    fake.routes.set(`${API}/actions/jobs/${JOB}/logs`, () => json(status, {}));
    const evidence = await read(fake);
    assert.equal(evidence.checks[0].unavailable, reason, String(status));
    assert.equal(evidence.checks[0].failingSteps.length, 1);
  }

  const limited = new FakeGitHub(fixtureBytes("real-1009.txt"));
  limited.routes.set(
    `${API}/commits/${HEAD}/check-runs`,
    () => json(429, { message: "rate limited" }, { "retry-after": "60" }),
  );
  const throttled = await read(limited);
  assert.equal(throttled.unavailable, "rate_limited");
  assert.equal(throttled.checks.length, 0);
});

Deno.test("reader: a 40 MiB log still yields its failing step's tail through ranged reads", async () => {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    "2026-10-17T10:00:00.0000000Z ##[group]Run bun test\n" +
      "2026-10-17T10:00:00.0000000Z shell: /usr/bin/bash -e {0}\n" +
      "2026-10-17T10:00:00.0000000Z ##[endgroup]\n",
  );
  const filler = encoder.encode(
    "2026-10-17T10:00:01.0000000Z (pass) filler case keeps passing [0.01ms]\n",
  );
  const tail = encoder.encode(
    "2026-10-17T10:30:00.0000000Z tests/late.test.ts:12:3 AssertionError: late failure 7 !== 8\n" +
      "2026-10-17T10:30:00.0000000Z (fail) late suite > keeps order [3.00ms]\n" +
      "2026-10-17T10:30:00.0000000Z ##[error]Process completed with exit code 1.\n" +
      "2026-10-17T10:30:00.0000000Z Post job cleanup.\n",
  );
  const size = 40 * 1024 * 1024;
  const bytes = new Uint8Array(size);
  bytes.set(head, 0);
  let offset = head.length;
  while (offset + filler.length <= size - tail.length) {
    bytes.set(filler, offset);
    offset += filler.length;
  }
  bytes.fill(0x20, offset, size - tail.length);
  bytes.set(tail, size - tail.length);
  const fake = new FakeGitHub(bytes);
  const evidence = await read(fake, 120_000);
  const [check] = evidence.checks;
  assert.equal(check.truncatedScan, true);
  assert.match(check.excerpt ?? "", /AssertionError: late failure 7 !== 8/);
  assert.match(check.excerpt ?? "", /\(fail\) late suite > keeps order/);
  assert.match(check.excerpt ?? "", /bytes not scanned/);
  const logs = fake.logRequests();
  assert.equal(logs.length, MAX_CI_LOG_SCAN_BYTES / CI_LOG_CHUNK_BYTES + 1);
  assert.equal(
    logs.at(-1)?.headers.get("range"),
    `bytes=${size - CI_LOG_TAIL_BYTES}-${size - 1}`,
  );
});

Deno.test("reader: a host that ignores Range is used when bounded and refused when oversized", async () => {
  const small = new FakeGitHub(fixtureBytes("real-1119.txt"));
  small.log = ranged(fixtureBytes("real-1119.txt"), { ignoreRange: true });
  const evidence = await read(small);
  assert.match(evidence.checks[0].excerpt ?? "", /error TS2345/);
  const huge = new FakeGitHub(new Uint8Array(0));
  huge.log = ranged(new Uint8Array(MAX_CI_LOG_SCAN_BYTES + 1), {
    ignoreRange: true,
  });
  const oversized = await read(huge);
  assert.equal(oversized.checks[0].unavailable, "oversize");
  assert.equal(oversized.checks[0].excerpt, null);
  // Through the production transport, a whole body past its byte bound
  // fails in the transport itself and is still reported as oversize.
  const bounded = new FakeGitHub(new Uint8Array(0));
  const transport = fromFetch(() =>
    Promise.resolve(
      new Response(new Uint8Array(DEFAULT_HTTP_MAX_BODY_BYTES + 1), {
        status: 200,
      }),
    )
  );
  bounded.log = (request) => transport(request);
  const refused = await read(bounded);
  assert.equal(refused.checks[0].unavailable, "oversize");
  assert.equal(refused.checks[0].excerpt, null);
  assert.equal(refused.checks[0].failingSteps.length, 1, "identity is kept");
});

Deno.test("reader: a rate limit stops every later read of the collection", async () => {
  const fake = new FakeGitHub(fixtureBytes("real-1009.txt"));
  const validate = (wire("check-runs-1009.json").check_runs as Record<
    string,
    unknown
  >[]).find((run) => run.name === "validate")!;
  const runs = [validate, { ...validate, id: JOB + 1, name: "validate-2" }];
  fake.routes.set(
    `${API}/commits/${HEAD}/check-runs`,
    () => json(200, { total_count: runs.length, check_runs: runs }),
  );
  fake.routes.set(
    `${API}/actions/jobs/${JOB}`,
    () =>
      json(403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1792540800",
      }),
  );
  const evidence = await read(fake);
  assert.equal(evidence.unavailable, "rate_limited");
  assert.equal(evidence.checks.length, 1, "the reached check keeps identity");
  assert.equal(evidence.checks[0].unavailable, "rate_limited");
  assert.equal(evidence.omittedChecks, 1, "the unreached check is counted");
  assert.deepEqual(fake.apiPaths(), [
    `${API}/commits/${HEAD}/check-runs`,
    `${API}/commits/${HEAD}/statuses`,
    `${API}/actions/jobs/${JOB}`,
  ]);
  assert.equal(fake.logRequests().length, 0);
});

Deno.test("reader: a fired deadline returns partial evidence promptly", async () => {
  const fake = new FakeGitHub(fixtureBytes("real-1009.txt"));
  fake.log = () => new Promise<HttpResponseV1>(() => {});
  const started = Date.now();
  const evidence = await read(fake, 300);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(evidence.checks.length, 1, "identity read before the hang");
  assert.equal(evidence.checks[0].unavailable, "timeout");
  assert.equal(evidence.checks[0].failingSteps.length, 1);
});

Deno.test("reader: a job of another head is refused before its log is read", async () => {
  const fake = new FakeGitHub(fixtureBytes("real-1009.txt"));
  fake.routes.set(
    `${API}/actions/jobs/${JOB}`,
    () => json(200, { ...wire("job-1009.json"), head_sha: BASE }),
  );
  const evidence = await read(fake);
  assert.equal(evidence.checks[0].unavailable, "head_mismatch");
  assert.equal(fake.logRequests().length, 0);
  assert.ok(!fake.apiPaths().includes(`${API}/actions/jobs/${JOB}/logs`));
});

Deno.test("reader: many failing checks stay within the check, log and request bounds", async () => {
  const fake = new FakeGitHub(fixtureBytes("real-1119.txt"));
  const base = wire("check-runs-1009.json").check_runs as Record<
    string,
    unknown
  >[];
  const validate = base.find((run) => run.name === "validate")!;
  const runs = Array.from({ length: 12 }, (_, index) => ({
    ...validate,
    id: JOB + index,
    name: `validate-${index}`,
  }));
  fake.routes.set(
    `${API}/commits/${HEAD}/check-runs`,
    () => json(200, { total_count: runs.length, check_runs: runs }),
  );
  for (let index = 0; index < 12; index++) {
    const id = JOB + index;
    fake.routes.set(
      `${API}/actions/jobs/${id}`,
      () => json(200, { ...wire("job-1009.json"), id }),
    );
    fake.routes.set(`${API}/check-runs/${id}/annotations`, () => json(200, []));
    fake.routes.set(`${API}/actions/jobs/${id}/logs`, () => ({
      status: 302,
      headers: new Headers({ location: LOG_URL }),
      bodyText: "",
    }));
  }
  const evidence = await read(fake);
  assert.equal(evidence.checks.length, 8);
  assert.equal(evidence.omittedChecks, 4);
  assert.equal(
    evidence.checks.filter((check) => check.excerpt !== null).length,
    4,
  );
  assert.ok(fake.requests.length <= MAX_CI_EVIDENCE_REQUESTS);
  for (const path of fake.apiPaths()) {
    assert.ok(path.startsWith(`${API}/`), path);
  }
});

Deno.test("reader: non-Actions checks and commit statuses carry their own bounded output", async () => {
  const fake = new FakeGitHub(new Uint8Array(0));
  fake.routes.set(`${API}/commits/${HEAD}/check-runs`, () =>
    json(200, {
      total_count: 1,
      check_runs: [{
        id: 77,
        name: "external-lint",
        head_sha: HEAD,
        status: "completed",
        conclusion: "failure",
        started_at: "2026-10-17T12:00:00Z",
        completed_at: "2026-10-17T12:01:00Z",
        output: {
          title: "3 problems",
          summary: "src/a.ts:1 \u001b[31mno-unused\u001b[0m",
          text: "x".repeat(20_000),
          annotations_count: 1,
        },
        app: { id: 9, slug: "external-linter", name: "External Linter" },
      }],
    }));
  fake.routes.set(`${API}/check-runs/77/annotations`, () =>
    json(200, [{
      path: "src/a.ts",
      start_line: 1,
      end_line: 1,
      annotation_level: "failure",
      title: "no-unused",
      message: "'x' is defined but never used.",
      raw_details: "",
    }]));
  fake.routes.set(`${API}/commits/${HEAD}/statuses`, () =>
    json(200, [{
      context: "ci/legacy",
      state: "failure",
      description: "Build failed at step compile",
      target_url: "https://ci.example/build/1",
      created_at: "2026-10-17T12:00:00Z",
      updated_at: "2026-10-17T12:00:00Z",
    }]));
  const evidence = await read(fake);
  assert.equal(evidence.checks.length, 2);
  const [external, status] = evidence.checks;
  assert.equal(external.app, "external-linter");
  assert.equal(external.output?.summary, "src/a.ts:1 no-unused");
  assert.ok((external.output?.text.length ?? 0) <= 8 * 1024);
  assert.equal(
    external.annotations[0].message,
    "'x' is defined but never used.",
  );
  assert.equal(external.classification, "candidate");
  assert.equal(status.app, null);
  assert.equal(status.name, "ci/legacy");
  assert.equal(status.output?.summary, "Build failed at step compile");
  assert.ok(!fake.apiPaths().some((path) => path.includes("/actions/")));
});

Deno.test("reader: a malformed head never reaches the network", async () => {
  const fake = new FakeGitHub(new Uint8Array(0));
  const evidence = await client(fake).readCiFailureEvidence({
    head: "not-a-sha" as GitSha,
    base: BASE,
    deadlineMs: 1_000,
  });
  assert.equal(evidence.unavailable, "malformed");
  assert.equal(fake.requests.length, 0);
});
