import assert from "node:assert/strict";
import { MAX_ISSUE_BODY } from "../../src/github/wire.ts";
import {
  issueSourceFailureDetail,
  sanitizeIssueSourceContext,
} from "../../src/github/client-response.ts";
import { httpRespond, httpThrow, issueWire, makePort } from "./helpers.ts";

for (const name of ["sentinel", "ai.ubq.fi"]) {
  const target = `ubiquity/${name}`;
  const path = `/repos/${target}/issues`;
  for (const status of [401, 429, 500]) {
    Deno.test(`issue-source context: ${target} HTTP ${status} retains page/status without body or token`, async () => {
      const { port } = makePort({
        repository: { owner: "ubiquity", name, installationId: 1 },
        script: [
          httpRespond("GET", `${path}?state=open&per_page=100&page=1`, 200, [
            issueWire(),
          ], {
            link:
              `<https://api.github.com${path}?state=open&per_page=100&page=2>; rel="next"`,
          }),
          httpRespond("GET", `${path}?state=open&per_page=100&page=2`, status, {
            message: "Bearer secret-body-token",
          }),
        ],
      });
      const result = await port.listOpenIssues();
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(
        result.error.kind,
        status === 429
          ? "rate_limited"
          : status === 401
          ? "auth_failed"
          : "unavailable",
      );
      assert.deepEqual(result.error.issueSource, {
        target,
        method: "GET",
        endpointPath: path,
        httpStatus: status,
        page: 2,
        stage: "http",
        code: status === 429 ? "rate_limited" : "http_error",
      });
      assert.doesNotMatch(
        JSON.stringify(result),
        /secret-body-token|ghs_synthetic_token/,
      );
      assert.match(
        issueSourceFailureDetail(result.error),
        new RegExp(`HTTP ${status} page 2`),
      );
      assert.ok(issueSourceFailureDetail(result.error).length <= 300);
    });
  }

  Deno.test(`issue-source context: ${target} HTTP 200 malformed JSON is distinct from HTTP failure`, async () => {
    const { port } = makePort({
      repository: { owner: "ubiquity", name, installationId: 1 },
      script: [httpRespond("GET", path, 200, '{"Bearer secret-body-token')],
    });
    const result = await port.listOpenIssues();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.kind, "invalid");
    assert.deepEqual(result.error.issueSource, {
      target,
      method: "GET",
      endpointPath: path,
      httpStatus: 200,
      page: 1,
      stage: "json",
      code: "malformed_json",
    });
    assert.doesNotMatch(JSON.stringify(result), /secret-body-token/);
  });
}

Deno.test("issue-source context: a lost response has null HTTP status", async () => {
  const { port } = makePort({
    script: [httpThrow("GET", "/repos/ubiquity-sentinel/sentinel/issues")],
  });
  const result = await port.listOpenIssues();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.issueSource?.httpStatus, null);
  assert.equal(result.error.issueSource?.stage, "request");
});

Deno.test("issue-source context: HTTP 200 oversized body reports the current wire ceiling and measured length", async () => {
  assert.equal(MAX_ISSUE_BODY, 1_000_000);
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity-sentinel/sentinel/issues/1213",
        200,
        issueWire({ number: 1213, body: "x".repeat(MAX_ISSUE_BODY + 1) }),
      ),
    ],
  });
  const result = await port.readIssue(1213);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.issueSource, {
    target: "ubiquity-sentinel/sentinel",
    method: "GET",
    endpointPath: "/repos/ubiquity-sentinel/sentinel/issues/1213",
    httpStatus: 200,
    page: 1,
    stage: "validation",
    code: "bound_exceeded",
    issueNumber: 1213,
    validationPath: "$.body",
    limit: MAX_ISSUE_BODY,
    observedLength: MAX_ISSUE_BODY + 1,
  });
});

Deno.test("issue-source isolation: one bounded issue among three returns two complete issues and one skip", async () => {
  const { port } = makePort({
    script: [
      httpRespond("GET", "/repos/ubiquity-sentinel/sentinel/issues", 200, [
        issueWire({ number: 1, body: "x".repeat(MAX_ISSUE_BODY) }),
        issueWire({ number: 1213, body: "x".repeat(MAX_ISSUE_BODY + 1) }),
        issueWire({ number: 3, body: "third" }),
      ]),
    ],
  });
  const result = await port.listOpenIssues();
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.map((issue) => issue.number), [1, 3]);
  assert.equal(result.value[0].body.length, MAX_ISSUE_BODY);
  assert.ok("skippedIssues" in result);
  assert.deepEqual(result.skippedIssues, [{
    number: 1213,
    code: "bound_exceeded",
    validationPath: "$[1].body",
    limit: MAX_ISSUE_BODY,
    observedLength: MAX_ISSUE_BODY + 1,
  }]);
});

Deno.test("issue-source isolation: malformed issue identity still fails the page and keeps its validation path", async () => {
  const { port } = makePort({
    script: [
      httpRespond("GET", "/repos/ubiquity-sentinel/sentinel/issues", 200, [
        issueWire({ number: 1 }),
        issueWire({ number: "secret-invalid-number" }),
      ]),
    ],
  });
  const result = await port.listOpenIssues();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.issueSource?.validationPath, "$[1].number");
  assert.equal(result.error.issueSource?.code, "invalid_count");
  assert.doesNotMatch(JSON.stringify(result), /secret-invalid-number/);
});

Deno.test("issue-source context: diagnostic projection strips arbitrary fields, paths and raw port detail", () => {
  const valid = {
    target: "ubiquity-sentinel/sentinel",
    method: "GET",
    endpointPath: "/repos/ubiquity-sentinel/sentinel/issues",
    httpStatus: 200,
    page: 1,
    stage: "validation",
    code: "bound_exceeded",
    validationPath: "$.body",
    limit: 1_000_000,
    observedLength: 1_000_001,
  };
  assert.deepEqual(
    sanitizeIssueSourceContext({
      ...valid,
      token: "secret-token",
      body: "secret-body",
    }),
    valid,
  );
  assert.equal(
    sanitizeIssueSourceContext({
      ...valid,
      endpointPath: "https://secret-token@elsewhere/",
    }),
    undefined,
  );
  assert.equal(
    sanitizeIssueSourceContext({ ...valid, code: "secret-token" }),
    undefined,
  );
  assert.equal(
    sanitizeIssueSourceContext({ ...valid, validationPath: "$.secret-token" })
      ?.validationPath,
    undefined,
  );
  assert.doesNotMatch(
    issueSourceFailureDetail({
      kind: "unavailable",
      detail: "secret-token",
      issueSource:
        valid as import("../../src/contracts/ports.ts").IssueSourceErrorContextV1,
    }),
    /secret-token/,
  );
});
