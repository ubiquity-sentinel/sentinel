/**
 * Every foreign App-token mint narrows a refused list through the vendored
 * tolerant action, after its credential-free dependency install; self mints
 * stay strict; later jobs take maintenance's dropped names as a hint; and
 * maintenance hides them for its own run.
 */
import assert from "node:assert/strict";
import { parse } from "@std/yaml";

type Obj = Record<string, unknown>;

async function workflow(name: string): Promise<Obj> {
  return parse(await Deno.readTextFile(`.github/workflows/${name}`), {
    schema: "core",
  }) as Obj;
}
const jobs = (w: Obj) => w.jobs as Record<string, Obj>;
const steps = (job: Obj) => job.steps as Obj[];
const VENDORED = /^\.\/(launcher\/)?\.github\/actions\/sentinel-app-token$/;
const INSTALL = "Install the locked App token action dependencies";
const NPM =
  "npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix .github/actions/sentinel-app-token";
const HINT = "${{ needs.maintenance.outputs.unavailableRepositories }}";

function foreignMint(job: Obj): { index: number; step: Obj } {
  const list = steps(job);
  const index = list.findIndex((step) =>
    (step.with as Obj | undefined)?.owner === "ubiquity"
  );
  assert.ok(index >= 0, "the job mints a foreign token");
  return { index, step: list[index] };
}

Deno.test("tolerant mint workflows: every foreign mint is the vendored action with the opt-in after its install", async () => {
  const supervisor = jobs(await workflow("supervisor.yml"));
  const backup = jobs(await workflow("backup-ci.yml"));
  const cases: [string, Obj, string][] = [
    ...[
      "maintenance",
      "prepare",
      "matrix_plan",
      "matrix_cell",
      "repair_cell",
      "repair",
      "finalize",
    ].map((name) =>
      [name, supervisor[name], "supervisor"] as [string, Obj, string]
    ),
    ["backup_ci", backup.backup_ci, "backup"],
  ];
  for (const [name, job, file] of cases) {
    const { index, step } = foreignMint(job);
    assert.match(String(step.uses), VENDORED, name);
    const inputs = step.with as Obj;
    assert.equal(inputs["tolerate-inaccessible-repositories"], "true", name);
    const list = steps(job);
    // The dependency install precedes the mint, credential-free.
    const install = list.findIndex((candidate) =>
      candidate.name === INSTALL ||
      candidate.name === "Install locked self-test dependencies"
    );
    assert.ok(install >= 0 && install < index, `${name} installs first`);
    const run = String(list[install].run);
    assert.ok(run.includes(NPM), name);
    assert.equal(list[install].env, undefined, name);
    assert.doesNotMatch(run, /secrets\.|outputs\.token/);
    if (list[install].name === INSTALL) {
      // The registry is retried a bounded number of times, then fails.
      assert.match(run, /for attempt in 1 2 3; do/);
      assert.match(run, /exit 1\s*$/);
    }
    // Maintenance is the hint's source; every later supervisor job reads it.
    assert.equal(
      inputs["known-unavailable"],
      file === "supervisor" && name !== "maintenance" ? HINT : undefined,
      name,
    );
    // Every self mint stays strict.
    for (const other of list) {
      const given = other.with as Obj | undefined;
      if (given?.owner === "ubiquity-sentinel") {
        assert.equal(given["tolerate-inaccessible-repositories"], undefined);
        assert.equal(given["known-unavailable"], undefined);
      }
    }
  }
});

Deno.test("tolerant mint workflows: maintenance publishes its dropped names and hides them for its own run", async () => {
  const maintenance = jobs(await workflow("supervisor.yml")).maintenance;
  assert.equal(
    (maintenance.outputs as Obj).unavailableRepositories,
    "${{ steps.app-token.outputs.unavailable-repositories }}",
  );
  const autonomy = steps(maintenance).find((step) => step.id === "autonomy")!;
  assert.equal(
    (autonomy.env as Obj).SENTINEL_UNAVAILABLE_TARGETS,
    "${{ steps.app-token.outputs.unavailable-repositories }}",
  );
  assert.match(
    String(autonomy.run),
    /--allow-env=[^\s]*\bSENTINEL_UNAVAILABLE_TARGETS\b/,
  );
});
