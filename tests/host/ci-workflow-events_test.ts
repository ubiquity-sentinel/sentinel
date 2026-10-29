/** Ordinary CI entrypoints must preserve the PR-only native receipt producer. */
import assert from "node:assert/strict";
import { parse } from "@std/yaml";

type Obj = Record<string, unknown>;
const ci = parse(await Deno.readTextFile(".github/workflows/ci.yml"), {
  schema: "core",
}) as Obj;

Deno.test("CI events: canonical pushes and PRs run automatically; branch checks are explicit", () => {
  const events = ci.on as Obj;
  assert.deepEqual(Object.keys(events).sort(), [
    "pull_request",
    "push",
    "workflow_dispatch",
  ]);
  assert.equal(
    events.pull_request,
    null,
    "every normal PR event remains enabled",
  );
  assert.deepEqual(
    events.workflow_dispatch,
    {},
    "pre-PR checks need no inputs",
  );
  const push = events.push as Obj;
  assert.deepEqual(
    push.branches,
    ["master", "development"],
    "a codex branch push must not duplicate its PR check",
  );
  assert.deepEqual(Object.keys(push), ["branches"]);
});

Deno.test("CI concurrency: a branch check cannot cancel its PR receipt producer", () => {
  const concurrency = ci.concurrency as Obj;
  const group = concurrency.group;
  assert.equal(typeof group, "string");
  // Expand only the two fields this workflow supports, not GitHub expressions.
  const key = (event: string, branch: string) => {
    const value = String(group)
      .replace("${{ github.event_name }}", event)
      .replace("${{ github.head_ref || github.ref_name }}", branch);
    assert.doesNotMatch(value, /\$\{\{/, "every group field is bound");
    return value;
  };
  const branch = "codex/receipt-fix";
  const pr = key("pull_request", branch);
  assert.notEqual(pr, key("push", branch));
  assert.notEqual(pr, key("workflow_dispatch", branch));
  assert.notEqual(pr, key("pull_request", "codex/another-fix"));
  assert.equal(pr, key("pull_request", branch), "superseded PRs share a group");
  assert.equal(
    concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' || !startsWith(github.ref, 'refs/heads/development') }}",
    "PRs cancel superseded runs while running development CI is preserved",
  );
});
