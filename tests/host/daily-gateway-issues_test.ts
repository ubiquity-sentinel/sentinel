import assert from "node:assert/strict";
import { publishDailyGatewayIssues } from "../../ops/daily-gateway-issues.ts";
import { DAILY_GATEWAY_COUNT_KEYS } from "../../ops/daily-gateway-scan.ts";

const REPOSITORY = "https://api.github.com/repos/ubiquity/ai.ubq.fi";
const APP = "ubiquity-sentinel[bot]";
const RELEASE = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const WINDOW_MS = 48 * 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 23);
const ACTIONS = { repository: "ubiquity-sentinel/sentinel", runId: "1234" };

function report(release = RELEASE, start = START) {
  return {
    version: 1,
    window: { start_ms: start, end_ms: start + WINDOW_MS },
    release_sha: release,
    coverage: "complete",
    counts: {
      ...Object.fromEntries(DAILY_GATEWAY_COUNT_KEYS.map((key) => [key, 0])),
      observed_requests: 20,
      gateway_5xx: 6,
      unexpected_upstream_stream_end: 3,
    },
    findings: [
      {
        kind: "gateway_5xx",
        route: "responses",
        count: 6,
        release_sha: release,
      },
      {
        kind: "unexpected_upstream_stream_end",
        route: "chat.completions",
        count: 3,
        release_sha: release,
      },
    ],
  };
}

function issue(
  number: number,
  body = "",
  state: "open" | "closed" = "open",
  author = APP,
) {
  return {
    number,
    body,
    state,
    title: "fixture",
    repository_url: REPOSITORY,
    created_at: "2026-11-24T04:20:00Z",
    user: { login: author, type: author === APP ? "Bot" : "User" },
  };
}

function marker(release: string) {
  return "<!-- sentinel:daily-gateway-failure:v1 kind=gateway_5xx route=responses release=" +
    release + " -->";
}

function fake(options: {
  listing?: (page: number) => unknown;
  scope?: unknown;
  ambiguous?: boolean;
  ambiguousAt?: number;
} = {}) {
  const calls: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }[] = [];
  const opened: ReturnType<typeof issue>[] = [];
  return {
    calls,
    opened,
    request(
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ) {
      calls.push({ method, path, body });
      if (path === "/installation/repositories?per_page=2") {
        assert.equal(method, "GET");
        return Promise.resolve(
          options.scope ?? {
            total_count: 1,
            repositories: [{
              full_name: "ubiquity/ai.ubq.fi",
              private: false,
              has_issues: true,
            }],
          },
        );
      }
      if (method === "POST") {
        assert.equal(path, "/repos/ubiquity/ai.ubq.fi/issues");
        assert.equal(typeof body?.body, "string");
        assert.equal(typeof body?.title, "string");
        if (
          options.ambiguous ||
          options.ambiguousAt ===
            calls.filter((call) => call.method === "POST").length
        ) return Promise.resolve(null);
        const openedIssue = {
          ...issue(880 + opened.length, String(body?.body)),
          title: String(body?.title),
        };
        opened.push(openedIssue);
        return Promise.resolve(openedIssue);
      }
      const url = new URL("https://api.github.com" + path);
      assert.equal(url.pathname, "/repos/ubiquity/ai.ubq.fi/issues");
      assert.equal(url.searchParams.get("state"), "all");
      assert.equal(url.searchParams.get("creator"), APP);
      return Promise.resolve(
        options.listing?.(Number(url.searchParams.get("page"))) ??
          [...opened],
      );
    },
  };
}

Deno.test("daily writer publishes both fixed findings and suppresses a repeated observation", async () => {
  const gh = fake();
  const first = await publishDailyGatewayIssues(report(), ACTIONS, gh.request);
  assert.deepEqual(first, {
    status: "published",
    created: [880, 881],
    existing: 0,
    deferred: 0,
  });
  assert.equal(gh.opened.length, 2);
  assert.equal(
    gh.opened[0].title,
    "Investigate recurring gateway server errors on responses",
  );
  assert.match(gh.opened[0].body, /recorded 6 occurrences/);
  assert.match(
    gh.opened[0].body,
    /using synthetic input and mocked upstream behavior/,
  );
  assert.match(
    gh.opened[0].body,
    /https:\/\/github.com\/ubiquity-sentinel\/sentinel\/actions\/runs\/1234/,
  );
  assert(!gh.opened[0].body.includes("sentinel:review-followup"));
  gh.opened[0].state = "closed";
  const retry = await publishDailyGatewayIssues(report(), ACTIONS, gh.request);
  assert.deepEqual(retry, {
    status: "unchanged",
    created: [],
    existing: 2,
    deferred: 0,
  });
  const sameObservation = await publishDailyGatewayIssues(report(), {
    ...ACTIONS,
    runId: "1235",
  }, gh.request);
  assert.equal(sameObservation.status, "unchanged");
  assert.equal(gh.calls.filter((call) => call.method === "POST").length, 2);
});

Deno.test("daily writer suppresses an open incident or a closed same-release signature", async () => {
  for (
    const prior of [
      issue(77, marker(PREVIOUS)),
      issue(77, marker(RELEASE), "closed"),
    ]
  ) {
    const gh = fake({ listing: () => [prior] });
    const data = report();
    data.findings.pop();
    const result = await publishDailyGatewayIssues(data, ACTIONS, gh.request);
    assert.deepEqual(result, {
      status: "unchanged",
      created: [],
      existing: 1,
      deferred: 0,
    });
    assert.equal(gh.opened.length, 0);
  }
  const prior = issue(77, marker(PREVIOUS), "closed");
  const spoof = issue(76, marker(RELEASE), "open", "external-author");
  const gh = fake({ listing: () => [prior, spoof] });
  const result = await publishDailyGatewayIssues(report(), ACTIONS, gh.request);
  assert.equal(result.status, "published");
  assert.equal(gh.opened.length, 2);
});

Deno.test("daily writer refuses unsafe schema and unexpected token scope", async () => {
  const gh = fake();
  const unsafe = report();
  unsafe.findings[0].kind = "auth_security";
  await assert.rejects(() =>
    publishDailyGatewayIssues(unsafe, ACTIONS, gh.request)
  );
  const leaking = report();
  Object.assign(leaking.findings[0], { body: "synthetic untrusted body" });
  await assert.rejects(() =>
    publishDailyGatewayIssues(leaking, ACTIONS, gh.request)
  );
  await assert.rejects(() =>
    publishDailyGatewayIssues(report(), {
      ...ACTIONS,
      repository: "other/repo",
    }, gh.request)
  );
  const partial = { ...report(), coverage: "partial", findings: [] };
  const result = await publishDailyGatewayIssues(partial, ACTIONS, gh.request);
  assert.equal(result.status, "no_findings");
  assert.equal(gh.calls.length, 0);

  const overprivileged = fake({ scope: { total_count: 2, repositories: [] } });
  await assert.rejects(
    () => publishDailyGatewayIssues(report(), ACTIONS, overprivileged.request),
    /scope/,
  );
  assert.deepEqual(overprivileged.calls.map((call) => call.method), ["GET"]);
});

Deno.test("daily writer processes actual repeats in a capped sample and resumes after a confirmed create", async () => {
  const gh = fake({ ambiguousAt: 2 });
  const partial = { ...report(), coverage: "partial" };
  await assert.rejects(
    () => publishDailyGatewayIssues(partial, ACTIONS, gh.request),
    /create not verified/,
  );
  assert.equal(gh.opened.length, 1);
  assert.match(gh.opened[0].body, /bounded telemetry sample/);
  const retry = await publishDailyGatewayIssues(partial, ACTIONS, gh.request);
  assert.deepEqual(retry, {
    status: "published",
    created: [881],
    existing: 1,
    deferred: 0,
  });
  const post = gh.calls.filter((call) => call.method === "POST");
  assert.equal(post.length, 3);
  assert.notEqual(post[0].body?.body, post[2].body?.body);
  assert.equal(post[1].body?.body, post[2].body?.body);
});

Deno.test("daily writer fails closed on truncated pagination and ambiguity after one POST", async () => {
  const saturated = fake({
    listing: (page) =>
      Array.from({ length: 100 }, (_, index) => issue(page * 100 + index)),
  });
  await assert.rejects(
    () => publishDailyGatewayIssues(report(), ACTIONS, saturated.request),
    /page budget/,
  );
  assert(!saturated.calls.some((call) => call.method === "POST"));

  const shifted = fake({
    listing: () => Array.from({ length: 100 }, (_, index) => issue(index + 1)),
  });
  await assert.rejects(
    () => publishDailyGatewayIssues(report(), ACTIONS, shifted.request),
    /changed during pagination/,
  );
  assert(!shifted.calls.some((call) => call.method === "POST"));

  const ambiguous = fake({ ambiguous: true });
  await assert.rejects(
    () => publishDailyGatewayIssues(report(), ACTIONS, ambiguous.request),
    /create not verified/,
  );
  assert.equal(
    ambiguous.calls.filter((call) => call.method === "POST").length,
    1,
  );
});
