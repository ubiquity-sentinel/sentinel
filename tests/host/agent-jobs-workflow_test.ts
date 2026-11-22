import assert from "node:assert/strict";
import { parse } from "@std/yaml";

type Step = {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  env?: Record<string, string>;
  environment?: { name: string };
  outputs?: Record<string, string>;
  uses?: string;
  with?: Record<string, string>;
  secrets?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: {
    push?: { branches: string[]; paths: string[] };
    workflow_call?: unknown;
  };
  jobs: Record<string, Job>;
};

async function workflow(name: string): Promise<Workflow> {
  return parse(
    await Deno.readTextFile(".github/workflows/" + name + ".yml"),
    { schema: "core" },
  ) as Workflow;
}

Deno.test("agent job intake runs on development and skips empty push plans", async () => {
  for (
    const [name, requestDir] of [
      ["agent-jobs", "inbox"],
      ["agent-jobs-cleanup", "cleanup"],
    ]
  ) {
    const input = await workflow(name);
    assert.deepEqual(input.on.push, {
      branches: ["development"],
      paths: ["jobs/" + requestDir + "/*.json"],
    });
    const { plan, ...jobs } = input.jobs;
    assert.match(plan.if!, /github.ref == 'refs\/heads\/development'/);
    assert.match(
      plan.steps.find((step) => step.id === "plan")!.run!,
      /agent-jobs-prepare\.ts/,
    );
    assert(!JSON.stringify(plan).includes("secrets."));
    for (const job of Object.values(jobs)) {
      assert.match(job.if!, /needs\.plan\.outputs\.has-work == 'true'/);
    }
  }
});

Deno.test("agent job review produces an attempt-bound artifact ID for the scoped publisher", async () => {
  const { jobs } = await workflow("agent-jobs");
  assert.equal(
    jobs.delivery.uses,
    "./.github/workflows/agent-jobs-delivery.yml",
  );
  assert.deepEqual(Object.keys(jobs.delivery.secrets!), ["UOS_AI_TOKEN"]);
  assert.match(
    jobs.delivery.with!["plan-artifact-id"],
    /needs\.plan\.outputs\.artifact-id/,
  );
  const delivery = await workflow("agent-jobs-delivery");
  assert.deepEqual(Object.keys(delivery.on), ["workflow_call"]);
  const { cell, review, publish } = delivery.jobs;
  assert.equal(cell.environment, undefined);
  assert(!JSON.stringify(cell).includes("APP_PRIVATE_KEY"));
  assert.match(
    cell.if!,
    /github\.workflow_ref.*agent-jobs\.yml@refs\/heads\/development/,
  );
  assert.equal(review.needs, "cell");
  assert(
    review.steps.some((step) =>
      step.with?.["artifact-ids"] === "${{ needs.cell.outputs.artifact-id }}"
    ),
  );
  assert.equal(review.environment, undefined);
  assert(!JSON.stringify(review).includes("APP_PRIVATE_KEY"));
  assert(!JSON.stringify(review).includes("AGENT_JOBS_WRITE_TOKEN"));
  assert(!JSON.stringify(review).includes("actions/cache"));
  assert(review.steps.some((step) => /codex@0\.154\.0/.test(step.run ?? "")));
  assert(
    review.steps.some((step) =>
      step.with?.["artifact-ids"] === "${{ inputs.plan-artifact-id }}"
    ),
  );
  assert.equal(
    review.outputs!["artifact-id"],
    "${{ steps.reviewed.outputs.artifact-id }}",
  );
  assert.equal(review.outputs!["run-tag"], "${{ steps.gate.outputs.run-tag }}");
  assert.match(publish.if!, /needs\.review\.result == 'success'/);
  assert.equal(publish.needs, "review");
  assert(publish.environment);
  assert(!JSON.stringify(publish).includes("UOS_AI_TOKEN"));
  assert(
    publish.steps.some((step) =>
      step.with?.["artifact-ids"] === "${{ needs.review.outputs.artifact-id }}"
    ),
  );
  assert(
    publish.steps.some((step) =>
      step.env?.AGENT_JOBS_REVIEW_RUN_TAG ===
        "${{ needs.review.outputs.run-tag }}"
    ),
  );
  const mint = publish.steps.find((step) => step.id === "write-token")!;
  assert.equal(mint.with!["permission-statuses"], undefined);
  assert.equal(mint.with!["permission-workflows"], undefined);
});
