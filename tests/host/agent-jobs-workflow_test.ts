import assert from "node:assert/strict";
import { parse } from "@std/yaml";
import { requireAgentJobOperator } from "../../ops/agent-jobs-intake.ts";

type Step = {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "working-directory"?: string;
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
    assert.match(plan.if!, /github\.event\.sender\.type == 'User'/);
    assert.match(plan.if!, /github\.event\.sender\.login == github\.actor/);
    assert.match(plan.if!, /!endsWith\(github\.actor, '\[bot\]'\)/);
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

Deno.test("agent job operators must be GitHub User senders matching the actor", () => {
  requireAgentJobOperator({
    sender: { type: "User", login: "authorized-operator" },
    head_commit: { author: { username: "bot[bot]" } },
  }, "authorized-operator");
  for (
    const [sender, actor] of [
      [
        { type: "Bot", login: "ubiquity-sentinel[bot]" },
        "ubiquity-sentinel[bot]",
      ],
      [{ type: "User", login: "app[bot]" }, "app[bot]"],
      [{ type: "User", login: "other-user" }, "authorized-operator"],
      [{ login: "authorized-operator" }, "authorized-operator"],
      [undefined, "authorized-operator"],
    ] as const
  ) {
    assert.throws(
      () =>
        requireAgentJobOperator({
          sender,
          head_commit: { author: { username: "authorized-operator" } },
        }, actor),
      /matching GitHub User sender/,
    );
  }
});

Deno.test("agent job control code is pinned separately from development request data", async () => {
  for (const name of ["agent-jobs", "agent-jobs-cleanup"]) {
    const { jobs } = await workflow(name);
    const { plan } = jobs;
    const checkouts = plan.steps.filter((step) =>
      step.uses?.startsWith("actions/checkout@")
    );
    assert.deepEqual(checkouts.map((step) => step.with?.ref), [
      "refs/heads/sentinel-supervisor",
      "${{ github.sha }}",
    ]);
    assert.deepEqual(checkouts.map((step) => step.with?.path), [
      "control",
      "request",
    ]);
    assert(
      checkouts.every((step) =>
        Object.is(step.with?.["persist-credentials"], false)
      ),
    );
    assert.equal(
      plan.outputs?.["control-sha"],
      "${{ steps.control.outputs.sha }}",
    );
    const bind = plan.steps.find((step) => step.id === "control")!;
    assert.equal(bind["working-directory"], "control");
    assert.match(bind.run!, /git rev-parse --verify HEAD/);
    const prep = plan.steps.find((step) => step.id === "plan")!;
    assert.equal(prep["working-directory"], "control");
    assert.equal(
      prep.env?.AGENT_JOBS_REQUEST_CHECKOUT,
      "${{ github.workspace }}/request",
    );
    if (name === "agent-jobs") {
      assert.equal(
        jobs.delivery.with?.["control-sha"],
        "${{ needs.plan.outputs.control-sha }}",
      );
    } else {
      assert.equal(
        jobs.delete.steps[0].with?.ref,
        "${{ needs.plan.outputs.control-sha }}",
      );
    }
  }
  const { jobs } = await workflow("agent-jobs-delivery");
  for (const job of [jobs.cell, jobs.review, jobs.publish]) {
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@")
    )!;
    assert.equal(checkout.with?.ref, "${{ inputs.control-sha }}");
    assert(Object.is(checkout.with?.["persist-credentials"], false));
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
