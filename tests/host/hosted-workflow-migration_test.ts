/** Exercise the actual job predicates with the controller's migration outputs. */
import assert from "node:assert/strict";

const workflow = await Deno.readTextFile(".github/workflows/supervisor.yml");
const jobs = new Map(
  [...workflow.matchAll(
    /^ {2}([a-z_]+):\n([\s\S]*?)(?=^ {2}[a-z_]+:\n|$(?![\s\S]))/gm,
  )].map((match) => [match[1], match[2]]),
);

function context() {
  return {
    maintenance: {
      result: "success",
      outputs: {
        queueCustodyReady: "false",
        runtimeMigrationOnly: "true",
        runtimeMigrationRevision: "a".repeat(40),
        runtimeMigrationGeneration: "82",
      } as Record<string, string>,
    },
    prepare: {
      result: "success",
      outputs: {
        run: "true",
        modelStartsEnabled: "false",
        executionPurpose: "bootstrap",
        revision: "a".repeat(40),
        generation: "82",
      } as Record<string, string>,
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
  const condition = /^ {4}if: (.*)$/m.exec(jobs.get(job)!)?.[1];
  assert.ok(condition, job);
  // This fixed workflow subset uses only string comparisons and boolean
  // operators shared with JavaScript; it contains no untrusted expression.
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  return Boolean(
    new Function(
      "needs",
      "github",
      "always",
      "cancelled",
      `return (${expression});`,
    )(
      needs,
      { ref },
      () => true,
      () => cancelled,
    ),
  );
}

Deno.test("hosted migration workflow: only exact model-disabled bootstrap crosses the maintenance hold", () => {
  const needs = context();
  assert.equal(allows("prepare", needs), true);
  assert.equal(allows("repair", needs), true);
  for (const job of ["matrix_plan", "matrix_cell"]) {
    assert.equal(allows(job, needs), false, job);
  }
  for (
    const [field, value] of [
      ["revision", "b".repeat(40)],
      ["generation", "83"],
      ["executionPurpose", "ordinary"],
      ["modelStartsEnabled", "true"],
      ["modelStartsEnabled", ""],
      ["run", "false"],
    ]
  ) {
    const changed = context();
    changed.prepare.outputs[field] = value;
    assert.equal(allows("repair", changed), false, `${field}=${value}`);
  }
  for (
    const field of [
      "runtimeMigrationOnly",
      "runtimeMigrationRevision",
      "runtimeMigrationGeneration",
    ]
  ) {
    const changed = context();
    delete changed.maintenance.outputs[field];
    assert.equal(allows("repair", changed), false, `missing ${field}`);
  }
  for (const job of ["prepare", "repair"]) {
    assert.equal(allows(job, needs, "refs/heads/development"), false, job);
    const failed = context();
    failed.maintenance.result = "failure";
    assert.equal(allows(job, failed), false, job);
    failed.maintenance.result = "skipped";
    assert.equal(allows(job, failed), false, job);
  }
  assert.equal(allows("repair", needs, undefined, true), false);
  const failed = context();
  failed.prepare.result = "failure";
  assert.equal(allows("repair", failed), false);
});

Deno.test("hosted migration workflow: ordinary queue gates and final settlement retain their route", () => {
  const needs = context();
  needs.maintenance.outputs.runtimeMigrationOnly = "false";
  for (const job of ["prepare", "matrix_plan", "matrix_cell", "repair"]) {
    assert.equal(allows(job, needs), false, job);
  }
  needs.maintenance.outputs.queueCustodyReady = "true";
  needs.prepare.outputs.executionPurpose = "ordinary";
  needs.prepare.outputs.modelStartsEnabled = "true";
  assert.equal(allows("repair", needs), false);
  needs.matrix_plan.result = "success";
  for (const job of ["prepare", "matrix_plan", "matrix_cell", "repair"]) {
    assert.equal(allows(job, needs), true, job);
  }
  needs.maintenance.result = "failure";
  assert.equal(allows("finalize", needs), true);
  assert.equal(allows("finalize", needs, "refs/heads/development"), false);
  for (
    const name of [
      "runtimeMigrationOnly",
      "runtimeMigrationRevision",
      "runtimeMigrationGeneration",
    ]
  ) {
    assert.ok(
      jobs.get("maintenance")!.includes(
        `${name}: \${{ steps.autonomy.outputs.${name} }}`,
      ),
    );
  }
  for (const name of ["executionPurpose", "generation"]) {
    assert.ok(
      jobs.get("prepare")!.includes(
        `${name}: \${{ steps.prepare.outputs.${name} }}`,
      ),
    );
  }
});
