import assert from "node:assert/strict";
import { MAX_WIRE_TEXT } from "../../src/github/wire.ts";
import { scopeLocalRepairIssues } from "../../src/host/local-github.ts";
import { httpRespond, issueWire, makePort } from "../github/helpers.ts";
import { REPO } from "../state/helpers.ts";

Deno.test("local issue scope preserves skipped diagnostics across paginated REST intake", async () => {
  const issues = `/repos/${REPO.owner}/${REPO.name}/issues`;
  const { port, transport } = makePort({
    repository: REPO,
    script: [
      httpRespond("GET", `${issues}?state=open&per_page=100&page=1`, 200, [
        issueWire({ number: 1 }),
        issueWire({ number: 2, body: "x".repeat(MAX_WIRE_TEXT + 1) }),
        issueWire({ number: 3, body: "<!-- sentinel:skip -->\nmanual task" }),
      ], {
        link:
          `<https://api.github.com${issues}?state=open&per_page=100&page=2>; rel="next"`,
      }),
      httpRespond("GET", `${issues}?state=open&per_page=100&page=2`, 200, [
        issueWire({ number: 4 }),
      ]),
    ],
  });

  const scoped = scopeLocalRepairIssues(port);
  const listed = await scoped.listOpenIssues();

  assert.equal(scoped, port);
  assert.ok(listed.ok, JSON.stringify(listed));
  assert.deepEqual(listed.value.map((issue) => issue.number), [1, 4]);
  assert.ok(
    "skippedIssues" in listed,
    "scoping must retain raw wire diagnostics",
  );
  assert.deepEqual(listed.skippedIssues, [{
    number: 2,
    code: "bound_exceeded",
    validationPath: "$[1].body",
    limit: MAX_WIRE_TEXT,
    observedLength: MAX_WIRE_TEXT + 1,
  }]);
  assert.equal(
    transport.requests.length,
    2,
    "a skipped row cannot end discovery",
  );
});
