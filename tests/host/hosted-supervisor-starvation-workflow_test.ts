import assert from "node:assert/strict";

const workflow = await Deno.readTextFile(".github/workflows/supervisor.yml");
const jobs = new Map(
  [...workflow.matchAll(
    /^ {2}([a-z_]+):\n([\s\S]*?)(?=^ {2}[a-z_]+:\n|$(?![\s\S]))/gm,
  )].map((match) => [match[1], match[2]]),
);
function context() {
  return {
    maintenance: { result: "success", outputs: {} },
    prepare: {
      result: "success",
      outputs: {
        run: "true",
        modelStartsEnabled: "false",
        executionPurpose: "bootstrap",
      },
    },
    matrix_plan: { result: "skipped", outputs: { hasCells: "true" } },
  };
}
function allows(
  job: string,
  needs: ReturnType<typeof context>,
  ref = "refs/heads/sentinel-supervisor",
  cancelled = false,
): boolean {
  const condition = /^ {4}if: (.*)$/m.exec(jobs.get(job) ?? "")?.[1];
  assert.ok(condition, job);
  // Evaluate only the committed workflow's fixed boolean/string expression.
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  return Boolean(
    new Function(
      "needs",
      "github",
      "always",
      "cancelled",
      `return (${expression});`,
    )(needs, { ref }, () => true, () => cancelled),
  );
}
Deno.test("starvation workflow: authenticated prepare bootstrap runs without retired migration outputs", () => {
  const needs = context();
  assert.equal(allows("prepare", needs), true);
  assert.equal(allows("repair", needs), true);
  assert.equal(allows("matrix_plan", needs), false);
  assert.equal(allows("matrix_cell", needs), false);
  assert.ok(!jobs.get("prepare")?.includes("owner-development-install.ts"));
  for (const job of ["prepare", "repair"]) {
    assert.equal(allows(job, needs, "refs/heads/development"), false);
    const failed = context();
    failed.maintenance.result = "failure";
    assert.equal(allows(job, failed), false);
  }
  needs.prepare.outputs.run = "false";
  assert.equal(allows("repair", needs), false);
  needs.prepare.result = "failure";
  assert.equal(allows("repair", needs), false);
  needs.maintenance.result = "failure";
  assert.equal(allows("finalize", needs), true);
});
Deno.test("starvation workflow: ordinary fanout and aggregation remain bound to the admitted plan", () => {
  const needs = context();
  needs.prepare.outputs.modelStartsEnabled = "true";
  needs.prepare.outputs.executionPurpose = "ordinary";
  assert.equal(allows("matrix_plan", needs), true);
  assert.equal(allows("repair", needs), false);
  assert.equal(allows("matrix_cell", needs), false);
  needs.matrix_plan.result = "success";
  assert.equal(allows("repair", needs), true);
  assert.equal(allows("matrix_cell", needs), true);
  needs.matrix_plan.outputs.hasCells = "false";
  assert.equal(allows("matrix_cell", needs), false);
  for (const job of ["matrix_plan", "matrix_cell", "repair"]) {
    assert.equal(allows(job, needs, undefined, true), false);
  }
});
