import assert from "node:assert/strict";
import { portError } from "../../src/contracts/ports.ts";
import { makeMemoryRig, RelationsFakeGithub } from "./loop-rig.ts";
import { REPO, SHA1, T0 } from "../state/helpers.ts";
import { httpRespond, issueWire, makePort } from "../github/helpers.ts";
import { MAX_ISSUE_BODY } from "../../src/github/wire.ts";

Deno.test("issue source failure: the ordinary consumer retains safe HTTP and validation detail in its bounded outcome", async () => {
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listOpenIssues = () =>
    Promise.resolve(
      portError("unavailable", "raw-secret-must-not-escape", undefined, {
        target: "ubiquity/ai.ubq.fi",
        method: "GET",
        endpointPath: "/repos/ubiquity/ai.ubq.fi/issues",
        httpStatus: 200,
        page: 2,
        stage: "validation",
        code: "bound_exceeded",
        validationPath: "$[1].body",
        limit: 1_000_000,
        observedLength: 1_000_001,
        issueNumber: 1213,
      }),
    );
  const rig = makeMemoryRig(github);
  const result = await rig.run();
  assert.equal(result.status, "source_error");
  if (result.status !== "source_error") return;
  assert.match(
    result.detail,
    /HTTP 200 page 2 validation:bound_exceeded issue #1213 limit=1000000 length=1000001 at \$\[1\]\.body/,
  );
  assert.ok(result.detail.length <= 300);
  assert.doesNotMatch(result.detail, /raw-secret/);
  assert.equal(rig.model.requests.length, 0);
});

Deno.test("issue source isolation: the real listing consumer admits both valid issues and logs the rejected issue's measurements", async () => {
  const born = new Date(T0 - 1_000).toISOString();
  const wire = (number: number, body = "") =>
    issueWire({ number, body, created_at: born, updated_at: born });
  const { port } = makePort({
    repository: REPO,
    script: [httpRespond("GET", "/repos/ubiquity/ai.ubq.fi/issues", 200, [
      wire(1),
      wire(1213, "x".repeat(MAX_ISSUE_BODY + 1)),
      wire(3),
    ])],
  });
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listOpenIssues = () => port.listOpenIssues();
  const rig = makeMemoryRig(github);
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: unknown) => logs.push(String(line));
    await rig.run();
  } finally {
    console.log = originalLog;
  }
  const state = await rig.snapshot();
  assert.deepEqual(state.work.map((row) => row.related.issueNumber), [1, 3]);
  const diagnostic = logs.map((line) => JSON.parse(line)).find((row) =>
    row.kind === "sentinel_issue_intake"
  );
  assert.deepEqual(diagnostic, {
    kind: "sentinel_issue_intake",
    repository: "ubiquity/ai.ubq.fi",
    openIssues: 3,
    skippedIssues: [{
      number: 1213,
      code: "bound_exceeded",
      validationPath: "$[1].body",
      limit: MAX_ISSUE_BODY,
      observedLength: MAX_ISSUE_BODY + 1,
    }],
  });
  assert.equal(rig.model.requests.length, 0);
});
