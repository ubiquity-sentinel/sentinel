import assert from "node:assert/strict";

const workflow = await Deno.readTextFile(".github/workflows/supervisor.yml");
function job(name: string): string {
  const start = workflow.indexOf("  " + name + ":\n");
  assert.ok(start >= 0, "missing job " + name);
  const after = workflow.slice(start + 3);
  const next = after.search(/\n {2}[a-z_]+:\n/);
  return next < 0
    ? workflow.slice(start)
    : workflow.slice(start, start + 3 + next);
}

Deno.test("protected matrix workflow preserves verification, fanout, credentials and immutable artifacts", () => {
  const prepare = job("prepare");
  const plan = job("matrix_plan");
  const cell = job("matrix_cell");
  const repair = job("repair");
  const finalize = job("finalize");
  assert.ok(
    prepare.includes(
      "modelStartsEnabled: $" +
        "{{ steps.prepare.outputs.modelStartsEnabled }}",
    ),
  );
  assert.match(plan, /needs.prepare.outputs.modelStartsEnabled == 'true'/);
  assert.match(cell, /needs.matrix_plan.outputs.hasCells == 'true'/);
  assert.match(cell, /fail-fast: false/);
  assert.ok(!cell.includes("max-parallel"));
  assert.match(repair, /needs: \[maintenance, prepare, matrix_plan\]/);
  assert.ok(
    !repair.includes("matrix_cell"),
    "the consumer must start with the cells, before every sibling settles",
  );
  assert.match(repair, /needs.prepare.outputs.modelStartsEnabled != 'true'/);
  assert.match(
    finalize,
    /needs: \[maintenance, prepare, matrix_plan, matrix_cell, repair_cell, repair\]/,
  );
  assert.match(cell, /contents: read/);
  assert.ok(!cell.includes("contents: write"));
  assert.match(cell, /permission-contents: read/);
  assert.match(cell, /permission-issues: read/);
  assert.match(cell, /permission-pull-requests: read/);
  // Generation 81: the cell reads the failing job's steps and log for CI
  // failure evidence; its App token mint still grants nothing writable.
  assert.match(cell, /permission-checks: read/);
  assert.match(cell, /permission-actions: read/);
  assert.ok(!/permission-[a-z-]+: write/.test(cell));
  assert.ok(!cell.includes("SENTINEL_SUPERVISOR_APP_PRIVATE_KEY:"));
  assert.ok(plan.includes("group: sentinel-repair"));
  assert.ok(!cell.includes("sentinel-repair"));
  assert.ok(repair.includes("group: sentinel-repair"));
  for (
    const [stage, name] of [[plan, "Plan isolated issue matrix"], [
      cell,
      "Run isolated issue cell",
    ], [repair, "Run selected Sentinel runtime"]]
  ) {
    assert.ok(stage.includes("- name: " + name));
    assert.ok(stage.includes("path: launcher"));
    assert.ok(stage.includes("path: runtime"));
    assert.ok(
      stage.includes('ref: $" + "{{ github.sha }}'.replace('" + "', "")),
    );
    assert.ok(stage.includes("src/host/hosted-runtime.ts"));
  }
  assert.match(plan, /path: \.sentinel-matrix\/plan.json/);
  assert.match(plan, /planArtifactDigest:/);
  assert.match(cell, /cellArtifactDigest:/);
  assert.match(cell, /\.sentinel-matrix\/result.json/);
  assert.match(cell, /include-hidden-files: true/);
  assert.ok(
    cell.includes(
      '{"planDigest":"$' +
        '{{ needs.matrix_plan.outputs.planDigest }}","cellId":"$' +
        '{{ matrix.cellId }}"}',
    ),
  );
  assert.ok(
    repair.includes(
      '{"planDigest":"$' + '{{ needs.matrix_plan.outputs.planDigest }}"}',
    ),
  );
  assert.ok(!workflow.includes("GITHUB_JOB:"));
});

Deno.test("repository repair cells keep the cell boundary and hand finalize a sealed delta (#328)", () => {
  const plan = job("matrix_plan");
  const cell = job("repair_cell");
  const repair = job("repair");
  const finalize = job("finalize");
  const out = (name: string) => "$" + "{{ " + name + " }}";
  // Planned by the same matrix_plan pass, one cell per delegated repository.
  for (const output of ["repairMatrix", "repairPlanDigest", "hasRepairCells"]) {
    assert.ok(
      plan.includes(
        output + ": " + out("steps.matrix_plan.outputs." + output),
      ),
      output,
    );
  }
  assert.match(plan, /name: sentinel-repair-plan-/);
  assert.match(plan, /path: \.sentinel-repair\/plan.json/);
  assert.match(cell, /name: repair_cell \(\$\{\{ matrix.cellId \}\}\)/);
  assert.match(cell, /needs: \[maintenance, prepare, matrix_plan\]/);
  assert.match(cell, /needs.matrix_plan.outputs.hasRepairCells == 'true'/);
  assert.ok(
    cell.includes(
      "matrix: " + out("fromJSON(needs.matrix_plan.outputs.repairMatrix)"),
    ),
  );
  assert.match(cell, /fail-fast: false/);
  // The matrix cell's credential-free boundary: read-only native and App
  // tokens, no state ref write, the App key only in the mint steps.
  assert.match(cell, /contents: read/);
  assert.ok(!/: write/.test(cell));
  assert.ok(!/permission-[a-z-]+: write/.test(cell));
  assert.match(cell, /permission-contents: read/);
  assert.ok(!cell.includes("SENTINEL_SUPERVISOR_APP_PRIVATE_KEY:"));
  assert.ok(!cell.includes("group:"));
  assert.match(cell, /timeout-minutes: 120/);
  assert.ok(cell.includes("- name: Run repository repair cell"));
  assert.ok(cell.includes("src/host/hosted-runtime.ts"));
  assert.ok(
    cell.includes(
      '{"planDigest":"' + out("needs.matrix_plan.outputs.planDigest") +
        '","repairPlanDigest":"' +
        out("needs.matrix_plan.outputs.repairPlanDigest") + '","cellId":"' +
        out("matrix.cellId") + '"}',
    ),
  );
  assert.match(cell, /name: sentinel-repair-cell-/);
  assert.match(cell, /path: \.sentinel-repair\/result.json/);
  assert.match(cell, /include-hidden-files: true/);
  // The serial pass reads the same plan; finalize applies the deltas.
  assert.ok(!repair.includes("repair_cell"), "serial repair starts with cells");
  assert.match(repair, /name: sentinel-repair-plan-/);
  assert.ok(
    repair.includes(
      '"repairPlanDigest":"' +
        out("needs.matrix_plan.outputs.repairPlanDigest") + '"',
    ),
  );
  assert.ok(finalize.includes("SENTINEL_REPAIR_PLAN_DIGEST: "));
  assert.match(finalize, /run: deno task supervisor:run/);
});
