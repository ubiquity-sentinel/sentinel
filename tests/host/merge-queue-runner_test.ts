import assert from "node:assert/strict";
import { runHostedAutonomy } from "../../ops/hosted-autonomy-runner.ts";
import { writeQueueCustodyOutput } from "../../ops/hosted-autonomy-queue-output.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { orchestrationRig } from "./merge-queue-orchestration-fixtures.ts";
import { makeRig, run } from "./actions-supervisor-fixture.ts";
import { bootstrapHealthy } from "./actions-supervisor-lifecycle-fixture.ts";

Deno.test("queue runner: unprovable custody protects every gateway record while the pass continues; healthy runtime survives finalize", async () => {
  // Issue #188: an unreadable native queue no longer stops every target. The
  // pass continues with every ai.ubq.fi record protected, writes none of them
  // or their charges, and the custody output stays not ready.
  const runtime = await makeRig();
  try {
    await bootstrapHealthy(runtime);
    const healthy = canonicalStringify(await runtime.snapshot());
    const f = await orchestrationRig();
    f.rules({ status: "complete", value: true });
    f.scan({ status: "unavailable", reason: "permission" });
    const readiness: boolean[] = [];
    f.deps.onQueueCustodyReady = (value) => {
      readiness.push(value);
    };
    const charges = canonicalStringify(f.state.repair!.reservations);
    const work = canonicalStringify(f.state.repair!.work);
    const result = await runHostedAutonomy(f.deps);
    assert.notEqual(result.status, "failed", JSON.stringify(result));
    assert.ok(result.actions.includes("queue:gateway_protected"));
    assert.deepEqual(readiness, [false, false]);
    assert.equal(canonicalStringify(f.state.repair!.reservations), charges);
    assert.equal(canonicalStringify(f.state.repair!.work), work);
    assert.equal((await runtime.finalize(run(2))).status, "pending");
    assert.equal(canonicalStringify(await runtime.snapshot()), healthy);
    assert.equal((await runtime.snapshot()).hostedRuntimes[0].execution, null);
  } finally {
    await runtime.cleanup();
  }
});

Deno.test("queue runner: custody is first and thrown prephase keeps readiness false", async () => {
  const f = await orchestrationRig();
  const readiness: boolean[] = [];
  f.deps.onQueueCustodyReady = (value) => {
    readiness.push(value);
  };
  f.deps.uncertainMatrix = () => {
    assert.deepEqual(f.calls, ["rules"]);
    throw new Error("known prephase failure");
  };
  await assert.rejects(
    () => runHostedAutonomy(f.deps),
    /known prephase failure/,
  );
  assert.deepEqual(readiness, [false, false]);
});

Deno.test("queue runner: native gate file starts closed and changes only after completed custody", async () => {
  const directory = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".queue-output-",
  });
  const path = `${directory}/github-output`;
  try {
    const f = await orchestrationRig();
    f.deps.onQueueCustodyReady = (value) =>
      writeQueueCustodyOutput(path, value);
    await runHostedAutonomy(f.deps);
    assert.deepEqual((await Deno.readTextFile(path)).trim().split("\n"), [
      "queueCustodyReady=false",
      "queueCustodyReady=true",
    ]);
    f.rules({ status: "unavailable", reason: "permission" });
    await runHostedAutonomy(f.deps);
    assert.equal(
      (await Deno.readTextFile(path)).trim().split("\n").at(-1),
      "queueCustodyReady=false",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("queue workflow: matrix workers require successful authenticated prepare without retired migration outputs", async () => {
  const source = await Deno.readTextFile(".github/workflows/supervisor.yml");
  const jobs = new Map(
    [...source.matchAll(
      /^ {2}([a-z_]+):\n([\s\S]*?)(?=^ {2}[a-z_]+:\n|$(?![\s\S]))/gm,
    )]
      .map((match) => [match[1], match[2]]),
  );
  assert.match(
    jobs.get("maintenance")!,
    /queueCustodyReady: \$\{\{ steps.autonomy.outputs.queueCustodyReady \}\}/,
  );
  assert.match(jobs.get("maintenance")!, /id: autonomy/);
  assert.match(jobs.get("maintenance")!, /--allow-env=GITHUB_OUTPUT,/);
  for (const name of ["matrix_plan", "matrix_cell"]) {
    const job = jobs.get(name)!;
    assert.match(job, /needs: (?:maintenance|\[[^\]\n]*maintenance[^\]\n]*\])/);
    const condition = /^ {4}if: (.*)$/m.exec(job)?.[1];
    assert.ok(condition);
    assert.ok(
      condition.includes(
        "needs.maintenance.result == 'success' && needs.prepare.result == 'success'",
      ),
      name,
    );
    assert.equal(
      /queueCustodyReady|runtimeMigrationOnly/.test(condition),
      false,
    );
    assert.ok(condition.includes("needs.prepare.outputs.run == 'true'"), name);
    assert.ok(
      condition.includes("github.ref == 'refs/heads/sentinel-supervisor'"),
      name,
    );
  }
  assert.match(
    jobs.get("matrix_plan")!,
    /needs\.prepare\.outputs\.modelStartsEnabled == 'true'/,
  );
  assert.match(
    jobs.get("matrix_cell")!,
    /needs\.matrix_plan\.result == 'success'/,
  );
  assert.match(
    jobs.get("matrix_cell")!,
    /needs\.matrix_plan\.outputs\.hasCells == 'true'/,
  );
  assert.match(jobs.get("finalize")!, /if:.*always\(\)/);
});
